import { Schema, Effect } from 'effect'

export const MediaType = Schema.Literals(['photo', 'video', 'gif'])

export const MediaItem = Schema.Struct({
  id: Schema.String,
  tweetId: Schema.String,
  handle: Schema.String,
  type: MediaType,
  url: Schema.String,
  previewUrl: Schema.optional(Schema.String),
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
export const DownloadTraceSource = Schema.Literals(['quickgrab', 'badge', 'background', 'clear'])

const traceFields = {
  source: DownloadTraceSource,
  stage: Schema.String,
  t: Schema.Number,
  itemId: Schema.optional(Schema.String),
  tweetId: Schema.optional(Schema.String),
  type: Schema.optional(MediaType),
  elapsedMs: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
}
export const DownloadTraceEntry = Schema.Struct(traceFields)
export type DownloadTraceEntry = typeof DownloadTraceEntry.Type

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
  // Quick Grab (Overlay fast path): hold the modifier and hover one media item to
  // download just that Media Item at Original quality. Default on, Option/Alt.
  quickGrabEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  quickGrabModifier: QuickGrabModifier.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('alt' as const)),
  ),
  // Per-media download badge (Overlay fast path): corner badge on hover/lightbox
  // that downloads the one hovered Media Item on click. Default on.
  downloadBadgeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  // Bottom-left download dock (the "Download all" + rescan stack). Default on.
  downloadDockEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  // Render the dock as translucent "liquid glass" instead of the solid dark pill.
  dockGlassEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  // Auto-show sensitive-content covers (opt-in, default off): when X hides media
  // behind a "Content warning" cover, click its reveal control so the media
  // renders inline. The GraphQL tee already captures sensitive media for bulk
  // download regardless — this is purely about the on-page render, so the DOM
  // hover paths (Quick Grab / badge) and your own eyes can reach it.
  autoRevealSensitiveEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
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
  // Cloud Sync (ADR-0009): opt-in Convex control plane mirroring download
  // metadata only — never bytes, captures, or auth. Default off: the
  // local-only posture holds until the user explicitly enables it.
  cloudSyncEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  convexUrl: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  convexSyncSecret: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  // Stable per-install id tagged onto mirrored events; minted on first enable.
  cloudDeviceId: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  // Durable local download history (opt-in, default off): persist each download's
  // original link + status + provenance to the local store — the local-first twin
  // of Convex `media_state`. Independent of (orthogonal to) Cloud Sync.
  downloadHistoryEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  // Clear-on-complete (worklist self-emptying): once EVERY media item of a
  // bookmarked/liked tweet is Truly Complete, un-bookmark / un-like it via a
  // synthetic click on X's own control. The project's first (irreversible)
  // account mutation. Master defaults OFF — the design's on-by-default posture is
  // contingent on a first-run announcement (spec §8) that isn't built yet, so we
  // require a deliberate opt-in rather than silently mutating on first download.
  clearOnSave: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  // Per-scope toggles (active only while clearOnSave is on); all default on.
  autoUnbookmarkOnSave: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  autoUnlikeOnSave: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  // For You timeline: there is no bookmark/like to remove, so a completed post is
  // cleared by firing X's own "Not interested in this post" (caret menu) — dropping
  // it from the feed so the timeline self-empties too. Scoped to the For You home
  // tab only; never fires on Following, profiles, or search.
  autoNotInterestedOnSave: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  // Cross-list clearing ("Clear from every list", opt-in, default off). Normally a
  // clear acts ONLY on the list the page belongs to (un-like on Likes, un-bookmark
  // on Bookmarks, "Not interested" on For You). With this on, a completed post is
  // removed from EVERY membership it actually has, regardless of the page: un-like
  // a bookmarked post, un-bookmark a liked one, disengage on any timeline — so you
  // can un-bookmark while browsing Likes and un-like while browsing Bookmarks. Each
  // per-scope toggle above still gates whether that action is allowed at all;
  // "Not interested" stays For-You-only (it has no membership to read off-feed).
  // More aggressive than the default, so it ships off until the user opts in.
  clearAllListsOnSave: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  // Cloud upload (ADR-0013): opt-in, CLIENT-SIDE OAuth — uploads the real media
  // BYTES (not links) to your own Google Drive / Dropbox. Bytes go extension →
  // provider directly; nothing transits Convex. Master gate, default off so the
  // local-first posture holds until the user explicitly opts in + connects.
  cloudUploadEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  // Google Drive (PKCE). clientId = OAuth client id; tokens are minted by
  // launchWebAuthFlow and stored here (same posture as aria2Secret/convexSyncSecret).
  // A non-empty refresh token = "connected"; folderId caches the app root folder.
  gdriveClientId: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  gdriveAccessToken: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  gdriveRefreshToken: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  gdriveTokenExpiry: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  gdriveFolderId: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  gdriveAccount: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  // Dropbox (PKCE). clientId = app key.
  dropboxClientId: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  dropboxAccessToken: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  dropboxRefreshToken: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
  dropboxTokenExpiry: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  dropboxAccount: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
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
  events: Schema.optional(Schema.Array(DownloadTraceEntry)),
})
export type MetricsSnapshot = typeof MetricsSnapshot.Type

