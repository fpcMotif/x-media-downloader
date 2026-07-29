import { Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { Settings as SettingsSchema, type Settings } from '../core/schema'
import {
  makeBackgroundMessageHandlers,
  type BackgroundMessageHandlerDeps,
} from './background-message-handlers'
import type { BackgroundMessageSender } from './message-router'

const settings = Schema.decodeUnknownSync(SettingsSchema)({})
const sender: BackgroundMessageSender = { id: 'extension' }

const depsWith = (overrides: Partial<BackgroundMessageHandlerDeps>): BackgroundMessageHandlerDeps =>
  ({
    ...overrides,
  }) as BackgroundMessageHandlerDeps

describe('makeBackgroundMessageHandlers', () => {
  it('decodes a settings patch and commits it; writer commit publication is centralized', async () => {
    const committed: Settings = { ...settings, downloadBadgeEnabled: false }
    const update = vi.fn<BackgroundMessageHandlerDeps['settingsWriter']['update']>(
      async () => committed,
    )
    const handlers = makeBackgroundMessageHandlers(
      depsWith({
        settingsWriter: { update } as unknown as BackgroundMessageHandlerDeps['settingsWriter'],
        traceBackground: vi.fn<BackgroundMessageHandlerDeps['traceBackground']>(),
      }),
    )

    await expect(
      handlers.SettingsUpdateRequest!(
        {
          _tag: 'SettingsUpdateRequest',
          patch: { downloadBadgeEnabled: false },
        },
        sender,
      ),
    ).resolves.toEqual({
      _tag: 'SettingsUpdateSuccess',
      settings: committed,
    })
    expect(update).toHaveBeenCalledWith({ downloadBadgeEnabled: false })
  })

  it('turns a settings write failure into the exact protocol failure', async () => {
    const traceBackground = vi.fn<BackgroundMessageHandlerDeps['traceBackground']>()
    const handlers = makeBackgroundMessageHandlers(
      depsWith({
        settingsWriter: {
          update: vi.fn<BackgroundMessageHandlerDeps['settingsWriter']['update']>(async () => {
            throw new Error('disk stopped')
          }),
        } as unknown as BackgroundMessageHandlerDeps['settingsWriter'],
        traceBackground,
      }),
    )

    await expect(
      handlers.SettingsUpdateRequest!(
        {
          _tag: 'SettingsUpdateRequest',
          patch: { downloadBadgeEnabled: false },
        },
        sender,
      ),
    ).resolves.toEqual({
      _tag: 'SettingsUpdateFailure',
      reason: 'Settings were not saved.',
    })
    expect(traceBackground).toHaveBeenCalledWith('settings-update-failed', {
      detail: 'disk stopped',
    })
  })

  it('reads the boot-assigned transfer registry lazily', async () => {
    let registry: ReturnType<BackgroundMessageHandlerDeps['registry']>
    const handlers = makeBackgroundMessageHandlers(
      depsWith({
        registry: () => registry,
      }),
    )

    await expect(
      handlers.TransferRecoveryRequest!(
        { _tag: 'TransferRecoveryRequest', action: 'inspect' },
        sender,
      ),
    ).resolves.toEqual({ _tag: 'TransferRecoveryUnavailable' })

    const inspectRecovery = vi.fn<() => Promise<readonly []>>(async () => [])
    const forgetRecovery = vi.fn<(id: string) => Promise<boolean>>(async () => true)
    registry = { inspectRecovery, forgetRecovery }
    await expect(
      handlers.TransferRecoveryRequest!(
        { _tag: 'TransferRecoveryRequest', action: 'forget', id: 'request-1' },
        sender,
      ),
    ).resolves.toEqual({ _tag: 'TransferRecovery', items: [] })
    expect(forgetRecovery).toHaveBeenCalledWith('request-1')
    expect(inspectRecovery).toHaveBeenCalledOnce()
  })

  it('routes the Capture epoch and stamped batch through one Archive authority', async () => {
    const accept = vi.fn<BackgroundMessageHandlerDeps['captureArchive']['accept']>(async () => ({
      _tag: 'CaptureDiscarded' as const,
      epoch: 'capture:0',
      discarded: 1,
    }))
    const handlers = makeBackgroundMessageHandlers(
      depsWith({
        captureArchive: {
          epoch: async () => 'capture:0',
          accept,
          erase: async () => ({ cleared: 0, epoch: 'capture:1' }),
        },
      }),
    )
    const record = {
      tweetId: '1',
      conversationId: '1',
      author: { handle: 'alice' },
      text: 'text',
      rawText: 'text',
      links: [],
      media: [],
      mentions: [],
      hashtags: [],
      source: 'timeline' as const,
      sourceRank: 1 as const,
      capturedAt: 1,
    }

    await expect(
      handlers.CaptureEpochRequest!({ _tag: 'CaptureEpochRequest' }, sender),
    ).resolves.toEqual({ _tag: 'CaptureEpoch', epoch: 'capture:0' })
    await handlers.CaptureTweets!(
      { _tag: 'CaptureTweets', epoch: 'capture:0', records: [record] },
      sender,
    )
    expect(accept).toHaveBeenCalledWith('capture:0', [record])
  })

  it('publishes an epoch-change wake after Clear commits', async () => {
    const erase = vi.fn<BackgroundMessageHandlerDeps['captureArchive']['erase']>(async () => ({
      cleared: 2,
      epoch: 'capture:1',
    }))
    const broadcastCaptureEpochChanged = vi.fn<
      BackgroundMessageHandlerDeps['broadcastCaptureEpochChanged']
    >(async () => {})
    const handlers = makeBackgroundMessageHandlers(
      depsWith({
        captureArchive: {
          erase,
        } as unknown as BackgroundMessageHandlerDeps['captureArchive'],
        broadcastCaptureEpochChanged,
      }),
    )

    await expect(
      handlers.ClearCaptureRequest!({ _tag: 'ClearCaptureRequest' }, sender),
    ).resolves.toEqual({ cleared: 2, epoch: 'capture:1' })
    expect(erase).toHaveBeenCalledOnce()
    expect(broadcastCaptureEpochChanged).toHaveBeenCalledOnce()
  })
})
