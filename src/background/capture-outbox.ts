/**
 * Durable, separately-consented Capture Mirror outbox. The local Capture
 * Archive is authoritative; this module owns only accepted mirror work,
 * retries, wake recovery, generation fencing, and the Convex mutation.
 */
import { Effect } from 'effect'
import { storage } from 'wxt/utils/storage'
import type { Settings } from '../core/schema'
import { getSettings } from '../core/settings'
import type { TweetRecord } from '../core/capture/record'
import type { CaptureEpoch } from '../core/capture/epoch'
import {
  appendCaptureEvents,
  captureEventFromRecord,
  decodeCaptureOutboxResult,
  emptyCaptureOutbox,
  earliestCaptureAttempt,
  markCaptureBatchDrained,
  markCaptureBatchFailed,
  purgeCaptureOutbox,
  rebaseCaptureRetryDeadlines,
  takeCaptureBatch,
  type CaptureOutboxState,
  type SyncCaptureEvent,
} from '../core/sync/captures'
import { makeFetchServiceLive } from '../core/fetch-service'
import { makeConvexHttpPort } from '../core/sync/convex'
import { makeSerialQueue } from '../core/serial-queue'
import { captureMirrorDestination } from './sync-config'
import type { ConvexPort } from './convex-port'
import {
  defaultDurableWakePort,
  DURABLE_SIDE_EFFECT_WATCHDOG_MS,
  reconcileDurableWake,
  type DurableWakePort,
} from './durable-wake'

export const CAPTURE_OUTBOX_ALARM = 'capture-outbox-drain'

export interface LedgerStorage {
  get(): Promise<unknown>
  set(value: unknown): Promise<void>
}

/** Immutable consent and identity captured in the Archive's Settings turn. */
export interface CaptureMirrorAdmission {
  readonly _tag: 'CaptureMirrorAdmission'
  /** Canonical deployment identity. Credentials stay in current Settings. */
  readonly destination: string
  readonly deviceId: string
  readonly acceptedAt: number
}

export interface CaptureOutbox {
  /** Read the durable erase epoch. Corruption stays unavailable. */
  currentEpoch(): Promise<CaptureEpoch>
  /**
   * Commits accepted mirror events and reconciles their durable wake before
   * resolving. Remote delivery is queued afterward.
   */
  enqueueAccepted(
    records: ReadonlyArray<TweetRecord>,
    admission: CaptureMirrorAdmission,
  ): Promise<'accepted' | 'unavailable'>
  /** Increment the durable erase generation and remove every pending event. */
  purge(): Promise<CaptureEpoch>
  resumeOnBoot(): void
  resumeWhenEnabled(): void
  onWake(): void
  readonly captureAlarm: string
}

