/**
 * Opt-in Convex mirror for the local tweet harvest (spec §9). Best-effort and
 * fire-and-forget: the IndexedDB store (capture-db.ts) stays the source of truth,
 * so every control-plane error is swallowed. Parallels the `mirrorUploadJob` flow
 * in cloud-upload.ts and the metadata outbox in sync-outbox.ts — a durable
 * `captureOutboxItem` ledger, drained FIFO through one serialized chain to the
 * `captures:recordCaptures` mutation over the shared Convex HTTP port. The
 * settings source, ledger storage, Convex transport, and clock are injected so the
 * gate and drain are testable without IndexedDB, wxt storage, or the network.
 */
import { storage } from 'wxt/utils/storage'
import type { Settings } from '../core/schema'
import { getSettings } from '../core/settings'
import type { TweetRecord } from '../core/capture/record'
import {
  capLedger,
  captureEventFromRecord,
  claim,
  decodeLedger,
  enqueue,
  readyJobs,
  type SyncCaptureEvent,
} from '../core/sync/captures'
import { makeConvexPromisePort } from '../core/sync/convex'
import { makeSerialQueue } from '../core/serial-queue'
import { isSyncConfigured } from './sync-config'
import type { ConvexPort } from './convex-port'

/** Storage seam for the durable mirror ledger (`local:captureOutbox` by default). */
export interface LedgerStorage {
  get(): Promise<unknown>
  set(value: unknown): Promise<void>
}

export interface CaptureOutbox {
  /** Mirror an accepted harvest batch to the Convex control plane. Gated strictly
   *  on sync being configured AND `captureMirrorEnabled`; sends nothing otherwise.
   *  Fire-and-forget — the `CaptureTweets` reply never blocks on, or fails because
   *  of, the mirror. */
  mirrorCaptures(records: ReadonlyArray<TweetRecord>): void
}

export function makeCaptureOutbox(
  deps: {
    getSettings?: () => Promise<Settings>
    ledger?: LedgerStorage
    connect?: (settings: Settings) => ConvexPort
    fetchImpl?: typeof fetch
    now?: () => number
  } = {},
): CaptureOutbox {
  const readSettings = deps.getSettings ?? getSettings
  const ledger = deps.ledger ?? defaultLedger()
  const connect = deps.connect ?? defaultConnect(deps.fetchImpl ?? fetch)
  const now = deps.now ?? (() => Date.now())

  // Read-modify-writes are serialized through one chain: SW message handlers
  // interleave, and a lost update could drop a drained event. Re-sent events are
  // harmless — `captureId` makes the recordCaptures upsert idempotent server-side.
  const queue = makeSerialQueue()

  /** Drain ready capture events FIFO: send to `captures:recordCaptures` over the
   *  shared port, then drop the drained events. Control-plane errors are swallowed
   *  (best-effort; the local harvest remains authoritative) and stop the pass. */
  const drain = async (settings: Settings): Promise<void> => {
    const port = connect(settings)
    // oxlint-disable no-await-in-loop -- FIFO: each batch depends on the previous outcome
    for (;;) {
      const at = now()
      const decoded = decodeLedger(await ledger.get())
      const batch = readyJobs(decoded, at)
      if (batch.length === 0) return
      try {
        await port.mutation('captures:recordCaptures', {
          captures: batch.map((e) => toWireCapture(e, settings.cloudDeviceId)),
          secret: settings.convexSyncSecret,
        })
      } catch {
        /* control-plane mirror is best-effort; the local IndexedDB harvest is the source of truth */
        return
      }
      let next = decodeLedger(await ledger.get())
      for (const e of batch) next = claim(next, e.eventId, at)
      await ledger.set(capLedger(next))
    }
    // oxlint-enable no-await-in-loop
  }

  return {
    mirrorCaptures(records) {
      // Read settings and gate on the serialized chain (the contract takes no
      // Settings arg) so the gate, enqueue, and drain are ordered against each other.
      queue.push(async () => {
        const settings = await readSettings()
        if (
          !isSyncConfigured(settings) ||
          settings.cloudDeviceId === '' ||
          !settings.captureMirrorEnabled ||
          records.length === 0
        )
          return
        const at = now()
        let decoded = decodeLedger(await ledger.get())
        for (const record of records)
          decoded = enqueue(decoded, captureEventFromRecord(record, settings.cloudDeviceId, at))
        await ledger.set(decoded)
        await drain(settings)
      })
    },
  }
}

/** The wire row `captures:recordCaptures` expects: the queued event re-keyed to
 *  `captureId` with `deviceId` folded in (the ledger event carries neither). */
const toWireCapture = (
  event: SyncCaptureEvent,
  deviceId: string,
): Omit<SyncCaptureEvent, 'eventId'> & { captureId: string; deviceId: string } => {
  const { eventId, ...rest } = event
  return { captureId: eventId, deviceId, ...rest }
}

/** Default ledger: the durable `local:captureOutbox` key, capped on the reducer so
 *  a prolonged offline can't grow it without bound. */
function defaultLedger(): LedgerStorage {
  const item = storage.defineItem<unknown>('local:captureOutbox', { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}

/** Default transport: the shared Promise airlock (core/sync/convex.ts) over the bound
 *  fetch (an unbound fetch is rejected as an illegal invocation in the MV3 SW; see
 *  fetch.ts). */
const defaultConnect =
  (fetchImpl: typeof fetch) =>
  (settings: Settings): ConvexPort =>
    makeConvexPromisePort({ deploymentUrl: settings.convexUrl }, fetchImpl)
