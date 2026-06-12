import { describe, it, expect } from 'vitest'
import { Schema, Result } from 'effect'
import {
  MediaItem,
  Settings,
  Message,
  ClearDetectedMediaRequest,
  ClearDownloadMonitorRequest,
  DownloadTraceEntry,
} from './index'

const validMediaRaw = {
  id: 'media-1',
  tweetId: '123',
  handle: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/abc?format=jpg&name=orig',
  ext: 'jpg',
  index: 0,
}

describe('MediaItem schema', () => {
  it('decodes a valid photo media item', () => {
    const raw = {
      id: 'media-1',
      tweetId: '123',
      handle: 'alice',
      type: 'photo',
      url: 'https://pbs.twimg.com/media/abc?format=jpg&name=orig',
      previewUrl: 'https://pbs.twimg.com/media/abc?format=jpg&name=small',
      ext: 'jpg',
      index: 0,
    }
    const item = Schema.decodeUnknownSync(MediaItem)(raw)
    expect(item.handle).toBe('alice')
    expect(item.type).toBe('photo')
    expect(item.previewUrl).toBe('https://pbs.twimg.com/media/abc?format=jpg&name=small')
  })

  it('rejects an unknown media type with a failure result', () => {
    const raw = {
      id: 'media-1',
      tweetId: '123',
      handle: 'alice',
      type: 'audio',
      url: 'https://example.com/a.mp3',
      ext: 'mp3',
      index: 0,
    }
    const result = Schema.decodeUnknownResult(MediaItem)(raw)
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
    expect(items[0]!.handle).toBe('alice')
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
