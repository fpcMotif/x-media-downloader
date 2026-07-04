# Multi-platform adapter abstraction — as-built record

> Implements docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md (commit 774c7b1).

**Status: BUILT.** `bun run check` green (95 test files, 1129 tests, 100% coverage over `src/core`+`src/lib`), `bun run build` green, backend `bun run test` green (45 tests).

## What changed

**Domain model** (`src/core/schema/index.ts`): `MediaItem.tweetId`→`postId`, `.handle`→`.author`, new required `platform: 'x'|'instagram'|'threads'` field (new `Platform` schema export). `src/core/sync/events.ts`'s `SyncMediaMeta` (the direct Convex `media` mirror) renamed identically + gained `platform`.

**Compiler-guided rename, not a hand-authored file list.** The schema change was made first, then `bun run typecheck` enumerated every real call site precisely — this is more reliable than grepping for `tweetId`/`handle`, since most textual hits (worklist/clear-ledger/capture/tab-broadcaster/saved-status/selection's `TweetGroup`) are **independent, deliberately-unrenamed** concepts that only happen to share the old field names:
- `core/clear/*`, `core/capture/*` (Knowledge Capture/TweetRecord), `TweetGroup.tweetId` (core/selection.ts) — untouched. Clear-on-save and text capture stay X-only by design (spec Non-goals); `TweetGroup` is its own independent grouping key.
- Wire-message field NAMES that reference a post by id (`ClearTweetRequest.tweetId`, `RefreshMediaUrlRequest`/`TabMessagingPort.tweetId`, `SweepEnqueueRequest`, `RecoverTweetMediaRequest`, `DownloadTraceEntry.tweetId`, sidecar JSON's `handle`/`tweetId` keys) **kept their old names** — only the VALUE assigned to them changed (`item.postId` instead of `item.tweetId`). This is the same "keep the wire shape, change the source" pattern as the filename-template aliases.
- Every genuine `MediaItem`/`SyncMediaMeta` field access DID change: `core/resolver/index.ts`, `core/adapters/x/{index,dom,detection-store}.ts`, `core/download/{admission,destination,filename,media-url-refresh}.ts`, `core/sync/events.ts`, `background/{admission-gate,cloud-upload}.ts` (call-site mapping only, cloud-upload.ts's own `UploadCandidate.handle` interface left alone), `entrypoints/background.ts`, `entrypoints/overlay.content/{handlers.ts,index.tsx}`, `entrypoints/popup/history-section.ts`. Plus every test fixture constructing/reading a `MediaItem`/`SyncMediaMeta` literal (19 test files).

**Filename template aliasing** (`core/download/filename.ts`): `{handle}`/`{tweetId}` are now permanent aliases for `{author}`/`{postId}`; `{platform}` is a new available placeholder. Default template and existing saved templates are unchanged.

**Adapter interface + registry** (new):
- `core/adapters/types.ts` — the `PlatformAdapter` interface.
- `core/adapters/x/tracked-response.ts` — `isGraphqlMediaUrl` relocated here from `entrypoints/inject/tee.ts` (which now just re-exports it), consolidating X's full detection surface into `core/adapters/x/`. Widened signature (`url, requestHeaders?`) per the design's Instagram/Threads header-matching need; X's implementation ignores the second param.
- `core/adapters/x/adapter.ts` — `xAdapter: PlatformAdapter`, a thin composition over the *unchanged* existing X functions (`index.ts`/`dom.ts`/`walk.ts`/`resolve.ts`/`syndication.ts`) — zero internal X-adapter logic moved or rewritten.
- `core/adapters/registry.ts` — `ALL_ADAPTERS`, `adapterForUrl` (URL-keyed, for `background.ts`'s multi-tab dispatch), `adapterForHostname` (hostname-keyed, for a content script's boot-time single-adapter selection).
- `core/adapters/meta-shared/media-node.ts` — the structural `image_versions2`/`video_versions`/`carousel_media` walker for the (not-yet-built) Instagram/Threads adapters to share, built and fully tested as a standalone module now per the spec.

**Convex backend** (`backend/convex/schema.ts`, `sync.ts`): additive, backward-compatible schema change — `media`/`media_state` gain optional `platform`/`postId`/`author` alongside the still-present optional `tweetId`/`handle` (both sides optional, per the existing `media_state.tweetId` precedent, so a schema push never breaks on old stored rows). New indexes `by_post`/`by_platform_post`. `materializeState` seeds both old and new columns on every write. New migration mutation `backfillPlatformFields` (mirrors the existing `backfillTweetId` migration) + verification query `platformBackfillRemaining` — **not yet run against a live deployment**; that's this migration's "deploy 1" landing in code, execution is a separate, user-initiated step. Deploy 2 (drop `tweetId`/`handle`, require the new columns) is explicitly future work, gated on `platformBackfillRemaining` returning 0.

## Deliberately NOT done here (per spec's Non-goals / Out-of-scope)

- No Instagram or Threads adapter (no real detection/DOM logic for either platform).
- No `wxt.config.ts` host-permission or content-script `matches` widening (nothing needs those domains yet).
- No clear-on-save equivalent, no Knowledge Capture extension, no Stories support.
- The Convex migration mutations exist but have not been run/deployed.

## Verification

- `bun run check` (format + lint + typecheck + tests): green.
- `bun run test:coverage`: 100% statements/branches/functions/lines over `src/core`+`src/lib`.
- `bun run build`: produces a valid `.output/chrome-mv3` bundle.
- `cd backend && bun run test` / `test:coverage`: 45 tests green; the two remaining backend branch-coverage gaps (`sync.ts:164`, `captures.ts:25`) are pre-existing and untouched by this change (confirmed via diff).
- NOT browser-verified (no live Chrome extension reload/manual click-through).

## Instagram + Threads adapters (built)

**Status: BUILT, registered, uncommitted→committed this pass.** `src/core/adapters/instagram/adapter.ts` and `src/core/adapters/threads/adapter.ts` now implement `PlatformAdapter`, sharing detection logic through two new `meta-shared/` modules:

- `meta-shared/post-node.ts` — structural "find post-shaped objects anywhere in a JSON tree" walker, keyed on a node carrying both `code` (string) and `user.username` (string). Recurses into nested post-shaped nodes for free, which is how Threads' `reposted_post`/`quoted_post` resolve as independent `MediaItem`s with zero Threads-specific unwrapping code — the generic recursive walk finds them as their own post-shaped nodes.
- `meta-shared/detect.ts` — combines `post-node.ts` + the already-built `media-node.ts` into `detectMediaItems(json, platform)`, the full `detectFromResponse` pipeline both adapters call, parameterized only by the `platform` tag.

**Both adapters:**
- Instagram: `matchesUrl`/`hostMatch` = `www.instagram.com` only (no bare-domain redirect target, unlike X's two hosts). `isTrackedResponseUrl` matches `/graphql/query` OR `/api/v1/` (both surfaces Instagram's web client hits, per research), deliberately loose since detection is shape-driven, not URL-driven — a false-positive URL match only costs one wasted parse that returns `[]`. No repost/quote concept exists on Instagram (confirmed by research), so no unwrapping logic was needed there.
- Threads: `hostMatch` covers both `www.threads.net` and `www.threads.com` (April 2025 domain migration, same backend behind the redirect — one adapter, no per-domain branching). `isTrackedResponseUrl` matches `/api/graphql` (doc_id-dispatched persisted queries, no human-readable op name to filter on the way X's tee does), same "loose is safe" reasoning as Instagram. Repost (`reposted_post`) and quote-post (`quoted_post`) both resolve correctly under their own `postId`, proven by dedicated tests, not just asserted in comments.

**DOM-resolution decision (both adapters): tee-map-only, no independent DOM fallback.** `detectRenderedMedia` returns `[]` unconditionally; `resolveHoverItem`/`canResolveHoverItem` only ever look up the network-tee-populated `detected` map. This was a deliberate choice, not a shortcut two ways:
1. The design spec's own Open Questions flag both platforms' video hover/poster DOM idiom as unverified, needing live DevTools inspection.
2. Unlike X's `pbs.twimg.com`/`video.twimg.com` (a CDN URL scheme independently verified over years, letting X's DOM path do quality-upgradable resolution), no CDN URL scheme here has been live-verified. A guessed selector risks resolving to nothing, or to the wrong image, on click — worse than admitting the gap, because a guessed-but-wrong DOM resolver *looks* like real functionality while tee-map-only visibly fails closed until the network tee has actually seen the media.

Neither adapter implements `findMediaNeedingRecovery` — both platforms' oEmbed endpoints are Meta-app-registration-gated, so no public/no-auth recovery fallback exists (confirmed by research, matching the design spec's `PlatformAdapter` interface comment, not merely left unbuilt).

**Registry wiring:** `core/adapters/registry.ts`'s `ALL_ADAPTERS` now lists `[xAdapter, instagramAdapter, threadsAdapter]`; `registry.test.ts` gained coverage asserting `adapterForUrl`/`adapterForHostname` resolve `instagram.com`/`threads.net`/`threads.com` to the correct adapter and never to `xAdapter`, and that an X url/hostname never resolves to the new adapters.

**Everything here is research-informed (2024–2025 reverse-engineering write-ups), not live-verified** — no browser access exists in this environment to confirm against a real Instagram/Threads session. Structurally sound per research; needs live verification (network tab + DOM inspection) before anyone treats a specific endpoint match, header name, or DOM selector decision as confirmed working.

**Deliberately NOT done in this pass, and why:**
- `wxt.config.ts` host permissions and the two content-scripts' `matches` arrays (`inject.content.ts`, `overlay.content/index.tsx`) were **not** widened. Both content scripts currently import X's adapter functions directly and have zero registry-dispatch wiring — widening host permissions/matches now would inject a script on Instagram/Threads pages that does nothing useful (no DOM resolution wired up, the tee not connected to the registry), which is worse than not injecting at all.
- No clear-on-save equivalent, no Knowledge Capture extension, no Instagram Stories support — all explicitly out of scope per the design spec's Non-goals.

## Next concrete step

Rewire `background.ts` + `inject.content.ts` + `overlay.content/index.tsx` to dispatch via `core/adapters/registry.ts`'s `adapterForHostname`/`adapterForUrl` instead of hardcoded X imports. Only after that rewiring lands does widening `wxt.config.ts` host permissions and the content-script `matches` arrays to include Instagram/Threads become useful rather than inert.

## Other next steps (separate plans, not started)

1. Run the Convex migration (`backfillPlatformFields` → verify `platformBackfillRemaining` = 0 → deploy-2 schema push dropping `tweetId`/`handle`).
2. Live-verify Instagram's and Threads' actual network shapes/DOM selectors against a real session (per the design spec's Open Questions) — the adapters built here are structurally sound per research but unconfirmed live.
