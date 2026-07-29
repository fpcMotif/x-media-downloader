import { toWireUploadJob, type UploadJob } from '../core/cloud/upload-job'
import type { Settings } from '../core/schema'
import { isSyncConfigured } from './sync-config'

/** Narrow control-plane port. The byte uploader never needs Convex details. */
export interface UploadJobMirrorTransport {
  mirror(input: {
    readonly deploymentUrl: string
    readonly jobs: ReadonlyArray<ReturnType<typeof toWireUploadJob>>
    readonly secret: string
  }): Promise<unknown>
}

export interface UploadJobMirror {
  /** Read current consent and credentials only after the local outcome is durable. */
  readonly record: (job: UploadJob) => Promise<void>
}

export const makeUploadJobMirror = (deps: {
  readonly getSettings: () => Promise<Settings>
  readonly now: () => number
  readonly transport: UploadJobMirrorTransport
}): UploadJobMirror => ({
  record: async (job) => {
    const settings = await deps.getSettings()
    if (!isSyncConfigured(settings) || settings.cloudDeviceId === '') return
    try {
      await deps.transport.mirror({
        deploymentUrl: settings.convexUrl,
        jobs: [toWireUploadJob(job, settings.cloudDeviceId, deps.now())],
        secret: settings.convexSyncSecret,
      })
    } catch {
      /* control-plane mirror is best-effort; the local ledger is authoritative */
    }
  },
})
