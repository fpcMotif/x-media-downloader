import { Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { Settings as SettingsSchema, type ContentSettings } from '../core/schema'
import { makeSettingsPublisher } from './settings-publisher'

const settings = Schema.decodeUnknownSync(SettingsSchema)({})

describe('makeSettingsPublisher', () => {
  it('serializes committed projections and skips an unchanged content view', async () => {
    const seen: boolean[] = []
    let releaseFirst!: () => void
    const broadcast = vi.fn<(projection: { readonly quickGrabEnabled: boolean }) => Promise<void>>(
      async (projection) => {
        if (seen.length === 0)
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
        seen.push(projection.quickGrabEnabled)
      },
    )
    const publisher = makeSettingsPublisher({ broadcast })

    const first = publisher.publish({ ...settings, quickGrabEnabled: true })
    const second = publisher.publish({ ...settings, quickGrabEnabled: false })
    await vi.waitFor(() => expect(broadcast).toHaveBeenCalledOnce())
    releaseFirst()
    await Promise.all([first, second])
    await publisher.publish({
      ...settings,
      quickGrabEnabled: false,
      gdriveAccessToken: 'content-invisible-change',
    })

    expect(seen).toEqual([true, false])
    expect(broadcast).toHaveBeenCalledTimes(2)
  })

  it('forces boot replay after an earlier broadcast resolves despite losing a tab', async () => {
    const committed = { ...settings, quickGrabEnabled: false }
    const delivered: ContentSettings[] = []
    let loseFirstTab = true
    const broadcast = vi.fn<(settings: ContentSettings) => Promise<void>>(async (projection) => {
      if (loseFirstTab) {
        loseFirstTab = false
        return
      }
      delivered.push(projection)
    })
    const publisher = makeSettingsPublisher({ broadcast })

    // A tab can disappear between the broadcaster's fan-out and delivery. Its
    // swallowed per-tab failure still lets this normal commit publish resolve.
    await publisher.publish(committed)
    expect(delivered).toEqual([])
    await publisher.replay(committed)

    expect(broadcast).toHaveBeenCalledTimes(2)
    expect(delivered).toEqual([expect.objectContaining({ quickGrabEnabled: false })])
  })
})
