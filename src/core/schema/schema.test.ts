import { describe, it, expect } from 'vitest'
import { Schema, Result } from 'effect'
import {
  MediaItem,
  QueueUpdate,
  Platform,
  Settings,
  BackgroundRequest,
  decodeBackgroundRequest,
  ClearDownloadMonitorRequest,
  DownloadTraceEntry,
  SavedStatusRequest,
  SavedStatusResponse,
  TabBroadcast,
  TabRequest,
  RefreshMediaUrlRequest,
  LocateClearTweetRequest,
  ClearTweetRequest,
  TweetSnowflake,
  ClearVisibilityPulse,
  decodeClearTweetResponse,
  decodeLocateClearTweetResponse,
  DrainPageRequest,
  SweepPageRequest,
  SettingsUpdateFailure,
  SettingsReadRequest,
  SettingsReadSuccess,
  SettingsReadUnavailable,
  SettingsChanged,
  ContentSettings,
  projectContentSettings,
  decodeSettingsReadRequest,
  decodeSettingsReadResponse,
  decodeSettingsChanged,
  ClearLogRequest,
  CLEAR_LOG_LIMIT,
  decodeClearLogRequest,
  decodeClearLogResponse,
  DailyBudgetReadRequest,
  DailyBudgetResetRequest,
  decodeDailyBudgetReadRequest,
  decodeDailyBudgetResetRequest,
  decodeDailyBudgetReadResponse,
  decodeDailyBudgetResetResponse,
  decodeCloudConnectResponse,
  decodeCloudBackfillResponse,
  RecoverTweetMediaRequest,
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

describe('Cloud upload UI replies', () => {
  it('decodes only exact current OAuth replies', () => {
    expect(
      decodeCloudConnectResponse({
        ok: true,
        detail: 'Connected Google Drive.',
      }),
    ).toEqual({
      ok: true,
      detail: 'Connected Google Drive.',
    })
    expect(
      decodeCloudConnectResponse({
        ok: true,
        detail: 'Connected Google Drive.',
        account: 'alice@example.com',
      }),
    ).toEqual({
      ok: true,
      detail: 'Connected Google Drive.',
      account: 'alice@example.com',
    })
    expect(
      decodeCloudConnectResponse({
        ok: false,
        detail: 'Authorization was cancelled.',
      }),
    ).toEqual({
      ok: false,
      detail: 'Authorization was cancelled.',
    })
    for (const reply of [
      { ok: true, detail: 'Connected Google Drive.', extra: true },
      { ok: false, detail: 'Authorization was cancelled.', account: 'stale' },
      { ok: false, error: 'handler failed' },
      { ok: true, detail: 1 },
      { ok: true, detail: 'Connected Google Drive.', account: undefined },
      { ok: 'true', detail: 'Connected Google Drive.' },
    ])
      expect(decodeCloudConnectResponse(reply)).toBeUndefined()
  })

  it('decodes only exact current backfill replies', () => {
    expect(
      decodeCloudBackfillResponse({
        ok: true,
        queued: 2,
        detail: 'Queued 2 uploads from past downloads.',
      }),
    ).toEqual({
      ok: true,
      queued: 2,
      detail: 'Queued 2 uploads from past downloads.',
    })
    for (const reply of [
      {
        ok: true,
        queued: 2,
        detail: 'Queued 2 uploads from past downloads.',
        extra: true,
      },
      { ok: true, queued: -1, detail: 'Queued uploads.' },
      { ok: true, queued: 1.5, detail: 'Queued uploads.' },
      { ok: true, detail: 'Queued uploads.' },
      { ok: false, queued: 0, error: 'handler failed' },
    ])
      expect(decodeCloudBackfillResponse(reply)).toBeUndefined()
  })
})

describe('Settings schema', () => {
  it('fills defaults when keys are absent', () => {
    const s = Schema.decodeUnknownSync(Settings)({})
    expect(s.filenameTemplate).toBe('{platform}/{tweetId}_{index}.{ext}')
    expect(s.downloadConcurrency).toBe(3)
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

  it.each([
    ['downloadConcurrency', 0],
    ['downloadConcurrency', 2.5],
    ['downloadConcurrency', 11],
    ['downloadConcurrency', Infinity],
    ['downloadConcurrency', NaN],
    ['aria2Split', 0],
    ['aria2Split', 8.5],
    ['aria2Split', 17],
    ['minWidth', -1],
    ['minWidth', 1.5],
    ['minHeight', Infinity],
    ['minHeight', Number.MAX_SAFE_INTEGER + 1],
    ['dailyMaxCount', -1],
    ['dailyMaxCount', 1.5],
    ['dailyMaxCount', Number.MAX_SAFE_INTEGER + 1],
    ['maxFileSizeMB', -0.1],
    ['maxFileSizeMB', Infinity],
    ['dailyMaxMB', NaN],
    ['gdriveTokenExpiry', -1],
    ['gdriveTokenExpiry', Infinity],
    ['dropboxTokenExpiry', NaN],
  ] as const)('rejects invalid numeric setting %s=%s', (key, value) => {
    expect(Result.isFailure(Schema.decodeUnknownResult(Settings)({ [key]: value }))).toBe(true)
  })

  it('keeps fractional MB caps and nonnegative expiry values', () => {
    const s = Schema.decodeUnknownSync(Settings)({
      maxFileSizeMB: 0.5,
      dailyMaxMB: 1.25,
      gdriveTokenExpiry: 1,
      dropboxTokenExpiry: 2,
    })
    expect(s.maxFileSizeMB).toBe(0.5)
    expect(s.dailyMaxMB).toBe(1.25)
  })

  it('rejects an unknown quick-grab modifier', () => {
    const result = Schema.decodeUnknownResult(Settings)({
      quickGrabModifier: 'space',
    })
    expect(Result.isFailure(result)).toBe(true)
  })
})

describe('BackgroundRequest schema', () => {
  it('accepts only an exact recovery snowflake request', () => {
    expect(
      Schema.decodeUnknownSync(RecoverTweetMediaRequest)({
        _tag: 'RecoverTweetMediaRequest',
        tweetId: '12345678901234567890',
      }),
    ).toEqual({
      _tag: 'RecoverTweetMediaRequest',
      tweetId: '12345678901234567890',
    })
    for (const tweetId of ['', 'tweet-1', '123456789012345678901'])
      expect(
        Result.isFailure(
          decodeBackgroundRequest({
            _tag: 'RecoverTweetMediaRequest',
            tweetId,
          }),
        ),
      ).toBe(true)
    expect(
      Result.isFailure(
        decodeBackgroundRequest({
          _tag: 'RecoverTweetMediaRequest',
          tweetId: '1',
          extra: true,
        }),
      ),
    ).toBe(true)
  })

  it('keeps QueueUpdate replies out of background ingress', () => {
    const raw = {
      _tag: 'QueueUpdate',
      planned: ['media-1'],
      started: ['media-1'],
      deferred: [],
      duplicates: [],
      failures: [],
      skipped: [],
    }
    expect(Schema.decodeUnknownSync(QueueUpdate)(raw)).toEqual(raw)
    expect(Result.isFailure(Schema.decodeUnknownResult(BackgroundRequest)(raw))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(QueueUpdate)({
          ...raw,
          started: 1,
        }),
      ),
    ).toBe(true)
  })

  it('rejects excess worker fields while retaining valid optional payloads', () => {
    expect(Result.isFailure(decodeBackgroundRequest({ _tag: 'MetricsRequest', extra: true }))).toBe(
      true,
    )
    expect(
      Result.isFailure(decodeBackgroundRequest({ _tag: 'ClearHistoryRequest', extra: true })),
    ).toBe(true)
    expect(
      Result.isFailure(
        decodeBackgroundRequest({
          _tag: 'ClearDownloadMonitorRequest',
          clearStaleLocks: true,
        }),
      ),
    ).toBe(false)
  })

  it('decodes the UI-only SettingsUpdate wire contract', () => {
    const decoded = decodeBackgroundRequest({
      _tag: 'SettingsUpdateRequest',
      patch: { downloadConcurrency: 4 },
    })
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isFailure(decoded)) return
    expect(decoded.success).toEqual({
      _tag: 'SettingsUpdateRequest',
      patch: { downloadConcurrency: 4 },
    })
    expect(
      Result.isFailure(
        decodeBackgroundRequest({
          _tag: 'SettingsUpdateRequest',
          patch: { downloadConcurrency: 4, futureKey: true },
        }),
      ),
    ).toBe(true)
    expect(
      Schema.decodeUnknownSync(BackgroundRequest)({
        _tag: 'SettingsUpdateRequest',
        patch: { theme: 'dark' },
      })._tag,
    ).toBe('SettingsUpdateRequest')

    expect(
      Schema.decodeUnknownSync(SettingsUpdateFailure)({
        _tag: 'SettingsUpdateFailure',
        reason: 'unknown setting key',
      }).reason,
    ).toBe('unknown setting key')
  })

  it('accepts only exact content settings read requests and worker replies', () => {
    expect(
      Schema.decodeUnknownSync(BackgroundRequest)({
        _tag: 'SettingsReadRequest',
      })._tag,
    ).toBe('SettingsReadRequest')
    expect(decodeSettingsReadRequest({ _tag: 'SettingsReadRequest' })).toEqual({
      _tag: 'SettingsReadRequest',
    })
    expect(decodeSettingsReadRequest({ _tag: 'SettingsReadRequest', extra: true })).toBeUndefined()

    const settings = projectContentSettings(
      Schema.decodeUnknownSync(Settings)({
        quickGrabEnabled: false,
        convexSyncSecret: 'must-not-cross-wire',
        aria2Secret: 'must-not-cross-wire',
        gdriveAccessToken: 'must-not-cross-wire',
      }),
    )
    expect(Object.keys(settings).toSorted()).toEqual(
      [
        'quickGrabEnabled',
        'quickGrabModifier',
        'downloadBadgeEnabled',
        'downloadDockEnabled',
        'dockGlassEnabled',
        'autoRevealSensitiveEnabled',
        'clearOnSave',
        'autoNotInterestedOnSave',
        'showSavedStatus',
        'captureEnabled',
        'captureAllScrolled',
        'autoUnbookmarkOnSave',
        'autoUnlikeOnSave',
        'downloadStrategy',
      ].toSorted(),
    )
    expect(settings).not.toHaveProperty('convexSyncSecret')
    expect(settings).not.toHaveProperty('aria2Secret')
    expect(settings).not.toHaveProperty('gdriveAccessToken')
    expect(decodeSettingsReadResponse({ _tag: 'SettingsReadSuccess', settings })).toMatchObject({
      _tag: 'SettingsReadSuccess',
      settings,
    })
    expect(decodeSettingsReadResponse({ _tag: 'SettingsReadUnavailable' })).toEqual({
      _tag: 'SettingsReadUnavailable',
    })
    expect(
      decodeSettingsReadResponse({
        _tag: 'SettingsReadSuccess',
        settings,
        extra: true,
      }),
    ).toBeUndefined()
    for (const key of Object.keys(settings)) {
      const missingSetting: Record<string, unknown> = { ...settings }
      delete missingSetting[key]
      expect(
        decodeSettingsReadResponse({
          _tag: 'SettingsReadSuccess',
          settings: missingSetting,
        }),
      ).toBeUndefined()
      expect(
        decodeSettingsChanged({
          _tag: 'SettingsChanged',
          settings: missingSetting,
        }),
      ).toBeUndefined()
    }
    expect(
      decodeSettingsReadResponse({
        _tag: 'SettingsReadSuccess',
        settings: { ...settings, secret: 'extra' },
      }),
    ).toBeUndefined()
    expect(
      decodeSettingsReadResponse({
        _tag: 'SettingsReadSuccess',
        settings: 'bad',
      }),
    ).toBeUndefined()
    expect(
      decodeSettingsReadResponse({
        _tag: 'SettingsReadUnavailable',
        extra: true,
      }),
    ).toBeUndefined()

    expect(decodeSettingsChanged({ _tag: 'SettingsChanged', settings })).toMatchObject({
      _tag: 'SettingsChanged',
      settings,
    })
    expect(
      decodeSettingsChanged({ _tag: 'SettingsChanged', settings, extra: true }),
    ).toBeUndefined()
    expect(
      decodeSettingsChanged({
        _tag: 'SettingsChanged',
        settings: { ...settings, secret: true },
      }),
    ).toBeUndefined()
    expect(
      Schema.decodeUnknownResult(BackgroundRequest)({
        _tag: 'SettingsChanged',
        settings,
      })._tag,
    ).toBe('Failure')

    expect(
      Schema.decodeUnknownSync(SettingsReadRequest)({
        _tag: 'SettingsReadRequest',
      })._tag,
    ).toBe('SettingsReadRequest')
    expect(
      Schema.decodeUnknownSync(SettingsReadSuccess)({
        _tag: 'SettingsReadSuccess',
        settings,
      }),
    ).toMatchObject({
      _tag: 'SettingsReadSuccess',
      settings,
    })
    expect(
      Schema.decodeUnknownSync(SettingsReadUnavailable)({
        _tag: 'SettingsReadUnavailable',
      }),
    ).toEqual({ _tag: 'SettingsReadUnavailable' })
    expect(
      Schema.decodeUnknownSync(SettingsChanged)({
        _tag: 'SettingsChanged',
        settings,
      }),
    ).toMatchObject({
      _tag: 'SettingsChanged',
      settings,
    })
    expect(Schema.decodeUnknownSync(ContentSettings)(settings)).toEqual(settings)
  })

  it('decodes a DownloadRequest and narrows by _tag', () => {
    const raw = { _tag: 'DownloadRequest', items: [validMediaRaw] }
    const msg = Schema.decodeUnknownSync(BackgroundRequest)(raw)
    expect(msg._tag).toBe('DownloadRequest')
    const items = msg._tag === 'DownloadRequest' ? msg.items : []
    expect(items).toHaveLength(1)
    expect(items[0]!.author).toBe('alice')
  })

  it('decodes ClearDownloadMonitorRequest with optional clearStaleLocks', () => {
    const msg1 = Schema.decodeUnknownSync(BackgroundRequest)({
      _tag: 'ClearDownloadMonitorRequest',
    })
    expect(msg1._tag).toBe('ClearDownloadMonitorRequest')

    const req = Schema.decodeUnknownSync(ClearDownloadMonitorRequest)({
      _tag: 'ClearDownloadMonitorRequest',
      clearStaleLocks: true,
    })
    expect(req.clearStaleLocks).toBe(true)
  })

  it('decodes HistoryRequest and ClearHistoryRequest (durable local history)', () => {
    expect(Schema.decodeUnknownSync(BackgroundRequest)({ _tag: 'HistoryRequest' })._tag).toBe(
      'HistoryRequest',
    )
    expect(
      Schema.decodeUnknownSync(BackgroundRequest)({
        _tag: 'ClearHistoryRequest',
      })._tag,
    ).toBe('ClearHistoryRequest')
  })

  it('accepts the exact UI-only Clear Log request', () => {
    expect(Schema.decodeUnknownSync(ClearLogRequest)({ _tag: 'ClearLogRequest' })._tag).toBe(
      'ClearLogRequest',
    )
    expect(Schema.decodeUnknownSync(BackgroundRequest)({ _tag: 'ClearLogRequest' })._tag).toBe(
      'ClearLogRequest',
    )
    expect(decodeClearLogRequest({ _tag: 'ClearLogRequest' })).toEqual({
      _tag: 'ClearLogRequest',
    })
    expect(decodeClearLogRequest({ _tag: 'ClearLogRequest', extra: true })).toBeUndefined()
  })

  it('accepts exact UI-only daily budget requests and hides durable fields', () => {
    expect(
      Schema.decodeUnknownSync(DailyBudgetReadRequest)({
        _tag: 'DailyBudgetReadRequest',
      }),
    ).toEqual({
      _tag: 'DailyBudgetReadRequest',
    })
    expect(
      Schema.decodeUnknownSync(DailyBudgetResetRequest)({
        _tag: 'DailyBudgetResetRequest',
      }),
    ).toEqual({ _tag: 'DailyBudgetResetRequest' })
    expect(
      Schema.decodeUnknownSync(BackgroundRequest)({
        _tag: 'DailyBudgetReadRequest',
      })._tag,
    ).toBe('DailyBudgetReadRequest')
    expect(
      Schema.decodeUnknownSync(BackgroundRequest)({
        _tag: 'DailyBudgetResetRequest',
      })._tag,
    ).toBe('DailyBudgetResetRequest')
    expect(decodeDailyBudgetReadRequest({ _tag: 'DailyBudgetReadRequest' })).toEqual({
      _tag: 'DailyBudgetReadRequest',
    })
    expect(decodeDailyBudgetResetRequest({ _tag: 'DailyBudgetResetRequest' })).toEqual({
      _tag: 'DailyBudgetResetRequest',
    })
    expect(
      decodeDailyBudgetReadRequest({
        _tag: 'DailyBudgetReadRequest',
        extra: true,
      }),
    ).toBeUndefined()
    expect(
      decodeDailyBudgetResetRequest({
        _tag: 'DailyBudgetResetRequest',
        extra: true,
      }),
    ).toBeUndefined()

    const usage = { day: '2026-07-22', bytes: 9, count: 1 }
    expect(decodeDailyBudgetReadResponse({ _tag: 'DailyBudgetReadSuccess', usage })).toEqual({
      _tag: 'DailyBudgetReadSuccess',
      usage,
    })
    expect(
      decodeDailyBudgetResetResponse({
        _tag: 'DailyBudgetResetSuccess',
        usage,
      }),
    ).toEqual({
      _tag: 'DailyBudgetResetSuccess',
      usage,
    })
    expect(
      decodeDailyBudgetReadResponse({
        _tag: 'DailyBudgetReadSuccess',
        usage: { ...usage, creditedReceiptIds: ['private'] },
      }),
    ).toBeUndefined()
    expect(
      decodeDailyBudgetResetResponse({
        _tag: 'DailyBudgetResetSuccess',
        usage: { ...usage, resetAt: 1 },
      }),
    ).toBeUndefined()
    expect(
      decodeDailyBudgetReadResponse({
        _tag: 'DailyBudgetReadSuccess',
        usage: { ...usage, day: 'not-a-day' },
      }),
    ).toBeUndefined()
  })

  it('decodes only exact, verified, newest-first Clear Log replies', () => {
    const first = {
      tweetId: '2',
      scope: 'bookmark',
      at: 5,
      mechanism: 'dom-click',
      permalink: 'https://x.com/i/status/2',
    }
    const second = {
      tweetId: '1',
      scope: 'like',
      at: 4,
      mechanism: 'dom-click',
      permalink: 'https://x.com/i/status/1',
    }
    expect(
      decodeClearLogResponse({
        _tag: 'ClearLogSuccess',
        records: [first, second],
      }),
    ).toEqual({ _tag: 'ClearLogSuccess', records: [first, second] })
    expect(decodeClearLogResponse({ _tag: 'ClearLogUnavailable' })).toEqual({
      _tag: 'ClearLogUnavailable',
    })
    for (const reply of [
      { _tag: 'ClearLogSuccess', records: [second, first] },
      { _tag: 'ClearLogSuccess', records: [first, { ...first }] },
      { _tag: 'ClearLogSuccess', records: [{ ...first, at: 1.5 }] },
      {
        _tag: 'ClearLogSuccess',
        records: [{ ...first, permalink: 'https://x.com/i/status/1' }],
      },
      { _tag: 'ClearLogUnavailable', extra: true },
      {
        _tag: 'ClearLogSuccess',
        records: Array.from({ length: CLEAR_LOG_LIMIT + 1 }, (_, index) => ({
          ...first,
          tweetId: String(CLEAR_LOG_LIMIT + 1 - index),
          at: CLEAR_LOG_LIMIT + 1 - index,
          permalink: `https://x.com/i/status/${CLEAR_LOG_LIMIT + 1 - index}`,
        })),
      },
    ]) {
      expect(decodeClearLogResponse(reply)).toBeUndefined()
    }
  })

  it('round-trips SavedStatusRequest and SavedStatusResponse', () => {
    const req = Schema.decodeUnknownSync(SavedStatusRequest)({
      _tag: 'SavedStatusRequest',
      tweetIds: ['1', '2'],
    })
    expect(req._tag).toBe('SavedStatusRequest')
    expect(req.tweetIds).toEqual(['1', '2'])

    const res = Schema.decodeUnknownSync(SavedStatusResponse)({
      _tag: 'SavedStatusResponse',
      saved: ['1'],
    })
    expect(res._tag).toBe('SavedStatusResponse')
    expect(res.saved).toEqual(['1'])

    const msgReq = Schema.decodeUnknownSync(BackgroundRequest)({
      _tag: 'SavedStatusRequest',
      tweetIds: ['1', '2'],
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
    const msg = Schema.decodeUnknownSync(BackgroundRequest)(raw)
    expect(msg._tag).toBe('DownloadTraceEvent')

    const entry = Schema.decodeUnknownSync(DownloadTraceEntry)(raw)
    expect(entry.source).toBe('quickgrab')
    expect(entry.elapsedMs).toBe(501)
  })
})

// TabRequest rides `browser.tabs.sendMessage`; broadcasts and worker requests
// are distinct directional contracts.
describe('TabRequest schema', () => {
  it('decodes the two no-payload page-action requests', () => {
    for (const tag of ['DrainPageRequest', 'SweepPageRequest'] as const) {
      const msg = Schema.decodeUnknownSync(TabRequest)({ _tag: tag })
      expect(msg._tag).toBe(tag)
    }
  })

  it('round-trips the real DrainPageRequest/SweepPageRequest literals', () => {
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
    const viaTabRequest = Schema.decodeUnknownSync(TabRequest)(raw)
    expect(viaTabRequest._tag).toBe('RefreshMediaUrlRequest')
    const req = Schema.decodeUnknownSync(RefreshMediaUrlRequest)(raw)
    expect(req.itemId).toBe('media-1')
    expect(req.index).toBe(0)
    expect(req.type).toBe('photo')
  })

  it('imports and decodes 1–20 digit snowflakes without number coercion', () => {
    expect(Schema.decodeUnknownSync(TweetSnowflake)('12345678901234567890')).toBe(
      '12345678901234567890',
    )
    expect(Result.isFailure(Schema.decodeUnknownResult(TweetSnowflake)('t99'))).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(TweetSnowflake)('123456789012345678901')),
    ).toBe(true)
  })

  it('bounds and deduplicates visibility pulses at the wire boundary', () => {
    expect(
      Schema.decodeUnknownSync(ClearVisibilityPulse)({
        _tag: 'ClearVisibilityPulse',
        tweetIds: ['1'],
      }),
    ).toEqual({ _tag: 'ClearVisibilityPulse', tweetIds: ['1'] })
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ClearVisibilityPulse)({
          _tag: 'ClearVisibilityPulse',
          tweetIds: ['1', '1'],
        }),
      ),
    ).toBe(true)
  })

  it('decodes the real LocateClearTweetRequest sender literal', () => {
    const raw = {
      _tag: 'LocateClearTweetRequest',
      tweetId: '12345678901234567890',
      scopes: ['bookmark', 'like'],
      allLists: true,
    }
    expect(Schema.decodeUnknownSync(TabRequest)(raw)._tag).toBe('LocateClearTweetRequest')
    expect(Schema.decodeUnknownSync(LocateClearTweetRequest)(raw).tweetId).toBe(raw.tweetId)
  })

  it('decodes the real ClearTweetRequest sender literal', () => {
    const raw = {
      _tag: 'ClearTweetRequest',
      tweetId: '12345678901234567890',
      scopes: ['bookmark'],
      allLists: true,
    }
    const viaTabRequest = Schema.decodeUnknownSync(TabRequest)(raw)
    expect(viaTabRequest._tag).toBe('ClearTweetRequest')
    const req = Schema.decodeUnknownSync(ClearTweetRequest)(raw)
    expect(req.tweetId).toBe('12345678901234567890')
    expect(req.scopes).toEqual(['bookmark'])
    expect(req.allLists).toBe(true)
  })

  it('rejects empty or duplicate scope lists before either Clear phase runs', () => {
    for (const request of [LocateClearTweetRequest, ClearTweetRequest]) {
      for (const scopes of [[], ['bookmark', 'bookmark']]) {
        expect(
          Result.isFailure(
            Schema.decodeUnknownResult(request)({
              _tag:
                request === LocateClearTweetRequest
                  ? 'LocateClearTweetRequest'
                  : 'ClearTweetRequest',
              tweetId: '1',
              scopes,
              allLists: false,
            }),
          ),
        ).toBe(true)
      }
    }
  })

  it('keeps Locate multi-scope but rejects a multi-scope destructive request', () => {
    const common = {
      tweetId: '1',
      scopes: ['bookmark', 'like'],
      allLists: false,
    }
    expect(
      Schema.decodeUnknownSync(LocateClearTweetRequest)({
        _tag: 'LocateClearTweetRequest',
        ...common,
      }).scopes,
    ).toEqual(['bookmark', 'like'])
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ClearTweetRequest)({
          _tag: 'ClearTweetRequest',
          ...common,
        }),
      ),
    ).toBe(true)
  })

  it('rejects malformed clear replies before they can select or settle a target', () => {
    expect(
      decodeLocateClearTweetResponse(
        {
          _tag: 'LocateClearTweetResponse',
          mounted: true,
          results: [{ scope: 'bookmark', state: 'actionable' }],
          extra: true,
        },
        ['bookmark'],
      ),
    ).toBeUndefined()
    expect(
      decodeClearTweetResponse(
        {
          _tag: 'ClearTweetResponse',
          results: [{ scope: 'bookmark', state: 'cleared' }],
        },
        ['bookmark', 'like'],
      ),
    ).toBeUndefined()
  })

  it('rejects a malformed / unknown-tag payload', () => {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(TabRequest)({ _tag: 'ClearTweetRequest' })),
    ).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(TabRequest)({ _tag: 'NotARealTag' }))).toBe(
      true,
    )
    expect(
      Result.isFailure(Schema.decodeUnknownResult(TabRequest)({ _tag: 'ClearVisibleRequest' })),
    ).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(TabRequest)({ _tag: 'ClearWholeListRequest' })),
    ).toBe(true)
  })

  it('keeps tab requests, broadcasts, and background requests disjoint', () => {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(BackgroundRequest)({
          _tag: 'ClearVisibleRequest',
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(BackgroundRequest)({
          _tag: 'DrainPageRequest',
        }),
      ),
    ).toBe(true)
    const broadcast = {
      _tag: 'TransferOutcome',
      requestId: 'media-1',
      outcome: 'complete',
      at: 1,
    }
    expect(Schema.decodeUnknownSync(TabBroadcast)(broadcast)).toEqual(broadcast)
    expect(Schema.decodeUnknownSync(TabBroadcast)({ _tag: 'CaptureEpochChanged' })).toEqual({
      _tag: 'CaptureEpochChanged',
    })
    expect(Result.isFailure(Schema.decodeUnknownResult(BackgroundRequest)(broadcast))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(TabRequest)(broadcast))).toBe(true)
  })
})
