import { describe, it, expect } from 'vitest'
import { Schema } from 'effect'
import {
  Settings,
  Message,
  CaptureTweets,
  CaptureSummaryRequest,
  CaptureSearchRequest,
  ExportCaptureRequest,
  ExportCaptureChunkRequest,
  ClearCaptureRequest,
} from '../index'

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
  it('decodes CaptureTweets via its tagged shape and the Message union', () => {
    const raw = { _tag: 'CaptureTweets', records: [validRecord] }
    const direct = Schema.decodeUnknownSync(CaptureTweets)(raw)
    expect(direct._tag).toBe('CaptureTweets')
    expect(direct.records).toHaveLength(1)

    const msg = Schema.decodeUnknownSync(Message)(raw)
    expect(msg._tag).toBe('CaptureTweets')
  })

  it('decodes CaptureSummaryRequest via its tagged shape and the Message union', () => {
    const raw = { _tag: 'CaptureSummaryRequest' }
    expect(Schema.decodeUnknownSync(CaptureSummaryRequest)(raw)._tag).toBe('CaptureSummaryRequest')
    expect(Schema.decodeUnknownSync(Message)(raw)._tag).toBe('CaptureSummaryRequest')
  })

  it('decodes CaptureSummaryRequest with the optional recent-list limit', () => {
    const raw = { _tag: 'CaptureSummaryRequest', limit: 1000 }
    expect(Schema.decodeUnknownSync(CaptureSummaryRequest)(raw).limit).toBe(1000)
    expect(Schema.decodeUnknownSync(Message)(raw)._tag).toBe('CaptureSummaryRequest')
  })

  it('decodes CaptureSearchRequest via its tagged shape and the Message union', () => {
    const raw = { _tag: 'CaptureSearchRequest', query: 'rust', limit: 5 }
    const direct = Schema.decodeUnknownSync(CaptureSearchRequest)(raw)
    expect(direct._tag).toBe('CaptureSearchRequest')
    expect(direct.query).toBe('rust')
    expect(direct.limit).toBe(5)
    expect(Schema.decodeUnknownSync(Message)(raw)._tag).toBe('CaptureSearchRequest')

    const minimal = Schema.decodeUnknownSync(CaptureSearchRequest)({
      _tag: 'CaptureSearchRequest',
      query: 'rust',
    })
    expect(minimal.limit).toBeUndefined()
    expect(
      Schema.decodeUnknownSync(Message)({ _tag: 'CaptureSearchRequest', query: 'rust' })._tag,
    ).toBe('CaptureSearchRequest')

    expect(() =>
      Schema.decodeUnknownSync(CaptureSearchRequest)({ _tag: 'CaptureSearchRequest' }),
    ).toThrow(/query/)
  })

  it('decodes ExportCaptureRequest via its tagged shape and the Message union', () => {
    const raw = { _tag: 'ExportCaptureRequest', kind: 'tree', conversationId: '123' }
    const direct = Schema.decodeUnknownSync(ExportCaptureRequest)(raw)
    expect(direct.kind).toBe('tree')
    expect(direct.conversationId).toBe('123')
    expect(Schema.decodeUnknownSync(Message)(raw)._tag).toBe('ExportCaptureRequest')

    const minimal = Schema.decodeUnknownSync(ExportCaptureRequest)({
      _tag: 'ExportCaptureRequest',
      kind: 'jsonl',
    })
    expect(minimal.conversationId).toBeUndefined()
  })

  it('decodes ExportCaptureChunkRequest via its tagged shape and the Message union', () => {
    const minimal = Schema.decodeUnknownSync(ExportCaptureChunkRequest)({
      _tag: 'ExportCaptureChunkRequest',
    })
    expect(minimal.after).toBeUndefined()
    expect(minimal.limit).toBeUndefined()
    expect(Schema.decodeUnknownSync(Message)({ _tag: 'ExportCaptureChunkRequest' })._tag).toBe(
      'ExportCaptureChunkRequest',
    )

    const full = { _tag: 'ExportCaptureChunkRequest', after: '12', limit: 100 }
    const direct = Schema.decodeUnknownSync(ExportCaptureChunkRequest)(full)
    expect(direct.after).toBe('12')
    expect(direct.limit).toBe(100)
    expect(Schema.decodeUnknownSync(Message)(full)._tag).toBe('ExportCaptureChunkRequest')

    expect(() =>
      Schema.decodeUnknownSync(ExportCaptureChunkRequest)({
        _tag: 'ExportCaptureChunkRequest',
        after: 12,
      }),
    ).toThrow(/after/)
  })

  it('decodes ClearCaptureRequest via its tagged shape and the Message union', () => {
    const raw = { _tag: 'ClearCaptureRequest' }
    expect(Schema.decodeUnknownSync(ClearCaptureRequest)(raw)._tag).toBe('ClearCaptureRequest')
    expect(Schema.decodeUnknownSync(Message)(raw)._tag).toBe('ClearCaptureRequest')
  })
})
