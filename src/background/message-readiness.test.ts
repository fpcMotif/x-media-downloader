import { Result } from 'effect'
import { describe, expect, it } from 'vitest'
import { decodeBackgroundRequest, type BackgroundRequest, type MediaItem } from '../core/schema'
import {
  messageReadinessDomain,
  unavailableMessageReply,
  type MessageReadinessDomain,
} from './message-readiness'

const item: MediaItem = {
  id: 'media-1',
  platform: 'x',
  postId: '1',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/a.jpg',
  ext: 'jpg',
  index: 0,
}

const message = (value: unknown): BackgroundRequest => value as BackgroundRequest

const captureRecord = {
  tweetId: '1',
  conversationId: '1',
  author: { handle: 'alice' },
  text: 'text',
  rawText: 'text',
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'timeline',
  sourceRank: 1,
  capturedAt: 1,
} as const

type ReadinessFixtureByTag = {
  readonly [Tag in BackgroundRequest['_tag']]: readonly [
    Extract<BackgroundRequest, { readonly _tag: Tag }>,
    MessageReadinessDomain,
  ]
}

const readinessFixtures = {
  SettingsUpdateRequest: [{ _tag: 'SettingsUpdateRequest', patch: {} }, 'base'],
  SettingsReadRequest: [{ _tag: 'SettingsReadRequest' }, 'base'],
  SettingsRecoveryRequest: [{ _tag: 'SettingsRecoveryRequest', action: 'inspect' }, 'base'],
  DownloadRequest: [{ _tag: 'DownloadRequest', items: [item] }, 'transfer'],
  MetricsRequest: [{ _tag: 'MetricsRequest' }, 'base'],
  DownloadTraceEvent: [
    { _tag: 'DownloadTraceEvent', source: 'background', stage: 'test', t: 1 },
    'base',
  ],
  ClearDownloadMonitorRequest: [{ _tag: 'ClearDownloadMonitorRequest' }, 'base'],
  HistoryRequest: [{ _tag: 'HistoryRequest' }, 'base'],
  ClearHistoryRequest: [{ _tag: 'ClearHistoryRequest' }, 'base'],
  TransferRecoveryRequest: [{ _tag: 'TransferRecoveryRequest', action: 'inspect' }, 'transfer'],
  DailyBudgetReadRequest: [{ _tag: 'DailyBudgetReadRequest' }, 'base'],
  DailyBudgetResetRequest: [{ _tag: 'DailyBudgetResetRequest' }, 'base'],
  ClearLogRequest: [{ _tag: 'ClearLogRequest' }, 'base'],
  SyncTestRequest: [{ _tag: 'SyncTestRequest' }, 'base'],
  SyncStatusRequest: [{ _tag: 'SyncStatusRequest' }, 'base'],
  CloudConnectRequest: [
    { _tag: 'CloudConnectRequest', provider: 'gdrive', clientId: 'client' },
    'cloud',
  ],
  CloudDisconnectRequest: [{ _tag: 'CloudDisconnectRequest', provider: 'gdrive' }, 'cloud'],
  CloudStatusRequest: [{ _tag: 'CloudStatusRequest' }, 'cloud'],
  CloudRetryRequest: [{ _tag: 'CloudRetryRequest' }, 'cloud'],
  CloudBackfillRequest: [{ _tag: 'CloudBackfillRequest' }, 'cloud'],
  SweepEnqueueRequest: [{ _tag: 'SweepEnqueueRequest', scope: 'bookmark', posts: [] }, 'clear'],
  ClearVisibilityPulse: [{ _tag: 'ClearVisibilityPulse', tweetIds: [] }, 'clear'],
  RecoverTweetMediaRequest: [{ _tag: 'RecoverTweetMediaRequest', tweetId: '1' }, 'base'],
  SavedStatusRequest: [{ _tag: 'SavedStatusRequest', tweetIds: [] }, 'base'],
  CaptureEpochRequest: [{ _tag: 'CaptureEpochRequest' }, 'base'],
  CaptureTweets: [{ _tag: 'CaptureTweets', epoch: 'capture:0', records: [captureRecord] }, 'base'],
  CaptureSummaryRequest: [{ _tag: 'CaptureSummaryRequest' }, 'base'],
  ExportCaptureRequest: [{ _tag: 'ExportCaptureRequest', kind: 'jsonl' }, 'fetched'],
  ClearCaptureRequest: [{ _tag: 'ClearCaptureRequest' }, 'base'],
} as const satisfies ReadinessFixtureByTag

describe('message readiness routing', () => {
  it('decodes and explicitly owns every worker-bound message tag', () => {
    for (const [tag, [raw, domain]] of Object.entries(readinessFixtures)) {
      const decoded = decodeBackgroundRequest(raw)
      expect({ tag, decoded: Result.isSuccess(decoded) }).toEqual({ tag, decoded: true })
      if (Result.isFailure(decoded)) continue
      expect(decoded.success._tag).toBe(tag)
      expect({ tag, domain: messageReadinessDomain(decoded.success) }).toEqual({ tag, domain })
    }
  })

  it('returns an exact failed QueueUpdate for unavailable transfers', () => {
    expect(unavailableMessageReply(message({ _tag: 'DownloadRequest', items: [item] }))).toEqual({
      value: {
        _tag: 'QueueUpdate',
        planned: ['media-1'],
        started: [],
        deferred: [],
        duplicates: [],
        failures: [{ requestId: 'media-1', reason: 'transfer unavailable' }],
        skipped: [],
      },
    })
  })

  it.each([
    [{ _tag: 'ExportCaptureRequest', kind: 'jsonl' }, { _tag: 'CaptureExportUnavailable' }],
    [
      { _tag: 'SweepEnqueueRequest', scope: 'bookmark', posts: [] },
      { _tag: 'SweepEnqueueUnavailable' },
    ],
    [{ _tag: 'ClearVisibilityPulse', tweetIds: [] }, { ok: false }],
    [
      { _tag: 'CloudConnectRequest', provider: 'gdrive', clientId: 'client' },
      { ok: false, detail: 'Cloud uploads are unavailable.' },
    ],
    [{ _tag: 'CloudDisconnectRequest', provider: 'gdrive' }, { ok: false }],
    [{ _tag: 'CloudStatusRequest' }, null],
    [{ _tag: 'CloudRetryRequest' }, { ok: false }],
    [
      { _tag: 'CloudBackfillRequest' },
      { ok: false, queued: 0, detail: 'Cloud uploads are unavailable.' },
    ],
    [
      { _tag: 'SettingsRecoveryRequest', action: 'inspect' },
      { _tag: 'SettingsRecoveryFailure', reason: 'unavailable' },
    ],
  ] as const)('returns the exact unavailable reply for %o', (input, reply) => {
    expect(unavailableMessageReply(message(input))).toEqual({ value: reply })
  })

  it('leaves base-domain failures to their own protocol handlers', () => {
    expect(unavailableMessageReply(message({ _tag: 'HistoryRequest' }))).toBeUndefined()
  })
})
