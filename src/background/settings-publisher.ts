import { projectContentSettings, type ContentSettings, type Settings } from '../core/schema'
import { makeSerialQueue } from '../core/serial-queue'

export interface SettingsPublisher {
  readonly publish: (settings: Settings) => Promise<void>
  /** Re-send the current projection even when an earlier broadcast looked successful. */
  readonly replay: (settings: Settings) => Promise<void>
}

/** One ordered lane publishes only changed content-safe projections. */
export const makeSettingsPublisher = (deps: {
  readonly broadcast: (settings: ContentSettings) => Promise<void>
  readonly onError?: (error: unknown) => void
}): SettingsPublisher => {
  const lane = makeSerialQueue(deps.onError)
  let lastPublished: string | undefined
  const enqueue = (settings: Settings, force: boolean): Promise<void> => {
    const projected = projectContentSettings(settings)
    const fingerprint = JSON.stringify(projected)
    return lane.run(async () => {
      if (!force && fingerprint === lastPublished) return
      await deps.broadcast(projected)
      lastPublished = fingerprint
    })
  }
  return {
    publish: (settings) => enqueue(settings, false),
    replay: (settings) => enqueue(settings, true),
  }
}
