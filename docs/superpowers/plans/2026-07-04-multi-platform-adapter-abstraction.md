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

## Next steps (separate plans, not started)

1. Instagram adapter (live DOM/network verification required — the design spec's endpoint/selector research is a 2024–2025 snapshot, not a working config).
2. Threads adapter (same caveat; shares `meta-shared/` with Instagram).
3. Run the Convex migration (`backfillPlatformFields` → verify `platformBackfillRemaining` = 0 → deploy-2 schema push dropping `tweetId`/`handle`).
4. `wxt.config.ts` host permissions + content-script `matches` widening, once an adapter actually needs them.
