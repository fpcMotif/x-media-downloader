import { Effect, Option } from 'effect'
import { storage } from 'wxt/utils/storage'
import { makeFetchServiceLive } from '../core/fetch-service'
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
import type { ConvexPort } from './convex-port'

/** Durable outbox storage seam (`local:syncOutbox` by default, ADR-0005). */
export interface OutboxStorage {
  get(): Promise<unknown>
  set(value: unknown): Promise<void>
}

/** Ephemeral sync-status storage seam (`session:syncStatus` by default, ADR-0005 —
 *  a diagnostic, not durable state, so it is kept separate from the outbox). */
export interface StatusStore {
  get(): Promise<SyncStatus | null>
  set(value: SyncStatus | null): Promise<void>
}

/** Host-permission probe seam (`browser.permissions.contains` by default). Unlike an
 *  OAuth consent popup this is a queryable check, so the connection test is fully
 *  unit-testable. */
export interface PermissionsPort {
  contains(origins: ReadonlyArray<string>): Promise<boolean>
}

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
  /** The fetch the Convex port uses (bound for the MV3 SW; see fetch.ts). Only
   *  consumed to build the default Convex transport; ignored when `connect` is injected. */
  readonly fetchImpl: typeof fetch
  // Injectable side-effect seams — each defaults to its live binding, so the entrypoint
  // passes none of them; a test passes only the few its path exercises.
  /** The durable outbox store (default: the `local:syncOutbox` wxt item). */
  readonly outbox?: OutboxStorage
  /** The ephemeral status store (default: the `session:syncStatus` wxt item). */
  readonly status?: StatusStore
  /** The Convex transport, built per drain from settings (default: the shared HTTP port). */
  readonly connect?: (settings: Settings) => ConvexPort
  /** The host-permission probe (default: `browser.permissions`). */
  readonly permissions?: PermissionsPort
  /** The clock (default: `Date.now`). Injected so backoff assertions are deterministic. */
  readonly now?: () => number
}

/** The live durable outbox store: the `local:syncOutbox` key (ADR-0005). */
const defaultOutboxStore = (): OutboxStorage => {
  const item = storage.defineItem<unknown>('local:syncOutbox', { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}

/** The live ephemeral status store: the `session:syncStatus` key (ADR-0005). */
const defaultStatusStore = (): StatusStore => {
  const item = storage.defineItem<SyncStatus | null>('session:syncStatus', { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}

/** The live Convex transport: the shared HTTP port over a bound fetch. The port reads
 *  FetchService from R (ADR-0017); the boundary is crossed at this airlock so the drain
 *  loop stays a plain Promise and a tagged error reverts to the rejection classifySyncError
 *  already handles. */
const defaultConnect =
  (fetchImpl: typeof fetch) =>
  (settings: Settings): ConvexPort => {
    const port = makeConvexHttpPort({ deploymentUrl: settings.convexUrl })
    const layer = makeFetchServiceLive(fetchImpl)
    return {
      mutation: (name, args) =>
        Effect.runPromise(
          port.mutation(name, args as Record<string, unknown>).pipe(Effect.provide(layer)),
        ),
    }
  }

/** The live host-permission probe (`browser.permissions`). */
const defaultPermissions = (): PermissionsPort => ({
  contains: (origins) => browser.permissions.contains({ origins: [...origins] }),
})

export const makeSyncOutbox = (deps: SyncOutboxDeps): SyncOutbox => {
  // Resolve each side-effect seam to its live binding unless a test injected one.
  const outbox = deps.outbox ?? defaultOutboxStore()
  const status = deps.status ?? defaultStatusStore()
  const connect = deps.connect ?? defaultConnect(deps.fetchImpl)
  const permissions = deps.permissions ?? defaultPermissions()
  const now = deps.now ?? (() => Date.now())

  // Outbox read-modify-writes are serialized through this chain: SW event
  // handlers interleave, and a lost update could drop a drained marker. Re-sent
  // batches are harmless regardless — eventIds are idempotent server-side.
  const outboxQueue = makeSerialQueue(deps.queueError('outbox'))

  /** Drain FIFO until empty or the first failure; backoff state gates retries.
   *  Each outcome is recorded to the status store so a stuck sync is visible in
   *  the popup rather than failing silently into the backoff. */
  const drainOutbox = async (settings: Settings): Promise<void> => {
    const port = connect(settings)
    // oxlint-disable no-await-in-loop -- FIFO: each batch depends on the previous outcome
    for (;;) {
      const state = decodeOutbox(await outbox.get())
      if (!isReady(state, now())) return
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
        await outbox.set(next)
        await status.set({
          ok: true,
          detail: describeSyncOk(next.pending.length),
          pending: next.pending.length,
        })
      } catch (err) {
        await outbox.set(markFailed(state, now()))
        await status.set({
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
    const pending = decodeOutbox(await outbox.get()).pending.length
    if (settings.convexUrl === '')
      return { ok: false, detail: 'Enter the Convex deployment URL first.', pending }
    if (settings.convexSyncSecret === '')
      return { ok: false, detail: 'Enter the sync secret first.', pending }
    const pattern = convexOriginPattern(settings.convexUrl)
    if (Option.isNone(pattern))
      return { ok: false, detail: "That doesn't look like a valid URL.", pending }
    const granted = await permissions.contains([pattern.value]).catch(() => false)
    if (!granted)
      return { ok: false, detail: 'Grant access to the deployment first (button above).', pending }
    const port = connect(settings)
    // Persist the verdict through the same chain the drain uses, so a Test press
    // and a concurrent download-driven drain can't clobber each other's status.
    try {
      await port.mutation('sync:recordEvents', {
        events: [],
        secret: settings.convexSyncSecret,
      })
      const ok: SyncStatus = { ok: true, detail: describeSyncOk(pending), pending }
      outboxQueue.push(() => status.set(ok))
      return ok
    } catch (err) {
      const failed: SyncStatus = { ok: false, detail: classifySyncError(err), pending }
      outboxQueue.push(() => status.set(failed))
      return failed
    }
  }

  /** Mirror state transitions when Cloud Sync is on. Fire-and-forget: downloads
   *  never block on — or fail because of — the cloud (ADR-0009). */
  const recordSync = (settings: Settings, events: ReadonlyArray<SyncEvent>): void => {
    if (!isSyncConfigured(settings) || events.length === 0) return
    outboxQueue.push(async () => {
      await outbox.set(append(decodeOutbox(await outbox.get()), events))
      await drainOutbox(settings)
    })
  }

  const clearOutbox = (): void => {
    outboxQueue.push(async () => {
      await outbox.set(null)
      await status.set(null)
    })
  }

  return {
    outboxQueue,
    recordSync,
    drainOutbox,
    runSyncConnectionTest,
    getSyncStatus: () => status.get(),
    clearOutbox,
  }
}
