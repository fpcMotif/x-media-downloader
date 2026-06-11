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

/** Which saved-tweets timeline an Archive run drains. */
export const ArchiveSource = Schema.Literals(['bookmarks', 'likes'])
export type ArchiveSource = typeof ArchiveSource.Type

/** Which of a tweet's external links the history record keeps. */
export const ArchiveLinkScope = Schema.Literals(['all', 'scholarly', 'none'])
export type ArchiveLinkScope = typeof ArchiveLinkScope.Type

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
  // Bookmarks & Likes archive: per-tweet history records saved with the media.
  archiveIncludeText: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  archiveLinkScope: ArchiveLinkScope.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('all' as const)),
  ),
  // Destructive: after a tweet archives, click X's own remove-bookmark/unlike
  // button for it. Opt-in only, like the auth fallback.
  archiveRemoveAfterSave: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
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

/**
 * One saved tweet as captured from a Bookmarks/Likes timeline response: the
 * archive unit. `links` are the expanded external URLs from the tweet's
 * entities; whether text/links reach the history record is decided at archive
 * time by the Settings, not at capture time.
 */
export const TweetCapture = Schema.Struct({
  tweetId: Schema.String,
  handle: Schema.String,
  text: Schema.optional(Schema.String),
  createdAt: Schema.optional(Schema.String),
  links: Schema.Array(Schema.String),
  media: Schema.Array(MediaItem),
})
export type TweetCapture = typeof TweetCapture.Type

export const ArchiveRequest = Schema.TaggedStruct('ArchiveRequest', {
  source: ArchiveSource,
  tweets: Schema.Array(TweetCapture),
})
export type ArchiveRequest = typeof ArchiveRequest.Type

/** Per-tweet archive outcome. `alreadyArchived` = skipped idempotently (saved
 *  by an earlier session); `ok` covers both "saved now" and "saved before". */
export const ArchiveTweetResult = Schema.Struct({
  tweetId: Schema.String,
  ok: Schema.Boolean,
  completed: Schema.Number,
  total: Schema.Number,
  alreadyArchived: Schema.Boolean,
})
export type ArchiveTweetResult = typeof ArchiveTweetResult.Type

export const ArchiveResponse = Schema.TaggedStruct('ArchiveResponse', {
  sessionId: Schema.String,
  results: Schema.Array(ArchiveTweetResult),
})
export type ArchiveResponse = typeof ArchiveResponse.Type

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
  ArchiveRequest,
  ClearDetectedMediaRequest,
  ClearDownloadMonitorRequest,
])
export type Message = typeof Message.Type
