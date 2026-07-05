# Multi-platform adapter abstraction (X + Instagram + Threads) — design

**Date:** 2026-07-04
**Status:** Approved for planning

## Goal

Generalize the extension's media-download pipeline — today hardcoded to X/Twitter end to end — so Instagram (`instagram.com`) and Threads (`threads.net` / `threads.com`) can be added as sibling platforms, each with completely different detection/DOM logic underneath, while:

- The popup and options UI stay the shared surface, unchanged in structure — just platform-aware where it currently assumes "X" implicitly.
- Download queue, admission gate, cloud upload, Convex sync, and export all keep operating on one generalized domain model, oblivious to which platform a `MediaItem` came from.
- Existing X users see zero behavior change (same default filenames, same readable Convex history) after the schema generalizes.

This spec is the **abstraction pass only** — it defines the contract every platform implements and the domain-model/schema changes that let it exist. It does **not** implement Instagram or Threads. Those are separate, subsequent plans (see Non-goals).

## Scope

**In:**
- `Platform` type + generalized `MediaItem`/sync-event schema (`tweetId`→`postId`, `handle`→`author`, new required `platform` field).
- `PlatformAdapter` interface (`core/adapters/types.ts`) formalizing the contract the existing X adapter already structurally satisfies, plus a `registry.ts` (`adapterForUrl` / `adapterForHostname`).
- Filename-template placeholder aliasing (`{handle}`/`{tweetId}` permanently alias `{author}`/`{postId}`) so saved user templates never break.
- `wxt.config.ts` host-permission / content-script `matches` wiring pattern for adding a platform (host lists driven by each adapter's own `hostMatch`).
- Convex schema generalization (`backend/convex/schema.ts`: `media`, `media_state`, `sync_events` gain `platform`/`postId`/`author`) + two-deploy migration mechanics for existing X rows.
- Research-informed refinements: optional `findMediaNeedingRecovery` adapter method (X-only — no public fallback exists for IG or Threads), a shared `core/adapters/meta-shared/` media-node walker Instagram and Threads can both build on, and a widened `isTrackedResponseUrl(url, requestHeaders?)` signature.

**Out (deferred, not designed here):**
- Building the actual Instagram adapter (network filter, DOM resolution, live-verified selectors/operation names).
- Building the actual Threads adapter.
- The Convex backend migration *execution* (the mechanics are designed here; running it happens alongside the first platform's build).
- Clear-on-save equivalents (auto-unlike/unsave) for Instagram or Threads. The adapter interface doesn't preclude adding this later — it's simply not part of `PlatformAdapter` today, matching how `core/clear/*` isn't part of it either.
- Knowledge Capture (text/reply-tree harvesting into `tweet_captures`) for Instagram or Threads — stays X-only. Its `conversationId`/`inReplyToTweetId` reply-tree model doesn't map onto IG/Threads comment structures and would need its own future design.
- Instagram Stories. Genuinely lossy under a passive-capture design (only viewable-while-active, no backfill query exists) — a future decision, not blocking this round.
- Any UI platform-picker/mode-switcher. Platform stays silently auto-detected from the active tab's hostname, exactly like today.

## Current state (why this is a real abstraction problem, not a config tweak)

The X-specific assumption isn't confined to one file — it runs through the whole pipeline:

- `MediaItem` (`src/core/schema/index.ts`) hardcodes `tweetId: Schema.String` / `handle: Schema.String`.
- The passive "tee" (`src/entrypoints/inject/tee.ts`, `isGraphqlMediaUrl`) allowlists X GraphQL operation names (`TweetDetail`, `UserTweets`, …) — the entire detection mechanism is X's private-API shape.
- `backend/convex/schema.ts` mirrors the same `tweetId`/`handle` names into `media_state`, `sync_events`, `tweet_captures` — no `platform` column anywhere.
- `core/clear/*` (auto-unlike/unbookmark/"not interested") is an X-account-mutation feature with no generalized concept of "clear."
- Both content-script entrypoints (`inject.content.ts`, `overlay.content/index.tsx`) hard-`matches: [...X_HOST_MATCH]`, and `X_HOST_MATCH`/`isXUrl` live inside `core/adapters/x/index.ts` — i.e. today there is exactly one adapter and no registry, because there's never been a second one.

## Domain model changes

### `src/core/schema/index.ts`

```ts
export const Platform = Schema.Literals(['x', 'instagram', 'threads'])
export type Platform = typeof Platform.Type

export const MediaItem = Schema.Struct({
  id: Schema.String,          // media key — already platform-agnostic (hash of url), unchanged
  platform: Platform,         // NEW
  postId: Schema.String,      // was `tweetId`
  author: Schema.String,      // was `handle`
  type: MediaType,            // unchanged: photo | video | gif — reels/carousel items are just video/photo MediaItems, no new type needed
  url: Schema.String,
  previewUrl: Schema.optional(Schema.String),
  ext: Schema.String,
  index: Schema.Number,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  bitrate: Schema.optional(Schema.Number),
})
```

Every downstream consumer (download queue, admission gate, `SavedIndex` dedup, cloud upload, export sidecars) already treats `tweetId`/`handle` as opaque strings — this is a mechanical rename at the schema boundary, no logic changes required in `core/download/*`, `core/cloud/*`, or `core/sync/*`.

`width`/`height` already existed as optional fields — Instagram's `image_versions2.candidates[]`/`video_versions[]` carry per-candidate dimensions natively, so no schema addition is needed there either.

### Filename template aliasing

`{handle}`/`{tweetId}` remain permanent aliases for `{author}`/`{postId}` in the template renderer (`core/download/filename.ts`). Existing saved templates keep working byte-for-byte on X. New installs keep defaulting to `{handle}/{tweetId}_{index}.{ext}` unchanged — zero surprise. `{platform}` becomes available as a new placeholder for anyone who wants `instagram/handle/postId_0.ext`-style separation once multiple platforms are active against the same download folder; it is not part of the default template.

### Convex schema (`backend/convex/schema.ts`)

Same rename, plus a required `platform` field on `media`, `media_state`, and `sync_events`:

```ts
export const media = v.object({
  platform: v.union(v.literal('x'), v.literal('instagram'), v.literal('threads')),
  postId: v.string(),   // was tweetId
  author: v.string(),   // was handle
  type: v.string(),
  url: v.string(),
  ext: v.string(),
  index: v.number(),
})
```

`media_state.by_tweet` → `by_post` (`['postId']`); add `by_platform_post` (`['platform', 'postId']`) since `postId` alone is no longer globally unique across platforms (an Instagram shortcode and an X snowflake id colliding is unlikely but not impossible — worth being correct rather than lucky).

`tweet_captures` is **untouched** — Knowledge Capture stays X-only (see Non-goals), so its `tweetId`/`handle`/`conversationId` naming is now *correctly* X-specific, not a generalization gap.

### Migration mechanics (two-deploy pattern)

1. Push the new schema with `platform`/`postId`/`author` as **optional** fields alongside the old `tweetId`/`handle` — avoids the "required field blocks the whole schema push" trap already noted in the existing schema's own comments (see the `tweetId: v.optional(v.string())` precedent on `media_state`).
2. Run a backfill mutation over `media_state`/`sync_events`, paged, setting `platform: 'x'`, `postId: row.tweetId`, `author: row.handle` on every row missing them.
3. Verify 100% coverage (a query confirming zero rows with `platform` still undefined), then flip `postId`/`author`/`platform` to required and drop `tweetId`/`handle` from the validators in a follow-up schema push.
4. Client-side `sync.ts`/`captures.ts` mutation call sites switch to sending the new field names in the same PR that flips the schema.

## Adapter contract + registry

This is the actual "UI stays the same, backend logic differs" seam.

### `src/core/adapters/types.ts`

```ts
export interface PlatformAdapter {
  readonly platform: Platform
  /** Manifest content-script match patterns AND the `browser.tabs.query` filter —
   *  single source of truth, mirrors X_HOST_MATCH today. */
  readonly hostMatch: readonly string[]
  matchesUrl(url: string): boolean

  /** Network layer (the "tee"): does this response carry media-bearing data worth
   *  parsing? `requestHeaders` is optional — X's X_HOST_MATCH-style filter ignores
   *  it; Instagram/Threads need it to match on `x-fb-friendly-name`/doc_id rather
   *  than URL string alone. */
  isTrackedResponseUrl(url: string, requestHeaders?: Record<string, string>): boolean
  /** Parse a tracked response body into MediaItems. */
  detectFromResponse(url: string, json: unknown): MediaItem[]

  /** DOM layer: media already rendered in a timeline/list, for the initial paint
   *  before any network capture lands. */
  detectRenderedMedia(root: ParentNode, pathname: string): MediaItem[]
  /** Overlay hot paths: hover resolution for Quick Grab / per-item badge. */
  resolveHoverItem(
    el: Element,
    key: string,
    detected: ReadonlyMap<string, MediaItem>,
    pathname: string,
  ): MediaItem | null
  canResolveHoverItem(el: Element, key: string, detected: ReadonlyMap<string, MediaItem>): boolean

  /** Optional: a public/unauthenticated recovery pass for media the passive tee
   *  missed, X's `syndication.ts` role. Instagram and Threads both lack any
   *  no-auth public fallback (oEmbed on both is Meta-app-registration-gated), so
   *  neither implements this — confirmed by research, not just left unbuilt. */
  findMediaNeedingRecovery?(root: ParentNode, detectedKeys: ReadonlySet<string>): string[]
}
```

Everything inside `detectFromResponse`/`resolveHoverItem`/etc. is entirely free to differ per platform — that is the point of the interface. X's existing `walk.ts` (GraphQL tree traversal), `resolve.ts` (photo/video URL upgrading), `syndication.ts` (recovery fallback) stay exactly as they are internally; only the exported shape gets wrapped to satisfy the interface.

### Folder structure

```
core/adapters/
  types.ts            # PlatformAdapter interface + Platform registry types
  registry.ts          # adapterForUrl(url), adapterForHostname(hostname), ALL_ADAPTERS
  x/                   # unchanged internals, wrapped to satisfy PlatformAdapter
  meta-shared/         # NEW — shared by instagram/ and threads/ only, NOT by x/
    media-node.ts       # structural walker: finds image_versions2/video_versions/
                         # carousel_media anywhere in a response tree and recursively
                         # resolves carousel children, rather than hardcoding one
                         # envelope path (both research reports independently
                         # recommended this, since envelope shape — items[0] vs
                         # data.xdt_shortcode_media vs edges[].node — differs by
                         # surface/version while the leaf media-node shape doesn't)
  instagram/            # new — filter (GraphQL friendly-name + /api/v1 paths) +
                         # DOM resolution (article + /p//reel/ anchors) + repost: N/A
  threads/              # new — filter (doc_id dispatch) + DOM resolution
                         # (article/[role=article]/data-pressable-container +
                         # /post/ anchors) + repost/quoted_post unwrapping
```

`meta-shared/` exists because Instagram and Threads are, per research, the *same* backend media schema (`image_versions2.candidates[]`, `video_versions[]`, `carousel_media[]` — literally shared field names, not merely similar), while X's schema is unrelated. Sharing where platforms are genuinely the same and separating where they're genuinely different is the concrete test of whether this abstraction is doing its job.

### Two call-site patterns, one registry

- **Content scripts** (`inject.content.ts`, `overlay.content/index.tsx`): `matches` widens to all three platforms' host patterns (mirrors how `X_HOST_MATCH` already covers two domains today — no new mechanism, just a longer list, generated from each adapter's own `hostMatch`). At boot, each picks its one adapter via `adapterForHostname(location.hostname)` once and closes over it — no per-call dispatch on the hover/mousemove hot path.
- **`background.ts`** (a single service worker spanning tabs on potentially different platforms concurrently): uses `adapterForUrl(tab.url)` per-message, since it can't assume one platform for its whole lifetime.

Adding a platform becomes: new folder implementing `PlatformAdapter` + one line in `registry.ts` + widen the two `matches` arrays (derived from `hostMatch`, not hand-duplicated) + add host permissions in `wxt.config.ts`. Nothing in `core/download`, `core/cloud`, `core/sync`, `core/clear`, or the UI panels changes at all.

## Manifest & host permissions

`wxt.config.ts` `host_permissions` grows to cover both new platforms, mirroring how X already lists both `x.com` and `twitter.com`:

```ts
host_permissions: [
  'https://x.com/*', 'https://twitter.com/*',
  'https://www.instagram.com/*',
  'https://www.threads.net/*', 'https://www.threads.com/*',
  'https://cdn.syndication.twimg.com/*',   // X-only recovery fallback, unchanged
  ...
]
```

Required (not optional), matching the existing X posture — the extension needs them out of the box for its core purpose. Threads' domain migration (`threads.net` → `threads.com`, April 2025, confirmed same backend behind a redirect) means **both hosts point at one adapter** — no per-domain branching, just two entries in `hostMatch`.

## Platform capability comparison

| | X (existing) | Instagram | Threads |
|---|---|---|---|
| Detection mechanism | MAIN-world fetch/XHR patch, filter by GraphQL operation name in URL | Same patch mechanism. Filter needs both GraphQL (`graphql/query`, matched via `x-fb-friendly-name` request header — more stable than the rotating `doc_id`) *and* REST (`/api/v1/...`) response shapes | Same patch mechanism. Filter by `doc_id`-keyed persisted queries — same dispatch model as X's own tee |
| Media node shape | X-specific (`media_url_https`, `video_info.variants`) | `image_versions2.candidates[]` (photo), `video_versions[]` (video), `carousel_media[]` (recursive, same shape as a standalone post) | Identical field names to Instagram — literally the same backend schema |
| No-auth public recovery fallback | Yes — `cdn.syndication.twimg.com`, used by `syndication.ts` | None — oEmbed is Meta-app-registration-gated | None — oEmbed equally gated |
| DOM identity anchor | `article` + `a[href*="/status/"]` | `article` + `a[href*="/p/"]` or `/reel/"]` | `article` / `[role="article"]` / `div[data-pressable-container="true"]` + `a[href*="/post/"]` |
| Post id shape | Single numeric tweet id | Numeric `pk` **+** separate URL `shortcode` | Numeric `pk`/thread id **+** separate URL `code` (shortcode) — same split as IG |
| Ephemeral content | None | Stories (24h) — lossy, viewed-while-active only, no backfill (deferred, see Non-goals) | "Ghost posts" (Oct 2025) — text-only at launch, not a media-detection concern |
| Reposts/quotes | Retweet wraps original tweet id | N/A (no repost concept) | `reposted_post` (bare repost) vs `quoted_post` (quote-post) — both need their media resolved separately |

All endpoint names, `doc_id`/header values, and CSS selectors above are structural/behavioral summaries from current (2024–2025) reverse-engineering research, not a working configuration — every platform's actual adapter build must re-verify against the live site (network tab + DOM inspection) before writing detection code, exactly as the DOM-structure caveats already documented in this codebase (e.g. `docs/testing`) note for X's own selectors.

## Error handling

- An adapter that fails to parse a network response (malformed/unexpected shape — expected given churn risk above) must fail closed: return `[]` from `detectFromResponse`, never throw into the tee's dispatch loop. This already matches X's posture (`forEachTweetNode` skips nodes with no media/id rather than throwing).
- `registry.ts`'s `adapterForUrl`/`adapterForHostname` return `undefined` for an unmatched hostname (e.g. a non-media tab) rather than throwing — callers already must handle "no adapter for this tab" as the common case (most open tabs aren't X/Instagram/Threads at all).
- The Convex migration's optional-fields-first ordering (Migration mechanics, step 1) exists specifically so a partially-run backfill never blocks a schema push — the existing `media_state.tweetId` comment already documents this exact failure mode from a prior migration.

