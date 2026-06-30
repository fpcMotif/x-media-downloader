# Timeline "Saved" status from Convex — design (2026-06-27)

Surface a **cross-device "already downloaded" indicator** on posts in the For You /
Following timelines and in List timelines. As the user scrolls, each post whose
image/video they have already downloaded — **on any device** — is marked with a
"Saved ✓" chip. The truth comes from the Convex sync ledger, with the device's own
local download history as an instant, offline-capable fast-path.

Decided with the user in a brainstorming session (approach **B+C**). An executor
with no memory of that session can act from this file alone.

## Why (context)

The extension already mirrors every download to a Convex control plane
(`sync_events` → `media_state`, ADR-0009) and keeps a durable **local** download
history (ADR-0010/0014). But nothing surfaces "I already grabbed this" back onto
the timeline. The user re-encounters the same posts across sessions and devices
and cannot tell, at a glance, which they have already saved.

This feature reads that existing ledger back and paints it onto the timeline. It
is **read-only status surfacing** — no new download or clear behavior.

## Decided design (the forks the user settled)

1. **Granularity:** per-**post** (`tweetId`), not per-media. Matches the timeline
   UX and the existing sweep that de-dupes by `tweetId`.
2. **Scope:** **cross-device** — a post saved on *any* device is "Saved". This is
   the entire reason to route through Convex rather than local history alone.
3. **"Saved" definition:** a post is Saved if **≥1** of its media reached
   `lastKind === 'completed'`. A "2/4 partial" indicator is explicitly **deferred**.
4. **Behavior:** **badge only** for v1. Skip-on-bulk-save/sweep (which reuses the
   exact same data) is a **phase-2** follow-on, out of scope here.
5. **Architecture:** **B + C** — exact membership via a promoted `tweetId` index
   (B), layered over a local-first Saved Index that seeds from local history and
   updates on every local completion (C).
6. **Default:** `showSavedStatus` **on by default**; runs **C-only** (local marks)
   when Convex sync is not configured.

## Load-bearing facts verified during design (don't re-discover)

- **The overlay cannot reach the network.** Only the background SW does Convex I/O
  (the fetch port lives there). So the flow is fixed: overlay enumerates `tweetId`s
  → message background → background answers → overlay renders. This mirrors the
  existing `clearScope` / `queueDrain` message handlers.
- **No read path exists yet.** `ConvexPort` (`src/core/sync/convex.ts`) exposes only
  `mutation()` over `POST /api/mutation`. The backend has only `recordEvents` (write)
  and `recentEvents` (paginated dump). There is **no membership query and no
  `tweetId` index**.
- **Identity mismatch is the crux.** The badge is per-post (`tweetId`), but Convex
  stores per-media: `media_state` is keyed/indexed by `deviceId + requestId`
  (`requestId === item.id`, one row per media), with `tweetId` only **nested inside
  `media`**. Convex indexes are over top-level fields, so answering "is this post
  saved?" requires promoting `tweetId` to a top-level column.
- **`tweetId` is populated at row creation.** `materializeState` inserts a
  `media_state` row on the first event for a request; the `queued` event always
  carries `media` (and thus `tweetId`). Outcome (`completed`/`failed`) events only
  patch `lastKind`/`at`. So new rows get `tweetId` for free at insert.
- **Auth is fail-closed on `SYNC_SHARED_SECRET`** for both reads and writes. The
  extension already holds the secret (used by `recordEvents`); the new query reuses it.
- **The overlay already has the enumeration machinery:** `tweetIdOfArticle(article)`
  (DOM → `tweetId`), `TWEET_ARTICLE_SEL` (enumerate posts), the de-dupe-by-`tweetId`
  sweep at `handlers.ts:210`, and per-article control injection at `handlers.ts:157`.
  No existing "already-saved" indicator anywhere in the overlay.

## Architecture

```
Overlay (content script)                Background SW                    Convex
─────────────────────────               ─────────────                   ──────
sweep visible <article>s        ──msg──▶ SavedIndex.resolve(tweetIds)
  via TWEET_ARTICLE_SEL                    ├─ local known? answer now
  → tweetIdOfArticle()                     └─ unknowns ──query──────────▶ downloadedAmong(secret, ids[])
render "Saved ✓" chip on        ◀─reply── { saved: tweetId[] }          ◀── subset with a completed row
  each saved <article>
```

### Component 1 — Convex backend (exact membership, the "B")

`backend/convex/schema.ts`
- Add top-level `tweetId: v.string()` to `media_state`.
- Add index `by_tweet` on `['tweetId']`. (Cross-device by construction — the index
  ignores `deviceId`.)

`backend/convex/sync.ts`
- `materializeState`: set `tweetId` from `e.media.tweetId` when inserting a new row.
  (Patches never touch it.) Rows created by a media-less first event have no
  derivable `tweetId` — accepted limitation; such a row is simply not indexable by
  tweet. Rare (requires the `queued` event to have been lost).
- New `backfillTweetId` mutation (one-off, secret-gated, internal-style): page
  `media_state` and patch `tweetId` from `row.media?.tweetId` where missing.
- New query **`downloadedAmong({ secret, tweetIds: string[] }) → string[]`**:
  - `assertSecret(secret)` (same fail-closed guard).
  - Cap the batch (e.g. ≤128 ids); reject or truncate oversized input.
  - For each id: `db.query('media_state').withIndex('by_tweet', q => q.eq('tweetId', id))`,
    return the id if any row has `lastKind === 'completed'`.
  - Returns the matched subset.

### Component 2 — Convex client read path

