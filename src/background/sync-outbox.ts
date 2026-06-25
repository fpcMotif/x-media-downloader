import { storage } from 'wxt/utils/storage'
import type { Settings } from '../core/schema'
import type { SyncEvent } from '../core/sync/events'
import {
  append,
  decodeOutbox,
  isReady,
  markDrained,
  markFailed,
  takeBatch,
} from '../core/sync/outbox'
import { convexOriginPattern, makeConvexHttpPort } from '../core/sync/convex'
import { classifySyncError, describeSyncOk, type SyncStatus } from '../core/sync/status'
import { makeSerialQueue, type SerialQueue } from '../core/serial-queue'
import { isSyncConfigured } from './sync-config'

export interface SyncOutbox {
  /** The serialized outbox chain — boot drain + the "sync off" reset push onto it. */
  readonly outboxQueue: SerialQueue
  /** Mirror state transitions when Cloud Sync is on (gated, fire-and-forget). */
  readonly recordSync: (settings: Settings, events: ReadonlyArray<SyncEvent>) => void
  /** Drain FIFO until empty or the first failure; each outcome lands in syncStatus. */
  readonly drainOutbox: (settings: Settings) => Promise<void>
  /** Probe the configured deployment with a real, zero-write recordEvents call. */
  readonly runSyncConnectionTest: (settings: Settings) => Promise<SyncStatus>
  /** Latest drain outcome for the popup (read by SyncStatusRequest). */
  readonly getSyncStatus: () => Promise<SyncStatus | null>
  /** Clear the outbox + status when the user turns Cloud Sync off. */
  readonly clearOutbox: () => void
}

export interface SyncOutboxDeps {
  /** Build the queue's error observer (traces through the background's chain). */
  readonly queueError: (label: string) => (err: unknown) => void
  /** The fetch the Convex port uses (bound for the MV3 SW; see fetch.ts). */
  readonly fetchImpl: typeof fetch
}

export const makeSyncOutbox = (deps: SyncOutboxDeps): SyncOutbox => {
  // Cloud Sync outbox (ADR-0009) — metadata-only events, durable until drained.
  const outboxItem = storage.defineItem<unknown>('local:syncOutbox', { fallback: null })

  // Latest drain outcome, so the popup can show whether sync is actually landing
  // instead of inferring it from the silent "Cloud sync on" footer. Session-scoped
  // (ADR-0005): a diagnostic, not durable state.
  const syncStatusItem = storage.defineItem<SyncStatus | null>('session:syncStatus', {
    fallback: null,
  })

  // Outbox read-modify-writes are serialized through this chain: SW event
  // handlers interleave, and a lost update could drop a drained marker. Re-sent
  // batches are harmless regardless — eventIds are idempotent server-side.
  const outboxQueue = makeSerialQueue(deps.queueError('outbox'))

  /** Drain FIFO until empty or the first failure; backoff state gates retries.
   *  Each outcome is recorded to `syncStatusItem` so a stuck sync is visible in
   *  the popup rather than failing silently into the backoff. */
  const drainOutbox = async (settings: Settings): Promise<void> => {
    const port = makeConvexHttpPort({
      deploymentUrl: settings.convexUrl,
      fetchImpl: deps.fetchImpl,
    })
    // oxlint-disable no-await-in-loop -- FIFO: each batch depends on the previous outcome
    for (;;) {
      const state = decodeOutbox(await outboxItem.getValue())
      if (!isReady(state, Date.now())) return
      const batch = takeBatch(state)
      if (batch.length === 0) return
      try {
        await port.mutation('sync:recordEvents', {
          events: batch,
          secret: settings.convexSyncSecret,
        })
        const next = markDrained(
          state,
          batch.map((e) => e.eventId),
        )
        await outboxItem.setValue(next)
        await syncStatusItem.setValue({
          ok: true,
          detail: describeSyncOk(next.pending.length),
          pending: next.pending.length,
        })
      } catch (err) {
        await outboxItem.setValue(markFailed(state, Date.now()))
        await syncStatusItem.setValue({
          ok: false,
          detail: classifySyncError(err),
          pending: state.pending.length,
        })
        return
      }
    }
    // oxlint-enable no-await-in-loop
  }

  /** Probe the configured deployment with a real, zero-write `recordEvents` call.
   *  An empty batch is accepted only when the URL resolves, the host permission is
   *  granted, and the secret matches — so the result names the exact failure. */
  const runSyncConnectionTest = async (settings: Settings): Promise<SyncStatus> => {
    const pending = decodeOutbox(await outboxItem.getValue()).pending.length
    if (settings.convexUrl === '')
      return { ok: false, detail: 'Enter the Convex deployment URL first.', pending }
    if (settings.convexSyncSecret === '')
      return { ok: false, detail: 'Enter the sync secret first.', pending }
    const pattern = convexOriginPattern(settings.convexUrl)
    if (pattern === null)
      return { ok: false, detail: "That doesn't look like a valid URL.", pending }
    const granted = await browser.permissions.contains({ origins: [pattern] }).catch(() => false)
    if (!granted)
      return { ok: false, detail: 'Grant access to the deployment first (button above).', pending }
    const port = makeConvexHttpPort({
      deploymentUrl: settings.convexUrl,
      fetchImpl: deps.fetchImpl,
    })
    // Persist the verdict through the same chain the drain uses, so a Test press
    // and a concurrent download-driven drain can't clobber each other's status.
    try {
      await port.mutation('sync:recordEvents', { events: [], secret: settings.convexSyncSecret })
      const status: SyncStatus = { ok: true, detail: describeSyncOk(pending), pending }
      outboxQueue.push(() => syncStatusItem.setValue(status))
      return status
    } catch (err) {
      const status: SyncStatus = { ok: false, detail: classifySyncError(err), pending }
      outboxQueue.push(() => syncStatusItem.setValue(status))
      return status
    }
  }

  /** Mirror state transitions when Cloud Sync is on. Fire-and-forget: downloads
   *  never block on — or fail because of — the cloud (ADR-0009). */
  const recordSync = (settings: Settings, events: ReadonlyArray<SyncEvent>): void => {
    if (!isSyncConfigured(settings) || events.length === 0) return
    outboxQueue.push(async () => {
      await outboxItem.setValue(append(decodeOutbox(await outboxItem.getValue()), events))
      await drainOutbox(settings)
    })
  }

  const clearOutbox = (): void => {
    outboxQueue.push(async () => {
      await outboxItem.setValue(null)
      await syncStatusItem.setValue(null)
    })
  }

  return {
    outboxQueue,
    recordSync,
    drainOutbox,
    runSyncConnectionTest,
    getSyncStatus: () => syncStatusItem.getValue(),
    clearOutbox,
  }
}
