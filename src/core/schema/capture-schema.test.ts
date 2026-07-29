import { describe, it, expect } from 'vitest'
import { Schema } from 'effect'
import {
  Settings,
  BackgroundRequest,
  CaptureEpochRequest,
  CaptureEpochResult,
  CaptureTweets,
  CaptureTweetsResult,
  CaptureSummaryRequest,
  ExportCaptureRequest,
  ClearCaptureRequest,
} from './index'

const EPOCH = 'capture:0'

const validRecord = {
  tweetId: '123',
  conversationId: '123',
  author: { handle: 'alice' },
  text: 'hello',
  rawText: 'hello',
  metrics: {},
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'timeline',
  sourceRank: 1,
  capturedAt: 1700000000000,
}

describe('Capture settings defaults', () => {
  it('defaults the three capture flags off when absent', () => {
    const s = Schema.decodeUnknownSync(Settings)({})
    expect(s.captureEnabled).toBe(false)
    expect(s.captureAllScrolled).toBe(false)
    expect(s.captureMirrorEnabled).toBe(false)
  })
})

describe('Capture messages', () => {
  it('decodes CaptureTweets via its tagged shape and BackgroundRequest', () => {
    const raw = { _tag: 'CaptureTweets', epoch: EPOCH, records: [validRecord] }
    const direct = Schema.decodeUnknownSync(CaptureTweets)(raw)
    expect(direct._tag).toBe('CaptureTweets')
    expect(direct.records).toHaveLength(1)

    const msg = Schema.decodeUnknownSync(BackgroundRequest)(raw)
    expect(msg._tag).toBe('CaptureTweets')
  })

  it.each([0, 65])('rejects CaptureTweets batches outside 1..64: %i', (count) => {
    const raw = {
      _tag: 'CaptureTweets',
      epoch: EPOCH,
      records: Array.from({ length: count }, () => validRecord),
    }
    expect(() => Schema.decodeUnknownSync(CaptureTweets)(raw)).toThrow('records')
    expect(() => Schema.decodeUnknownSync(BackgroundRequest)(raw)).toThrow('records')
  })

  it('decodes explicit stored and opt-out-discarded capture receipts', () => {
    expect(
      Schema.decodeUnknownSync(CaptureTweetsResult)({
        _tag: 'CaptureStored',
        epoch: EPOCH,
        stored: 1,
        mirror: 'accepted',
      }),
    ).toEqual({
      _tag: 'CaptureStored',
      epoch: EPOCH,
      stored: 1,
      mirror: 'accepted',
    })
    expect(
      Schema.decodeUnknownSync(CaptureTweetsResult)({
        _tag: 'CaptureDiscarded',
        epoch: EPOCH,
        discarded: 1,
      }),
    ).toEqual({ _tag: 'CaptureDiscarded', epoch: EPOCH, discarded: 1 })
  })

  it('decodes the exact Capture epoch request and result', () => {
    expect(Schema.decodeUnknownSync(CaptureEpochRequest)({ _tag: 'CaptureEpochRequest' })).toEqual({
      _tag: 'CaptureEpochRequest',
    })
    expect(
      Schema.decodeUnknownSync(CaptureEpochResult)({ _tag: 'CaptureEpoch', epoch: EPOCH }),
    ).toEqual({ _tag: 'CaptureEpoch', epoch: EPOCH })
  })

  it('decodes CaptureSummaryRequest via its tagged shape and BackgroundRequest', () => {
    const raw = { _tag: 'CaptureSummaryRequest' }
    expect(Schema.decodeUnknownSync(CaptureSummaryRequest)(raw)._tag).toBe('CaptureSummaryRequest')
    expect(Schema.decodeUnknownSync(BackgroundRequest)(raw)._tag).toBe('CaptureSummaryRequest')
  })

  it('decodes CaptureSummaryRequest with the optional recent-list limit', () => {
    const raw = { _tag: 'CaptureSummaryRequest', limit: 1000 }
    expect(Schema.decodeUnknownSync(CaptureSummaryRequest)(raw).limit).toBe(1000)
    expect(Schema.decodeUnknownSync(BackgroundRequest)(raw)._tag).toBe('CaptureSummaryRequest')
  })

  it.each([-1, 1.5, 1001, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid CaptureSummaryRequest limit: %s',
    (limit) => {
      const raw = { _tag: 'CaptureSummaryRequest', limit }
      expect(() => Schema.decodeUnknownSync(CaptureSummaryRequest)(raw)).toThrow('limit')
      expect(() => Schema.decodeUnknownSync(BackgroundRequest)(raw)).toThrow('limit')
    },
  )

  it('decodes ExportCaptureRequest via its tagged shape and BackgroundRequest', () => {
    const raw = { _tag: 'ExportCaptureRequest', kind: 'tree', conversationId: '123' }
    const direct = Schema.decodeUnknownSync(ExportCaptureRequest)(raw)
    expect(direct.kind).toBe('tree')
    expect(direct.conversationId).toBe('123')
    expect(Schema.decodeUnknownSync(BackgroundRequest)(raw)._tag).toBe('ExportCaptureRequest')

    const minimal = Schema.decodeUnknownSync(ExportCaptureRequest)({
      _tag: 'ExportCaptureRequest',
      kind: 'jsonl',
    })
    expect(minimal.conversationId).toBeUndefined()
  })

  it('decodes ClearCaptureRequest via its tagged shape and BackgroundRequest', () => {
    const raw = { _tag: 'ClearCaptureRequest' }
    expect(Schema.decodeUnknownSync(ClearCaptureRequest)(raw)._tag).toBe('ClearCaptureRequest')
    expect(Schema.decodeUnknownSync(BackgroundRequest)(raw)._tag).toBe('ClearCaptureRequest')
  })
})
