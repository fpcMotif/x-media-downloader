import { Effect, Option } from 'effect'
import { storage } from 'wxt/utils/storage'
import { makeFetchServiceLive } from '../core/fetch-service'
import type { Settings } from '../core/schema'
import type { SettingsOwnershipSnapshot } from '../core/settings'
import type { SyncEvent } from '../core/sync/events'
import {
  append,
  decodeOutboxResult,
  isReady,
  markDrained,
  markFailed,
  rebaseRetryDeadline,
  takeBatch,
  type OutboxState,
} from '../core/sync/outbox'
import { convexOriginPattern, makeConvexHttpPort } from '../core/sync/convex'
import {
  classifySyncError,
  decodeSyncStatus,
  describeSyncOk,
  normalizeSyncStatus,
  type SyncStatus,
} from '../core/sync/status'
import { makeSerialQueue, type SerialQueue } from '../core/serial-queue'
import { isSyncConfigured } from './sync-config'
import type { ConvexPort } from './convex-port'
import {
  defaultDurableWakePort,
  DURABLE_SIDE_EFFECT_WATCHDOG_MS,
  reconcileDurableWake,
  type DurableWakePort,
} from './durable-wake'

/** Stable MV3 alarm name; the entrypoint owns its listener. */
export const SYNC_OUTBOX_ALARM = 'sync-outbox-drain'
export const CORRUPT_SYNC_OUTBOX_DETAIL =
  'Local sync queue is corrupt. Sync is paused to preserve unsent events. Turn Cloud Sync off to clear it.'

/** Durable outbox storage seam (`local:syncOutbox` by default, ADR-0005). */
export interface OutboxStorage {
  get(): Promise<unknown>
  set(value: unknown): Promise<void>
}

/** Ephemeral sync-status storage seam (`session:syncStatus` by default, ADR-0005 —
 *  a diagnostic, not durable state, so it is kept separate from the outbox). */
export interface StatusStore {
  get(): Promise<unknown>
  set(value: SyncStatus | null): Promise<void>
}

/** Host-permission probe seam (`browser.permissions.contains` by default). Unlike an
 *  OAuth consent popup this is a queryable check, so the connection test is fully
 *  unit-testable. */
export interface PermissionsPort {
  contains(origins: ReadonlyArray<string>): Promise<boolean>
}

export interface SyncOutbox {
  /** Sole lane for durable outbox mutation and remote side effects. */
  readonly outboxQueue: SerialQueue
  /** Persist mirror state transitions when Cloud Sync is on. Resolves after the
   * durable append + wake, never after the network drain. */
  readonly recordSync: (events: ReadonlyArray<SyncEvent>) => Promise<void>
  /** Drain FIFO until empty or the first failure; each outcome lands in syncStatus. */
  readonly drainOutbox: () => Promise<void>
  /** Probe the configured deployment with a real, zero-write recordEvents call. */
  readonly runSyncConnectionTest: (settings: Settings) => Promise<SyncStatus>
  /** Latest drain outcome for the popup (read by SyncStatusRequest). */
  readonly getSyncStatus: () => Promise<SyncStatus | null>
  /** Fresh-read Settings ownership inside the outbox FIFO. Recovery pauses,
   * available opt-out clears, and available opt-in drains. */
  readonly reconcileSettings: () => Promise<void>
  /** Ordered command from SettingsWriter after an available canonical commit.
   * This is distinct from storage watches, which are wakes and unordered. */
  readonly onSettingsCommitted: (settings: Settings) => void
  /** Re-kick persisted work when {@link SYNC_OUTBOX_ALARM} fires. */
  readonly onWake: () => void
  /** Stable alarm name for the entrypoint listener. */
  readonly syncAlarm: string
}

export interface SyncOutboxDeps {
  /** Build the queue's error observer (traces through the background's chain). */
  readonly queueError: (label: string) => (err: unknown) => void
  /** The fetch the Convex port uses (bound for the MV3 SW; see fetch.ts). Only
   *  consumed to build the default Convex transport; ignored when `connect` is injected. */
  readonly fetchImpl: typeof fetch
  /** Live Settings authority. Every admission and remote batch reads it inside
   * the outbox lane; caller snapshots never grant later consent. */
  readonly getSettings: () => Promise<Settings>
  /** Live desired intent plus availability. Cleanup requires an available,
   * committed opt-out; a fail-safe recovery projection cannot authorize it. */
  readonly getSettingsOwnership: () => Promise<SettingsOwnershipSnapshot>
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
  /** The durable backoff wake-up alarm (default: `browser.alarms`). */
  readonly wake?: DurableWakePort
}