export const DetectRequest = Schema.TaggedStruct('DetectRequest', { tweetId: Schema.String })
export const MediaDetected = Schema.TaggedStruct('MediaDetected', {
  items: Schema.Array(MediaItem),
})
export const DownloadRequest = Schema.TaggedStruct('DownloadRequest', {
  items: Schema.Array(MediaItem),
  // For the For You "Not interested" clear: the FULL detected media id set per
  // tweet in this batch, so the clear gate waits for the WHOLE post to download —
  // a single grabbed photo must never mark a 4-photo post Truly Complete and hide
  // it, losing the other three. The background widens the clear ledger's `expected`
  // to this set; the un-grabbed ids stay pending, blocking the clear until every
  // photo is grabbed (or Download-all'd). Omitted off the feed, where the grabbed
  // subset gates as before (the page's bookmark/like is what clears there).
  clearExpect: Schema.optional(
    Schema.Array(Schema.Struct({ tweetId: Schema.String, ids: Schema.Array(Schema.String) })),
  ),
})
export const QueueUpdate = Schema.TaggedStruct('QueueUpdate', {
  completed: Schema.Number,
  total: Schema.Number,
})
export const MetricsRequest = Schema.TaggedStruct('MetricsRequest', {})
export const MetricsUpdate = Schema.TaggedStruct('MetricsUpdate', {
  snapshot: MetricsSnapshot,
})
export const DownloadTraceEvent = Schema.TaggedStruct('DownloadTraceEvent', traceFields)

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

// Durable local download history (popup ⇄ background). Requests carry no
// payload; the response records ride back via `sendResponse` (not the decoded
// union) so this schema never has to reference DownloadRecord (avoids a
// schema↔history import cycle).
export const HistoryRequest = Schema.TaggedStruct('HistoryRequest', {})
export type HistoryRequest = typeof HistoryRequest.Type

export const ClearHistoryRequest = Schema.TaggedStruct('ClearHistoryRequest', {})
export type ClearHistoryRequest = typeof ClearHistoryRequest.Type

// Cloud Sync connection probe (popup → background). Runs a real, zero-write
// `recordEvents` ping against the configured deployment so the user sees why
// sync fails (bad URL / secret / missing host permission) instead of a silent
// backoff. The `{ ok, detail, pending }` result rides back via `sendResponse`.
export const SyncTestRequest = Schema.TaggedStruct('SyncTestRequest', {})
export type SyncTestRequest = typeof SyncTestRequest.Type

// Read-only twin: returns the last recorded drain outcome (no network), so the
// popup surfaces a stuck sync the moment it opens.
export const SyncStatusRequest = Schema.TaggedStruct('SyncStatusRequest', {})
export type SyncStatusRequest = typeof SyncStatusRequest.Type

