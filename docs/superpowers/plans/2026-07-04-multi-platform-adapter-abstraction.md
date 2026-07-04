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

## Content-script registry rewiring + host permission widening (built)

**Status: BUILT.** `bun run check` green (98 test files, 1185 tests, oxfmt/oxlint/tsgo clean), `bun run test:coverage` 100% statements/branches/functions/lines over `src/core`+`src/lib`, `bun run build` green (manifest confirmed below), backend `bun run test` green (45 tests).

This closes out the "Next concrete step" from the previous section: both content scripts now dispatch through `core/adapters/registry.ts` instead of hardcoding X, and `wxt.config.ts` widened to match. No `PlatformAdapter` interface changes were needed — the interface shape defined earlier already covered every call site these two files needed.

**`src/entrypoints/inject.content.ts`** (MAIN-world tee, 68 lines): `matches` is now `[...new Set(ALL_ADAPTERS.flatMap((a) => a.hostMatch))]` instead of `[...X_HOST_MATCH]`. At `main()` start it resolves `adapterForHostname(location.hostname)` once and fails closed (`if (!adapter) return`) — an unrecognized host tees nothing, matching the registry's documented "undefined is the common case" contract. The one behavioral dispatch point, `isGraphqlMediaUrl(url)`, became `adapter.isTrackedResponseUrl(url)`. `src/entrypoints/inject/tee.ts` + its test (the old home of `isGraphqlMediaUrl`) are deleted — the function already lived in `core/adapters/x/tracked-response.ts` per the prior pass, and this file was the last remaining re-export shim; nothing else imported it (`rg` confirms zero remaining references to `inject/tee` anywhere in `src/`).

