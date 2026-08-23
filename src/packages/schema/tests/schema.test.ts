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
  TabMessage,
  RefreshMediaUrlRequest,
  ClearTweetRequest,
  ClearTweetResponse,
  ClearDrainRequest,
  ClearVisibleRequest,
  ClearWholeListRequest,
  DrainPageRequest,
  SweepPageRequest,
} from '../index'

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
    expect(s.filenameTemplate).toBe('{platform}/{tweetId}_{index}.{ext}')
    expect(s.downloadConcurrency).toBe(5)
    expect(s.authFallbackEnabled).toBe(false)
    expect(s.downloadStrategy).toBe('direct')
    expect(s.theme).toBe('system')
    expect(s.quickGrabEnabled).toBe(true)
    expect(s.quickGrabModifier).toBe('alt')
    expect(s.keyboardNavEnabled).toBe(true)
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

  it('decodes a capture-sourced tee-drop trace (#92 follow-up)', () => {
    // The MAIN-world passive tee's budget drops surface as production-visible
    // traces so a missing feed batch is diagnosable without a dev build.
    const drop = Schema.decodeUnknownSync(DownloadTraceEntry)({
      _tag: 'DownloadTraceEvent',
      source: 'capture',
      stage: 'tee-drop',
      t: 1234,
      detail: 'threads in-flight-cap',
    })
    expect(drop.source).toBe('capture')
    expect(drop.stage).toBe('tee-drop')
  })
})

