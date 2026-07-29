import {
  MAX_FETCHED_BYTES,
  type ByteSource,
  type FetchedBootObservation,
  type FetchedLeaseOwner,
  type FetchedTerminalTransferObservation,
  type FetchedTransferGateway,
} from '../core/download/fetched-transfer-contract'
import { isSafeId, isTransferFilename } from '../core/download/transfer-registry-model'
import { isTransferProjectionId } from '../core/wire/identity'
import { errorReason } from '../core/error'
import {
  OFFSCREEN_BLOB_CHUNK_BYTES,
  OFFSCREEN_BLOB_MAX_LEASES,
  isOffscreenBlobMimeType,
} from '../core/offscreen-blob-protocol'
import { makeSerialQueue } from '../core/serial-queue'
import {
  decodeFetchedBlobLeaseStore,
  FETCHED_BLOB_LEASE_STORE_VERSION,
  isSafeFetchedBlobLeaseKey,
  isValidFetchedBlobLeaseText,
  type FetchedBlobLease,
  type FetchedBlobLeaseStorage,
  type FetchedBlobLeaseStore,
} from './fetched-blob-lease-store'
import { type OffscreenBlobPort } from './offscreen-blob-port'

/** No byte progress for this long means the reader is wedged. */
export const FETCHED_STAGE_IDLE_TIMEOUT_MS = 25_000
/** Slow but live 15 MiB transfers remain valid up to this hard ceiling. */
export const FETCHED_STAGE_MAX_TIMEOUT_MS = 4 * 60_000
export const FETCHED_TERMINAL_CLEANUP_RETRY_MS = 30_000
export { MAX_FETCHED_BYTES, type ByteSource, type FetchedTransferGateway }
const isSafeInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export interface BrowserDownloadPort {
  readonly download: (opts: {
    readonly url: string
    readonly filename: string
    readonly conflictAction: 'uniquify'
    readonly saveAs: false
  }) => Promise<number>
  readonly search: (
    id: number,
  ) => Promise<ReadonlyArray<{ readonly state?: string; readonly exists?: boolean }>>
  /** Exact Blob URL lookup recovers the id after a worker death during activation. */
  readonly searchByUrl: (url: string) => Promise<
    ReadonlyArray<{
      readonly id: number
      readonly state?: string
      readonly exists?: boolean
    }>
  >
}

export const makeBrowserDownloadPort = (): BrowserDownloadPort => ({
  download: (opts) => browser.downloads.download(opts),
  search: (id) => browser.downloads.search({ id }),
  searchByUrl: (url) => browser.downloads.search({ url }),
})

const newLeaseId = (): string => crypto.randomUUID()
const ownerIdentity = (owner: FetchedLeaseOwner): string => JSON.stringify(owner)
const terminal = (row: { readonly state?: string } | undefined): boolean =>
  row?.state === 'complete' || row?.state === 'interrupted'
class TerminalCleanupWakeError extends Error {
  constructor(cause: unknown) {
    super(`terminal cleanup wake unavailable: ${errorReason(cause)}`)
  }
}
const raceAbort = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(new Error('Fetched staging timed out'))
    const abort = () => reject(new Error('Fetched staging timed out'))
    signal.addEventListener('abort', abort, { once: true })
    void work.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
        return undefined
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
        return undefined
      },
    )
  })

type StartResult = Awaited<ReturnType<FetchedTransferGateway['start']>>
type Reservation =
  | {
      readonly tag: 'reserved'
      readonly id: string
      readonly createdAt: number
    }
  | { readonly tag: 'busy' }
  | { readonly tag: 'unavailable' }
  | { readonly tag: 'owner-duplicate' }

const validStartInput = (input: Parameters<FetchedTransferGateway['start']>[0]): boolean =>
  isTransferFilename(input.filename) &&
  (input.owner.tag !== 'capture' || isValidFetchedBlobLeaseText(input.owner.exportId)) &&
  (input.owner.tag !== 'transfer' ||
    (isSafeId(input.owner.requestId) && isTransferProjectionId(input.owner.projectionId)))

