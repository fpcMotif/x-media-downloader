import { Schema, Effect } from 'effect'
import { TweetRecord } from '@/packages/capture/record'
import { MediaItem, MediaType } from './media'

export { MediaItem, MediaType, Platform } from './media'

export const DownloadStrategyName = Schema.Literals(['direct', 'fetched', 'aria2'])
export const Theme = Schema.Literals(['light', 'dark', 'system'])
export const QuickGrabModifier = Schema.Literals(['alt', 'shift', 'ctrl', 'meta'])
/** `capture`: the MAIN-world passive tee reporting its OWN budget refusals
 *  (`tee-drop`) — a whole feed batch missing from the Detected Media Set is
 *  diagnosable from the Monitor snapshot without a dev build (#92 follow-up). */
export const DownloadTraceSource = Schema.Literals([
  'quickgrab',
  'badge',
  'background',
  'clear',
  'capture',
])

const traceFields = {
  source: DownloadTraceSource,
  stage: Schema.String,
  t: Schema.Number,
  itemId: Schema.optional(Schema.String),
  tweetId: Schema.optional(Schema.String),
  type: Schema.optional(MediaType),
  elapsedMs: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
  // Which tab produced a content-script trace line. Stamped ONLY in the background
  // from `sender.tab?.id` — never sent over the wire by the overlay, so a page script
  // can't forge it. Without it, two open X tabs answering one clear read as a retry in
  // a single tab, and `clear-dispatch`'s `preferHonored=` can't be cross-checked.
  tabId: Schema.optional(Schema.Number),
}
export const DownloadTraceEntry = Schema.Struct(traceFields)
export type DownloadTraceEntry = typeof DownloadTraceEntry.Type

/** The filename template the schema defaults to today. Single source of truth —
 *  both the decoding default below and the legacy-template migration
 *  (`core/settings/template-migration.ts`) read this constant, so a future
 *  default change only has to happen in one place. */
export const CURRENT_DEFAULT_TEMPLATE = '{platform}/{tweetId}_{index}.{ext}'

export const Settings = Schema.Struct({
  filenameTemplate: Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(CURRENT_DEFAULT_TEMPLATE)),
  ),
  downloadConcurrency: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
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
  // Keyboard navigation (Overlay): vim-style j/k post traversal + single-key
  // actions on Threads/Instagram (issue #58). Default on; X stays on its own
  // native shortcuts regardless.
  keyboardNavEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  // Per-media download badge (Overlay fast path): corner badge on hover/lightbox
  // that downloads the one hovered Media Item on click. Default on.
  downloadBadgeEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  // Bottom-left download dock (the "Download all" + rescan stack). Default on.
  downloadDockEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  // Render the dock as translucent "liquid glass" instead of the solid dark pill.
  dockGlassEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  // Timeline "Saved" status (Overlay): mark already-downloaded tweets in the
  // feed so you can see at a glance what's been grabbed. Default on.
  showSavedStatus: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
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
  // media metadata only — never bytes, captures, or auth. Default off: the
  // local-only posture holds until the user explicitly enables it. (Tweet TEXT
  // rides its own separate opt-in mirror — see ADR-0018.)
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
  // Release diagnostics: mutation observation (spec #59 ticket #63, default off).
  // With this on, the MAIN-world tee additionally relays CreateBookmark/
  // DeleteBookmark/FavoriteTweet/UnfavoriteTweet request+response evidence into
  // the durable Release diagnostics log — the H1/H5 discriminators (a server-side
  // reject, or a mutation firing mid-Release). Off ⇒ zero collection; the tee's
  // media-detection path is completely untouched either way.
  releaseMutationDiagnosticsEnabled: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
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
  // Download Admission Gate (opt-in; all default off/zero → gate is a pass-through):
  // a pre-scheduling gate that skips duplicates and filtered / over-budget media.
  // See docs/superpowers/specs/2026-06-27-download-admission-gate-design.md.
  // Per-tweet duplicate prevention; the options UI auto-enables downloadHistoryEnabled
  // (its data source) when this is turned on.
  preventDuplicateDownloads: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
  ),
  // Skip these media types entirely (e.g. ['video']). Empty = no type filter.
  skipTypes: Schema.Array(MediaType).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // Min-resolution filter; 0 = off. Skips media below either dimension when known.
  minWidth: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  minHeight: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  // Per-file size cap in MB (HEAD-probed content-length); 0 = off.
  maxFileSizeMB: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  // Daily budget caps (local calendar day; hard-stop once either is reached); 0 = off.
  dailyMaxMB: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  dailyMaxCount: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  // Knowledge Capture (Tweet Harvest, spec §12): harvest tweet TEXT/metadata off
  // the GraphQL tee into a local store, with an opt-in Convex mirror. All default
  // off — the master gate keeps the capture pipeline dormant until opted in.
  captureEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  captureAllScrolled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  captureMirrorEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
})
export type Settings = typeof Settings.Type

