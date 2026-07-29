import { MAX_FETCHED_BYTES, type ByteSource } from '../core/download/fetched-transfer-contract'
import { makeSerialQueue } from '../core/serial-queue'
import { MAX_TRANSFER_REGISTRY_ID_LENGTH } from '../core/wire/limits'

/** Durable writes stay small even when the archive spans many Fetched leases. */
export const CAPTURE_EXPORT_STAGE_CHUNK_BYTES = 256 * 1024
const MAX_CAPTURE_EXPORT_STAGE_CHUNKS = Math.ceil(
  MAX_FETCHED_BYTES / CAPTURE_EXPORT_STAGE_CHUNK_BYTES,
)

type StageState = 'building' | 'ready'

interface CaptureExportStageManifest {
  readonly id: string
  readonly state: StageState
  readonly totalBytes: number
  readonly partCount: number
}

interface CaptureExportStagePart {
  readonly part: number
  readonly totalBytes: number
  readonly chunkCount: number
}

/** One durable slot. The export owner is the only writer and reader. */
export interface CaptureExportStageStore {
  readonly begin: (id: string) => Promise<void>
  readonly append: (id: string, part: number, bytes: Uint8Array) => Promise<void>
  readonly ready: (id: string, partCount: number) => Promise<void>
  /** `undefined` is only the exact end of one ready part. */
  readonly read: (id: string, part: number, index: number) => Promise<Uint8Array | undefined>
  /** With no id, removes a stale worker's whole detached job. */
  readonly discard: (id?: string) => Promise<void>
}

/**
 * A line factory must be repeatable. Staging measures once, then writes once.
 * This keeps boundaries between records without retaining a whole line.
 */
export type CaptureJsonlLine = () => Iterable<string>

type CaptureJsonlMaterialization =
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly partCount: number }
  | { readonly kind: 'too-large' }

export interface CaptureExportStaging {
  readonly materializeJsonl: (
    id: string,
    lines: AsyncIterable<CaptureJsonlLine>,
    maxPartBytes: number,
  ) => Promise<CaptureJsonlMaterialization>
  readonly source: (id: string, part: number) => ByteSource
  readonly discard: (id: string) => Promise<void>
  /** Boot-only stale job cleanup. It has no Blob/download authority. */
  readonly discardStale: () => Promise<void>
}

const DB_NAME = 'xmd-capture-export-stage'
const DB_VERSION = 2
const MANIFEST = 'manifest'
const PARTS = 'parts'
const CHUNKS = 'chunks'
const SLOT = 'active'
const encoder = new TextEncoder()
const newline = encoder.encode('\n')

const isSafeCount = (value: unknown, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum

const isStageId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_TRANSFER_REGISTRY_ID_LENGTH

const decodeManifest = (value: unknown): CaptureExportStageManifest | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (
    row.slot !== SLOT ||
    !isStageId(row.id) ||
    (row.state !== 'building' && row.state !== 'ready') ||
    !isSafeCount(row.totalBytes, Number.MAX_SAFE_INTEGER) ||
    !isSafeCount(row.partCount, Number.MAX_SAFE_INTEGER)
  )
    return undefined
  if (row.partCount === 0 && row.totalBytes !== 0) return undefined
  return {
    id: row.id,
    state: row.state,
    totalBytes: row.totalBytes,
    partCount: row.partCount,
  }
}

const decodePart = (value: unknown): CaptureExportStagePart | undefined => {
  if (typeof value !== 'object' || value === null) return undefined
  const row = value as Record<string, unknown>
  if (
    row.slot !== SLOT ||
    !isSafeCount(row.part, Number.MAX_SAFE_INTEGER) ||
    !isSafeCount(row.totalBytes, MAX_FETCHED_BYTES) ||
    !isSafeCount(row.chunkCount, MAX_CAPTURE_EXPORT_STAGE_CHUNKS)
  )
    return undefined
  if (row.chunkCount === 0 || row.totalBytes === 0) return undefined
  if (row.totalBytes > row.chunkCount * CAPTURE_EXPORT_STAGE_CHUNK_BYTES) return undefined
  return {
    part: row.part,
    totalBytes: row.totalBytes,
    chunkCount: row.chunkCount,
  }
}

const request = <T>(value: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    value.addEventListener('success', () => resolve(value.result))
    value.addEventListener('error', () => reject(value.error))
  })

const transaction = (value: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    value.addEventListener('complete', () => resolve())
    value.addEventListener('abort', () =>
      reject(value.error ?? new Error('staging transaction aborted')),
    )
    value.addEventListener('error', () => reject(value.error))
  })

const fail = (tx: IDBTransaction, message: string): never => {
  tx.abort()
  throw new Error(message)
}

const requireBuildingOwner = (
  tx: IDBTransaction,
  value: CaptureExportStageManifest | undefined,
  id: string,
): CaptureExportStageManifest => {
  if (value === undefined || value.id !== id || value.state !== 'building')
    return fail(tx, 'capture export staging owner is unavailable')
  return value
}

