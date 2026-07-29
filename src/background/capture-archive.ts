import type { TweetRecord } from '../core/capture/record'
import type { CaptureEpoch } from '../core/capture/epoch'
import type { CaptureEraseResult, CaptureTweetsResult } from '../core/schema'
import { makeSerialQueue } from '../core/serial-queue'
import type { CaptureDb } from './capture-db'
import type { CaptureMirrorAdmission, CaptureOutbox } from './capture-outbox'
import type { SettingsWriter } from './settings-writer'
import { captureMirrorDestination } from './sync-config'

/** Sole authority for accepting and erasing the durable local Capture Archive. */
export interface CaptureArchive {
  epoch(): Promise<CaptureEpoch>
  accept(epoch: CaptureEpoch, records: ReadonlyArray<TweetRecord>): Promise<CaptureTweetsResult>
  erase(): Promise<CaptureEraseResult>
}

export function makeCaptureArchive(deps: {
  readonly settings: Pick<SettingsWriter, 'withSnapshotTurn'>
  readonly store: Pick<CaptureDb, 'putRecords' | 'clearAndCount'>
  readonly mirror: Pick<CaptureOutbox, 'currentEpoch' | 'enqueueAccepted' | 'purge'>
  readonly now?: () => number
}): CaptureArchive {
  const lane = makeSerialQueue()
  const now = deps.now ?? Date.now

  return {
    epoch: () => lane.run(() => deps.mirror.currentEpoch()),
    accept: (epoch, records) =>
      lane.run(async () => {
        const currentEpoch = await deps.mirror.currentEpoch()
        if (epoch !== currentEpoch)
          return { _tag: 'CaptureDiscarded', epoch: currentEpoch, discarded: records.length }
        const decision = await deps.settings.withSnapshotTurn(async (settings) => {
          if (!settings.captureEnabled) return { accepted: false } as const
          const acceptedAt = now()
          const destination = captureMirrorDestination(settings)
          const mirror: CaptureMirrorAdmission | undefined =
            destination === undefined
              ? undefined
              : {
                  _tag: 'CaptureMirrorAdmission',
                  destination,
                  deviceId: settings.cloudDeviceId,
                  acceptedAt,
                }
          return { accepted: true, mirror } as const
        })
        if (!decision.accepted)
          return { _tag: 'CaptureDiscarded', epoch: currentEpoch, discarded: records.length }

        await deps.store.putRecords(records)
        const mirror =
          decision.mirror === undefined
            ? ('not-requested' as const)
            : await deps.mirror.enqueueAccepted(records, decision.mirror)
        return { _tag: 'CaptureStored', epoch: currentEpoch, stored: records.length, mirror }
      }),
    erase: () =>
      lane.run(async () => {
        // Purge first. A worker death cannot leave erased records queued for a
        // later mirror wake. The same Archive lane blocks a delayed accept.
        const epoch = await deps.mirror.purge()
        return { cleared: await deps.store.clearAndCount(), epoch }
      }),
  }
}