/** Release diagnostics summary (ticket #66) — the SAME shape
 * `computeReleaseCorrelationCounters` (packages/clear/correlate.ts) returns, mirrored
 * here as a schema so it can ride on `MetricsSnapshot` over the wire. Omitted from
 * the snapshot entirely when every field is zero (see the `MetricsRequest` handler in
 * background.ts) — the popup's zero-state renders exactly as it did before this
 * field existed. */
export const ReleaseDiagnosticsSummary = Schema.Struct({
  clears: Schema.Number,
  clearsByBranch: Schema.Struct({
    testid: Schema.Number,
    detached: Schema.Number,
    alreadyCleared: Schema.Number,
  }),
  mutations: Schema.Number,
  serverRejects: Schema.Number,
  reAddFingerprints: Schema.Number,
  reappearances: Schema.Number,
})
export type ReleaseDiagnosticsSummary = typeof ReleaseDiagnosticsSummary.Type

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
  releaseDiagnostics: Schema.optional(ReleaseDiagnosticsSummary),
  // Count of tabs the fan-out has proven dead and stopped probing (tab-broadcaster.ts
  // Part D orphan policy). Omitted at 0 — the popup only shows the advisory when it
  // has something to say.
  staleTabs: Schema.optional(Schema.Number),
})
export type MetricsSnapshot = typeof MetricsSnapshot.Type

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
// Why a download was dropped by the admission gate (mirrors the SkipReason union
// in src/core/download/admission.ts; keep the two literal lists in sync).
export const SkipReason = Schema.Literals([
  'duplicate',
  'filtered-type',
  'too-small',
  'too-big',
  'daily-budget',
])
export type SkipReason = typeof SkipReason.Type
export const QueueUpdate = Schema.TaggedStruct('QueueUpdate', {
  completed: Schema.Number,
  total: Schema.Number,
  // Admission-gate drops aggregated by reason (omitted when nothing was skipped).
  skipped: Schema.optional(
    Schema.Array(Schema.Struct({ reason: SkipReason, count: Schema.Number })),
  ),
  // Requests that failed before any byte moved: URL-validation rejections
  // (fail-closed CDN allow-list) and requests that reached the download
  // strategy but failed to START (the strategy's own DownloadError.reason — a
  // 403/network/CDN failure, not an admission-gate skip). Omitted when nothing
  // failed. Without this, "why didn't this download?" was answerable only from
  // the SW's own console.
  failures: Schema.optional(
    Schema.Array(Schema.Struct({ itemId: Schema.String, reason: Schema.String })),
  ),
})
export type QueueUpdate = typeof QueueUpdate.Type
export const MetricsRequest = Schema.TaggedStruct('MetricsRequest', {})
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
 *  request fail decode at the router, not just by convention. Reused below as the
 *  wire type of `ClearTweetRequest.asPageScope` — both mean "a membership list a
 *  PAGE can own", which `notInterested` (a feed action with no list) never is. */