**`src/entrypoints/overlay.content/index.tsx`** (ISOLATED-world overlay, 1666 lines, still 0% automated coverage — see caveat below): same `matches` widening + boot-time `adapterForHostname` resolution, closed over as `adapter` for the rest of `main()` (resolved once, not per-call, per the design spec's stated hot-path constraint). Exactly five call sites were rewired to `adapter.*`, all of them the platform-dispatch surface the `PlatformAdapter` interface exists for:
- `adapter.detectRenderedMedia(document, location.pathname)` — 3 call sites (`scanRenderedMedia`, `onRescanClick`, and via `handlerDeps` passed into `handlers.ts`), replacing the hardcoded `detectRenderedImageElements`.
- `adapter.resolveHoverItem(...)` — 2 call sites (`fireGrab`, `onBadgeClick`), replacing the hardcoded `resolveHoverItem` import.
- `adapter.canResolveHoverItem(...)` — 1 call site (`badgeInput`), replacing the hardcoded `canResolveHoverItem` import.
- `adapter.detectFromResponse(detail.path, json)` — 1 call site (the `xmd:media-response` listener), replacing the hardcoded `detectFromJson`.
- `adapter.platform` appended to the existing boot console marker (`console.info('[XMD] overlay content script loaded @', location.href, adapter.platform)`) — a debugging aid, not a behavior change.

Everything else in the file is untouched. In particular, every X-only feature stayed as a direct, unconditional import from `core/adapters/x/*` / `core/clear/*` / `core/capture/*` — never routed through `adapter.*`, never gated behind `if (adapter.platform === 'x')`:
- `clickSensitiveReveals` (`core/adapters/x/reveal`) — sensitive-content auto-reveal.
- `parseSyndicationTweet` (`core/adapters/x/syndication`) — video-recovery fallback parsing.
- `harvestTweets` (`core/capture/harvest`) — Knowledge Capture text harvest.
- `clearScope`/`clearNotInterested`/every `core/clear/clearer` import (`clearControl`, `isMember`, `tweetIdOfArticle`, `TWEET_ARTICLE_SEL`, `caretControl`, `findFeedbackButton`, `notInterestedConfirmed`, `isForYouHome`, etc.) — clear-on-save / worklist / "Not interested".
- `makeScrollDrain` (`core/clear/scroll-drain`) and `makeListClear` (via `handlers.ts`) — the auto-scroll drain and whole-list clear.
- `sweepSavedStatus`/`savedStatusVisible` (`./handlers`) — cross-device "Saved ✓" chip sweep, itself built on X-only `TWEET_ARTICLE_SEL`/`tweetIdOfArticle`.

These functions have no equivalent in `PlatformAdapter` by design (confirmed against both the design spec's Non-goals and the interface file itself) — there was nothing to "route through the registry" for them because the registry was never meant to carry them. On Instagram/Threads, none of this code path executes anyway (the overlay never even reaches these call sites for a feature gated on X-specific DOM, since the DOM it's looking for doesn't exist there) and on X it runs exactly as before, unconditionally, with zero new branching introduced around it.

**`src/entrypoints/overlay.content/handlers.ts`**: `HandlerDeps` gained one new field, `adapter: PlatformAdapter`, threaded in from `index.tsx`'s boot-time resolution. Exactly two call sites that previously hardcoded `detectRenderedImageElements` (imported directly from `core/adapters/x`) now call `deps.adapter.detectRenderedMedia(...)` instead: `handleRefreshMediaUrl` (background-initiated CDN url refresh before an interrupt retry) and `handleClearDetectedMedia` (popup "Clear detected media" with `rescanVisible`). Both are DOM-rendered-media rescans, i.e. exactly the kind of platform-specific logic the interface exists to generalize — not X-only-forever features. No other handler in this file touches `deps.adapter`; every clear-on-save handler (`handleClearVisible`, `handleClearWholeList`, `handleDrainPage`, `handleSweepPage`, `handleClearTweet`, `clearMountedTweet`) still imports directly from `core/clear/clearer` and is unconditionally X-shaped (`pageScope`, `isMember`, `TWEET_ARTICLE_SEL`, etc. — all X DOM concepts with no Instagram/Threads equivalent). `handlers.test.ts` was not modified — its existing `makeDeps` helper casts through `as unknown as HandlerDeps`, so the new required `adapter` field doesn't break any existing test; the two rewired handlers aren't exercised in a way that reads `deps.adapter` in this test file today (pre-existing gap, not introduced here — see coverage caveat below).

**`wxt.config.ts`**: `host_permissions` gained `https://www.instagram.com/*`, `https://www.threads.net/*`, `https://www.threads.com/*`, required (not optional) — matching the design spec's stated posture and the existing X pair's precedent. `optional_host_permissions` untouched.

**Manifest verified post-build** (`.output/chrome-mv3/manifest.json`): both `content_scripts` entries (`inject.js` MAIN-world and `overlay.js` ISOLATED-world) now list `x.com`, `twitter.com`, `www.instagram.com`, `www.threads.com`, `www.threads.net` in `matches`; `host_permissions` lists the same five (plus `cdn.syndication.twimg.com`, X-only, unchanged).

**`background.ts` — deliberately untouched, confirmed not just assumed.** It imports exactly one adapter-related symbol, `syndicationUrl` from `core/adapters/x/syndication` (X-only video-recovery fallback), unchanged by this pass. `rg` over the file confirms zero other `adapters/x`, `adapters/registry`, or `adapters/types` references. `background.ts` operates purely on already-resolved `MediaItem[]`/wire messages the content scripts send it — and the content scripts are responsible for only ever sending X-only messages (`RecoverTweetMediaRequest`, `ClearTweetRequest`, `SweepEnqueueRequest`, `CaptureTweets`, etc.) when actually running on X, which they still do unconditionally per the above. No registry dispatch was needed or added in `background.ts`.

**`PlatformAdapter` interface**: unchanged. Every call site this pass needed (`detectRenderedMedia`, `resolveHoverItem`, `canResolveHoverItem`, `detectFromResponse`, `isTrackedResponseUrl`, `hostMatch`, `platform`) already existed on the interface from the prior abstraction pass.

### What this means for Instagram/Threads today

With the tee (`inject.content.ts`) and the overlay (`overlay.content/index.tsx`) both now boot-dispatching via the registry, and `wxt.config.ts`/the manifest granting the hosts, the content scripts actually inject and run on Instagram/Threads pages for the first time. Concretely:
- The MAIN-world tee will capture and parse Instagram/Threads network responses (`detectMediaItems` via each adapter's `detectFromResponse`) into the overlay's `DetectionStore`, the same store X uses.
- Any Quick Grab / badge hover that resolves via the tee-populated map (`resolveHoverItem`/`canResolveHoverItem` — both `detected.get(key) ?? null` / `detected.has(key)` for IG/Threads, per the adapters' by-design tee-map-only posture) will work.
- `detectRenderedMedia` returns `[]` for both new platforms by design, so the DOM-only rescan paths (`onRescanClick`, `scanRenderedMedia`'s initial paint, `handleRefreshMediaUrl`'s DOM fallback) contribute nothing extra there — this degrades gracefully to "nothing found yet," never a crash or wrong result, and was confirmed by reading every call site, not merely inferred from the adapter's own doc comments.
- The launcher/dock, Download-all, and the download queue/admission/cloud-upload/Convex-sync pipeline downstream are all platform-agnostic already (from the earlier schema-generalization pass) and need no further changes to work once a `MediaItem` reaches them, regardless of its `platform`.
- Every X-only feature enumerated above (clear-on-save, worklist, sensitive-content reveal, syndication recovery, Knowledge Capture) is wired to X-specific DOM/functions that simply don't match anything on an Instagram/Threads page — they don't error, they just find no matching articles/controls and no-op, exactly as before this task on any non-X page the extension was never injected into at all.

### Honest caveats — do not oversell

- **NOT browser-verified.** No live Chrome extension reload, no manual click-through on x.com, instagram.com, or threads.net/.com was performed in this environment. Everything above is confirmed by reading the diff, `git show`, the built manifest JSON, and running `bun run check`/`test:coverage`/`build` — not by observing actual runtime behavior in a browser.
- **`overlay.content/index.tsx` still has 0% automated test coverage** — there is no test file for it at all (confirmed: no `index.test.ts`/`index.test.tsx` exists alongside it), and this task did not add one. Entrypoints are excluded from the 100% coverage gate by design, but that exclusion is a scope decision, not a claim of safety. The safety net for this specific 32-line diff inside a 1666-line file was: (1) reading the full file before and after the change, (2) `tsgo --noEmit` (the compiler would catch a type mismatch on `adapter.*` calls or the `HandlerDeps.adapter` field), (3) `bun run build` succeeding, and (4) manual manifest inspection. It was NOT: any test asserting the overlay actually behaves correctly on X after this change, or on Instagram/Threads at all. A regression in the hover/badge/launcher hot path introduced by this diff would not be caught by any automated gate in this repo today.
- **`handlers.ts`'s two rewired call sites (`handleRefreshMediaUrl`, `handleClearDetectedMedia`) are covered by `handlers.test.ts`, but not for the `deps.adapter` codepath specifically** — the existing tests exercise these handlers via a `makeDeps` helper that casts `as unknown as HandlerDeps`, and neither test file gained a case constructing a real (or fake) `PlatformAdapter` to verify `detectRenderedMedia` is actually invoked through the injected adapter rather than a stale hardcoded import. This is a pre-existing test-file convention (unsafe cast for a partial deps object), not a gap this task introduced, but it means the rewiring's correctness here also rests on reading + typecheck, not a passing assertion.
- Instagram/Threads adapters themselves remain "research-informed, partially live-verified" per the prior section's own caveat (2026-07-04 network-shape verification via claude-in-chrome happened for the GraphQL endpoint filters; DOM hover/poster resolution is still unverified and deliberately unimplemented). This task did not add or change any Instagram/Threads adapter logic — it only wired the two content scripts and the manifest to actually reach those adapters at runtime.

## Next concrete step

None outstanding from this pass. The registry-dispatch rewiring and host-permission widening described above were the last blocking step before Instagram/Threads content scripts could do anything at all; that step is now done. Browser verification (see caveats) is the natural next action before treating this as production-ready.

## Other next steps (separate plans, not started)

1. Run the Convex migration (`backfillPlatformFields` → verify `platformBackfillRemaining` = 0 → deploy-2 schema push dropping `tweetId`/`handle`).
2. Live-verify Instagram's and Threads' actual network shapes/DOM selectors against a real session (per the design spec's Open Questions) — the adapters built here are structurally sound per research but unconfirmed live. The GraphQL endpoint filters were live-verified 2026-07-04; DOM hover/poster idioms were not.
3. Browser-verify this task's content-script rewiring itself: load the unpacked extension, confirm X behavior is byte-for-byte unchanged (Quick Grab, badge, dock, clear-on-save, Knowledge Capture, sensitive-content reveal all still work), and confirm Instagram/Threads tabs inject without erroring (console shows the boot marker with the correct `platform`, no thrown exceptions) even though no useful detection is expected yet.
4. Consider adding a first automated test for `overlay.content/index.tsx` (e.g. a narrow test extracting the boot-time adapter-selection branch, or a DOM-free unit test of the `xmd:media-response` listener's dispatch) to start closing the 0%-coverage gap flagged above — out of scope for this task, but the highest-leverage follow-up for future changes to this file.