export function makeCaptureOutbox(
  deps: {
    getSettings?: () => Promise<Settings>
    ledger?: LedgerStorage
    connect?: (settings: Settings) => ConvexPort
    now?: () => number
    generation?: () => string
    wake?: DurableWakePort
    reportError?: (error: unknown) => void
  } = {},
): CaptureOutbox {
  const readSettings = deps.getSettings ?? getSettings
  const ledger = deps.ledger ?? defaultLedger()
  const connect = deps.connect ?? defaultConnect
  const now = deps.now ?? (() => Date.now())
  const generation = deps.generation ?? (() => crypto.randomUUID())
  const wake = deps.wake ?? defaultDurableWakePort()
  const reportError = deps.reportError ?? ((error: unknown) => console.error(error))
  const queue = makeSerialQueue(reportError)

  const readStrict = async (): Promise<CaptureOutboxState> => {
    const decoded = decodeCaptureOutboxResult(await ledger.get())
    if (decoded.status === 'corrupt') throw new Error('Capture Mirror outbox is corrupt')
    return decoded.state
  }

  const readRetryState = async (at = now()): Promise<CaptureOutboxState> => {
    const state = await readStrict()
    return rebaseCaptureRetryDeadlines(state, at, DURABLE_SIDE_EFFECT_WATCHDOG_MS)
  }

  const scheduleWake = async (strict = false): Promise<void> => {
    const persisted = await readStrict()
    const at = now()
    const state = rebaseCaptureRetryDeadlines(persisted, at, DURABLE_SIDE_EFFECT_WATCHDOG_MS)
    const settings = await readSettings()
    const destination = captureMirrorDestination(settings)
    const first = destination === undefined ? undefined : earliestCaptureAttempt(state, destination)
    const when =
      first === undefined ? undefined : first <= at ? at + DURABLE_SIDE_EFFECT_WATCHDOG_MS : first
    if (state !== persisted && when !== undefined) {
      // A shortened durable deadline must never outrun its alarm. If this MV3
      // worker dies between writes, the earlier alarm already recovers it.
      try {
        await wake.create(CAPTURE_OUTBOX_ALARM, when)
        await ledger.set(state)
      } catch (error) {
        if (strict) throw error
        reportError(error)
      }
      return
    }
    if (strict) {
      if (when === undefined) await wake.clear(CAPTURE_OUTBOX_ALARM)
      else await wake.create(CAPTURE_OUTBOX_ALARM, when)
      return
    }
    await reconcileDurableWake(wake, CAPTURE_OUTBOX_ALARM, when, reportError)
  }

  const drain = async (): Promise<void> => {
    try {
      // oxlint-disable no-await-in-loop -- FIFO; each durable ack follows its mutation
      for (;;) {
        // Consent and destination are live. A long first mutation cannot
        // authorize a later batch after disablement or destination rotation.
        const settings = await readSettings()
        const destination = captureMirrorDestination(settings)
        if (destination === undefined) return
        const at = now()
        const state = await readRetryState(at)
        const batch = takeCaptureBatch(state, destination, at)
        if (batch.length === 0) return
        const batchGeneration = state.generation
        const eventIds = batch.map((item) => item.event.eventId)
        try {
          // No remote side effect starts without a confirmed post-crash wake.
          await wake.create(CAPTURE_OUTBOX_ALARM, at + DURABLE_SIDE_EFFECT_WATCHDOG_MS)
          // Wake I/O may suspend this MV3 worker. Revalidate consent and
          // destination at the irreversible boundary; credentials stay fresh.
          const freshSettings = await readSettings()
          if (captureMirrorDestination(freshSettings) !== destination) return
          const port = connect(freshSettings)
          await port.mutation('captures:recordCaptures', {
            captures: batch.map((item) => toWireCapture(item.event)),
            secret: freshSettings.convexSyncSecret,
          })
        } catch {
          const latest = await readStrict()
          await ledger.set(
            markCaptureBatchFailed(latest, batchGeneration, destination, eventIds, at),
          )
          return
        }
        const latest = await readStrict()
        await ledger.set(markCaptureBatchDrained(latest, batchGeneration, destination, eventIds))
      }
      // oxlint-enable no-await-in-loop
    } finally {
      await scheduleWake()
    }
  }

  const resumePending = async (): Promise<void> => {
    await drain()
  }

  return {
    async enqueueAccepted(records, admission) {
      if (records.length === 0) return 'accepted'
      const events = records.map((record) => captureEventFromRecord(record, admission.deviceId))
      const result = await queue.run(async () => {
        const current = await readStrict()
        const appended = appendCaptureEvents(
          current,
          events,
          admission.destination,
          admission.acceptedAt,
        )
        if (appended.status === 'full') return 'unavailable' as const
        // A new durable row needs a future MV3 wake before it exists. This is
        // strict: an alarm failure leaves the admitted snapshot uncommitted.
        // If the ledger write then fails, this watchdog is merely spurious.
        await wake.create(CAPTURE_OUTBOX_ALARM, now() + DURABLE_SIDE_EFFECT_WATCHDOG_MS)
        await ledger.set(appended.state)
        // Reconcile after persistence: it may shorten/rebase the watchdog or
        // clear it if a later Settings turn withdrew this destination.
        await scheduleWake(true)
        return 'accepted' as const
      })
      // Delivery or capacity recovery starts only after durable admission settles.
      queue.push(resumePending)
      return result
    },
    currentEpoch: () => queue.run(async () => (await readStrict()).generation),
    purge: () =>
      queue.run(async () => {
        const decoded = decodeCaptureOutboxResult(await ledger.get())
        const current = decoded.status === 'available' ? decoded.state : emptyCaptureOutbox
        // Explicit erase may discard corrupt raw state. A fresh opaque epoch
        // cannot collide with work from a damaged or older generation.
        const next = purgeCaptureOutbox(current, generation())
        await ledger.set(next)
        await scheduleWake()
        return next.generation
      }),
    resumeOnBoot() {
      queue.push(resumePending)
    },
    resumeWhenEnabled() {
      queue.push(resumePending)
    },
    onWake() {
      queue.push(resumePending)
    },
    captureAlarm: CAPTURE_OUTBOX_ALARM,
  }
}

const toWireCapture = (
  event: SyncCaptureEvent,
): Omit<SyncCaptureEvent, 'eventId'> & { readonly captureId: string } => {
  const { eventId, ...capture } = event
  return { captureId: eventId, ...capture }
}

function defaultLedger(): LedgerStorage {
  const item = storage.defineItem<unknown>('local:captureOutbox', { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}

function defaultConnect(settings: Settings): ConvexPort {
  const port = makeConvexHttpPort({ deploymentUrl: settings.convexUrl })
  const layer = makeFetchServiceLive(fetch)
  return {
    mutation: (name, args) =>
      Effect.runPromise(
        port.mutation(name, args as Record<string, unknown>).pipe(Effect.provide(layer)),
      ),
  }
}
