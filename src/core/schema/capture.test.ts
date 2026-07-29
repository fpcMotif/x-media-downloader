import { describe, expect, it } from 'vitest'
import { MAX_CAPTURE_BATCH, MAX_CAPTURE_MESSAGE_BYTES } from '../capture/contract'
import { measureJsonBytes } from '../wire/json-budget'
import {
  MAX_CAPTURE_EXPORT_FILENAME_LENGTH,
  MAX_CAPTURE_EXPORT_RESULT_BYTES,
  MAX_CAPTURE_ERASE_RESULT_BYTES,
  decodeCaptureExportResult,
  decodeCaptureEraseResult,
  decodeCaptureEpochChanged,
  decodeCaptureEpochRequest,
  decodeCaptureEpochResult,
  decodeCaptureSummaryRequest,
  decodeCaptureSummary,
  decodeCaptureTweets,
  decodeCaptureTweetsResult,
  decodeClearCaptureRequest,
  decodeExportCaptureRequest,
} from './capture'

const EPOCH = 'capture:0'

const record = (tweetId: string) => ({
  tweetId,
  conversationId: tweetId,
  author: { handle: 'alice' },
  text: '',
  rawText: '',
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'timeline',
  sourceRank: 1,
  capturedAt: 1,
})

const jsonBytes = (value: unknown): number => {
  const bytes = measureJsonBytes(value, Number.MAX_SAFE_INTEGER)
  if (bytes === undefined) throw new Error('test input must be canonical JSON')
  return bytes
}

/** Pads canonical records instead of allocating a second serialized message. */
const captureMessageAtBytes = (target: number) => {
  const records = Array.from({ length: MAX_CAPTURE_BATCH }, (_, index) => record(`${index + 1}`))
  const message = { _tag: 'CaptureTweets' as const, epoch: EPOCH, records }
  let remaining = target - jsonBytes(message)
  for (const row of records) {
    const padding = Math.min(remaining, 32_768)
    row.text = 'x'.repeat(padding)
    remaining -= padding
  }
  if (remaining !== 0) throw new Error('test fixture cannot reach byte boundary')
  expect(jsonBytes(message)).toBe(target)
  return message
}