// Cloud upload (ADR-0013). Single source of truth for the provider enumeration:
// `core/cloud/types` derives `CloudProviderId` from this (cloud → schema, never
// the reverse, so schema stays free of cloud imports).
export const CLOUD_PROVIDERS = ['gdrive', 'dropbox'] as const
export const CloudProvider = Schema.Literals(CLOUD_PROVIDERS)
export type CloudProvider = typeof CloudProvider.Type

// popup → background: run the PKCE OAuth flow for a provider in the SW (survives
// the popup closing on focus loss), store the tokens. The client id rides with
// the request so the popup never writes token/clientId settings itself
// (single-writer, ADR-0005). Reply rides via sendResponse.
export const CloudConnectRequest = Schema.TaggedStruct('CloudConnectRequest', {
  provider: CloudProvider,
  clientId: Schema.String,
})
export type CloudConnectRequest = typeof CloudConnectRequest.Type

// popup → background: clear a provider's stored tokens (disconnect).
export const CloudDisconnectRequest = Schema.TaggedStruct('CloudDisconnectRequest', {
  provider: CloudProvider,
})
export type CloudDisconnectRequest = typeof CloudDisconnectRequest.Type

// popup → background: read the upload-ledger summary + last error (no network).
export const CloudStatusRequest = Schema.TaggedStruct('CloudStatusRequest', {})
export type CloudStatusRequest = typeof CloudStatusRequest.Type

// popup → background: resurrect dead/failed upload jobs and kick the drain.
export const CloudRetryRequest = Schema.TaggedStruct('CloudRetryRequest', {})
export type CloudRetryRequest = typeof CloudRetryRequest.Type

// popup → background: enqueue cloud uploads for already-downloaded media, read
// from the durable download-history store (the "sync my existing library" path).
export const CloudBackfillRequest = Schema.TaggedStruct('CloudBackfillRequest', {})
export type CloudBackfillRequest = typeof CloudBackfillRequest.Type

/** SW → content script: look up a fresh CDN url before an interrupt retry. */
export const RefreshMediaUrlRequest = Schema.TaggedStruct('RefreshMediaUrlRequest', {
  itemId: Schema.String,
  tweetId: Schema.String,
  index: Schema.optional(Schema.Number),
  type: Schema.optional(MediaType),
})
export type RefreshMediaUrlRequest = typeof RefreshMediaUrlRequest.Type

export const RefreshMediaUrlResponse = Schema.TaggedStruct('RefreshMediaUrlResponse', {
  url: Schema.optional(Schema.String),
})
export type RefreshMediaUrlResponse = typeof RefreshMediaUrlResponse.Type

export const ClearScope = Schema.Literals(['bookmark', 'like', 'notInterested'])
export type ClearScope = typeof ClearScope.Type

/** The membership scopes a MANUAL sweep may target. Deliberately excludes
 *  `notInterested`: the one-by-one/"clear this page" buttons are list-only, so a
 *  button can never fire "Not interested" across a whole feed. Narrowing the WIRE
 *  type (not just the producer) makes a forged/future `notInterested` sweep
 *  request fail decode at the router, not just by convention. */
export const SweepScope = Schema.Literals(['bookmark', 'like'])
export type SweepScope = typeof SweepScope.Type

/** SW → content script: the tweet is Truly Complete on the Worklist — un-bookmark
 *  and/or un-like it in-page (DOM-click X's own control, verify the flip).
 *  `allLists` (the "Clear from every list" setting) lifts the page-scope gate: when
 *  true the content script fires EVERY requested scope the article is actually a
 *  member of, not only the current page's list ("Not interested" stays For-You-only). */
export const ClearTweetRequest = Schema.TaggedStruct('ClearTweetRequest', {
  tweetId: Schema.String,
  scopes: Schema.Array(ClearScope),
  allLists: Schema.optional(Schema.Boolean),
})
export type ClearTweetRequest = typeof ClearTweetRequest.Type

