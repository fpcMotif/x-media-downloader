import { Schema, Effect } from 'effect'

export const MediaType = Schema.Literals(['photo', 'video', 'gif'])

export const MediaItem = Schema.Struct({
  id: Schema.String,
  tweetId: Schema.String,
  handle: Schema.String,
  type: MediaType,
  url: Schema.String,
  ext: Schema.String,
  index: Schema.Number,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  bitrate: Schema.optional(Schema.Number),
})
export type MediaItem = typeof MediaItem.Type

export const DownloadStrategyName = Schema.Literals(['direct', 'fetched', 'aria2'])
export const Theme = Schema.Literals(['light', 'dark', 'system'])
export const QuickGrabModifier = Schema.Literals(['alt', 'shift', 'ctrl', 'meta'])

export const Settings = Schema.Struct({
  filenameTemplate: Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('{handle}/{tweetId}_{index}.{ext}')),
  ),
  downloadConcurrency: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
  authFallbackEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  downloadStrategy: DownloadStrategyName.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('direct' as const)),
  ),
  theme: Theme.pipe(Schema.withDecodingDefaultKey(Effect.succeed('system' as const))),
  // Quick Grab (Overlay fast path): hold the modifier and hover one photo to
  // download just that Media Item at Original quality. Default on, Option/Alt.
  quickGrabEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  quickGrabModifier: QuickGrabModifier.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('alt' as const)),
  ),
  // Write a per-item `.json` sidecar (author/url/tweetId/type) next to each file (D).
  sidecarMetadata: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  // aria2 opt-in backend (C). Requests `http://localhost/*` via optional permissions.
  aria2RpcUrl: Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('http://localhost:6800/jsonrpc')),
  ),
  aria2Secret: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  aria2Dir: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  aria2Split: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(8))),
})
export type Settings = typeof Settings.Type

/**
 * Download-efficiency snapshot (B). A pure projection of timestamped byte
 * samples + state transitions; `core/download/metrics.ts` produces it and the
 * background SW persists the latest to `storage.session` for the popup to poll.
 */
export const MetricsSnapshot = Schema.Struct({
  total: Schema.Number,
  completed: Schema.Number,
  failed: Schema.Number,
  active: Schema.Number,
  retries: Schema.Number,
  concurrencyCap: Schema.Number,
  bytesReceived: Schema.Number,
  bytesTotal: Schema.Number,
  throughputBps: Schema.Number,
  etaSeconds: Schema.optional(Schema.Number),
  elapsedMs: Schema.Number,
})
export type MetricsSnapshot = typeof MetricsSnapshot.Type

export const DetectRequest = Schema.TaggedStruct('DetectRequest', { tweetId: Schema.String })
export const MediaDetected = Schema.TaggedStruct('MediaDetected', {
  items: Schema.Array(MediaItem),
})
export const DownloadRequest = Schema.TaggedStruct('DownloadRequest', {
  items: Schema.Array(MediaItem),
})
export const QueueUpdate = Schema.TaggedStruct('QueueUpdate', {
  completed: Schema.Number,
  total: Schema.Number,
})
export const MetricsRequest = Schema.TaggedStruct('MetricsRequest', {})
export const MetricsUpdate = Schema.TaggedStruct('MetricsUpdate', {
  snapshot: MetricsSnapshot,
})

export const ClearDetectedMediaRequest = Schema.TaggedStruct('ClearDetectedMediaRequest', {
  rescanVisible: Schema.optional(Schema.Boolean),
})
export type ClearDetectedMediaRequest = typeof ClearDetectedMediaRequest.Type

export const ClearDetectedMediaResponse = Schema.TaggedStruct('ClearDetectedMediaResponse', {
  cleared: Schema.Number,
  rescanned: Schema.Number,
})
export type ClearDetectedMediaResponse = typeof ClearDetectedMediaResponse.Type

export const ClearDownloadMonitorRequest = Schema.TaggedStruct('ClearDownloadMonitorRequest', {
  clearStaleLocks: Schema.optional(Schema.Boolean),
})
export type ClearDownloadMonitorRequest = typeof ClearDownloadMonitorRequest.Type

export const ClearDownloadMonitorResponse = Schema.TaggedStruct('ClearDownloadMonitorResponse', {
  ok: Schema.Boolean,
  active: Schema.Number,
  clearedMetrics: Schema.Boolean,
  clearedLocks: Schema.Number,
  reason: Schema.optional(Schema.String),
})
export type ClearDownloadMonitorResponse = typeof ClearDownloadMonitorResponse.Type

export const Message = Schema.Union([
  DetectRequest,
  MediaDetected,
  DownloadRequest,
  QueueUpdate,
  MetricsRequest,
  MetricsUpdate,
  ClearDetectedMediaRequest,
  ClearDownloadMonitorRequest,
])
export type Message = typeof Message.Type