function makeIndexedDbStageStore(): CaptureExportStageStore {
  let database: Promise<IDBDatabase> | undefined
  const open = (): Promise<IDBDatabase> => {
    if (database !== undefined) return database
    database = new Promise((resolve, reject) => {
      const opening = indexedDB.open(DB_NAME, DB_VERSION)
      opening.addEventListener('upgradeneeded', () => {
        const db = opening.result
        for (const name of [MANIFEST, PARTS, CHUNKS])
          if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name)
        db.createObjectStore(MANIFEST, { keyPath: 'slot' })
        db.createObjectStore(PARTS, { keyPath: ['slot', 'part'] })
        db.createObjectStore(CHUNKS, { keyPath: ['slot', 'part', 'index'] })
      })
      opening.addEventListener('success', () => resolve(opening.result))
      opening.addEventListener('error', () => reject(opening.error))
    })
    return database
  }
  const manifest = async (): Promise<CaptureExportStageManifest | undefined> => {
    const db = await open()
    return decodeManifest(await request(db.transaction(MANIFEST).objectStore(MANIFEST).get(SLOT)))
  }
  return {
    begin: async (id) => {
      if (!isStageId(id)) throw new Error('invalid capture export staging id')
      const db = await open()
      const tx = db.transaction(MANIFEST, 'readwrite')
      const store = tx.objectStore(MANIFEST)
      if ((await request(store.get(SLOT))) !== undefined)
        fail(tx, 'capture export staging slot is occupied')
      store.put({ slot: SLOT, id, state: 'building', totalBytes: 0, partCount: 0 })
      await transaction(tx)
    },
    append: async (id, part, bytes) => {
      if (
        !isSafeCount(part, Number.MAX_SAFE_INTEGER) ||
        bytes.byteLength === 0 ||
        bytes.byteLength > CAPTURE_EXPORT_STAGE_CHUNK_BYTES
      )
        throw new Error('invalid capture export staging chunk')
      const db = await open()
      const tx = db.transaction([MANIFEST, PARTS, CHUNKS], 'readwrite')
      const manifests = tx.objectStore(MANIFEST)
      const current = requireBuildingOwner(
        tx,
        decodeManifest(await request(manifests.get(SLOT))),
        id,
      )
      const isNewPart = part === current.partCount
      if (!isNewPart && part + 1 !== current.partCount)
        fail(tx, 'capture export staging parts are not sequential')
      const parts = tx.objectStore(PARTS)
      const storedPart = decodePart(await request(parts.get([SLOT, part])))
      if ((isNewPart && storedPart !== undefined) || (!isNewPart && storedPart === undefined))
        fail(tx, 'capture export staging part is malformed')
      const currentPart = storedPart ?? { part, totalBytes: 0, chunkCount: 0 }
      if (
        currentPart.chunkCount >= MAX_CAPTURE_EXPORT_STAGE_CHUNKS ||
        currentPart.totalBytes + bytes.byteLength > MAX_FETCHED_BYTES ||
        current.totalBytes > Number.MAX_SAFE_INTEGER - bytes.byteLength
      )
        fail(tx, 'capture export staging exceeds its byte limit')
      tx.objectStore(CHUNKS).put({
        slot: SLOT,
        part,
        index: currentPart.chunkCount,
        bytes: new Uint8Array(bytes),
      })
      parts.put({
        slot: SLOT,
        part,
        totalBytes: currentPart.totalBytes + bytes.byteLength,
        chunkCount: currentPart.chunkCount + 1,
      })
      manifests.put({
        slot: SLOT,
        id,
        state: 'building',
        totalBytes: current.totalBytes + bytes.byteLength,
        partCount: isNewPart ? current.partCount + 1 : current.partCount,
      })
      await transaction(tx)
    },
    ready: async (id, partCount) => {
      const db = await open()
      const tx = db.transaction(MANIFEST, 'readwrite')
      const store = tx.objectStore(MANIFEST)
      const current = requireBuildingOwner(tx, decodeManifest(await request(store.get(SLOT))), id)
      if (current.partCount !== partCount) fail(tx, 'capture export staging part count changed')
      store.put({ slot: SLOT, ...current, state: 'ready' })
      await transaction(tx)
    },
    read: async (id, part, index) => {
      const current = await manifest()
      if (current === undefined || current.id !== id || current.state !== 'ready')
        throw new Error('capture export staging owner is unavailable')
      if (
        !isSafeCount(part, current.partCount - 1) ||
        !isSafeCount(index, MAX_CAPTURE_EXPORT_STAGE_CHUNKS)
      )
        throw new Error('invalid capture export staging position')
      const db = await open()
      const tx = db.transaction([PARTS, CHUNKS])
      const storedPart = decodePart(await request(tx.objectStore(PARTS).get([SLOT, part])))
      if (storedPart === undefined || storedPart.part !== part)
        throw new Error('capture export staging part is missing')
      if (index > storedPart.chunkCount) throw new Error('invalid capture export staging position')
      if (index === storedPart.chunkCount) return undefined
      const row = (await request(tx.objectStore(CHUNKS).get([SLOT, part, index]))) as
        | { readonly bytes?: unknown }
        | undefined
      if (
        !(row?.bytes instanceof Uint8Array) ||
        row.bytes.byteLength === 0 ||
        row.bytes.byteLength > CAPTURE_EXPORT_STAGE_CHUNK_BYTES
      )
        throw new Error('capture export staging chunk is missing')
      return new Uint8Array(row.bytes)
    },
    discard: async (id) => {
      const db = await open()
      const tx = db.transaction([MANIFEST, PARTS, CHUNKS], 'readwrite')
      const manifests = tx.objectStore(MANIFEST)
      const current = decodeManifest(await request(manifests.get(SLOT)))
      if (id !== undefined && current !== undefined && current.id !== id) {
        await transaction(tx)
        return
      }
      manifests.delete(SLOT)
      tx.objectStore(PARTS).clear()
      tx.objectStore(CHUNKS).clear()
      await transaction(tx)
    },
  }
}