/** The live durable outbox store: the `local:syncOutbox` key (ADR-0005). */
const defaultOutboxStore = (): OutboxStorage => {
  const item = storage.defineItem<unknown>('local:syncOutbox', { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}

/** The live ephemeral status store: the `session:syncStatus` key (ADR-0005). */
const defaultStatusStore = (): StatusStore => {
  const item = storage.defineItem<unknown>('session:syncStatus', { fallback: null })
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

const eventsBelongTo = (settings: Settings, events: ReadonlyArray<SyncEvent>): boolean =>
  events.every((event) => event.deviceId === settings.cloudDeviceId)

/** A connection probe has no authority beyond the exact Settings snapshot that
 * started it. URL, secret, device, and consent all select its remote effect. */
const sameSyncConnection = (left: Settings, right: Settings): boolean =>
  left.cloudSyncEnabled === right.cloudSyncEnabled &&
  left.convexUrl === right.convexUrl &&
  left.convexSyncSecret === right.convexSyncSecret &&
  left.cloudDeviceId === right.cloudDeviceId

export const makeSyncOutbox = (deps: SyncOutboxDeps): SyncOutbox => {
  // Resolve each side-effect seam to its live binding unless a test injected one.
  const outbox = deps.outbox ?? defaultOutboxStore()
  const status = deps.status ?? defaultStatusStore()
  const connect = deps.connect ?? defaultConnect(deps.fetchImpl)
  const permissions = deps.permissions ?? defaultPermissions()
  const now = deps.now ?? (() => Date.now())
  const wake = deps.wake ?? defaultDurableWakePort()
  const reportWakeError = deps.queueError('sync-outbox-wake')

  /** Media Sync requires current consent, destination, credentials, and device
   * identity. SettingsWriter keeps the identity stable while consent is live. */
  const configuredSettings = async (): Promise<Settings | undefined> => {
    const settings = await deps.getSettings()
    return isSyncConfigured(settings) && settings.cloudDeviceId !== '' ? settings : undefined
  }

  // Outbox read-modify-writes are serialized through this chain: SW event
  // handlers interleave, and a lost update could drop a drained marker. Re-sent
  // batches are harmless regardless — eventIds are idempotent server-side.
  const outboxQueue = makeSerialQueue(deps.queueError('outbox'))
  // Storage watches are unordered. An explicit OFF closes this gate before its
  // queued erase can run, so older queued drains cannot send the old generation.
  let admissionClosed = false
  let latestOptOutCommit = 0
  let nextSettingsCommit = 0
  let latestSyncTestIntent = 0

  const isAdmissionOpen = (): boolean => !admissionClosed

  const corruptStatus = (): SyncStatus =>
    normalizeSyncStatus({
      ok: false,
      detail: CORRUPT_SYNC_OUTBOX_DETAIL,
      pending: 0,
    })

  /** Surface corruption, retain the raw bytes, and remove every automatic wake. */
  const pauseCorruptOutbox = async (): Promise<void> => {
    try {
      await status.set(corruptStatus())
    } finally {
      await reconcileDurableWake(wake, SYNC_OUTBOX_ALARM, undefined, reportWakeError)
    }
  }

  /** Durable reads are strict. `undefined` means the raw value was quarantined. */
  const readOutbox = async (): Promise<OutboxState | undefined> => {
    const decoded = decodeOutboxResult(await outbox.get())
    if (decoded.ok) return decoded.state
    await pauseCorruptOutbox()
    return undefined
  }

  /** Rebase before any retry decision and persist before scheduling or sending. */
  const readRetryState = async (): Promise<OutboxState | undefined> => {
    const state = await readOutbox()
    if (state === undefined) return
    const rebased = rebaseRetryDeadline(state, now())
    if (rebased !== state) {
      // A fresh worker can shorten a rollback-rebased deadline after the old
      // alarm was consumed. Do not persist it without a replacement wake.
      try {
        await wake.create(SYNC_OUTBOX_ALARM, now() + DURABLE_SIDE_EFFECT_WATCHDOG_MS)
      } catch (error) {
        reportWakeError(error)
        return
      }
      await outbox.set(rebased)
    }
    return rebased
  }

  /** Schedule the first pending retry, or remove a stale alarm. Ready work gets a
   * future watchdog, not a due-now alarm that can be consumed before I/O settles. */
  const scheduleWake = async (): Promise<void> => {
    if (!isAdmissionOpen()) {
      await reconcileDurableWake(wake, SYNC_OUTBOX_ALARM, undefined, reportWakeError)
      return
    }
    const settings = await configuredSettings()
    if (settings === undefined) {
      await reconcileDurableWake(wake, SYNC_OUTBOX_ALARM, undefined, reportWakeError)
      return
    }
    const state = await readRetryState()
    if (state === undefined) return
    if (!eventsBelongTo(settings, state.pending)) {
      await reconcileDurableWake(wake, SYNC_OUTBOX_ALARM, undefined, reportWakeError)
      return
    }
    const at = now()
    await reconcileDurableWake(
      wake,
      SYNC_OUTBOX_ALARM,
      state.pending.length === 0
        ? undefined
        : state.nextAttemptAt <= at
          ? at + DURABLE_SIDE_EFFECT_WATCHDOG_MS
          : state.nextAttemptAt,
      reportWakeError,
    )
  }

  /** Drain FIFO until empty or the first failure; backoff state gates retries.
   *  Each outcome is recorded to the status store so a stuck sync is visible in
   *  the popup rather than failing silently into the backoff. */
  const drainOwned = async (): Promise<void> => {
    let wakeAlreadyReconciled = false
    try {
      // oxlint-disable no-await-in-loop -- FIFO: each batch depends on the previous outcome
      for (;;) {
        if (!isAdmissionOpen()) return
        // Consent, destination, credentials, and identity are live per batch.
        // A slow first mutation cannot authorize a later one.
        const settings = await configuredSettings()
        if (!isAdmissionOpen() || settings === undefined) return
        const state = await readRetryState()
        if (!isAdmissionOpen() || state === undefined) {
          wakeAlreadyReconciled = true
          return
        }
        if (!isReady(state, now())) return
        const batch = takeBatch(state)
        if (batch.length === 0) return
        if (!eventsBelongTo(settings, batch)) return
        try {
          await wake.create(SYNC_OUTBOX_ALARM, now() + DURABLE_SIDE_EFFECT_WATCHDOG_MS)
        } catch (error) {
          reportWakeError(error)
          return
        }
        // Alarm I/O yields. Recovery or an explicit opt-out may commit while
        // it is pending, so revalidate immediately before the remote call.
        // Keep Settings read failures outside remote-failure bookkeeping.
        const currentSettings = await configuredSettings()
        if (
          !isAdmissionOpen() ||
          currentSettings === undefined ||
          !eventsBelongTo(currentSettings, batch)
        )
          return
        try {
          const port = connect(currentSettings)
          await port.mutation('sync:recordEvents', {
            events: batch,
            secret: currentSettings.convexSyncSecret,
          })
          const next = markDrained(
            state,
            batch.map((e) => e.eventId),
          )
          await outbox.set(next)
          await status.set(
            normalizeSyncStatus({
              ok: true,
              detail: describeSyncOk(next.pending.length),
              pending: next.pending.length,
            }),
          )
        } catch (err) {
          await outbox.set(markFailed(state, now()))
          await status.set(
            normalizeSyncStatus({
              ok: false,
              detail: classifySyncError(err),
              pending: state.pending.length,
            }),
          )
          return
        }
      }
      // oxlint-enable no-await-in-loop
    } finally {
      if (!wakeAlreadyReconciled) await scheduleWake()
    }
  }

  /** Probe the configured deployment with a real, zero-write `recordEvents` call.
   *  An empty batch is accepted only when the URL resolves, the host permission is
   *  granted, and the secret matches — so the result names the exact failure. */
  const runSyncConnectionTest = async (settings: Settings): Promise<SyncStatus> => {
    // Connection tests are independent zero-write probes. Their results are UI
    // diagnostics, so the newest click owns the session projection.
    const intent = ++latestSyncTestIntent
    const state = await readOutbox()
    if (state === undefined) return corruptStatus()
    const pending = state.pending.length
    if (settings.convexUrl === '')
      return normalizeSyncStatus({
        ok: false,
        detail: 'Enter the Convex deployment URL first.',
        pending,
      })
    if (settings.convexSyncSecret === '')
      return normalizeSyncStatus({
        ok: false,
        detail: 'Enter the sync secret first.',
        pending,
      })
    const pattern = convexOriginPattern(settings.convexUrl)
    if (Option.isNone(pattern))
      return normalizeSyncStatus({
        ok: false,
        detail: "That doesn't look like a valid URL.",
        pending,
      })
    const granted = await permissions.contains([pattern.value]).catch(() => false)
    if (!granted)
      return normalizeSyncStatus({
        ok: false,
        detail: 'Grant access to the deployment first (button above).',
        pending,
      })
    // Permission UI can outlive several Settings commits. Re-read before the
    // zero-write remote call so an old URL or secret never crosses the wire.
    const current = await configuredSettings()
    const stale = (): SyncStatus =>
      normalizeSyncStatus({ ok: false, detail: 'Sync settings changed. Try again.', pending })
    if (current === undefined || !sameSyncConnection(current, settings)) return stale()
    const stillCurrent = async (): Promise<boolean> => {
      const latest = await configuredSettings()
      return latest !== undefined && sameSyncConnection(latest, current)
    }
    const publish = (verdict: SyncStatus): void => {
      outboxQueue.push(async () => {
        if (intent !== latestSyncTestIntent || !(await stillCurrent())) return
        await status.set(verdict)
      })
    }
    const port = connect(current)
    // Persist the verdict through the same chain the drain uses, so a Test press
    // and a concurrent download-driven drain can't clobber each other's status.
    try {
      await port.mutation('sync:recordEvents', {
        events: [],
        secret: current.convexSyncSecret,
      })
      const ok = normalizeSyncStatus({ ok: true, detail: describeSyncOk(pending), pending })
      if (!(await stillCurrent())) return stale()
      publish(ok)
      return ok
    } catch (err) {
      const failed = normalizeSyncStatus({
        ok: false,
        detail: classifySyncError(err),
        pending,
      })
      if (!(await stillCurrent())) return stale()
      publish(failed)
      return failed
    }
  }

  /** Persist the event before starting the detached drain. This acknowledgement
   * never waits on Convex, so terminal bookkeeping cannot be held by network
   * latency; the next queue task drains after this append settles. */
  const recordSync = (events: ReadonlyArray<SyncEvent>): Promise<void> => {
    if (events.length === 0) return Promise.resolve()
    return outboxQueue.run(async () => {
      if (!isAdmissionOpen()) return
      const settings = await configuredSettings()
      if (!isAdmissionOpen() || settings === undefined || !eventsBelongTo(settings, events)) return
      const state = await readOutbox()
      if (state === undefined) throw new Error(CORRUPT_SYNC_OUTBOX_DETAIL)
      if (!isAdmissionOpen()) return
      // A persisted event must never be left without a future MV3 wake. Unlike
      // post-commit reconciliation, this arm is strict: alarm failure rejects
      // before the append. A spurious alarm is harmless when no row follows.
      try {
        await wake.create(SYNC_OUTBOX_ALARM, now() + DURABLE_SIDE_EFFECT_WATCHDOG_MS)
      } catch (error) {
        reportWakeError(error)
        throw error
      }
      // Alarm I/O yields. An ordered opt-out may close admission while it waits;
      // do not append an event that its terminal projection has withdrawn.
      const current = await configuredSettings()
      if (!isAdmissionOpen() || current === undefined || !eventsBelongTo(current, events)) return
      await outbox.set(append(state, events))
      await scheduleWake()
      outboxQueue.push(drainOwned)
    })
  }

  const reconcileSettingsOwned = async (): Promise<void> => {
    const ownership = await deps.getSettingsOwnership()
    if (ownership.availability === 'recovery-required') {
      await reconcileDurableWake(wake, SYNC_OUTBOX_ALARM, undefined, reportWakeError)
      return
    }
    if (!ownership.desired.cloudSyncEnabled) {
      try {
        await outbox.set(null)
        await status.set(null)
      } finally {
        await reconcileDurableWake(wake, SYNC_OUTBOX_ALARM, undefined, reportWakeError)
      }
      return
    }
    // Admission completes before remote I/O. The queued drain owns a durable
    // watchdog and boot will reconcile again after worker death.
    outboxQueue.push(drainOwned)
  }

  const reconcileSettings = (): Promise<void> => outboxQueue.run(reconcileSettingsOwned)

  const onSettingsCommitted = (settings: Settings): void => {
    const commit = ++nextSettingsCommit
    if (!settings.cloudSyncEnabled) {
      admissionClosed = true
      latestOptOutCommit = commit
      outboxQueue.push(async () => {
        try {
          await outbox.set(null)
          await status.set(null)
        } finally {
          await reconcileDurableWake(wake, SYNC_OUTBOX_ALARM, undefined, reportWakeError)
        }
      })
      return
    }
    outboxQueue.push(async () => {
      // A later OFF arrived while this ON waited. Its later ON command, if any,
      // alone may reopen admission after that newer erase turn.
      if (latestOptOutCommit >= commit) return
      admissionClosed = false
      await drainOwned()
    })
  }

  const onWake = (): void => {
    outboxQueue.push(drainOwned)
  }

  return {
    outboxQueue,
    recordSync,
    drainOutbox: () => outboxQueue.run(drainOwned),
    runSyncConnectionTest,
    getSyncStatus: async () => decodeSyncStatus(await status.get()) ?? null,
    reconcileSettings,
    onSettingsCommitted,
    onWake,
    syncAlarm: SYNC_OUTBOX_ALARM,
  }
}