describe('capture wire contract', () => {
  it('accepts the exact whole-message limit and rejects the next byte', () => {
    const exact = captureMessageAtBytes(MAX_CAPTURE_MESSAGE_BYTES)
    const oversize = captureMessageAtBytes(MAX_CAPTURE_MESSAGE_BYTES + 1)

    expect(decodeCaptureTweets(exact)?.records).toHaveLength(MAX_CAPTURE_BATCH)
    expect(decodeCaptureTweets(oversize)).toBeUndefined()
  })

  it('rejects hostile non-canonical payloads before Effect decode', () => {
    const message: Record<string, unknown> = { _tag: 'CaptureTweets', epoch: EPOCH }
    Object.defineProperty(message, 'records', {
      enumerable: true,
      get: () => {
        throw new Error('Effect must not read this')
      },
    })

    expect(() => decodeCaptureTweets(message)).not.toThrow()
    expect(decodeCaptureTweets(message)).toBeUndefined()
  })

  it.each([MAX_CAPTURE_BATCH, MAX_CAPTURE_BATCH + 1])(
    'enforces the capture record count: %i',
    (count) => {
      const message = {
        _tag: 'CaptureTweets',
        epoch: EPOCH,
        records: Array.from({ length: count }, (_, index) => record(`${index + 1}`)),
      }
      expect(decodeCaptureTweets(message) === undefined).toBe(count > MAX_CAPTURE_BATCH)
    },
  )

  it.each([
    [{ _tag: 'CaptureStored', epoch: EPOCH, stored: MAX_CAPTURE_BATCH, mirror: 'accepted' }, true],
    [{ _tag: 'CaptureDiscarded', epoch: EPOCH, discarded: MAX_CAPTURE_BATCH }, true],
    [
      {
        _tag: 'CaptureStored',
        epoch: EPOCH,
        stored: MAX_CAPTURE_BATCH + 1,
        mirror: 'not-requested',
      },
      false,
    ],
    [{ _tag: 'CaptureDiscarded', epoch: EPOCH, discarded: MAX_CAPTURE_BATCH + 1 }, false],
    [
      {
        _tag: 'CaptureStored',
        epoch: EPOCH,
        stored: Number.MAX_SAFE_INTEGER + 1,
        mirror: 'unavailable',
      },
      false,
    ],
    [{ _tag: 'CaptureStored', epoch: EPOCH, stored: MAX_CAPTURE_BATCH }, false],
    [{ _tag: 'CaptureStored', epoch: EPOCH, stored: MAX_CAPTURE_BATCH, mirror: 'unknown' }, false],
  ])('bounds capture receipts: %o', (receipt, valid) => {
    expect(decodeCaptureTweetsResult(receipt, MAX_CAPTURE_BATCH) !== undefined).toBe(valid)
  })

  it('requires receipt accounting to match its sent batch', () => {
    expect(
      decodeCaptureTweetsResult(
        { _tag: 'CaptureStored', epoch: EPOCH, stored: 2, mirror: 'accepted' },
        1,
      ),
    ).toBeUndefined()
    expect(
      decodeCaptureTweetsResult({ _tag: 'CaptureDiscarded', epoch: EPOCH, discarded: 2 }, 2),
    ).toEqual({ _tag: 'CaptureDiscarded', epoch: EPOCH, discarded: 2 })
  })

  it('decodes only an exact bounded Capture epoch handshake', () => {
    expect(decodeCaptureEpochRequest({ _tag: 'CaptureEpochRequest' })).toEqual({
      _tag: 'CaptureEpochRequest',
    })
    expect(decodeCaptureEpochResult({ _tag: 'CaptureEpoch', epoch: EPOCH })).toEqual({
      _tag: 'CaptureEpoch',
      epoch: EPOCH,
    })
    expect(decodeCaptureEpochResult({ _tag: 'CaptureEpoch', epoch: 'bad epoch' })).toBeUndefined()
  })

  it('requires an X snowflake for a conversation export', () => {
    expect(
      decodeExportCaptureRequest({
        _tag: 'ExportCaptureRequest',
        kind: 'tree',
        conversationId: '12345678901234567890',
      }),
    ).toBeDefined()
    expect(
      decodeExportCaptureRequest({
        _tag: 'ExportCaptureRequest',
        kind: 'tree',
        conversationId: 'not-an-x-id',
      }),
    ).toBeUndefined()
  })

  it.each([
    { _tag: 'CaptureExportStarted', filename: 'xharvest-20260726.jsonl' },
    { _tag: 'CaptureExportEmpty' },
    { _tag: 'CaptureExportTooLarge' },
    { _tag: 'CaptureExportUnavailable' },
    { _tag: 'CaptureExportUncertain' },
    { _tag: 'CaptureExportFailed' },
  ])('decodes an exact export result: %o', (result) => {
    expect(decodeCaptureExportResult(result)).toEqual(result)
  })

  it('rejects excess and oversized export results', () => {
    expect(decodeCaptureExportResult({ _tag: 'CaptureExportEmpty', extra: true })).toBeUndefined()
    expect(
      decodeCaptureExportResult({
        _tag: 'CaptureExportStarted',
        filename: 'x'.repeat(MAX_CAPTURE_EXPORT_FILENAME_LENGTH + 1),
      }),
    ).toBeUndefined()
    expect(
      decodeCaptureExportResult({
        _tag: 'CaptureExportStarted',
        filename: 'x'.repeat(MAX_CAPTURE_EXPORT_RESULT_BYTES),
      }),
    ).toBeUndefined()
  })

  it('rejects hostile export results without invoking accessors or proxy traps', () => {
    let filenameRead = false
    const accessor: Record<string, unknown> = { _tag: 'CaptureExportStarted' }
    Object.defineProperty(accessor, 'filename', {
      enumerable: true,
      get: () => {
        filenameRead = true
        throw new Error('must not run')
      },
    })
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('must be contained')
        },
      },
    )

    expect(() => decodeCaptureExportResult(accessor)).not.toThrow()
    expect(decodeCaptureExportResult(accessor)).toBeUndefined()
    expect(filenameRead).toBe(false)
    expect(() => decodeCaptureExportResult(proxy)).not.toThrow()
    expect(decodeCaptureExportResult(proxy)).toBeUndefined()
  })

  it('decodes only an exact, bounded archive erase acknowledgement', () => {
    expect(decodeCaptureEraseResult({ cleared: 4, epoch: EPOCH })).toEqual({
      cleared: 4,
      epoch: EPOCH,
    })
    expect(decodeCaptureEraseResult({ cleared: 4, epoch: EPOCH, extra: true })).toBeUndefined()
    expect(decodeCaptureEraseResult({ cleared: -1, epoch: EPOCH })).toBeUndefined()
    expect(
      decodeCaptureEraseResult({
        cleared: 4,
        epoch: EPOCH,
        padding: 'x'.repeat(MAX_CAPTURE_ERASE_RESULT_BYTES),
      }),
    ).toBeUndefined()
  })

  it('decodes only the exact epoch-change wake', () => {
    expect(decodeCaptureEpochChanged({ _tag: 'CaptureEpochChanged' })).toEqual({
      _tag: 'CaptureEpochChanged',
    })
    expect(decodeCaptureEpochChanged({ _tag: 'CaptureEpochChanged', epoch: EPOCH })).toBeUndefined()
  })

  it('accepts only an exact, requested subset summary', () => {
    const summary = {
      tweets: 2,
      conversations: 2,
      recent: [
        { conversationId: '2', rootHandle: 'alice', rootText: 'new', count: 1, lastAt: 2 },
        { conversationId: '1', rootHandle: 'bob', rootText: 'old', count: 1, lastAt: 1 },
      ],
    }
    expect(decodeCaptureSummary(summary, 2)).toEqual(summary)
    expect(decodeCaptureSummary(summary, 1)).toBeUndefined()
    expect(
      decodeCaptureSummary({ ...summary, recent: [summary.recent[0], summary.recent[0]] }, 2),
    ).toBeUndefined()
  })

  it('rejects extra keys on every capture wire shape', () => {
    expect(
      decodeCaptureTweets({
        _tag: 'CaptureTweets',
        epoch: EPOCH,
        records: [record('1')],
        extra: true,
      }),
    ).toBeUndefined()
    expect(
      decodeCaptureTweets({
        _tag: 'CaptureTweets',
        epoch: EPOCH,
        records: [{ ...record('1'), extra: true }],
      }),
    ).toBeUndefined()
    expect(
      decodeCaptureTweetsResult(
        { _tag: 'CaptureStored', epoch: EPOCH, stored: 1, mirror: 'accepted', extra: true },
        1,
      ),
    ).toBeUndefined()
    expect(
      decodeCaptureSummaryRequest({ _tag: 'CaptureSummaryRequest', limit: 1, extra: true }),
    ).toBeUndefined()
    expect(
      decodeExportCaptureRequest({ _tag: 'ExportCaptureRequest', kind: 'jsonl', extra: true }),
    ).toBeUndefined()
    expect(decodeClearCaptureRequest({ _tag: 'ClearCaptureRequest', extra: true })).toBeUndefined()
  })
})
