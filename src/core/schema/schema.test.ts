import { describe, it, expect } from 'vitest'
import { Schema, Result } from 'effect'
import {
  MediaItem,
  Settings,
  Message,
  ClearDetectedMediaRequest,
  ClearDownloadMonitorRequest,
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
      ext: 'jpg',
      index: 0,
    }
    const item = Schema.decodeUnknownSync(MediaItem)(raw)
    expect(item.handle).toBe('alice')
    expect(item.type).toBe('photo')
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
    expect(s.archiveIncludeText).toBe(true)
    expect(s.archiveLinkScope).toBe('all')
    expect(s.archiveRemoveAfterSave).toBe(false)
  })

  it('rejects an unknown quick-grab modifier', () => {
    const result = Schema.decodeUnknownResult(Settings)({ quickGrabModifier: 'space' })
    expect(Result.isFailure(result)).toBe(true)
  })

  it('rejects an unknown archive link scope', () => {
    const result = Schema.decodeUnknownResult(Settings)({ archiveLinkScope: 'some' })
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

  it('decodes an ArchiveRequest with optional capture fields absent', () => {
    const raw = {
      _tag: 'ArchiveRequest',
      source: 'bookmarks',
      tweets: [{ tweetId: '99', handle: 'alice', links: [], media: [validMediaRaw] }],
    }
    const msg = Schema.decodeUnknownSync(Message)(raw)
    expect(msg._tag).toBe('ArchiveRequest')
    const tweets = msg._tag === 'ArchiveRequest' ? msg.tweets : []
    expect(msg._tag === 'ArchiveRequest' ? msg.source : '').toBe('bookmarks')
    expect(tweets[0]!.text).toBeUndefined()
    expect(tweets[0]!.media[0]!.handle).toBe('alice')
  })

  it('rejects an ArchiveRequest with an unknown source', () => {
    const result = Schema.decodeUnknownResult(Message)({
      _tag: 'ArchiveRequest',
      source: 'retweets',
      tweets: [],
    })
    expect(Result.isFailure(result)).toBe(true)
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
})