export const SweepScope = Schema.Literals(['bookmark', 'like'])
export type SweepScope = typeof SweepScope.Type

/** SW → content script: the tweet is Truly Complete on the Worklist — un-bookmark
 *  and/or un-like it in-page (DOM-click X's own control, verify the flip).
 *  `allLists` (the "Clear from every list" setting) lifts the page-scope gate: when
 *  true the content script fires EVERY requested scope the article is actually a
 *  member of, not only the current page's list ("Not interested" stays For-You-only).
 *
 *  `asPageScope` is the ORIGIN page's list scope, supplied by the background ONLY on
 *  the permalink release leg (`/i/web/status/{id}`), which owns no list scope of its
 *  own. Without it a page-scoped release (`allLists` off — the shipped default) has no
 *  page to be scoped to, and membership gating would un-bookmark AND un-like a post the
 *  user meant to drop from one list. The receiver honours it strictly as a FALLBACK for
 *  a page with no scope of its own, never as an override, so it can never widen a real
 *  Likes/Bookmarks tab past its one-mutation-per-page rule. Typed `SweepScope`
 *  (bookmark|like), not `ClearScope`: a permalink page can never be the For You feed, so
 *  a `notInterested` page scope is incoherent and must fail decode at the overlay's gate
 *  rather than depend on the producer's discipline. */
export const ClearTweetRequest = Schema.TaggedStruct('ClearTweetRequest', {
  tweetId: Schema.String,
  scopes: Schema.Array(ClearScope),
  allLists: Schema.optional(Schema.Boolean),
  asPageScope: Schema.optional(SweepScope),
  // Release-leg poll attempts ≥ 2 (background/tab-broadcaster.ts): the tab already
  // proved reachable on attempt 1, so an unmounted answer here is expected noise,
  // not evidence — the receiver skips its own request/not-mounted trace lines and
  // lets the leg's one folded `clear-release-poll` line speak for the whole poll.
  probe: Schema.optional(Schema.Boolean),
})
export type ClearTweetRequest = typeof ClearTweetRequest.Type

const ClearResult = Schema.Struct({
  scope: ClearScope,
  ok: Schema.Boolean,
  noop: Schema.optional(Schema.Boolean),
})

/** Page-state evidence the content script can read even when the target tweet
 *  never mounted — what a release leg polling a dead permalink actually saw,
 *  so it can tell "still loading" from "X served an error block" from "this
 *  page will never mount that post" without guessing off silence. */
const ClearPageEvidence = Schema.Struct({
  articles: Schema.Number, // article[data-testid="tweet"] count
  cells: Schema.Number, // [data-testid="cellInnerDiv"] count — 0 ⇒ nothing rendered at all
  ready: Schema.Literals(['loading', 'interactive', 'complete']),
  error: Schema.Boolean, // [data-testid="error-detail"] present (X's own error block)
})

/** Per-scope outcome, returned via `sendResponse` (not the decoded union).
 *  `noop: true` marks an off-list scope the content script did NOT click (it
 *  reports ok:true only so the in-memory ledger can settle) — the durable sweep
 *  flag must exclude these, treating only a real verified flip as cleared.
 *  `page` is present only on an UNMOUNTED answer — the release leg's only window
 *  into why a permalink never mounted the post. */
export const ClearTweetResponse = Schema.TaggedStruct('ClearTweetResponse', {
  mounted: Schema.Boolean,
  drainEligible: Schema.Boolean,
  results: Schema.Array(ClearResult),
  page: Schema.optional(ClearPageEvidence),
})
export type ClearTweetResponse = typeof ClearTweetResponse.Type

/** SW → content: immediate Clear failed in every tab. The worker authorizes this
 * one list tab to run Scroll Drain and return the terminal per-scope result. */
export const ClearDrainRequest = Schema.TaggedStruct('ClearDrainRequest', {
  tweetId: Schema.String,
  scopes: Schema.Array(ClearScope),
  allLists: Schema.optional(Schema.Boolean),
})
export type ClearDrainRequest = typeof ClearDrainRequest.Type