## Testing

- `PlatformAdapter` conformance: a shared test suite (`core/adapters/conformance.test.ts` or similar) run against every registered adapter, asserting the interface's structural contracts hold (e.g. `detectFromResponse` never throws on arbitrary/malformed JSON, `hostMatch` patterns all parse as valid match patterns) — catches "forgot to implement X for the new platform" mistakes generically rather than per-adapter.
- Each platform's own adapter tests stay fully independent (mirroring `core/adapters/x/*.test.ts`'s existing per-file split: dom, walk, resolve, reveal, syndication) — nothing here requires cross-platform test coupling.
- `core/adapters/meta-shared/media-node.ts` gets its own unit tests independent of both Instagram's and Threads' adapters, since it's consumed by both.
- This repo's 100% coverage gate (`src/core` + `src/lib`, `bun run test:coverage`) applies to all new adapter code exactly as it does to `x/` today — no carve-out.
- Convex migration: covered by `convex-test` against a schema fixture seeded with pre-migration (`tweetId`/`handle`-only) rows, asserting the backfill mutation produces the expected `platform`/`postId`/`author` values and the verification query correctly reports zero-remaining-unmigrated only when true.

## Open questions carried into the next planning pass (not blocking this design)

- Instagram web video player's exact hover/poster DOM idiom, and whether `currentSrc` is populated without a network capture — flagged as unverified by research, needs live DevTools inspection during the Instagram adapter build.
- Threads' hidden-`<video>` hover-anchor pattern — same caveat, needs live inspection during the Threads adapter build.
- Whether Instagram's/Threads' carousel navigation exposes any DOM-derivable indicator (research found none) — carousel children are expected to come from the tee'd `carousel_media[]` JSON as primary source of truth, DOM-only carousel discovery is best-effort fallback at most.
