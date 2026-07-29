import { Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { projectContentSettings, Settings } from '../schema'
import {
  makeContentSettingsClient,
  type ContentSettingsListener,
  type ContentSettingsRuntime,
  type ContentSettingsSender,
} from './content-client'

const OWN = 'self-extension-id'
const settings = Schema.decodeUnknownSync(Settings)({})
const contentSettings = projectContentSettings(settings)

const makeRuntime = () => {
  let listener: ContentSettingsListener | undefined
  const runtime: ContentSettingsRuntime = {
    ownId: OWN,
    addMessageListener: vi.fn<(next: ContentSettingsListener) => void>((next) => {
      listener = next
    }),
    removeMessageListener: vi.fn<(next: ContentSettingsListener) => void>((next) => {
      if (listener === next) listener = undefined
    }),
  }
  return { runtime, listener: () => listener }
}

describe('ContentSettingsClient.read', () => {
  it('requests and returns only the content-safe worker projection', async () => {
    const send = vi.fn<ContentSettingsSender>(async () => ({
      _tag: 'SettingsReadSuccess',
      settings: { ...contentSettings, quickGrabEnabled: false },
    }))
    const { runtime } = makeRuntime()

    await expect(makeContentSettingsClient(send, runtime).read()).resolves.toMatchObject({
      status: 'available',
      settings: { quickGrabEnabled: false },
    })
    expect(send).toHaveBeenCalledWith({ _tag: 'SettingsReadRequest' })
  })

  it('keeps an explicit worker-unavailable reply unavailable', async () => {
    const { runtime } = makeRuntime()
    await expect(
      makeContentSettingsClient(async () => ({ _tag: 'SettingsReadUnavailable' }), runtime).read(),
    ).resolves.toEqual({ status: 'unavailable', reason: 'worker-unavailable' })
  })

  it('keeps send, stale-context, unclaimed, and malformed replies explicit', async () => {
    const { runtime } = makeRuntime()
    await expect(
      makeContentSettingsClient(async () => Promise.reject(new Error('offline')), runtime).read(),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'send-failed' })
    await expect(
      makeContentSettingsClient(
        async () => Promise.reject(new Error('Extension context invalidated')),
        runtime,
      ).read(),
    ).resolves.toEqual({ status: 'unavailable', reason: 'context-invalidated' })
    await expect(makeContentSettingsClient(async () => undefined, runtime).read()).resolves.toEqual(
      {
        status: 'unavailable',
        reason: 'unclaimed',
      },
    )
    await expect(
      makeContentSettingsClient(
        async () => ({ _tag: 'SettingsReadSuccess', settings: contentSettings, extra: true }),
        runtime,
      ).read(),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed-response' })
    await expect(
      makeContentSettingsClient(
        async () => ({ _tag: 'SettingsReadSuccess', settings }),
        runtime,
      ).read(),
    ).resolves.toMatchObject({ status: 'unavailable', reason: 'malformed-response' })
  })
})

describe('ContentSettingsClient.watch', () => {
  it('accepts exact worker notifications, rejects spoofed or malformed ones, and unwatches', () => {
    const { runtime, listener } = makeRuntime()
    const onChange = vi.fn<(settings: typeof contentSettings) => void>()
    const client = makeContentSettingsClient(
      async () => ({ _tag: 'SettingsReadUnavailable' }),
      runtime,
    )
    const unwatch = client.watch(onChange)
    const receive = listener()
    expect(receive).toBeDefined()

    receive?.({ _tag: 'SettingsChanged', settings: contentSettings }, { id: 'foreign' })
    receive?.({ _tag: 'SettingsChanged', settings: contentSettings }, { id: OWN, tab: { id: 1 } })
    receive?.({ _tag: 'SettingsChanged', settings: contentSettings, extra: true }, { id: OWN })
    receive?.({ _tag: 'SettingsChanged', settings }, { id: OWN })
    receive?.({ _tag: 'SettingsReadSuccess', settings: contentSettings }, { id: OWN })
    expect(onChange).not.toHaveBeenCalled()

    receive?.(
      { _tag: 'SettingsChanged', settings: { ...contentSettings, quickGrabEnabled: false } },
      { id: OWN },
    )
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ quickGrabEnabled: false }))

    unwatch()
    expect(runtime.removeMessageListener).toHaveBeenCalledWith(receive)
    expect(listener()).toBeUndefined()
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})

describe('ContentSettingsClient.start', () => {
  it('treats pushes as canonical-read wakes and ignores older reads', async () => {
    const resolves: Array<(value: unknown) => void> = []
    const send: ContentSettingsSender = () =>
      new Promise((resolve) => {
        resolves.push(resolve)
      })
    const { runtime, listener } = makeRuntime()
    const onChange = vi.fn<(settings: typeof contentSettings) => void>()
    const session = makeContentSettingsClient(send, runtime).start(onChange)

    listener()?.(
      { _tag: 'SettingsChanged', settings: { ...contentSettings, quickGrabEnabled: false } },
      { id: OWN },
    )
    expect(resolves).toHaveLength(2)
    resolves[0]!({
      _tag: 'SettingsReadSuccess',
      settings: { ...contentSettings, quickGrabEnabled: true },
    })
    resolves[1]!({
      _tag: 'SettingsReadSuccess',
      settings: { ...contentSettings, quickGrabEnabled: false },
    })

    await expect(session.initial).resolves.toMatchObject({
      status: 'available',
      settings: { quickGrabEnabled: true },
    })
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledOnce())
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ quickGrabEnabled: false }))

    session.stop()
    expect(listener()).toBeUndefined()
  })

  it('a delayed older push cannot overwrite the latest canonical snapshot', async () => {
    const replies = [
      { ...contentSettings, quickGrabEnabled: true },
      { ...contentSettings, quickGrabEnabled: false },
      { ...contentSettings, quickGrabEnabled: false },
    ]
    const send = vi.fn<ContentSettingsSender>(async () => ({
      _tag: 'SettingsReadSuccess',
      settings: replies.shift()!,
    }))
    const { runtime, listener } = makeRuntime()
    const onChange = vi.fn<(settings: typeof contentSettings) => void>()
    const session = makeContentSettingsClient(send, runtime).start(onChange)
    await session.initial

    listener()?.(
      { _tag: 'SettingsChanged', settings: { ...contentSettings, quickGrabEnabled: false } },
      { id: OWN },
    )
    listener()?.(
      { _tag: 'SettingsChanged', settings: { ...contentSettings, quickGrabEnabled: true } },
      { id: OWN },
    )

    await vi.waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ quickGrabEnabled: false }),
      ),
    )
    session.stop()
  })
})
