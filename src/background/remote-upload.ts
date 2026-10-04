import { Effect, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import type { Settings } from '@/packages/schema'
import { ConvexFunctionError, makeConvexHttpPort } from '@/packages/sync/convex'
import { makeFetchServiceLive } from '@/packages/kernel/fetch-service'
import { makeSerialQueue } from '@/packages/kernel/serial-queue'
import type { DurableStore } from '@/packages/kernel/durable-store'
import { guessMime } from '@/packages/cloud/types'
import type { UploadSummary } from '@/packages/cloud/upload-job'
import { localDay } from '@/packages/download/daily-budget'
import type { CloudHistoryNotice, UploadCandidate } from '@/packages/cloud/execution'

const Receipt = Schema.Struct({
  mediaId: Schema.String,
  deviceId: Schema.String,
  deploymentUrl: Schema.String,
  syncSecret: Schema.optional(Schema.String),
  budgetDay: Schema.optional(Schema.String),
  sourceUrl: Schema.String,
  path: Schema.String,
  contentType: Schema.String,
  accepted: Schema.Boolean,
  estimatedBytes: Schema.optional(Schema.Number),
  historyOutcome: Schema.optional(Schema.Literals(['queued', 'completed', 'failed'])),
})
const Receipts = Schema.Array(Receipt)
type Receipt = typeof Receipt.Type
const Acceptance = Schema.Struct({ id: Schema.String, created: Schema.Boolean })
const Setup = Schema.Struct({ available: Schema.Boolean, reason: Schema.NullOr(Schema.String) })
const Status = Schema.Array(
  Schema.Struct({
    mediaId: Schema.String,
    status: Schema.Literals(['queued', 'uploading', 'completed', 'failed']),
    at: Schema.Number,
  }),
)

export interface RelaySetup {
  readonly available: boolean
  readonly reason: string | null
}
export interface RemoteUploadPort {
  record(settings: Settings, items: ReadonlyArray<UploadCandidate>): Promise<ReadonlyArray<string>>
  owns(mediaId: string): Promise<boolean>
  summary(): Promise<UploadSummary>
  budget(day: string): Promise<{ bytes: number; count: number }>
  reconcile(): Promise<void>
  setup(): Promise<RelaySetup>
  probe(url: string): Promise<number | null>
  control(enabled: boolean, accepting: boolean, connected: boolean): Promise<void>
  disconnect(): Promise<void>
  retry(): Promise<void>
}

function deploymentOrigin(raw: string): string {
  const url = new URL(raw)
  if (
    url.protocol !== 'https:' ||
    !url.hostname.endsWith('.convex.cloud') ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error('Configure a valid Convex deployment URL')
  return url.origin
}

export function makeRemoteUpload(deps: {
  readonly getSettings: () => Promise<Settings>
  readonly fetchImpl: typeof fetch
  readonly onHistoryNotice: (notice: CloudHistoryNotice) => void | Promise<void>
  readonly store?: DurableStore
}): RemoteUploadPort {
  const item = storage.defineItem<unknown>('local:convexDriveReceipts', { fallback: null })
  const store: DurableStore = deps.store ?? {
    get: () => item.getValue(),
    set: (value) => item.setValue(value),
  }
  const queue = makeSerialQueue(() => {})
  const read = async (): Promise<ReadonlyArray<Receipt>> => {
    const raw = await store.get()
    return raw === null ? [] : Schema.decodeUnknownSync(Receipts)(raw)
  }
  const patchReceipt = async (mediaId: string, patch: Partial<Receipt>): Promise<void> => {
    const rows = await read()
    const index = rows.findIndex((row) => row.mediaId === mediaId)
    const previous = rows[index]
    if (!previous) throw new Error('Missing durable server receipt')
    const next = rows.slice()
    next[index] = { ...previous, ...patch }
    await store.set(next)
  }
  const http = makeFetchServiceLive(deps.fetchImpl)
  const call = async (
    settings: Settings,
    endpoint: 'mutation' | 'query' | 'action',
    path: string,
    args: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>,
    deploymentUrl = settings.convexUrl,
    syncSecret = settings.convexSyncSecret,
  ) => {
    const origin = deploymentOrigin(deploymentUrl)
    const currentOrigin = URL.canParse(settings.convexUrl)
      ? new URL(settings.convexUrl).origin
      : null
    const secret = currentOrigin === origin ? settings.convexSyncSecret : syncSecret
    if (!secret) throw new Error('Configure the Convex sync secret')
    const port = makeConvexHttpPort({ deploymentUrl: origin })
    return await Effect.runPromise(
      port[endpoint](path, { ...args, secret }).pipe(Effect.provide(http)),
    )
  }
  const setup = async (): Promise<RelaySetup> => {
    const settings = await deps.getSettings()
    if (!settings.convexUrl || !settings.convexSyncSecret)
      return { available: false, reason: 'Configure the Convex deployment and sync secret first.' }
    try {
      return Schema.decodeUnknownSync(Setup)(await call(settings, 'query', 'relay:setup', {}))
    } catch {
      return {
        available: false,
        reason: 'Relay setup is unavailable. Check deployment, permission, and sync secret.',
      }
    }
  }
  const control = async (
    enabled: boolean,
    accepting: boolean,
    connected: boolean,
  ): Promise<void> => {
    const settings = await deps.getSettings()
    if (connected && !settings.convexDriveConnected) {
      const readiness = await setup()
      if (!readiness.available) throw new Error(readiness.reason ?? 'Relay unavailable')
    }
    await call(settings, 'mutation', 'relay:control', { enabled, accepting, connected })
  }
  const submit = async (
    settings: Settings,
    receipt: Receipt,
    releaseOnRejection = false,
  ): Promise<boolean> => {
    try {
      const result = Schema.decodeUnknownSync(Acceptance)(
        await call(
          settings,
          'mutation',
          'relay:submit',
          {
            mediaId: receipt.mediaId,
            deviceId: receipt.deviceId,
            sourceUrl: receipt.sourceUrl,
            path: receipt.path,
            contentType: receipt.contentType,
            budgetDay: receipt.budgetDay ?? localDay(Date.now()),
            estimatedBytes: receipt.estimatedBytes ?? 0,
          },
          receipt.deploymentUrl,
          receipt.syncSecret,
        ),
      )
      if (!result.id) throw new Error('Missing durable acceptance identity')
      await patchReceipt(receipt.mediaId, { accepted: true })
      return result.created
    } catch (error) {
      if (releaseOnRejection && error instanceof ConvexFunctionError)
        await store.set((await read()).filter((row) => row.mediaId !== receipt.mediaId))
      throw error
    }
  }
  const record = (settings: Settings, items: ReadonlyArray<UploadCandidate>) =>
    queue.run(async () => {
      if (settings.saveToDisk || !settings.convexDriveEnabled)
        throw new Error('Convex uploads require the Cloud-only experiment')
      if (
        !settings.cloudUploadEnabled ||
        !settings.gdriveUploadEnabled ||
        !settings.convexDriveConnected
      )
        throw new Error('The backend Drive destination is disabled, paused, or disconnected')
      if (settings.dropboxUploadEnabled && settings.dropboxRefreshToken)
        throw new Error('Disable Dropbox uploads before selecting the Drive-only experiment')
      if (!settings.cloudDeviceId)
        throw new Error('Configure a device identity before submitting remote jobs')
      const origin = deploymentOrigin(settings.convexUrl)
      if (!settings.convexSyncSecret) throw new Error('Configure the Convex sync secret')
      const accepted: string[] = []
      const submitNext = async (index: number): Promise<void> => {
        const candidate = items[index]
        if (!candidate) return
        if (
          !candidate.estimatedBytes ||
          !Number.isSafeInteger(candidate.estimatedBytes) ||
          candidate.estimatedBytes <= 0
        )
          throw new Error('Remote source size is unavailable; no job was submitted')
        const rows = await read()
        const existing = rows.find((row) => row.mediaId === candidate.item.id)
        const receipt: Receipt = existing ?? {
          mediaId: candidate.item.id,
          deviceId: settings.cloudDeviceId,
          deploymentUrl: origin,
          syncSecret: settings.convexSyncSecret,
          budgetDay: localDay(Date.now()),
          sourceUrl: candidate.item.url,
          path: candidate.filename,
          contentType: guessMime(candidate.item.ext),
          accepted: false,
          ...(candidate.estimatedBytes === undefined
            ? {}
            : { estimatedBytes: candidate.estimatedBytes }),
        }
        if (!existing) await store.set([...rows, receipt])
        if (!receipt.accepted && (await submit(settings, receipt, !existing)))
          accepted.push(receipt.mediaId)
        await submitNext(index + 1)
      }
      await submitNext(0)
      return accepted
    })
  const reconcile = () =>
    queue.run(async () => {
      const settings = await deps.getSettings()
      const rows = (await read()).filter((row) => row.historyOutcome !== 'completed')
      const reconcileNext = async (index: number): Promise<void> => {
        const row = rows[index]
        if (!row) return
        const statuses = Schema.decodeUnknownSync(Status)(
          await call(
            settings,
            'query',
            'relay:status',
            { deviceId: row.deviceId, mediaIds: [row.mediaId] },
            row.deploymentUrl,
            row.syncSecret,
          ),
        )
        const status = statuses[0]
        const kind = status?.status === 'uploading' ? 'queued' : status?.status
        if (status && kind && row.historyOutcome !== kind && row.historyOutcome !== 'completed') {
          await deps.onHistoryNotice({ mediaId: row.mediaId, kind, at: status.at })
          await patchReceipt(row.mediaId, { accepted: true, historyOutcome: kind })
        }
        await reconcileNext(index + 1)
      }
      await reconcileNext(0)
    })
  const disconnect = async (): Promise<void> => {
    const settings = await deps.getSettings()
    if (!settings.convexDriveConnected) return
    await call(settings, 'mutation', 'relay:control', {
      enabled: false,
      accepting: false,
      connected: false,
    })
  }
  const retry = () =>
    queue.run(async () => {
      const settings = await deps.getSettings()
      const rows = (await read()).filter((row) => !row.accepted || row.historyOutcome === 'failed')
      const retryNext = async (index: number): Promise<void> => {
        const row = rows[index]
        if (!row) return
        if (!row.accepted) await submit(settings, row)
        await call(
          settings,
          'mutation',
          'relay:retry',
          { deviceId: row.deviceId, mediaId: row.mediaId },
          row.deploymentUrl,
          row.syncSecret,
        )
        await retryNext(index + 1)
      }
      await retryNext(0)
    })
  const summary = async (): Promise<UploadSummary> => {
    const rows = await read()
    return {
      succeeded: rows.filter((row) => row.historyOutcome === 'completed').length,
      dead: rows.filter((row) => row.historyOutcome === 'failed').length,
      failed: rows.filter((row) => !row.accepted && row.historyOutcome !== 'failed').length,
      pending: rows.filter(
        (row) =>
          row.accepted && (row.historyOutcome === undefined || row.historyOutcome === 'queued'),
      ).length,
      uploading: 0,
      skipped: 0,
    }
  }
  const budget = async (day: string): Promise<{ bytes: number; count: number }> => {
    const settings = await deps.getSettings()
    const rows = await read()
    if (!settings.convexDriveEnabled || settings.saveToDisk)
      return rows
        .filter((row) => row.budgetDay === day)
        .reduce(
          (total, row) => ({
            bytes: total.bytes + (row.estimatedBytes ?? 0),
            count: total.count + 1,
          }),
          { bytes: 0, count: 0 },
        )
    const origins = new Map<
      string,
      { deploymentUrl: string; deviceId: string; syncSecret: string }
    >()
    for (const row of rows)
      origins.set(`${row.deploymentUrl}:${row.deviceId}`, {
        deploymentUrl: row.deploymentUrl,
        deviceId: row.deviceId,
        syncSecret: row.syncSecret ?? settings.convexSyncSecret,
      })
    if (settings.convexDriveConnected) {
      const origin = deploymentOrigin(settings.convexUrl)
      origins.set(`${origin}:${settings.cloudDeviceId}`, {
        deploymentUrl: origin,
        deviceId: settings.cloudDeviceId,
        syncSecret: settings.convexSyncSecret,
      })
    }
    const totals = await Promise.all(
      [...origins.values()].map(async ({ deviceId, deploymentUrl, syncSecret }) => {
        const result = await call(
          settings,
          'query',
          'relay:budget',
          { deviceId, day },
          deploymentUrl,
          syncSecret,
        )
        return Schema.decodeUnknownSync(
          Schema.Struct({ bytes: Schema.Number, count: Schema.Number }),
        )(result)
      }),
    )
    return totals.reduce(
      (total, current) => ({
        bytes: total.bytes + current.bytes,
        count: total.count + current.count,
      }),
      { bytes: 0, count: 0 },
    )
  }
  const probe = async (url: string): Promise<number | null> => {
    const settings = await deps.getSettings()
    const result = await call(settings, 'action', 'relayWorker:probe', { sourceUrl: url })
    return Schema.decodeUnknownSync(Schema.NullOr(Schema.Number))(result)
  }
  return {
    budget,
    summary,
    probe,
    control,
    record,
    owns: async (mediaId) => (await read()).some((row) => row.mediaId === mediaId),
    reconcile,
    setup,
    disconnect,
    retry,
  }
}