export const ClearDrainResponse = Schema.TaggedStruct('ClearDrainResponse', {
  results: Schema.Array(ClearResult),
})
export type ClearDrainResponse = typeof ClearDrainResponse.Type

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

/** content → background: which of these tweets are already downloaded? Used by
 *  the timeline "Saved" status overlay to mark grabbed posts in the feed. */
export const SavedStatusRequest = Schema.TaggedStruct('SavedStatusRequest', {
  tweetIds: Schema.Array(Schema.String),
})
export type SavedStatusRequest = typeof SavedStatusRequest.Type

/** background → content: the subset of the queried tweetIds that are saved. */
export const SavedStatusResponse = Schema.TaggedStruct('SavedStatusResponse', {
  saved: Schema.Array(Schema.String),
})
export type SavedStatusResponse = typeof SavedStatusResponse.Type

/** SW → content script (broadcast): LATE cross-device "Saved" hits. The sweep's
 *  reply carries only the locally-known subset (it must never wait on the
 *  Convex round-trip); when the backstop answers, the fresh hits ride this
 *  fire-and-forget push so the chips still land in one sweep. */
export const SavedStatusUpdate = Schema.TaggedStruct('SavedStatusUpdate', {
  saved: Schema.Array(Schema.String),
})
export type SavedStatusUpdate = typeof SavedStatusUpdate.Type

/** content → background: harvested tweet records off the GraphQL tee, mirrored
 *  into the local capture store (+ opt-in Convex). `{ stored }` rides back. */
export const CaptureTweets = Schema.TaggedStruct('CaptureTweets', {
  records: Schema.Array(TweetRecord),
})
export type CaptureTweets = typeof CaptureTweets.Type

/** panel → background: capture-store counts. `{ tweets, conversations, recent }` back.
 *  `limit` caps the `recent` list (absent → the background default; 0 → counts only). */
export const CaptureSummaryRequest = Schema.TaggedStruct('CaptureSummaryRequest', {
  limit: Schema.optional(Schema.Number),
})
export type CaptureSummaryRequest = typeof CaptureSummaryRequest.Type

/** panel → background: build + deliver an export. `{ ok, filename }` back. */
export const ExportCaptureRequest = Schema.TaggedStruct('ExportCaptureRequest', {
  kind: Schema.Literals(['jsonl', 'tree', 'markdown']),
  conversationId: Schema.optional(Schema.String),
})
export type ExportCaptureRequest = typeof ExportCaptureRequest.Type

/** panel → background: wipe the local capture store. `{ cleared }` back. */
export const ClearCaptureRequest = Schema.TaggedStruct('ClearCaptureRequest', {})
export type ClearCaptureRequest = typeof ClearCaptureRequest.Type

/** panel → background: build the Release diagnostics export. { ok, filename, text } back. */
export const ExportDiagnosticsRequest = Schema.TaggedStruct('ExportDiagnosticsRequest', {})
export type ExportDiagnosticsRequest = typeof ExportDiagnosticsRequest.Type

export const ReleaseMutationOp = Schema.Literals([
  'CreateBookmark',
  'DeleteBookmark',
  'FavoriteTweet',
  'UnfavoriteTweet',
])
export type ReleaseMutationOp = typeof ReleaseMutationOp.Type

/** content → background: one X bookmark/like mutation the MAIN-world tee observed
 *  (spec #59 ticket #63) — the H1/H5 evidence (a server-side reject, or a
 *  `CreateBookmark` fired mid-Release). Sent ONLY while
 *  `releaseMutationDiagnosticsEnabled` is on; forwarded into the same durable
 *  Release diagnostics log `ExportDiagnosticsRequest` exports. `status` and
 *  `error` are the failure signals the ordinary media tee drops (it only ever
 *  sees `res.ok`); `tweetId` is best-effort (parsed from the mutation's own
 *  request body, never guaranteed present). */
