import { describe, it, expect } from 'vitest'
import { Schema, Result } from 'effect'
import {
  MediaItem,
  Platform,
  Settings,
  Message,
  ClearDetectedMediaRequest,
  ClearDownloadMonitorRequest,
  DownloadTraceEntry,
  SavedStatusRequest,
  SavedStatusResponse,
} from './index'

const validMediaRaw = {
  id: 'media-1',
  platform: 'x',
  postId: '123',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/abc?format=jpg&name=orig',
  ext: 'jpg',
  index: 0,
}

describe('MediaItem schema', () => {
  it('decodes a valid photo media item', () => {
    const raw = {
      id: 'media-1',
      platform: 'x',
      postId: '123',
      author: 'alice',
      type: 'photo',
      url: 'https://pbs.twimg.com/media/abc?format=jpg&name=orig',
      previewUrl: 'https://pbs.twimg.com/media/abc?format=jpg&name=small',
      ext: 'jpg',
      index: 0,
    }
    const item = Schema.decodeUnknownSync(MediaItem)(raw)
    expect(item.author).toBe('alice')
    expect(item.type).toBe('photo')
    expect(item.previewUrl).toBe('https://pbs.twimg.com/media/abc?format=jpg&name=small')
  })

  it('rejects an unknown media type with a failure result', () => {
    const raw = {
      id: 'media-1',
      platform: 'x',
      postId: '123',
      author: 'alice',
      type: 'audio',
      url: 'https://example.com/a.mp3',
      ext: 'mp3',
      index: 0,
    }
    const result = Schema.decodeUnknownResult(MediaItem)(raw)
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe('Platform schema', () => {
  it('decodes every supported platform literal', () => {
    expect(Schema.decodeUnknownSync(Platform)('x')).toBe('x')
    expect(Schema.decodeUnknownSync(Platform)('instagram')).toBe('instagram')
    expect(Schema.decodeUnknownSync(Platform)('threads')).toBe('threads')
  })

  it('rejects an unknown platform with a failure result', () => {
    const result = Schema.decodeUnknownResult(Platform)('foo')
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe('Settings schema', () => {
  it('fills defaults when keys are absent', () => {
    const s = Schema.decodeUnknownSync(Settings)({})
    expect(s.filenameTemplate).toBe('{handle}/{tweetId}_{index}.{ext}')
    expect(s.downloadConcurrency).toBe(3)
    expect(s.authFallbackEnabled).toBe(false)
    expect(s.downloadStrategy).toBe('direct')
    expect(s.theme).toBe('system')
    expect(s.quickGrabEnabled).toBe(true)
    expect(s.quickGrabModifier).toBe('alt')
  })

  it('defaults downloadBadgeEnabled on when the key is absent', () => {
    const s = Schema.decodeUnknownSync(Settings)({})
    expect(s.downloadBadgeEnabled).toBe(true)
  })

  it('defaults downloadHistoryEnabled off when the key is absent', () => {
    const s = Schema.decodeUnknownSync(Settings)({})
    expect(s.downloadHistoryEnabled).toBe(false)
  })

  it('defaults showSavedStatus on when the key is absent', () => {
    const s = Schema.decodeUnknownSync(Settings)({})
    expect(s.showSavedStatus).toBe(true)
  })

  it('defaults the admission-gate filter keys off/zero when absent', () => {
    const s = Schema.decodeUnknownSync(Settings)({})
    expect(s.preventDuplicateDownloads).toBe(false)
    expect(s.skipTypes).toEqual([])
    expect(s.minWidth).toBe(0)
    expect(s.minHeight).toBe(0)
    expect(s.maxFileSizeMB).toBe(0)
    expect(s.dailyMaxMB).toBe(0)
    expect(s.dailyMaxCount).toBe(0)
  })

  it('rejects an unknown quick-grab modifier', () => {
    const result = Schema.decodeUnknownResult(Settings)({ quickGrabModifier: 'space' })
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe('Message schema', () => {
  it('decodes a DownloadRequest and narrows by _tag', () => {
    const raw = { _tag: 'DownloadRequest', items: [validMediaRaw] }
    const msg = Schema.decodeUnknownSync(Message)(raw)
    expect(msg._tag).toBe('DownloadRequest')
    const items = msg._tag === 'DownloadRequest' ? msg.items : []
    expect(items).toHaveLength(1)
    expect(items[0]!.author).toBe('alice')
  })

  it('decodes ClearDetectedMediaRequest with optional rescanVisible', () => {
    const msg1 = Schema.decodeUnknownSync(Message)({ _tag: 'ClearDetectedMediaRequest' })
    expect(msg1._tag).toBe('ClearDetectedMediaRequest')

    const req = Schema.decodeUnknownSync(ClearDetectedMediaRequest)({
      _tag: 'ClearDetectedMediaRequest',
      rescanVisible: true,
    })
    expect(req.rescanVisible).toBe(true)
  })

  it('decodes ClearDownloadMonitorRequest with optional clearStaleLocks', () => {
    const msg1 = Schema.decodeUnknownSync(Message)({ _tag: 'ClearDownloadMonitorRequest' })
    expect(msg1._tag).toBe('ClearDownloadMonitorRequest')

    const req = Schema.decodeUnknownSync(ClearDownloadMonitorRequest)({
      _tag: 'ClearDownloadMonitorRequest',
      clearStaleLocks: true,
    })
    expect(req.clearStaleLocks).toBe(true)
  })

  it('decodes HistoryRequest and ClearHistoryRequest (durable local history)', () => {
    expect(Schema.decodeUnknownSync(Message)({ _tag: 'HistoryRequest' })._tag).toBe(
      'HistoryRequest',
    )
    expect(Schema.decodeUnknownSync(Message)({ _tag: 'ClearHistoryRequest' })._tag).toBe(
      'ClearHistoryRequest',
    )
  })

  it('round-trips SavedStatusRequest and SavedStatusResponse', () => {
    const req = Schema.decodeUnknownSync(SavedStatusRequest)({
      _tag: 'SavedStatusRequest',
      tweetIds: ['T1', 'T2'],
    })
    expect(req._tag).toBe('SavedStatusRequest')
    expect(req.tweetIds).toEqual(['T1', 'T2'])

    const res = Schema.decodeUnknownSync(SavedStatusResponse)({
      _tag: 'SavedStatusResponse',
      saved: ['T1'],
    })
    expect(res._tag).toBe('SavedStatusResponse')
    expect(res.saved).toEqual(['T1'])

    const msgReq = Schema.decodeUnknownSync(Message)({
      _tag: 'SavedStatusRequest',
      tweetIds: ['T1', 'T2'],
    })
    expect(msgReq._tag).toBe('SavedStatusRequest')
  })

  it('decodes a local download trace event for monitor diagnostics', () => {
    const raw = {
      _tag: 'DownloadTraceEvent',
      source: 'quickgrab',
      stage: 'quickgrab-send',
      t: 1234,
      itemId: 'v1',
      tweetId: 'tweet-1',
      type: 'video',
      elapsedMs: 501,
      detail: 'mp4 queued',
    }
    const msg = Schema.decodeUnknownSync(Message)(raw)
    expect(msg._tag).toBe('DownloadTraceEvent')

    const entry = Schema.decodeUnknownSync(DownloadTraceEntry)(raw)
    expect(entry.source).toBe('quickgrab')
    expect(entry.elapsedMs).toBe(501)
  })
})
