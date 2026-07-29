import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchCaptureSummary,
  requestCaptureExport,
  runCaptureExport,
  type CaptureSummarySender,
} from './capture-export'

const row = {
  conversationId: '1',
  rootHandle: 'alice',
  rootText: 'hello',
  count: 1,
  lastAt: 1,
}

describe('fetchCaptureSummary', () => {
  it('sends the bounded request and returns a decoded summary', async () => {
    const result = await fetchCaptureSummary(3, async (request) => {
      expect(request).toEqual({ _tag: 'CaptureSummaryRequest', limit: 3 })
      return { tweets: 1, conversations: 1, recent: [row] }
    })
    expect(result).toEqual({
      status: 'available',
      summary: { tweets: 1, conversations: 1, recent: [row] },
    })
  })

  it.each([
    undefined,
    null,
    { tweets: 0, conversations: 0, recent: [], extra: true },
    { tweets: -1, conversations: 0, recent: [] },
    { tweets: 0, conversations: Number.POSITIVE_INFINITY, recent: [] },
    { tweets: 0, conversations: 0, recent: [{ ...row, count: -1 }] },
    { tweets: 0, conversations: 0, recent: [{ ...row, extra: true }] },
    { tweets: 1, conversations: 1, recent: [{ ...row, rootText: 'x'.repeat(257) }] },
    { tweets: 1, conversations: 1, recent: [row, { ...row, conversationId: '2' }] },
  ])('returns unavailable for an unclaimed or malformed reply: %o', async (reply) => {
    expect(await fetchCaptureSummary(undefined, async () => reply)).toEqual({
      status: 'unavailable',
    })
  })

  it('does not send an invalid requested limit', async () => {
    const send = vi.fn<CaptureSummarySender>()
    expect(await fetchCaptureSummary(1001, send)).toEqual({ status: 'unavailable' })
    expect(send).not.toHaveBeenCalled()
  })

  it('contains synchronous throws and rejected sends', async () => {
    expect(
      await fetchCaptureSummary(undefined, () => {
        throw new Error('background missing')
      }),
    ).toEqual({ status: 'unavailable' })
    expect(
      await fetchCaptureSummary(undefined, async () => Promise.reject(new Error('storage failed'))),
    ).toEqual({ status: 'unavailable' })
  })
})

describe('requestCaptureExport', () => {
  it('accepts only exact tagged export replies', async () => {
    expect(
      await requestCaptureExport('jsonl', undefined, async () => ({
        _tag: 'CaptureExportStarted',
        filename: 'captures.jsonl',
      })),
    ).toEqual({ _tag: 'CaptureExportStarted', filename: 'captures.jsonl' })
    expect(
      await requestCaptureExport('jsonl', undefined, async () => ({ _tag: 'CaptureExportEmpty' })),
    ).toEqual({ _tag: 'CaptureExportEmpty' })
    expect(
      await requestCaptureExport('jsonl', undefined, async () => ({
        _tag: 'CaptureExportTooLarge',
      })),
    ).toEqual({ _tag: 'CaptureExportTooLarge' })
    expect(
      await requestCaptureExport('jsonl', undefined, async () => ({
        _tag: 'CaptureExportUnavailable',
      })),
    ).toEqual({ _tag: 'CaptureExportUnavailable' })
    expect(
      await requestCaptureExport('jsonl', undefined, async () => ({
        _tag: 'CaptureExportUncertain',
      })),
    ).toEqual({ _tag: 'CaptureExportUncertain' })
    expect(
      await requestCaptureExport('jsonl', undefined, async () => ({ _tag: 'CaptureExportFailed' })),
    ).toEqual({ _tag: 'CaptureExportFailed' })
  })

  it.each([
    undefined,
    { _tag: 'CaptureExportEmpty', extra: true },
    { _tag: 'CaptureExportStarted', filename: '' },
    { _tag: 'CaptureExportStarted', filename: 'capture.jsonl', text: 'tweet' },
  ])('rejects an unclaimed or malformed reply: %o', async (reply) => {
    expect(await requestCaptureExport('jsonl', undefined, async () => reply)).toBeNull()
  })

  it('contains synchronous throws and rejected sends', async () => {
    expect(
      await requestCaptureExport('jsonl', undefined, () => {
        throw new Error('background missing')
      }),
    ).toBeNull()
    expect(
      await requestCaptureExport('jsonl', undefined, async () =>
        Promise.reject(new Error('storage failed')),
      ),
    ).toBeNull()
  })
})

describe('runCaptureExport', () => {
  const originalSendMessage = browser.runtime.sendMessage

  afterEach(() => {
    browser.runtime.sendMessage = originalSendMessage
  })

  it('maps exact outcomes without building a page Blob', async () => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL')
    browser.runtime.sendMessage = (async () => ({
      _tag: 'CaptureExportEmpty',
    })) as typeof browser.runtime.sendMessage
    expect(await runCaptureExport('jsonl')).toEqual({
      ok: false,
      detail: 'Nothing harvested yet — turn on Capture and browse X.',
    })

    browser.runtime.sendMessage = (async () => ({
      _tag: 'CaptureExportTooLarge',
    })) as typeof browser.runtime.sendMessage
    expect(await runCaptureExport('jsonl')).toEqual({
      ok: false,
      detail: 'Export exceeds the 15 MiB limit.',
    })

    browser.runtime.sendMessage = (async () => ({
      _tag: 'CaptureExportUnavailable',
    })) as typeof browser.runtime.sendMessage
    expect(await runCaptureExport('jsonl')).toEqual({
      ok: false,
      detail: 'Export is unavailable. Other archive actions still work.',
    })

    browser.runtime.sendMessage = (async () => ({
      _tag: 'CaptureExportStarted',
      filename: 'captures.jsonl',
    })) as typeof browser.runtime.sendMessage
    expect(await runCaptureExport('jsonl')).toEqual({
      ok: true,
      detail: 'Exported captures.jsonl — check your Downloads folder.',
    })
    expect(createObjectUrl).not.toHaveBeenCalled()
    createObjectUrl.mockRestore()
  })
})