export const ReleaseMutationEvent = Schema.TaggedStruct('ReleaseMutationEvent', {
  op: ReleaseMutationOp,
  status: Schema.Number,
  error: Schema.Boolean,
  tweetId: Schema.optional(Schema.String),
  t: Schema.Number,
})
export type ReleaseMutationEvent = typeof ReleaseMutationEvent.Type

/** background → content: acknowledges a `ReleaseMutationEvent` — no payload, the
 *  overlay only needs to know the message was received (mirrors the other
 *  fire-and-forget content→background diagnostics sinks, which reply so
 *  `runtime.sendMessage` never hangs on a dead channel). */
export const ReleaseMutationAck = Schema.TaggedStruct('ReleaseMutationAck', {})
export type ReleaseMutationAck = typeof ReleaseMutationAck.Type

// ── Tab-targeted messages (popup → content script, `browser.tabs.sendMessage`) ──
// A DIFFERENT transport from the `Message` union below (`runtime.sendMessage`,
// content/popup → background): these seven tags never enter `Message` —
// the overlay content script decode-gates its inbound dispatch on a union built
// from the same `TAB_MESSAGE_MEMBERS` array as `TabMessage`, plus the few
// broadcast tags it also answers (`entrypoints/overlay.content/handlers.ts`).

/** popup → content: "Drain this page" — hand every currently-detected item to the
 *  download queue. No payload; `{ count }` rides back via `sendResponse`. */
export const DrainPageRequest = Schema.TaggedStruct('DrainPageRequest', {})
export type DrainPageRequest = typeof DrainPageRequest.Type

/** popup → content: the durable one-by-one sweep for the current list page (see
 *  `handleSweepPage`). No payload; `{ ok, queued, skipped, reason? }` rides back. */
export const SweepPageRequest = Schema.TaggedStruct('SweepPageRequest', {})
export type SweepPageRequest = typeof SweepPageRequest.Type

/** popup → content: one-shot "clear this page now" — un-bookmark/un-like every
 *  MOUNTED post. Page-scoped by the content script's own URL read, so no payload;
 *  `{ cleared }` rides back. */
export const ClearVisibleRequest = Schema.TaggedStruct('ClearVisibleRequest', {})
export type ClearVisibleRequest = typeof ClearVisibleRequest.Type

/** popup → content: "clear entire list" — auto-scroll the whole Likes/Bookmarks
 *  list, clearing every post as it mounts. No payload; `{ cleared, reason? }` back. */
export const ClearWholeListRequest = Schema.TaggedStruct('ClearWholeListRequest', {})
export type ClearWholeListRequest = typeof ClearWholeListRequest.Type

/** The seven tab-targeted schemas as ONE shared array: `TabMessage` below and the
 *  overlay's inbound gate (`entrypoints/overlay.content/handlers.ts`) are BOTH
 *  composed from it, so the two unions cannot drift apart. */
export const TAB_MESSAGE_MEMBERS = [
  RefreshMediaUrlRequest,
  ClearTweetRequest,
  ClearDrainRequest,
  ClearVisibleRequest,
  ClearWholeListRequest,
  DrainPageRequest,
  SweepPageRequest,
] as const

/** The full tab-targeted set the overlay content script may receive over
 *  `browser.tabs.sendMessage` — disjoint from `Message` (see the transport note
 *  above). */
export const TabMessage = Schema.Union(TAB_MESSAGE_MEMBERS)
export type TabMessage = typeof TabMessage.Type

export const Message = Schema.Union([
  DownloadRequest,
  QueueUpdate,
  MetricsRequest,
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
  RecoverTweetMediaResponse,
  TransferOutcome,
  SavedStatusRequest,
  SavedStatusResponse,
  SavedStatusUpdate,
  CaptureTweets,
  CaptureSummaryRequest,
  ExportCaptureRequest,
  ClearCaptureRequest,
  ExportDiagnosticsRequest,
  ReleaseMutationEvent,
  ReleaseMutationAck,
])
export type Message = typeof Message.Type