export function makeCaptureExportStaging(
  deps: { store?: CaptureExportStageStore } = {},
): CaptureExportStaging {
  const store = deps.store ?? makeIndexedDbStageStore()
  const lane = makeSerialQueue()
  const discard = (id: string): Promise<void> => lane.run(() => store.discard(id))
  return {
    materializeJsonl: (id, lines, maxPartBytes) =>
      lane.run(async () => {
        if (
          !Number.isSafeInteger(maxPartBytes) ||
          maxPartBytes < 0 ||
          maxPartBytes > MAX_FETCHED_BYTES
        )
          throw new Error('invalid capture export part limit')
        await store.begin(id)
        let part = 0
        let partBytes = 0
        let partHasLine = false
        let stagedLines = 0
        let pending = new Uint8Array(CAPTURE_EXPORT_STAGE_CHUNK_BYTES)
        let pendingBytes = 0
        const flush = async (): Promise<void> => {
          if (pendingBytes === 0) return
          await store.append(id, part, pending.slice(0, pendingBytes))
          pending = new Uint8Array(CAPTURE_EXPORT_STAGE_CHUNK_BYTES)
          pendingBytes = 0
        }
        const write = async (bytes: Uint8Array): Promise<void> => {
          let offset = 0
          // oxlint-disable no-await-in-loop -- durable chunks preserve exact byte order
          while (offset < bytes.byteLength) {
            const count = Math.min(
              bytes.byteLength - offset,
              CAPTURE_EXPORT_STAGE_CHUNK_BYTES - pendingBytes,
            )
            pending.set(bytes.subarray(offset, offset + count), pendingBytes)
            pendingBytes += count
            offset += count
            if (pendingBytes === CAPTURE_EXPORT_STAGE_CHUNK_BYTES) await flush()
          }
          // oxlint-enable no-await-in-loop
        }
        try {
          // oxlint-disable no-await-in-loop -- lines and parts form one ordered durable snapshot
          for await (const line of lines) {
            let lineBytes = 0
            for (const fragment of line()) {
              if (typeof fragment !== 'string')
                throw new Error('invalid capture export line fragment')
              const size = encoder.encode(fragment).byteLength
              if (size > maxPartBytes - lineBytes) {
                await store.discard(id)
                return { kind: 'too-large' as const }
              }
              lineBytes += size
            }
            if (lineBytes === 0) throw new Error('empty capture export JSONL line')
            if (partHasLine && lineBytes > maxPartBytes - partBytes - newline.byteLength) {
              await flush()
              part += 1
              partBytes = 0
              partHasLine = false
            }
            if (partHasLine) await write(newline)
            let written = 0
            for (const fragment of line()) {
              if (typeof fragment !== 'string')
                throw new Error('invalid capture export line fragment')
              const bytes = encoder.encode(fragment)
              if (bytes.byteLength > lineBytes - written)
                throw new Error('capture export line changed while staging')
              written += bytes.byteLength
              await write(bytes)
            }
            if (written !== lineBytes) throw new Error('capture export line changed while staging')
            partBytes += (partHasLine ? newline.byteLength : 0) + lineBytes
            partHasLine = true
            stagedLines += 1
          }
          // oxlint-enable no-await-in-loop
          if (stagedLines === 0) {
            await store.discard(id)
            return { kind: 'empty' as const }
          }
          await flush()
          const partCount = part + 1
          await store.ready(id, partCount)
          return { kind: 'ready' as const, partCount }
        } catch (cause) {
          await store.discard(id).catch(() => undefined)
          throw cause
        }
      }),
    source: (id, part) => {
      let index = 0
      let canceled = false
      return {
        read: async () => {
          if (canceled) return { done: true }
          const chunk = await lane.run(() => store.read(id, part, index))
          if (chunk === undefined) return { done: true }
          index += 1
          return { done: false, value: chunk }
        },
        cancel: async () => {
          canceled = true
        },
      }
    },
    discard,
    discardStale: () => lane.run(() => store.discard()),
  }
}