`src/core/sync/convex.ts`
- Extend `ConvexPort` with `query(path, args): Promise<unknown>` over
  `POST /api/query`, symmetric to `mutation()`: same `bindFetch` detachment (SW
  "Illegal invocation" footgun), same envelope handling and error vocabulary
  (`ConvexHttpError` / `ConvexFunctionError` / `ConvexMalformedError`).

### Component 3 — Saved Index (local-first merge, the "C")

New pure module (e.g. `src/core/sync/saved-index.ts`) owning a `Set<string>` of
known-saved `tweetId`s:
- **`seed(localCompletedTweetIds)`** — union the device's existing local download
  history (completed only). Instant, offline, authoritative for *this* device.
- **`markSaved(tweetId)`** — called on every local completion so a just-grabbed
  post lights up with no network round-trip.
- **`resolve(tweetIds, queryConvex)`** — return known ids from the Set immediately;
  for the remainder, call `queryConvex(unknowns)` (→ `downloadedAmong`), union the
  result in, and return the full saved subset. If `queryConvex` rejects (offline /
  secret missing / sync disabled), return just the locally-known subset.
- **TTL:** a per-id "recently queried, not found" guard so unknowns aren't
  re-queried for N minutes within a session.

The module is pure (Set + injected `queryConvex` + clock); all I/O is injected.

### Component 4 — Background wiring

`src/entrypoints/background.ts`
- On boot: `SavedIndex.seed(...)` from the local download-history store.
- Hook the existing completed-download path to call `SavedIndex.markSaved(tweetId)`.
- New message handler **`SavedStatusRequest({ tweetIds }) → SavedStatusResponse({ saved })`**
  that delegates to `SavedIndex.resolve`, with `queryConvex` bound to the new
  `downloadedAmong` caller (gated on sync being configured; else local-only).

`src/core/schema/index.ts`
- Add the `SavedStatusRequest` / `SavedStatusResponse` tagged message structs.

### Component 5 — Overlay sweep + render

`src/entrypoints/overlay.content/handlers.ts` + `index.tsx`
- **Sweep:** reuse the article-enumeration + `tweetId` de-dupe pattern
  (`handlers.ts:210`) and the existing scroll/observer machinery; debounce; fire on
  mount and as new posts scroll into view. Send `SavedStatusRequest` with the
  visible `tweetId` batch.
- **Render:** inject an **idempotent** "Saved ✓" chip into each saved `<article>`
  (mark the node so it is not double-injected), mirroring per-article control
  injection at `handlers.ts:157`. Styled with existing overlay tokens.
- **Scope gating:** run only on For You / Following / List timelines (reuse existing
  page-scope detection). Profiles / Bookmarks / Likes out of scope for v1.

`src/entrypoints/overlay.content/style.css`
- Chip styles using existing brand/overlay tokens.

### Component 6 — Settings

`src/core/schema/index.ts` (Settings) + options/popup surface
- `showSavedStatus: boolean` (default `true`). When Convex sync is unconfigured,
  the feature still runs **C-only** (local marks). When the toggle is off, no sweep
  and no badges.

## Error handling & fail-safe direction

- A badge appears **only on a positive signal**. Absence of data → **no badge**,
  never a false "Saved".
- Convex unreachable / secret missing / sync disabled → degrade to local-only
  marking. The timeline is never blocked and no error is surfaced intrusively;
  failures are logged at debug level.
- Pull-based, **no WebSocket** — consistent with ADR-0009 ("no Convex SDK in the SW").

## Testing

- **SavedIndex** (pure): seed + `markSaved` + Convex-union + offline-degrade + TTL.
- **`downloadedAmong`** via `convex-test`, mirroring `backend/convex/sync.test.ts`
  (completed vs queued/failed, cross-device match, batch cap, secret gate).
- **`ConvexPort.query`** via fetch mock (success, HTTP error, function error,
  malformed body) — mirroring the existing `convex.test.ts` mutation cases.
- **Overlay sweep → render** mapping via happy-dom (enumerate → message → idempotent
  chip injection; no double-inject; scope gating).
- Coverage gate over `src/core` (UI/entrypoints excluded by the existing gate).

## Explicitly out of scope (v1)

- Partial "2/4 saved" indicator (per-media granularity on the badge).
- Skip-already-saved on bulk-save / sweep (phase 2; reuses the same data).
- Profiles, Bookmarks, Likes, search results, single-tweet pages.
- Reactive (WebSocket) live updates — pull-based only.
- Backfilling `tweetId` for `media_state` rows whose only event ever lacked `media`.

## File touch list

| File | Change |
|---|---|
| `backend/convex/schema.ts` | `media_state.tweetId` column + `by_tweet` index |
| `backend/convex/sync.ts` | set `tweetId` in `materializeState`; `backfillTweetId`; `downloadedAmong` query |
| `backend/convex/sync.test.ts` | tests for the above |
| `src/core/sync/convex.ts` | `ConvexPort.query` over `POST /api/query` |
| `src/core/sync/convex.test.ts` | query-path tests |
| `src/core/sync/saved-index.ts` (new) | pure Saved Index |
| `src/core/sync/saved-index.test.ts` (new) | Saved Index tests |
| `src/core/schema/index.ts` | `SavedStatusRequest`/`Response` messages; `showSavedStatus` setting |
| `src/entrypoints/background.ts` | seed + `markSaved` hook + `SavedStatusRequest` handler |
| `src/entrypoints/overlay.content/handlers.ts` | status sweep + idempotent chip injection |
| `src/entrypoints/overlay.content/index.tsx` | wire sweep to scroll/observer + mount |
| `src/entrypoints/overlay.content/style.css` | "Saved ✓" chip styles |
| options/popup settings surface | `showSavedStatus` toggle |