// TabMessage rides `browser.tabs.sendMessage` (popup/background → content
// script) — a DIFFERENT transport from the `Message` union above
// (`runtime.sendMessage`). These six tags must decode via `TabMessage` and must
// NOT be reachable through `Message`.
describe('TabMessage schema', () => {
  it('decodes the four no-payload page-action requests', () => {
    for (const tag of [
      'ClearVisibleRequest',
      'ClearWholeListRequest',
      'DrainPageRequest',
      'SweepPageRequest',
    ] as const) {
      const msg = Schema.decodeUnknownSync(TabMessage)({ _tag: tag })
      expect(msg._tag).toBe(tag)
    }
  })

  it('round-trips the real ClearVisibleRequest/ClearWholeListRequest/DrainPageRequest/SweepPageRequest literals', () => {
    expect(
      Schema.decodeUnknownSync(ClearVisibleRequest)({ _tag: 'ClearVisibleRequest' })._tag,
    ).toBe('ClearVisibleRequest')
    expect(
      Schema.decodeUnknownSync(ClearWholeListRequest)({ _tag: 'ClearWholeListRequest' })._tag,
    ).toBe('ClearWholeListRequest')
    expect(Schema.decodeUnknownSync(DrainPageRequest)({ _tag: 'DrainPageRequest' })._tag).toBe(
      'DrainPageRequest',
    )
    expect(Schema.decodeUnknownSync(SweepPageRequest)({ _tag: 'SweepPageRequest' })._tag).toBe(
      'SweepPageRequest',
    )
  })

  it('decodes the real RefreshMediaUrlRequest sender literal (background → content, refresh-before-retry)', () => {
    const raw = {
      _tag: 'RefreshMediaUrlRequest',
      itemId: 'media-1',
      tweetId: '123',
      index: 0,
      type: 'photo',
    }
    const viaTabMessage = Schema.decodeUnknownSync(TabMessage)(raw)
    expect(viaTabMessage._tag).toBe('RefreshMediaUrlRequest')
    const req = Schema.decodeUnknownSync(RefreshMediaUrlRequest)(raw)
    expect(req.itemId).toBe('media-1')
    expect(req.index).toBe(0)
    expect(req.type).toBe('photo')
  })

  it('decodes the real ClearTweetRequest sender literal (tab-broadcaster.sendClearToTabs)', () => {
    const raw = {
      _tag: 'ClearTweetRequest',
      tweetId: 't99',
      scopes: ['bookmark', 'like'],
      allLists: true,
    }
    const viaTabMessage = Schema.decodeUnknownSync(TabMessage)(raw)
    expect(viaTabMessage._tag).toBe('ClearTweetRequest')
    const req = Schema.decodeUnknownSync(ClearTweetRequest)(raw)
    expect(req.tweetId).toBe('t99')
    expect(req.scopes).toEqual(['bookmark', 'like'])
    expect(req.allLists).toBe(true)
  })

  it('decodes the permalink RELEASE literal: the caller’s allLists plus the origin page’s list scope', () => {
    const raw = {
      _tag: 'ClearTweetRequest',
      tweetId: 't99',
      scopes: ['bookmark', 'like'],
      allLists: false,
      asPageScope: 'bookmark',
    }
    const viaTabMessage = Schema.decodeUnknownSync(TabMessage)(raw)
    expect(viaTabMessage._tag).toBe('ClearTweetRequest')
    const req = Schema.decodeUnknownSync(ClearTweetRequest)(raw)
    expect(req.allLists).toBe(false)
    expect(req.asPageScope).toBe('bookmark')
  })

  it('leaves asPageScope absent on the ordinary fan-out literal', () => {
    const req = Schema.decodeUnknownSync(ClearTweetRequest)({
      _tag: 'ClearTweetRequest',
      tweetId: 't99',
      scopes: ['like'],
    })
    expect(req.asPageScope).toBeUndefined()
  })

  it('decodes a release-leg probe attempt (attempts ≥ 2 of releaseViaStatusTab)', () => {
    const req = Schema.decodeUnknownSync(ClearTweetRequest)({
      _tag: 'ClearTweetRequest',
      tweetId: 't99',
      scopes: ['bookmark'],
      probe: true,
    })
    expect(req.probe).toBe(true)
  })

  it('leaves probe absent on the ordinary fan-out literal', () => {
    const req = Schema.decodeUnknownSync(ClearTweetRequest)({
      _tag: 'ClearTweetRequest',
      tweetId: 't99',
      scopes: ['bookmark'],
    })
    expect(req.probe).toBeUndefined()
  })

  it('decodes an unmounted ClearTweetResponse carrying page-state evidence', () => {
    const res = Schema.decodeUnknownSync(ClearTweetResponse)({
      _tag: 'ClearTweetResponse',
      mounted: false,
      drainEligible: false,
      results: [],
      page: { articles: 0, cells: 0, ready: 'complete', error: true },
    })
    expect(res.page).toEqual({ articles: 0, cells: 0, ready: 'complete', error: true })
  })

  it('leaves page absent on a mounted ClearTweetResponse', () => {
    const res = Schema.decodeUnknownSync(ClearTweetResponse)({
      _tag: 'ClearTweetResponse',
      mounted: true,
      drainEligible: false,
      results: [],
    })
    expect(res.page).toBeUndefined()
  })

  it('rejects a page.ready value outside the DocumentReadyState literal', () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ClearTweetResponse)({
          _tag: 'ClearTweetResponse',
          mounted: false,
          drainEligible: false,
          results: [],
          page: { articles: 0, cells: 0, ready: 'idle', error: false },
        }),
      ),
    ).toBe(true)
  })

  it('rejects notInterested as a page scope — a permalink page is never the For You feed', () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ClearTweetRequest)({
          _tag: 'ClearTweetRequest',
          tweetId: 't99',
          scopes: ['bookmark'],
          asPageScope: 'notInterested',
        }),
      ),
    ).toBe(true)
  })

  it('decodes the worker-authorized ClearDrainRequest', () => {
    const req = Schema.decodeUnknownSync(TabMessage)({
      _tag: 'ClearDrainRequest',
      tweetId: 't99',
      scopes: ['bookmark'],
      allLists: false,
    })

    expect(req._tag).toBe('ClearDrainRequest')
    expect(Schema.decodeUnknownSync(ClearDrainRequest)(req).tweetId).toBe('t99')
  })

  it('rejects a malformed / unknown-tag payload', () => {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(TabMessage)({ _tag: 'ClearTweetRequest' })),
    ).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(TabMessage)({ _tag: 'NotARealTag' }))).toBe(
      true,
    )
  })

  it('does NOT decode via the runtime-broadcast Message union — the two transports are disjoint', () => {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(Message)({ _tag: 'ClearVisibleRequest' })),
    ).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(Message)({ _tag: 'DrainPageRequest' })),
    ).toBe(true)
  })
})