/** Per-scope outcome, returned via `sendResponse` (not the decoded union).
 *  `noop: true` marks an off-list scope the content script did NOT click (it
 *  reports ok:true only so the in-memory ledger can settle) — the durable sweep
 *  flag must exclude these, treating only a real verified flip as cleared. */
export const ClearTweetResponse = Schema.TaggedStruct('ClearTweetResponse', {
  results: Schema.Array(
    Schema.Struct({
      scope: ClearScope,
      ok: Schema.Boolean,
      noop: Schema.optional(Schema.Boolean),
    }),
  ),
})
export type ClearTweetResponse = typeof ClearTweetResponse.Type

/** content → background: the durable one-by-one sweep. The content script hands
 *  the detected member posts for the current list page; the background skips
 *  already-cleared tweets (durable worklist flag), marks the rest queued, and
 *  fires their downloads into the queue. The clear itself still rides the
 *  verified Settle pipeline — the sweep never clicks anything. */
export const SweepEnqueueRequest = Schema.TaggedStruct('SweepEnqueueRequest', {
  scope: SweepScope,
  posts: Schema.Array(Schema.Struct({ tweetId: Schema.String, items: Schema.Array(MediaItem) })),
})
export type SweepEnqueueRequest = typeof SweepEnqueueRequest.Type

/** `{ queued, skipped }` rides back via `sendResponse`. */
export const SweepEnqueueResponse = Schema.TaggedStruct('SweepEnqueueResponse', {
  queued: Schema.Number,
  skipped: Schema.Number,
})
export type SweepEnqueueResponse = typeof SweepEnqueueResponse.Type

/** content → background: recover a tweet's media via X's public syndication
 *  endpoint — the fallback for a video the passive tee never captured (an SPA
 *  cache hit / lazy reply), where the DOM exposes the player but never the MP4.
 *  The background builds the URL from this digits-only id and fetches it. */
export const RecoverTweetMediaRequest = Schema.TaggedStruct('RecoverTweetMediaRequest', {
  tweetId: Schema.String,
})
export type RecoverTweetMediaRequest = typeof RecoverTweetMediaRequest.Type

/** `{ body }` (the raw syndication JSON) rides back via `sendResponse`; omitted
 *  on any fetch failure. The content script parses it (`parseSyndicationTweet`). */
export const RecoverTweetMediaResponse = Schema.TaggedStruct('RecoverTweetMediaResponse', {
  body: Schema.optional(Schema.String),
})
export type RecoverTweetMediaResponse = typeof RecoverTweetMediaResponse.Type

/** SW → content script: a tracked browser transfer reached its TERMINAL outcome
 *  (bytes landed / 403 / timeout) AFTER the start ack. The overlay marks the badge
 *  saved the instant a download is handed to the browser; this lets the background
 *  correct that optimistic state with the real result. Fire-and-forget — broadcast
 *  to every open X tab, a no-op on any tab whose entrance has moved on or is dead.
 *  `requestId` is the `SaveRequest.id` (== the source `MediaItem.id`). */
export const TransferOutcome = Schema.TaggedStruct('TransferOutcome', {
  requestId: Schema.String,
  outcome: Schema.Literals(['complete', 'failed']),
  at: Schema.Number,
})
export type TransferOutcome = typeof TransferOutcome.Type

export const Message = Schema.Union([
  DetectRequest,
  MediaDetected,
  DownloadRequest,
  QueueUpdate,
  MetricsRequest,
  MetricsUpdate,
  DownloadTraceEvent,
  ClearDetectedMediaRequest,
  ClearDownloadMonitorRequest,
  HistoryRequest,
  ClearHistoryRequest,
  SyncTestRequest,
  SyncStatusRequest,
  CloudConnectRequest,
  CloudDisconnectRequest,
  CloudStatusRequest,
  CloudRetryRequest,
  CloudBackfillRequest,
  SweepEnqueueRequest,
  RecoverTweetMediaRequest,
  TransferOutcome,
])
export type Message = typeof Message.Type
