import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../core/schema'
import {
  makeBackgroundMessageListener,
  type BackgroundMessageHandlers,
  type BackgroundMessageSender,
} from './message-router'
import type { Readiness } from './readiness'

const ownId = 'extension-id'
const uiSender: BackgroundMessageSender = { id: ownId }
const contentSender: BackgroundMessageSender = {
  id: ownId,
  tab: { id: 7 },
  origin: 'https://x.com',
}
const available: Readiness = { tag: 'available' }
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const item: MediaItem = {
  id: 'media-1',
  platform: 'x',
  postId: '1',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/a.jpg',
  ext: 'jpg',
  index: 0,
}

function makeHarness(
  handlers: BackgroundMessageHandlers,
  waitFor: (
    domain: 'base' | 'fetched' | 'transfer' | 'clear' | 'cloud',
  ) => Promise<Readiness> = async () => available,
) {
  const trace = vi.fn<(stage: string, error: unknown) => void>()
  const warn = vi.fn<(message: string, detail?: unknown) => void>()
  const sendResponse = vi.fn<(reply: unknown) => void>()
  return {
    trace,
    warn,
    sendResponse,
    listener: makeBackgroundMessageListener({ ownId, handlers, waitFor, trace, warn }),
  }
}

describe('background message router', () => {
  it.each([
    {
      _tag: 'QueueUpdate',
      planned: ['media-1'],
      started: ['media-1'],
      deferred: [],
      duplicates: [],
      failures: [],
      skipped: [],
    },
    { _tag: 'TransferOutcome', requestId: 'media-1', outcome: 'complete', at: 1 },
    { _tag: 'SavedStatusUpdate', saved: ['1'] },
  ])('drops a reply or broadcast at worker ingress: $._tag', (message) => {
    const handler = vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true }))
    const h = makeHarness({ MetricsRequest: handler })

    expect(h.listener(message, uiSender, h.sendResponse)).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    expect(h.sendResponse).not.toHaveBeenCalled()
  })

  it.each([
    { _tag: 'SettingsReadRequest' },
    { _tag: 'DailyBudgetReadRequest' },
    { _tag: 'DailyBudgetResetRequest' },
    { _tag: 'ClearLogRequest' },
    { _tag: 'TransferRecoveryRequest', action: 'inspect' },
  ])('rejects excess fields through the exact $._tag decoder', (request) => {
    const handler = vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true }))
    const handlers: BackgroundMessageHandlers = {
      SettingsReadRequest: handler,
      DailyBudgetReadRequest: handler,
      DailyBudgetResetRequest: handler,
      ClearLogRequest: handler,
      TransferRecoveryRequest: handler,
    }
    const h = makeHarness(handlers)

    expect(h.listener({ ...request, extra: true }, uiSender, h.sendResponse)).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    expect(h.sendResponse).not.toHaveBeenCalled()
  })

  it('routes a valid exact request through its business handler', async () => {
    const reply = { _tag: 'SettingsReadSuccess', settings: { sample: true } }
    const handler = vi.fn<() => Promise<typeof reply>>(async () => reply)
    const h = makeHarness({ SettingsReadRequest: handler })

    expect(h.listener({ _tag: 'SettingsReadRequest' }, uiSender, h.sendResponse)).toBe(true)
    await tick()

    expect(handler).toHaveBeenCalledOnce()
    expect(h.sendResponse).toHaveBeenCalledWith(reply)
  })

  it('keeps local history erase available when transfers are unavailable', async () => {
    const erased = vi.fn<() => Promise<{ ok: true }>>(async () => ({ ok: true }))
    const waitFor = vi.fn<
      (domain: 'base' | 'fetched' | 'transfer' | 'clear' | 'cloud') => Promise<Readiness>
    >(async () => available)
    const h = makeHarness({ ClearHistoryRequest: erased }, waitFor)

    expect(h.listener({ _tag: 'ClearHistoryRequest' }, uiSender, h.sendResponse)).toBe(true)
    await tick()

    expect(waitFor).toHaveBeenCalledWith('base')
    expect(erased).toHaveBeenCalledOnce()
    expect(h.sendResponse).toHaveBeenCalledWith({ ok: true })
  })

  it('drops a UI-only request from an otherwise trusted content script', () => {
    const handler = vi.fn<() => Promise<{ cleared: number; epoch: string }>>(async () => ({
      cleared: 1,
      epoch: 'capture:1',
    }))
    const h = makeHarness({ ClearCaptureRequest: handler })

    expect(h.listener({ _tag: 'ClearCaptureRequest' }, contentSender, h.sendResponse)).toBe(false)
    expect(handler).not.toHaveBeenCalled()
    expect(h.sendResponse).not.toHaveBeenCalled()
    expect(h.warn).toHaveBeenCalledOnce()
  })

  it('returns each owner protocol reply when its readiness domain is unavailable', async () => {
    const h = makeHarness(
      {
        DownloadRequest: async () => ({ unexpected: true }),
        ExportCaptureRequest: async () => ({ unexpected: true }),
        SettingsReadRequest: async () => ({ unexpected: true }),
      },
      async (domain) => ({
        tag: 'unavailable',
        failure: 'permanent',
        reason: `${domain} failed`,
      }),
    )

    expect(
      h.listener({ _tag: 'DownloadRequest', items: [item] }, contentSender, h.sendResponse),
    ).toBe(true)
    expect(
      h.listener({ _tag: 'ExportCaptureRequest', kind: 'jsonl' }, uiSender, h.sendResponse),
    ).toBe(true)
    expect(h.listener({ _tag: 'SettingsReadRequest' }, uiSender, h.sendResponse)).toBe(true)
    await tick()

    expect(h.sendResponse).toHaveBeenCalledWith({
      _tag: 'QueueUpdate',
      planned: ['media-1'],
      started: [],
      deferred: [],
      duplicates: [],
      failures: [{ requestId: 'media-1', reason: 'transfer unavailable' }],
      skipped: [],
    })
    expect(h.sendResponse).toHaveBeenCalledWith({ _tag: 'CaptureExportUnavailable' })
    expect(h.sendResponse).toHaveBeenCalledWith({ _tag: 'SettingsReadUnavailable' })
  })

  it('turns an exact handler rejection into its exact unavailable reply', async () => {
    const h = makeHarness({
      DailyBudgetReadRequest: async () => {
        throw new Error('storage failed')
      },
    })

    expect(h.listener({ _tag: 'DailyBudgetReadRequest' }, uiSender, h.sendResponse)).toBe(true)
    await tick()

    expect(h.sendResponse).toHaveBeenCalledWith({ _tag: 'DailyBudgetUnavailable' })
    expect(h.trace).toHaveBeenCalledWith(
      'daily-budget-read-unavailable',
      expect.objectContaining({ message: 'storage failed' }),
    )
  })

  it('resolves a decoded handler rejection with the stable generic failure reply', async () => {
    const h = makeHarness({
      HistoryRequest: async () => {
        throw new Error('history failed')
      },
    })

    expect(h.listener({ _tag: 'HistoryRequest' }, uiSender, h.sendResponse)).toBe(true)
    await tick()

    expect(h.sendResponse).toHaveBeenCalledWith({ ok: false, error: 'handler failed' })
    expect(h.trace).toHaveBeenCalledWith('message-handler-failed', expect.any(Error))
  })

  it('turns an undefined exact reply into its protocol failure', async () => {
    const h = makeHarness({ SettingsReadRequest: async () => undefined })

    expect(h.listener({ _tag: 'SettingsReadRequest' }, uiSender, h.sendResponse)).toBe(true)
    await tick()

    expect(h.sendResponse).toHaveBeenCalledWith({ _tag: 'SettingsReadUnavailable' })
    expect(h.trace).toHaveBeenCalledWith(
      'settings-read-unavailable',
      expect.objectContaining({ message: 'SettingsReadRequest handler returned undefined' }),
    )
  })

  it('turns an undefined decoded reply into the stable generic failure', async () => {
    const h = makeHarness({ HistoryRequest: async () => undefined })

    expect(h.listener({ _tag: 'HistoryRequest' }, uiSender, h.sendResponse)).toBe(true)
    await tick()

    expect(h.sendResponse).toHaveBeenCalledWith({ ok: false, error: 'handler failed' })
    expect(h.trace).toHaveBeenCalledWith(
      'message-handler-failed',
      expect.objectContaining({
        message: 'HistoryRequest: HistoryRequest handler returned undefined',
      }),
    )
  })

  it('dispatches Capture export through the same readiness-aware interface', async () => {
    const reply = { _tag: 'CaptureExportStarted', downloadId: 11 }
    const handler = vi.fn<() => Promise<typeof reply>>(async () => reply)
    const h = makeHarness({ ExportCaptureRequest: handler })

    expect(
      h.listener({ _tag: 'ExportCaptureRequest', kind: 'jsonl' }, uiSender, h.sendResponse),
    ).toBe(true)
    await tick()

    expect(handler).toHaveBeenCalledOnce()
    expect(h.sendResponse).toHaveBeenCalledWith(reply)
  })
})
