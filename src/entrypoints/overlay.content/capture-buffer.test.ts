import { describe, expect, it, vi } from 'vitest'
import { decodeCaptureAcceptedAck, isCaptureAcceptedAck, makeCaptureBuffer } from './capture-buffer'
import type { TweetRecord } from '../../core/capture/record'
import { MAX_CAPTURE_MESSAGE_BYTES, MAX_CAPTURE_RECORD_BYTES } from '../../core/capture/contract'
import { measureJsonBytes } from '../../core/wire/json-budget'
import type { CaptureTweetsResult } from '../../core/schema'

const EPOCH = 'capture:0'

const record = (tweetId: string): TweetRecord => ({
  tweetId,
  conversationId: tweetId,
  author: { handle: 'a' },
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

const jsonBytes = (value: unknown): number =>
  measureJsonBytes(value, Number.MAX_SAFE_INTEGER) ??
  (() => {
    throw new Error('invalid test JSON')
  })()

const captureMessageBytes = (records: ReadonlyArray<TweetRecord>): number =>
  jsonBytes({ _tag: 'CaptureTweets', epoch: EPOCH, records })

const stored = (rows: ReadonlyArray<TweetRecord>, epoch = EPOCH) =>
  Promise.resolve({
    _tag: 'CaptureStored' as const,
    epoch,
    stored: rows.length,
    mirror: 'accepted' as const,
  })

type CaptureSend = (
  rows: ReadonlyArray<TweetRecord>,
  epoch: string,
) => Promise<CaptureTweetsResult | undefined>

const recordWithBytes = (tweetId: string, targetBytes: number): TweetRecord => {
  const base = record(tweetId)
  const padding = targetBytes - jsonBytes(base)
  if (padding < 0) throw new Error('target is smaller than record fixture')
  return { ...base, text: 'x'.repeat(padding) }
}

function clock() {
  const tasks: Array<() => void> = []
  return {
    after: vi.fn<(ms: number, task: () => void) => () => void>((_ms, task) => {
      tasks.push(task)
      return () => undefined
    }),
    run: () => tasks.shift()?.(),
  }
}

describe('capture buffer', () => {
  it.each([
    ['zero batch', { maxBatch: 0 }],
    ['oversized batch', { maxBatch: 65 }],
    ['zero pending capacity', { maxPending: 0 }],
    ['batch beyond pending capacity', { maxBatch: 2, maxPending: 1 }],
  ])('rejects %s constructor bounds', (_name, limits) => {
    expect(() =>
      makeCaptureBuffer({
        epoch: EPOCH,
        send: async () => undefined,
        clock: clock(),
        maxBatch: 2,
        maxPending: 8,
        debounceMs: 1,
        retryBaseMs: 2,
        retryMaxMs: 8,
        ...limits,
      }),
    ).toThrow('capture buffer')
  })

  it('requires an exact stored or discarded acknowledgement', () => {
    expect(
      isCaptureAcceptedAck(
        { _tag: 'CaptureStored', epoch: EPOCH, stored: 2, mirror: 'accepted' },
        2,
      ),
    ).toBe(true)
    expect(
      isCaptureAcceptedAck(
        { _tag: 'CaptureStored', epoch: EPOCH, stored: 2, mirror: 'unavailable' },
        2,
      ),
    ).toBe(true)
    expect(
      decodeCaptureAcceptedAck(
        { _tag: 'CaptureStored', epoch: EPOCH, stored: 2, mirror: 'unavailable' },
        2,
      ),
    ).toEqual({
      _tag: 'CaptureStored',
      epoch: EPOCH,
      stored: 2,
      mirror: 'unavailable',
    })
    expect(isCaptureAcceptedAck({ _tag: 'CaptureDiscarded', epoch: EPOCH, discarded: 2 }, 2)).toBe(
      true,
    )
    expect(
      isCaptureAcceptedAck(
        { _tag: 'CaptureStored', epoch: EPOCH, stored: 1, mirror: 'accepted' },
        2,
      ),
    ).toBe(false)
    expect(isCaptureAcceptedAck({ _tag: 'CaptureStored', epoch: EPOCH, stored: 2 }, 2)).toBe(false)
    expect(
      isCaptureAcceptedAck(
        { _tag: 'CaptureStored', epoch: EPOCH, stored: 2, mirror: 'unknown' },
        2,
      ),
    ).toBe(false)
    expect(
      isCaptureAcceptedAck(
        { _tag: 'CaptureStored', epoch: EPOCH, stored: 2, mirror: 'accepted', extra: true },
        2,
      ),
    ).toBe(false)
    expect(isCaptureAcceptedAck(undefined, 2)).toBe(false)
  })

  it('retains a failed batch, retries it first, and removes it only after its exact ack', async () => {
    const c = clock()
    const send = vi.fn<CaptureSend>()
    send.mockResolvedValueOnce(undefined).mockImplementationOnce(stored)
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send,
      clock: c,
      maxBatch: 2,
      maxPending: 8,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })

    buffer.enqueue([record('1'), record('2'), record('3')])
    c.run()
    await vi.waitFor(() => expect(c.after).toHaveBeenCalledTimes(2))
    expect(buffer.pending).toBe(3)
    c.run()
    await vi.waitFor(() => expect(buffer.pending).toBe(1))
    expect(send.mock.calls.map(([rows]) => rows.map((row) => row.tweetId))).toEqual([
      ['1', '2'],
      ['1', '2'],
    ])
    expect(buffer.pending).toBe(1)
  })

  it('cancels scheduled retries on lifecycle stop', () => {
    const c = clock()
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send: async () => undefined,
      clock: c,
      maxBatch: 2,
      maxPending: 8,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })
    buffer.enqueue([record('1')])
    buffer.stop()
    c.run()
    expect(buffer.pending).toBe(1)
  })

  it('keeps the oldest pending prefix and reports deterministic overflow', () => {
    const c = clock()
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send: async () => undefined,
      clock: c,
      maxBatch: 2,
      maxPending: 3,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })

    expect(buffer.enqueue([record('1'), record('2')])).toEqual({
      tag: 'accepted',
      accepted: 2,
    })
    expect(buffer.enqueue([record('3'), record('4')])).toEqual({
      tag: 'dropped',
      accepted: 1,
      capacityDiscarded: 1,
      invalidDiscarded: 0,
      oversizeDiscarded: 0,
    })
    expect(buffer.pending).toBe(3)
  })

  it('accepts the exact record byte limit, rejects the next byte, and measures UTF-8', () => {
    const c = clock()
    const exact = recordWithBytes('1', MAX_CAPTURE_RECORD_BYTES)
    const tooLarge = recordWithBytes('2', MAX_CAPTURE_RECORD_BYTES + 1)
    const emoji = { ...record('3'), text: '😀漢' }
    expect(jsonBytes(emoji)).toBe(new TextEncoder().encode(JSON.stringify(emoji)).byteLength)
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send: stored,
      clock: c,
      maxBatch: 8,
      maxPending: 8,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })

    expect(buffer.enqueue([exact, tooLarge])).toEqual({
      tag: 'dropped',
      accepted: 1,
      capacityDiscarded: 0,
      invalidDiscarded: 0,
      oversizeDiscarded: 1,
    })
    expect(buffer.pending).toBe(1)
  })

  it('sends 64 small records inside the CaptureTweets message budget', async () => {
    const c = clock()
    const send = vi.fn<CaptureSend>(async (rows, epoch) => {
      expect(rows).toHaveLength(64)
      expect(captureMessageBytes(rows)).toBeLessThanOrEqual(MAX_CAPTURE_MESSAGE_BYTES)
      return stored(rows, epoch)
    })
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send,
      clock: c,
      maxBatch: 64,
      maxPending: 64,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })

    buffer.enqueue(Array.from({ length: 64 }, (_, index) => record(String(index))))
    buffer.flush()
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1)
      expect(buffer.pending).toBe(0)
    })
  })

  it('splits by exact message bytes while retaining FIFO order', async () => {
    const c = clock()
    const first = record('1')
    const second = record('2')
    const third = record('3')
    const maxMessageBytes = captureMessageBytes([first, second])
    const send = vi.fn<CaptureSend>(stored)
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send,
      clock: c,
      maxBatch: 8,
      maxPending: 8,
      maxRecordBytes: 1024,
      maxMessageBytes,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })

    buffer.enqueue([first, second, third])
    buffer.flush()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0]?.[0].map((item) => item.tweetId)).toEqual(['1', '2'])
    expect(captureMessageBytes(send.mock.calls[0]?.[0] ?? [])).toBe(maxMessageBytes)

    await vi.waitFor(() => expect(c.after).toHaveBeenCalledTimes(2))
    buffer.flush()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1]?.[0].map((item) => item.tweetId)).toEqual(['3'])
  })

  it('drops an oversize middle record, then sends later records', async () => {
    const c = clock()
    const first = record('1')
    const later = record('3')
    const maxRecordBytes = jsonBytes(first)
    const oversize = recordWithBytes('2', maxRecordBytes + 1)
    const send = vi.fn<CaptureSend>(stored)
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send,
      clock: c,
      maxBatch: 8,
      maxPending: 8,
      maxRecordBytes,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })

    expect(buffer.enqueue([first, oversize, later])).toEqual({
      tag: 'dropped',
      accepted: 2,
      capacityDiscarded: 0,
      invalidDiscarded: 0,
      oversizeDiscarded: 1,
    })
    buffer.flush()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0]?.[0].map((item) => item.tweetId)).toEqual(['1', '3'])
  })

  it('drops semantic-invalid records and still sends a later valid record', async () => {
    const c = clock()
    const invalidId = { ...record('bad') } as TweetRecord
    const invalidRank = { ...record('2'), sourceRank: 2 } as TweetRecord
    const duplicateMention = {
      ...record('3'),
      mentions: ['a', 'A'],
    } as TweetRecord
    const duplicateLink = {
      ...record('4'),
      links: [{ expandedUrl: 'https://example.test/a' }, { expandedUrl: 'https://example.test/a' }],
    } as TweetRecord
    const duplicateMedia = {
      ...record('5'),
      media: [
        {
          id: 'media-a',
          type: 'photo',
          url: 'https://example.test/a.jpg',
          ext: 'jpg',
          index: 0,
        },
        {
          id: 'media-b',
          type: 'photo',
          url: 'https://example.test/b.jpg',
          ext: 'jpg',
          index: 0,
        },
      ],
    } as TweetRecord
    const send = vi.fn<CaptureSend>(stored)
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send,
      clock: c,
      maxBatch: 8,
      maxPending: 8,
      maxRecordBytes: 1024,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })

    expect(
      buffer.enqueue([
        invalidId,
        invalidRank,
        duplicateMention,
        duplicateLink,
        duplicateMedia,
        record('6'),
      ]),
    ).toEqual({
      tag: 'dropped',
      accepted: 1,
      capacityDiscarded: 0,
      invalidDiscarded: 5,
      oversizeDiscarded: 0,
    })
    buffer.flush()
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    expect(send.mock.calls[0]?.[0].map((item) => item.tweetId)).toEqual(['6'])
    expect(buffer.pending).toBe(0)
  })

  it('retries the identical byte-packed prefix before later records', async () => {
    const c = clock()
    const first = record('1')
    const second = record('2')
    const third = record('3')
    const send = vi.fn<CaptureSend>()
    send.mockResolvedValueOnce(undefined).mockImplementationOnce(stored)
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send,
      clock: c,
      maxBatch: 8,
      maxPending: 8,
      maxRecordBytes: 1024,
      maxMessageBytes: captureMessageBytes([first, second]),
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })

    buffer.enqueue([first, second, third])
    buffer.flush()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(c.after).toHaveBeenCalledTimes(2))
    buffer.flush()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls.map(([rows]) => rows.map((item) => item.tweetId))).toEqual([
      ['1', '2'],
      ['1', '2'],
    ])
  })

  it('holds post-Clear intake until the canonical epoch arrives', async () => {
    const c = clock()
    const send = vi.fn<CaptureSend>(stored)
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send,
      clock: c,
      maxBatch: 2,
      maxPending: 8,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })

    buffer.invalidateEpoch()
    buffer.enqueue([record('1')])
    buffer.flush()
    expect(send).not.toHaveBeenCalled()

    buffer.advanceEpoch('capture:1')
    buffer.flush()
    await vi.waitFor(() => expect(buffer.pending).toBe(0))
    expect(send).toHaveBeenCalledWith([record('1')], 'capture:1')
  })

  it('drops old-epoch pending after a stale receipt without dropping new-epoch work', async () => {
    const c = clock()
    let resolve!: (receipt: {
      readonly _tag: 'CaptureDiscarded'
      readonly epoch: string
      readonly discarded: number
    }) => void
    const firstReply = new Promise<{
      readonly _tag: 'CaptureDiscarded'
      readonly epoch: string
      readonly discarded: number
    }>((done) => {
      resolve = done
    })
    const send = vi
      .fn<CaptureSend>()
      .mockImplementationOnce(async () => firstReply)
      .mockImplementation(stored)
    const buffer = makeCaptureBuffer({
      epoch: EPOCH,
      send,
      clock: c,
      maxBatch: 2,
      maxPending: 8,
      debounceMs: 1,
      retryBaseMs: 2,
      retryMaxMs: 8,
    })

    buffer.enqueue([record('1'), record('2')])
    buffer.flush()
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
    buffer.invalidateEpoch()
    buffer.enqueue([record('3')])
    buffer.advanceEpoch('capture:1')
    resolve({ _tag: 'CaptureDiscarded', epoch: 'capture:1', discarded: 2 })
    await vi.waitFor(() => expect(buffer.pending).toBe(1))

    buffer.flush()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(
      send.mock.calls.map(([rows, epoch]) => [rows.map((row: TweetRecord) => row.tweetId), epoch]),
    ).toEqual([
      [['1', '2'], EPOCH],
      [['3'], 'capture:1'],
    ])
  })
})
