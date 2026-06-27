/**
 * Opt-in Convex mirror for the local tweet harvest (spec §9). Best-effort and
 * fire-and-forget: the IndexedDB store (capture-db.ts) stays the source of truth,
 * so every control-plane error is swallowed. Parallels the `mirrorUploadJob` flow
 * in cloud-upload.ts and the metadata outbox in sync-outbox.ts — a durable
 * `captureOutboxItem` ledger, drained FIFO through one serialized chain to the
 * `captures:recordCaptures` mutation over the shared Convex HTTP port.
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
import { bindFetch } from '../core/fetch'
import { makeConvexHttpPort } from '../core/sync/convex'
import { makeSerialQueue } from '../core/serial-queue'
import { isSyncConfigured } from './sync-config'

// Durable capture mirror ledger — events queued until drained, capped on the
// ledger reducer so a prolonged offline can't grow it without bound.
const captureOutboxItem = storage.defineItem<unknown>('local:captureOutbox', { fallback: null })

// Read-modify-writes are serialized through one chain: SW message handlers
// interleave, and a lost update could drop a drained event. Re-sent events are
// harmless — `captureId` makes the recordCaptures upsert idempotent server-side.
const captureQueue = makeSerialQueue()

// Bound for the MV3 SW (an unbound fetch is rejected as an illegal invocation;
// see fetch.ts) — the one fetch the capture port uses.
const fetchImpl = bindFetch(fetch)

/** The wire row `captures:recordCaptures` expects: the queued event re-keyed to
 *  `captureId` with `deviceId` folded in (the ledger event carries neither). */
const toWireCapture = (
  event: SyncCaptureEvent,
  deviceId: string,
): Omit<SyncCaptureEvent, 'eventId'> & { captureId: string; deviceId: string } => {
  const { eventId, ...rest } = event
  return { captureId: eventId, deviceId, ...rest }
}

/** Drain ready capture events FIFO: send to `captures:recordCaptures` over the
 *  shared port, then drop the drained events. Control-plane errors are swallowed
 *  (best-effort; the local harvest remains authoritative) and stop the pass. */
const drainCaptures = async (settings: Settings): Promise<void> => {
  const port = makeConvexHttpPort({ deploymentUrl: settings.convexUrl, fetchImpl })
  // oxlint-disable no-await-in-loop -- FIFO: each batch depends on the previous outcome
  for (;;) {
    const now = Date.now()
    const ledger = decodeLedger(await captureOutboxItem.getValue())
    const batch = readyJobs(ledger, now)
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
    let next = decodeLedger(await captureOutboxItem.getValue())
    for (const e of batch) next = claim(next, e.eventId, now)
    await captureOutboxItem.setValue(capLedger(next))
  }
  // oxlint-enable no-await-in-loop
}

/** Mirror an accepted harvest batch to the Convex control plane. Gated strictly
 *  on sync being configured AND `captureMirrorEnabled`; sends nothing otherwise.
 *  Fire-and-forget — the `CaptureTweets` reply never blocks on, or fails because
 *  of, the mirror. */
export function mirrorCaptures(records: ReadonlyArray<TweetRecord>): void {
  // Read settings and gate on the serialized chain (the contract takes no
  // Settings arg) so the gate, enqueue, and drain are ordered against each other.
  captureQueue.push(async () => {
    const settings = await getSettings()
    if (
      !isSyncConfigured(settings) ||
      settings.cloudDeviceId === '' ||
      !settings.captureMirrorEnabled ||
      records.length === 0
    )
      return
    const now = Date.now()
    let ledger = decodeLedger(await captureOutboxItem.getValue())
    for (const record of records)
      ledger = enqueue(ledger, captureEventFromRecord(record, settings.cloudDeviceId, now))
    await captureOutboxItem.setValue(ledger)
    await drainCaptures(settings)
  })
}