/** One short durable lane for lease mutations. Blob I/O never occupies it. */
export function makeFetchedTransferGateway(deps: {
  readonly leases: FetchedBlobLeaseStorage
  readonly offscreen: OffscreenBlobPort
  readonly downloads: BrowserDownloadPort
  readonly now?: () => number
  readonly leaseId?: () => string
  /** Durable retry must exist before autonomous terminal evidence is written. */
  readonly scheduleAutonomousTerminalCleanup: (at: number) => Promise<void>
  readonly trace?: (message: string) => void
}): FetchedTransferGateway {
  const lane = makeSerialQueue((error) => deps.trace?.(`fetched gateway: ${errorReason(error)}`))
  // Blob construction is globally serialized, but its remote I/O must never
  // occupy the durable lease-mutation lane.
  const stagingLane = makeSerialQueue((error) =>
    deps.trace?.(`fetched staging: ${errorReason(error)}`),
  )
  let capacityRevision = 0
  let capacityWaiters = new Set<() => void>()
  const signalCapacityChange = (): void => {
    capacityRevision += 1
    const waiting = capacityWaiters
    capacityWaiters = new Set()
    for (const resolve of waiting) resolve()
  }
  const waitForCapacityChange = (observedRevision: number): Promise<void> => {
    if (capacityRevision !== observedRevision) return Promise.resolve()
    return new Promise((resolve) => capacityWaiters.add(resolve))
  }
  const now = deps.now ?? Date.now
  const timestamp = (floor = 0): number => {
    const value = now()
    if (!isSafeInt(value)) throw new Error('invalid Fetched lease clock')
    return Math.max(value, floor)
  }
  const leaseId = deps.leaseId ?? newLeaseId
  const read = async (): Promise<FetchedBlobLeaseStore> => {
    const decoded = decodeFetchedBlobLeaseStore(await deps.leases.get())
    if (decoded === null) throw new Error('fetched Blob lease store is malformed')
    return decoded
  }
  const write = (store: FetchedBlobLeaseStore): Promise<void> => deps.leases.set(store)
  const change = async (
    mutate: (store: FetchedBlobLeaseStore) => FetchedBlobLeaseStore,
  ): Promise<FetchedBlobLeaseStore> => {
    const next = mutate(await read())
    await write(next)
    return next
  }
  const remove = async (id: string): Promise<FetchedBlobLeaseStore> => {
    const next = await change((store) => {
      const { [id]: _removed, ...leases } = store.leases
      return { version: FETCHED_BLOB_LEASE_STORE_VERSION, leases }
    })
    signalCapacityChange()
    return next
  }
  const closeIfEmpty = async (store: FetchedBlobLeaseStore): Promise<void> => {
    if (Object.keys(store.leases).length === 0 && (await deps.offscreen.isDocumentPresent()))
      await deps.offscreen.closeDocument()
  }
  const removeAndCloseIfEmpty = (id: string): Promise<void> =>
    lane.run(async () => {
      const next = await remove(id)
      await closeIfEmpty(next)
    })
  type TerminalCleanup = 'projector' | 'autonomous' | 'capture'
  const armAutonomousCleanup = async (): Promise<void> => {
    try {
      await deps.scheduleAutonomousTerminalCleanup(timestamp() + FETCHED_TERMINAL_CLEANUP_RETRY_MS)
    } catch (cause) {
      throw new TerminalCleanupWakeError(cause)
    }
  }
  const exactTerminalLease = async (
    downloadId: number,
    accepts: (owner: FetchedLeaseOwner) => boolean,
  ): Promise<FetchedBlobLease | undefined> => {
    const store = await lane.run(read)
    const active = Object.values(store.leases).find(
      (lease): lease is Extract<FetchedBlobLease, { readonly state: 'active' }> =>
        lease.state === 'active' && lease.downloadId === downloadId && accepts(lease.owner),
    )
    if (active !== undefined) return active
    const alreadyTerminal = Object.values(store.leases).find(
      (lease): lease is Extract<FetchedBlobLease, { readonly state: 'terminal' }> =>
        lease.state === 'terminal' && lease.downloadId === downloadId && accepts(lease.owner),
    )
    if (alreadyTerminal !== undefined) return alreadyTerminal
    // The active write may fail after Chrome accepts a download. `ready` was
    // durable before that side effect, so exact URL lookup still proves which
    // terminal handle owns the Blob without retrying the browser download.
    // oxlint-disable no-await-in-loop -- exact URL probes stop at the owning lease
    for (const lease of Object.values(store.leases)) {
      if (lease.state !== 'ready' || !accepts(lease.owner)) continue
      let matches: ReadonlyArray<{
        readonly id: number
        readonly state?: string
        readonly exists?: boolean
      }>
      try {
        matches = await deps.downloads.searchByUrl(lease.objectUrl)
      } catch {
        continue
      }
      if (matches.length === 1 && matches[0]?.id === downloadId) return lease
    }
    // oxlint-enable no-await-in-loop
  }
  const terminalize = async (
    matched: FetchedBlobLease,
    downloadId: number,
    accepts: (owner: FetchedLeaseOwner) => boolean,
    cleanup: TerminalCleanup,
  ): Promise<Extract<FetchedBlobLease, { readonly state: 'terminal' }> | undefined> =>
    lane.run(async () => {
      const store = await read()
      const lease = store.leases[matched.leaseId]
      if (lease?.state === 'terminal' && lease.downloadId === downloadId && accepts(lease.owner)) {
        // The Registry has now proved this lease orphaned or superseded. That
        // durable decision must replace projector ownership before revoke; an
        // alarm retry otherwise skips a worker-death survivor forever.
        if (lease.cleanup !== 'projector' || cleanup !== 'autonomous') return lease
        await armAutonomousCleanup()
        const autonomous = { ...lease, cleanup: 'autonomous' as const }
        await write({
          version: FETCHED_BLOB_LEASE_STORE_VERSION,
          leases: { ...store.leases, [lease.leaseId]: autonomous },
        })
        return autonomous
      }
      if (
        (lease?.state !== 'active' && lease?.state !== 'ready') ||
        !accepts(lease.owner) ||
        (lease.state === 'active' && lease.downloadId !== downloadId)
      )
        return undefined
      // A worker may die after this write. Arm first: the terminal fact never
      // exists without a durable path to retry its autonomous Blob cleanup.
      if (cleanup !== 'projector') await armAutonomousCleanup()
      const next: Extract<FetchedBlobLease, { readonly state: 'terminal' }> = {
        leaseId: lease.leaseId,
        owner: lease.owner,
        state: 'terminal',
        cleanup,
        downloadId,
        createdAt: lease.createdAt,
        terminalAt: timestamp(lease.createdAt),
      }
      await write({
        version: FETCHED_BLOB_LEASE_STORE_VERSION,
        leases: { ...store.leases, [lease.leaseId]: next },
      })
      return next
    })
  const release = async (
    downloadId: number,
    accepts: (owner: FetchedLeaseOwner) => boolean,
    cleanup: TerminalCleanup,
  ): Promise<void> => {
    const matched = await exactTerminalLease(downloadId, accepts)
    if (matched === undefined) return
    const terminalLease = await terminalize(matched, downloadId, accepts, cleanup)
    if (terminalLease === undefined) return
    // Existing terminal evidence may have survived after its prior alarm
    // fired. Re-arm before this fresh cleanup attempt.
    if (
      matched.state === 'terminal' &&
      cleanup !== 'projector' &&
      !(matched.cleanup === 'projector' && cleanup === 'autonomous')
    )
      await armAutonomousCleanup()
    await discardAndRemove(terminalLease.leaseId)
  }
  const discardAndRemove = async (id: string): Promise<void> => {
    if (await deps.offscreen.isDocumentPresent()) await deps.offscreen.discard(id)
    await removeAndCloseIfEmpty(id)
  }
  const persistActivation = async (
    id: string,
    owner: Exclude<FetchedLeaseOwner, { readonly tag: 'legacy-unknown' }>,
    createdAt: number,
    downloadId: number,
    activatedAt: number,
  ): Promise<void> => {
    // `ready` already makes terminal cleanup durable. A failed optional promotion
    // must not wedge this lane, reject into the queue retry, or start Chrome twice.
    try {
      await lane.run(() =>
        change((store) => ({
          version: FETCHED_BLOB_LEASE_STORE_VERSION,
          leases: {
            ...store.leases,
            [id]: {
              leaseId: id,
              owner,
              state: 'active',
              downloadId,
              createdAt,
              activatedAt,
            },
          },
        })),
      )
    } catch (cause) {
      deps.trace?.(`fetched Blob activation deferred: ${errorReason(cause)}`)
    }
  }

  /** Reserves durable capacity before any response byte is read. */
  const reserve = (
    owner: Exclude<FetchedLeaseOwner, { readonly tag: 'legacy-unknown' }>,
  ): Promise<Reservation> =>
    lane.run(async () => {
      let existing: FetchedBlobLeaseStore
      try {
        existing = await read()
      } catch {
        return { tag: 'unavailable' as const }
      }
      if (Object.values(existing.leases).some((lease) => lease.owner.tag === 'legacy-unknown'))
        return { tag: 'unavailable' as const }
      if (
        Object.values(existing.leases).some(
          (lease) => ownerIdentity(lease.owner) === ownerIdentity(owner),
        )
      )
        return { tag: 'owner-duplicate' as const }
      if (Object.keys(existing.leases).length >= OFFSCREEN_BLOB_MAX_LEASES)
        return { tag: 'busy' as const }
      const id = leaseId()
      if (
        !isValidFetchedBlobLeaseText(id) ||
        !isSafeFetchedBlobLeaseKey(id) ||
        Object.hasOwn(existing.leases, id)
      )
        return { tag: 'unavailable' as const }
      const createdAt = timestamp(owner.tag === 'transfer' ? owner.since : 0)
      await change((store) => ({
        version: FETCHED_BLOB_LEASE_STORE_VERSION,
        leases: {
          ...store.leases,
          [id]: {
            leaseId: id,
            owner,
            state: 'building',
            phase: 'reserved',
            createdAt,
          },
        },
      }))
      return { tag: 'reserved' as const, id, createdAt }
    })

  /** Runs after reservation. Slow body, Blob, and Chrome calls never hold the lease lane. */
  const stage = (
    input: Parameters<FetchedTransferGateway['startReserved']>[0],
    reservation: Extract<Reservation, { readonly tag: 'reserved' }>,
  ): Promise<StartResult> =>
    (async () => {
      const { id, createdAt } = reservation
      let browserId: number | undefined
      let begun = false
      let body: ByteSource | undefined
      const controller = new AbortController()
      let idleTimeout: ReturnType<typeof setTimeout> | undefined
      const absoluteTimeout = setTimeout(() => controller.abort(), FETCHED_STAGE_MAX_TIMEOUT_MS)
      const touchProgress = (): void => {
        if (idleTimeout !== undefined) clearTimeout(idleTimeout)
        idleTimeout = setTimeout(() => controller.abort(), FETCHED_STAGE_IDLE_TIMEOUT_MS)
      }
      const cancelBody = async (): Promise<void> => {
        if (body !== undefined) await body.cancel().catch(() => {})
      }
      try {
        const stored = (await lane.run(read)).leases[id]
        if (
          stored?.state !== 'building' ||
          stored.phase !== 'staging' ||
          ownerIdentity(stored.owner) !== ownerIdentity(input.owner)
        )
          throw new Error('fetched Blob reservation is unavailable')
        touchProgress()
        const source = await raceAbort(input.open(controller.signal), controller.signal)
        body = source.body
        touchProgress()
        if (!isOffscreenBlobMimeType(source.mimeType))
          throw new Error('invalid fetched Blob MIME type')
        await deps.offscreen.ensureDocument()
        // A lost begin reply may still have created offscreen state. Cleanup
        // must attempt discard even when the await rejects.
        begun = true
        await deps.offscreen.begin(id, source.mimeType)
        let received = 0
        touchProgress()
        // oxlint-disable no-await-in-loop -- ByteSource and offscreen chunks are ordered
        for (;;) {
          const chunk = await raceAbort(body.read(), controller.signal)
          if (typeof chunk.done !== 'boolean') throw new Error('invalid fetched body chunk')
          if (chunk.done) {
            if (chunk.value !== undefined) throw new Error('invalid fetched body chunk')
            break
          }
          if (!(chunk.value instanceof Uint8Array)) throw new Error('invalid fetched body chunk')
          touchProgress()
          received += chunk.value.byteLength
          if (received > MAX_FETCHED_BYTES) {
            await cancelBody()
            await discardAndRemove(id)
            return { kind: 'too-large' as const }
          }
          for (
            let offset = 0;
            offset < chunk.value.byteLength;
            offset += OFFSCREEN_BLOB_CHUNK_BYTES
          )
            await deps.offscreen.append(
              id,
              chunk.value.slice(offset, offset + OFFSCREEN_BLOB_CHUNK_BYTES),
            )
        }
        // oxlint-enable no-await-in-loop
        const objectUrl = await deps.offscreen.finalize(id)
        // This write is the crash boundary. Boot can match the exact Blob URL to
        // Chrome's DownloadItem if the worker dies before `active` is stored.
        await lane.run(() =>
          change((store) => ({
            version: FETCHED_BLOB_LEASE_STORE_VERSION,
            leases: {
              ...store.leases,
              [id]: {
                leaseId: id,
                owner: input.owner,
                state: 'ready',
                objectUrl,
                createdAt,
                finalizedAt: timestamp(createdAt),
              },
            },
          })),
        )
        try {
          const candidate = await deps.downloads.download({
            url: objectUrl,
            filename: input.filename,
            conflictAction: 'uniquify',
            saveAs: false,
          })
          if (!isSafeInt(candidate)) return { kind: 'handoff-ambiguous' as const }
          browserId = candidate
        } catch {
          // `ready` is already durable. A rejected reply cannot prove Chrome
          // did not accept; retain it and let boot inspect the exact Blob URL.
          return { kind: 'handoff-ambiguous' as const }
        }
        const observedAt = now()
        const activatedAt = isSafeInt(observedAt) ? Math.max(createdAt, observedAt) : createdAt
        await persistActivation(id, input.owner, createdAt, browserId, activatedAt)
        return { kind: 'started' as const, downloadId: browserId }
      } catch (cause) {
        // Any failure before Chrome accepted a handle is safe to tear down. Once
        // accepted, the durable `ready` row remains the cleanup authority; never
        // reject into the queue's save retry or revoke a possibly-live Blob URL.
        if (browserId !== undefined) throw cause
        await cancelBody()
        try {
          if (begun) await discardAndRemove(id)
          else await removeAndCloseIfEmpty(id)
        } catch (cleanupCause) {
          // Keep the durable row when discard failed. Boot can retry it;
          // removing first would create an unowned offscreen Blob.
          deps.trace?.(`fetched Blob cleanup deferred: ${errorReason(cleanupCause)}`)
        }
        throw cause
      } finally {
        clearTimeout(absoluteTimeout)
        if (idleTimeout !== undefined) clearTimeout(idleTimeout)
      }
    })()

  const startReserved: FetchedTransferGateway['startReserved'] = async (input) => {
    if (!validStartInput(input)) return { kind: 'unavailable' as const }
    let reservation: Extract<Reservation, { readonly tag: 'reserved' }> | undefined
    try {
      await lane.run(async () => {
        const store = await read()
        const lease = store.leases[input.leaseId]
        if (
          lease?.state !== 'building' ||
          lease.phase !== 'reserved' ||
          ownerIdentity(lease.owner) !== ownerIdentity(input.owner)
        )
          return
        await write({
          ...store,
          leases: {
            ...store.leases,
            [input.leaseId]: { ...lease, phase: 'staging' },
          },
        })
        reservation = {
          tag: 'reserved',
          id: input.leaseId,
          createdAt: lease.createdAt,
        }
      })
    } catch {
      return { kind: 'unavailable' as const }
    }
    const claimedReservation = reservation
    if (claimedReservation === undefined) return { kind: 'unavailable' as const }
    const result = await stagingLane.run(() => stage(input, claimedReservation))
    return result.kind === 'busy' ? { kind: 'unavailable' as const } : result
  }

  return {
    reserve: async (owner) => {
      if (
        (owner.tag === 'capture' && !isValidFetchedBlobLeaseText(owner.exportId)) ||
        (owner.tag === 'transfer' &&
          (!isSafeId(owner.requestId) || !isTransferProjectionId(owner.projectionId)))
      )
        return { kind: 'unavailable' as const }
      const reservation = await reserve(owner)
      return reservation.tag === 'reserved'
        ? { kind: 'reserved' as const, leaseId: reservation.id }
        : { kind: reservation.tag }
    },
    awaitCaptureReservation: async (owner) => {
      if (!isValidFetchedBlobLeaseText(owner.exportId)) return { kind: 'unavailable' as const }
      // oxlint-disable no-await-in-loop -- each wait observes one serialized capacity revision.
      for (;;) {
        const observedRevision = capacityRevision
        const reservation = await reserve(owner)
        if (reservation.tag === 'reserved')
          return { kind: 'reserved' as const, leaseId: reservation.id }
        if (reservation.tag !== 'busy') return { kind: reservation.tag }
        await waitForCapacityChange(observedRevision)
      }
      // oxlint-enable no-await-in-loop
    },
    startReserved,
    start: async (input) => {
      if (!validStartInput(input)) {
        return { kind: 'unavailable' as const }
      }
      const reservation = await reserve(input.owner)
      return reservation.tag === 'reserved'
        ? startReserved({ ...input, leaseId: reservation.id })
        : { kind: reservation.tag }
    },
    releaseTerminal: (downloadId) =>
      release(downloadId, (owner) => owner.tag === 'transfer', 'projector'),
    releaseCaptureTerminal: (downloadId) =>
      release(downloadId, (owner) => owner.tag === 'capture', 'capture'),
    releaseAutonomousTerminal: (downloadId) =>
      release(downloadId, (owner) => owner.tag === 'transfer', 'autonomous'),
    observeTerminalTransfer: async (downloadId) => {
      const matched = await exactTerminalLease(downloadId, (owner) => owner.tag === 'transfer')
      if (matched === undefined || matched.owner.tag !== 'transfer') return undefined
      return {
        tag: 'matched',
        leaseId: matched.leaseId,
        owner: matched.owner,
        downloadId,
        terminal: true,
      } satisfies FetchedTerminalTransferObservation
    },
    retryAutonomousTerminalCleanup: async () => {
      const store = await lane.run(read)
      // oxlint-disable no-await-in-loop -- each durable discard must finish before document close.
      for (const lease of Object.values(store.leases)) {
        if (lease.state !== 'terminal' || lease.cleanup === 'projector') continue
        // This alarm is one-shot. Re-arm before every attempt so a worker
        // death during revoke cannot strand a terminal Blob lease.
        await armAutonomousCleanup()
        try {
          await discardAndRemove(lease.leaseId)
        } catch (cause) {
          deps.trace?.(`fetched terminal cleanup retry deferred: ${errorReason(cause)}`)
        }
      }
      // oxlint-enable no-await-in-loop
    },
    discardRecoveredStaging: async (leaseIds) => {
      // oxlint-disable no-await-in-loop -- each durable removal must commit before the next
      for (const recoveredLeaseId of leaseIds) {
        const lease = (await lane.run(read)).leases[recoveredLeaseId]
        if (lease?.state !== 'building' || lease.owner.tag !== 'transfer') continue
        await discardAndRemove(recoveredLeaseId)
      }
      // oxlint-enable no-await-in-loop
    },
    inspectOnBoot: async () => {
      let store: FetchedBlobLeaseStore
      try {
        store = await lane.run(read)
      } catch (cause) {
        // A corrupt Fetched-only store must block Fetched starts, but it must
        // not brick Direct/UI/Clear/Capture startup. Leave it untouched so no
        // recovery path can mistake a live Blob lease for disposable state.
        const reason = errorReason(cause)
        deps.trace?.(`fetched Blob boot reconciliation quarantined: ${reason}`)
        return { tag: 'unavailable' as const, reason }
      }
      const observations: FetchedBootObservation[] = []
      // oxlint-disable no-await-in-loop -- one durable lane reconciles leases in order
      for (const lease of Object.values(store.leases)) {
        try {
          if (lease.state === 'building' && lease.owner.tag === 'capture') {
            // `ready` is persisted before handoff, so this phase cannot own a live
            // browser download. It is safe to discard stale staged bytes on boot.
            await discardAndRemove(lease.leaseId)
            continue
          }
          if (lease.state === 'building' && lease.owner.tag === 'transfer') {
            observations.push({
              tag: 'staging',
              leaseId: lease.leaseId,
              owner: lease.owner,
            })
            continue
          }
          if (lease.state === 'ambiguous') {
            observations.push({
              tag: 'unknown',
              leaseId: lease.leaseId,
              reason: 'legacy-owner',
            })
            continue
          }
          if (lease.state === 'terminal') {
            if (lease.cleanup === 'capture' || lease.cleanup === 'autonomous') {
              // Boot is another one-shot attempt. Its retry alarm must exist
              // before offscreen cleanup can run.
              try {
                await armAutonomousCleanup()
              } catch (cause) {
                const reason = errorReason(cause)
                deps.trace?.(`fetched terminal cleanup wake unavailable: ${reason}`)
                return { tag: 'unavailable' as const, reason }
              }
              try {
                await discardAndRemove(lease.leaseId)
              } catch (cause) {
                deps.trace?.(`fetched terminal cleanup retry deferred: ${errorReason(cause)}`)
              }
            } else if (lease.owner.tag === 'transfer')
              observations.push({
                tag: 'matched',
                leaseId: lease.leaseId,
                owner: lease.owner,
                downloadId: lease.downloadId,
                terminal: true,
              })
            continue
          }
          if (lease.state === 'ready') {
            let matches: ReadonlyArray<{
              readonly id: number
              readonly state?: string
              readonly exists?: boolean
            }>
            try {
              matches = await deps.downloads.searchByUrl(lease.objectUrl)
            } catch {
              if (lease.owner.tag === 'transfer')
                observations.push({
                  tag: 'unknown',
                  leaseId: lease.leaseId,
                  reason: 'search-failed',
                })
              continue
            }
            if (matches.length === 0) {
              // `ready` already crossed the Chrome handoff boundary. Absence
              // is ambiguous, so retain Capture bytes until terminal evidence.
              if (lease.owner.tag === 'transfer')
                observations.push({
                  tag: 'unknown',
                  leaseId: lease.leaseId,
                  reason: 'no-url-match',
                })
              continue
            }
            if (matches.length !== 1 || !isSafeInt(matches[0]?.id)) {
              if (lease.owner.tag === 'transfer')
                observations.push({
                  tag: 'unknown',
                  leaseId: lease.leaseId,
                  reason: matches.length === 1 ? 'missing-id' : 'many-url-matches',
                })
              continue
            }
            const match = matches[0]
            // A terminal Chrome row has no live Blob consumer. Release the exact
            // URL-matched lease before attempting the optional active promotion:
            // a failed promotion must not strand its finalized Blob URL.
            if (terminal(match)) {
              if (lease.owner.tag === 'capture')
                await release(match.id, (owner) => owner.tag === 'capture', 'capture')
              else if (lease.owner.tag === 'transfer')
                observations.push({
                  tag: 'matched',
                  leaseId: lease.leaseId,
                  owner: lease.owner,
                  downloadId: match.id,
                  terminal: true,
                  terminalState: match.state === 'complete' ? 'complete' : 'interrupted',
                })
              continue
            }
            if (lease.owner.tag === 'transfer') {
              observations.push({
                tag: 'matched',
                leaseId: lease.leaseId,
                owner: lease.owner,
                downloadId: match.id,
                terminal: false,
              })
              continue
            }
            try {
              await lane.run(() =>
                change((current) => ({
                  version: FETCHED_BLOB_LEASE_STORE_VERSION,
                  leases: {
                    ...current.leases,
                    [lease.leaseId]: {
                      leaseId: lease.leaseId,
                      owner: lease.owner,
                      state: 'active',
                      downloadId: match.id,
                      createdAt: lease.createdAt,
                      activatedAt: timestamp(lease.createdAt),
                    },
                  },
                })),
              )
            } catch (cause) {
              deps.trace?.(`fetched Blob boot activation retry: ${errorReason(cause)}`)
              continue
            }
            continue
          }
          if (lease.state !== 'active') continue
          let row: { readonly state?: string; readonly exists?: boolean } | undefined
          try {
            row = (await deps.downloads.search(lease.downloadId))[0]
          } catch {
            if (lease.owner.tag === 'transfer')
              observations.push({
                tag: 'unknown',
                leaseId: lease.leaseId,
                reason: 'search-failed',
              })
            continue
          }
          if (row === undefined) {
            // A missing row does not prove Capture was never accepted or is
            // safe to revoke. Only an exact terminal row releases its lease.
            if (lease.owner.tag === 'transfer')
              observations.push({
                tag: 'unknown',
                leaseId: lease.leaseId,
                reason: 'no-url-match',
              })
            continue
          }
          if (terminal(row)) {
            if (lease.owner.tag === 'capture')
              await release(lease.downloadId, (owner) => owner.tag === 'capture', 'capture')
            else if (lease.owner.tag === 'transfer')
              observations.push({
                tag: 'matched',
                leaseId: lease.leaseId,
                owner: lease.owner,
                downloadId: lease.downloadId,
                terminal: true,
                terminalState: row.state === 'complete' ? 'complete' : 'interrupted',
              })
          } else if (lease.owner.tag === 'transfer')
            observations.push({
              tag: 'matched',
              leaseId: lease.leaseId,
              owner: lease.owner,
              downloadId: lease.downloadId,
              terminal: false,
            })
        } catch (cause) {
          if (cause instanceof TerminalCleanupWakeError)
            return { tag: 'unavailable' as const, reason: cause.message }
          // One broken lease must not reject global background boot. Durable
          // ownership stays for the next wake when cleanup cannot finish.
          deps.trace?.(`fetched Blob boot lease ${lease.leaseId} deferred: ${errorReason(cause)}`)
        }
      }
      // oxlint-enable no-await-in-loop
      try {
        await lane.run(async () => closeIfEmpty(await read()))
      } catch (cause) {
        deps.trace?.(`fetched Blob boot close deferred: ${errorReason(cause)}`)
      }
      return { tag: 'available' as const, observations }
    },
  }
}
