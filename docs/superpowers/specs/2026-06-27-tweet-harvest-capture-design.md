# Tweet Harvest ("Capture") — Design Spec

- **Date:** 2026-06-27
- **Status:** Approved + reviewed (2026-06-27); §15 open questions resolved; ready for implementation plan
- **Author:** brainstorming session (f + Claude)
- **Related:** ADR-0001 (passive tee), ADR-0009 (Convex control plane), ADR-0013 (client-side cloud byte upload / offscreen), ADR-0016 (media-key identity); [[timeline-saved-status-planned]]
- **Posture change:** mirroring tweet **text** extends the documented Convex scope *"metadata only — never bytes, captures, or auth"* → **new ADR-0017 required** (see §11)

---

## 1. Problem

The extension is a **media** downloader: the passive MAIN-world tee copies X's GraphQL
responses to the content script, and [`detectFromJson`](../../../src/core/adapters/x/index.ts)
extracts **only media** (`legacy.extended_entities.media`). Everything else in those same
responses — the tweet **text**, author, timestamps, engagement counts, the **links**
(including the real YouTube/arXiv URLs behind `t.co`), and the **reply tree** of any
thread you open — is discarded.

The user wants to **harvest that discarded metadata** into structured JSON to feed an AI
for studying technical discussions ("was this a good or bad technical decision?"):

- All tweet info as structured JSON, with **media kept as references** (not bytes).
- **Links de-shortened**: every `t.co` replaced by its real destination; YouTube/arXiv
  links appear as full URLs, ideally with a title.
- A **flag** to capture *all* text that scrolls past — even pure-text tweets with no
  media that were never downloaded.
- **Conversation/reply trees** exported as JSON or JSONL.
- Convert JSON → **Markdown** now; Notion / Google Sheets **later**.

## 2. Goals / Non-goals

**Goals**
1. Capture full per-tweet metadata off the existing tee — **no new interception, no new
   network for capture**, and **one shared traversal** (no second walk of each response).
2. De-shorten links and, when X embedded a link-preview **card**, carry its
   title/description/domain (zero extra network).
3. Reconstruct **real reply trees** from opened threads (`TweetDetail`) and loosely link
   scrolled tweets by `conversation_id`.
4. Persist locally (durable) and **opt-in mirror to Convex**, with **local and cloud
   merge rules that provably agree**.
5. Export **flat JSONL** (bulk) and **per-thread nested JSON + threaded Markdown**.
6. Stay consistent with the project's posture: **opt-in, default OFF**, local-first, deep
   modules (pure core + thin shell), 100% coverage on `src/core`.

**Non-goals (YAGNI for v1)**
- Notion / Google Sheets exporters (leave a clean `toRows` projection seam; do not build).
- Active link enrichment (fetching titles when X embedded no card).
- Full-text search / querying over the harvest.
- DMs, profiles-as-entities, non-tweet content.
- Any account mutation (this is strictly read-only).

## 3. Decisions

| # | Decision | Choice |
|---|----------|--------|
| D1 | Storage & retrieval | **Local DB + opt-in Convex mirror** |
| D2 | Thread reconstruction | **Full trees from opened `TweetDetail`** + loose `conversation_id` linkage for scrolled tweets |
| D3 | Link enrichment | **De-shorten (`expanded_url`) + reuse X's embedded card data**; no active fetching |
| D4 | Capture breadth | **Default**: tweets with media + every opened thread. **Flag `captureAllScrolled`**: also pure-text scrolled tweets |
| D5 | Export shape | **Both**: flat JSONL (bulk) + per-thread nested JSON / threaded Markdown |
| D6 | Local store backend | **IndexedDB** (resolved; see §8). storage.local capped-ring kept only as a documented fallback. |
| D7 | Convex posture | Mirroring tweet **text** → **new ADR-0017 + its own opt-in toggle** `captureMirrorEnabled` (see §11) |
| D8 | Merge rule (local **and** cloud) | **Richer-source-wins**, identical on both sides via a carried `sourceRank` (see §6.4) |

## 4. Domain vocabulary

- **Capture** — harvesting tweet metadata (distinct from media **detection** →
  `MediaItem`).
- **TweetRecord** — one normalized, immutable record extracted from one tweet node.
- **ConversationTree** — `{ conversationId, roots: TweetNode[] }`; `TweetNode =
  TweetRecord & { children: TweetNode[] }`.
- **Harvest store** — durable local IndexedDB collection of `TweetRecord`s, keyed by
  `tweetId`.
- **sourceRank** — a small integer encoding how authoritative a sighting is
  (`TweetDetail` > timeline); the single tiebreaker that makes local and cloud merges
  agree (§6.4).
- **Breadth flag** — the `captureAllScrolled` setting (D4).

## 5. Architecture

```
X GraphQL ─▶ MAIN-world tee (exists) ──CustomEvent('xmd:media-response')──▶ content script
                                                                              │
   overlay.content/index.tsx listener (exists, index.tsx:1432)                │
     └─ forEachTweetNode(json, visit)  ← ONE shared traversal (NEW, §6.0)     │
            ├─ detectFromJson refactored to consume it → MediaItem[] (exists) │
            └─ harvestTweets(...)        consumes it    → TweetRecord[] (NEW)  │
                   │  batch + debounce, no producer-side identity dedup        │
                   ▼                                                           │
       browser.runtime.sendMessage(CaptureTweets{records})                    │
                   ▼                                                           ▼
   background.ts  CaptureTweets handler  (the dispatcher; fans out to:)
     ├─ capture-db.putRecords(records)       → IndexedDB harvest store (durable, merge)
     └─ capture-outbox.mirrorCaptures(...)   → opt-in: enqueue + drain → Convex recordCaptures
                   │
   options panel "Knowledge Capture" (NEW) ─▶ Export/Summary/Clear messages ─▶ background
                   ▼
   export converters (pure): toJsonl · toTreeJson · toMarkdown
                   ▼
   delivery: data: URL (sidecarDataUrl pattern) ── or, for large artifacts ──▶ offscreen saveBlob → chrome.downloads
```

Every box maps to a §16 file. **Dedup happens at the durable layer** (`capture-db`
merge), never at the content-script producer — see §6.4 / §7.

## 6. Data model (`src/core/capture/`, all pure + 100% gated)

### 6.0 Shared traversal (refactor of `src/core/adapters/x/`)

Today `walk`, `findScreenName`, and `NESTED_TWEET_KEYS` are **module-private** in
`adapters/x/index.ts`; only `detectFromJson` is exported, and it returns a flat,
tweetId-deduped `MediaItem[]` — not a per-tweet grouping. Harvesting must **not** run a
second full walk of every (large) GraphQL response, and must **not** re-implement
media-key identity (ADR-0016 one-media-one-item).

Extract a single shared primitive:

```ts
// src/core/adapters/x/walk.ts (NEW, gated)
export function forEachTweetNode(
  json: unknown,
  visit: (n: { node: Obj; tweetId: string; handle: string; author: Author; mediaRaw: RawMedia[] }) => void,
): void
```

It performs **one** depth-first walk, unwraps `TweetWithVisibilityResults` (`.tweet`),
**skips** `TweetTombstone`, derives `tweetId` (`rest_id` → `legacy.id_str`), and resolves
the author via `findAuthor` (§6.1). `detectFromJson` is refactored to build `MediaItem[]`
from this primitive (behavior-preserving; existing `xadapter.test.ts` guards it), and
`harvestTweets` builds `TweetRecord[]` from the **same** visit — one walk, one identity
authority.

### 6.1 `TweetRecord` (`record.ts`)

Verified JSON paths from real X GraphQL shapes (the project's minimal `tweet-detail.json`
lacks most of these → **new fixtures required**, §13). Paths are relative to the tweet
result node.

| Field | Type | Source |
|-------|------|--------|
| `tweetId` | string | `rest_id` (fallback `legacy.id_str`) |
| `conversationId` | string | `legacy.conversation_id_str` (fallback: `tweetId`) |
| `inReplyToTweetId?` | string | `legacy.in_reply_to_status_id_str` |
| `inReplyToHandle?` | string | `legacy.in_reply_to_screen_name` |
| `author` | `{ handle, name?, userId? }` | via `findAuthor` (below) |
| `text` | string | `legacy.full_text` with `t.co`→`expanded_url` (§6.3, index-safe) |
| `rawText` | string | unmodified `legacy.full_text` (cheap insurance against expansion bugs; §6.3) |
| `createdAt?` | number (epoch ms) | `legacy.created_at` parsed |
| `lang?` | string | `legacy.lang` |
| `metrics` | `{ replies?, retweets?, likes?, quotes?, bookmarks?, views? }` | `legacy.reply_count`/`retweet_count`/`favorite_count`/`quote_count`/`bookmark_count`; `views.count` (sibling of `legacy` at the result node) |
| `links` | `Link[]` | `legacy.entities.urls[]` joined with card (§6.3) |
| `media` | `MediaRef[]` | from the shared traversal's resolved media (§6.0), **not** a re-walk |
| `mentions` | string[] | `legacy.entities.user_mentions[].screen_name` |
| `hashtags` | string[] | `legacy.entities.hashtags[].text` |
| `quotedTweetId?` | string | `quoted_status_result.result.rest_id` |
| `retweetOf?` | string | `retweeted_status_result.result.rest_id` |
| `source` | `'tweetDetail' \| 'timeline' \| 'other'` | derived from the tee `path` |
| `sourceRank` | number | `tweetDetail`=2, else 1 (§6.4) |
| `capturedAt` | number (epoch ms) | clock passed in (pure fn stays clock-free) |

`Link = { expandedUrl, displayUrl?, title?, description?, domain? }`.
`MediaRef` keeps only `id/type/url/ext/index/width?/height?` from `MediaItem`, dropping
download-lifecycle concerns — and is produced from the **same** media resolution the
detector uses (so the media-key identity never diverges, ADR-0016).

**`findAuthor(node) → { handle, name?, userId? }`** (generalizes the private
`findScreenName`): prunes `NESTED_TWEET_KEYS` **once** and reads `screen_name`, `name`,
and `rest_id` from the **same** `core.user_results.result` subtree it stops at — so a
quoted tweet's name/userId can never leak into the outer record (today `findScreenName`
guards only the handle). Tested with an outer-quotes-inner fixture.

**Nested tweets**: quoted/retweeted tweets are visited independently → their **own**
`TweetRecord`s; the outer record links via `quotedTweetId`/`retweetOf`.

### 6.2 `ConversationTree` (`tree.ts`)

Pure `buildTree(records): ConversationTree[]`:
1. Group by `conversationId`.
2. Build `tweetId → node`; link each node under its `inReplyToTweetId` parent **iff** that
   parent is in the group. **Reply parentage is reconstructed solely from
   `in_reply_to_status_id_str`; the `conversationthread` module nesting in the raw
   response is ignored** (it is a display grouping, not the reply graph).
3. **Roots** = true roots (no `inReplyToTweetId`) **plus** orphan replies whose parent
   wasn't captured (surfaced honestly as additional roots).
4. Stable order: `createdAt` then `tweetId`. Cycle-defended (visited set) to stay total.

This supports **multi-level** chains (root → A → reply-to-A) — see the §13 fixture/test
requirement that exercises a real grandchild reply.

### 6.3 Card / link de-shortening (`card.ts`)

Pure helpers:
- `expandText(fullText, urlEntities)` → `t.co`→`expanded_url`. **Index-safe**: apply entity
  replacements from the **highest index backwards** so earlier UTF-16 offsets stay valid
  (X entity indices are code-unit based; astral/emoji chars otherwise corrupt the rewrite).
  `rawText` is retained regardless, so any expansion error is recoverable.
- `linksFromEntities(urlEntities)` → `Link[]`.
- `cardMeta(cardNode)` → `{ title?, description?, domain? }`, joined onto the matching
  link. Supports both encodings: **flat** `summary`/`summary_large_image` cards
  (`card.legacy.binding_values[]` keyed `title`/`description`/`domain`/`card_url`), and
  **`unified_card`** (a JSON-encoded `string_value` → parse →
  `component_objects[*].data.title.content`/`.subtitle.content`,
  `destination_objects[*].data.url_data.{url,vanity}`). Best-effort: any mismatch → no
  title, never throws.

### 6.4 Merge rule (`store.ts`) — local **and** cloud agree (D8)

A tweet is **not monotonic** (timelines re-serve the same tweet thin after you saw it rich
in a thread; counts drift). So raw last-write-wins-by-time is wrong. The single rule, used
**identically** by the local store and the Convex mutation:

```
keep incoming over existing  ⟺  incoming.sourceRank > existing.sourceRank
                                  OR (equal rank AND incoming.capturedAt ≥ existing.at)
```

`sourceRank` (and `capturedAt`/`at`) ride on the `TweetRecord`, the `SyncCaptureEvent`,
and the `tweet_captures` row, so a later thin timeline sighting can **never** overwrite a
rich `TweetDetail` record on either side. Field-wise, the winner replaces the loser whole
(records are self-consistent snapshots). Symmetric tests on both sides (§13) assert
`rich-then-thin` keeps rich and `thin-then-rich` upgrades.

## 7. Capture flow & the breadth rule (`harvest.ts`)

`harvestTweets(json, { source, includeTextOnly, capturedAt }): TweetRecord[]` consumes the
shared traversal (§6.0). For each tweet node it builds a candidate and **keeps** it when:

```
hasMedia(node)                 // default: media tweets
  OR source === 'tweetDetail'  // default: every tweet in an opened thread
  OR includeTextOnly           // the breadth flag: all scrolled text
```

`source` is derived from the tee `path` (`/TweetDetail` → `'tweetDetail'`). This is D4.

**Content-script side** (in the existing `xmd:media-response` listener — ungated, by
design):
- Gated on `settings.captureEnabled`; `includeTextOnly = settings.captureAllScrolled`.
- **No producer-side identity dedup.** The content script only **batches** (debounce
  ~750 ms idle, **hard cap `MAX_CAPTURE_BATCH = 64` records per `CaptureTweets` message**)
  and flushes; also flushes on `pagehide`/`visibilitychange:hidden`. Re-sending the same
  tweet is a cheap no-op at the durable merge (§6.4), and this is what lets a later rich
  `TweetDetail` sighting upgrade an earlier thin one — the central feature promise.
- Cost is bounded by the **single** shared walk (§6.0), the batch cap, and one IndexedDB
  transaction per batch (§8). No unbounded per-session `Set` is kept.

## 8. Local store (D6: IndexedDB — resolved)

**Pure core** — `src/core/capture/store.ts` (gated, no I/O): `decodeRecords(raw)`;
`mergeRecord(existing, incoming)` implementing §6.4; selectors `selectConversation`,
`summarize(records) → { tweets, conversations }`, and `recentConversations(records, n) →
{ conversationId, rootHandle, rootText, count, lastAt }[]` (the source for the panel's
recent list, §12).

**Thin shell** — `src/background/capture-db.ts` (ungated, like `background.ts`): minimal
IndexedDB wrapper — DB `xmd-capture`, store `tweets` (keyPath `tweetId`), indexes
`by_conversation`, `by_capturedAt`. `putRecords(records)` does read-merge-write per tweet
via `mergeRecord` inside **one** transaction; `allRecords()`, `conversation(id)`,
`count()`, `clear()`. Funneled through `makeSerialQueue` (same RMW discipline as
`recordHistory`).

**Rationale (resolved, not an open question):** the repo uses `browser.storage.local`
everywhere (10 MB quota **shared** across the extension; zero IndexedDB today). The breadth
flag harvests *all* scrolled text — easily tens of thousands of records — which would blow
the shared budget and evict download history. IndexedDB is effectively unbounded and
isolates harvest volume. Add **`unlimitedStorage`** to the manifest permissions so the
harvest isn't evicted under storage pressure. The pure store is backend-agnostic, so a
capped **storage.local fallback** (ring like history) remains a drop-in if ever needed —
documented, not planned.

## 9. Convex mirror (opt-in, default OFF)

Follows the **cloud-upload precedent literally** (which uses its **own** dedicated ledger
`src/core/cloud/upload-job.ts` + `uploadJobsItem`, and does **not** reuse the
`SyncEvent`-bound `core/sync/outbox.ts`). The media `outbox.ts` is *not* schema-agnostic,
so we build a parallel, dedicated capture stream:

- `src/core/sync/captures.ts` (NEW, gated): `SyncCaptureEvent` schema (carries `tweetId`,
  `conversationId`, `inReplyToTweetId?`, `handle`, `text`, `createdAt?`, `links?`,
  `sourceRank`, `at`); a dedicated bounded **ledger reducer** modeled on `upload-job.ts`
  (`enqueue` deduped by `tweetId` — a newer event replaces an older queued one;
  `readyJobs`/`claim`; `capLedger` cap ~2000; `decodeLedger`); idempotency key
  `captureEventId(deviceId, tweetId) = \`${deviceId}/${tweetId}\``.
- `src/background/capture-outbox.ts` (NEW, shell): **`mirrorCaptures(records)`** (named to
  parallel `mirrorUploadJob`) gates on `isSyncConfigured() && settings.captureMirrorEnabled`,
  `enqueue`s into a new `captureOutboxItem` (storage.local), and drains via a serialized
  queue using the shared Convex HTTP port. Control-plane errors are swallowed (IndexedDB is
  source of truth), exactly like `mirrorUploadJob`.
- `backend/convex/captures.ts` (NEW): **`recordCaptures({ captures, secret })`** mutation,
  modeled on `recordUploadJobs`: `assertSecret(secret)`, per-row upsert via a
  `by_capture_id` index applying the **§6.4 merge rule** (rank-then-`at`, **not** raw
  last-write-wins), returns `{ received, upserted }`.
- `backend/convex/schema.ts`: add

  ```ts
  tweet_captures: defineTable({
    captureId: v.string(),        // `${deviceId}/${tweetId}`
    deviceId: v.string(),
    tweetId: v.string(),
    conversationId: v.string(),
    inReplyToTweetId: v.optional(v.string()),
    handle: v.string(),
    text: v.string(),
    createdAt: v.optional(v.number()),
    links: v.optional(v.array(v.object({ expandedUrl: v.string(), title: v.optional(v.string()), domain: v.optional(v.string()) }))),
    sourceRank: v.number(),
    at: v.number(),
  })
    .index('by_capture_id', ['captureId'])
    .index('by_conversation', ['conversationId'])
    .index('by_at', ['at'])
  ```

  Validators live in `schema.ts`, imported by `captures.ts` (single source of truth).

## 10. Export (`src/core/capture/export.ts`, pure + gated) and delivery

- `toJsonl(records): string` — one `TweetRecord` per line (carries `conversationId` +
  `inReplyToTweetId`); the bulk AI-ingestion artifact.
- `toTreeJson(tree, allRecords): string` — one `ConversationTree` as pretty nested JSON.
- `toMarkdown(tree, allRecords): string` — threaded, depth-indented replies; per tweet:
  author + timestamp, **expanded** text, link bullets (`title — url` when titled), and
  `[media: type ×N]` lines.
- **Quote inlining:** because a quoted/retweeted tweet lives in its *own* conversation
  group, `toMarkdown`/`toTreeJson` take the full record set and **resolve `quotedTweetId`
  to inline the quoted tweet's text** where it is referenced (cross-conversation lookup);
  unresolved → a bare reference. `export.test` asserts quoted text renders.
- **Future seam (not built):** `toRows(records): Row[]` flat projection for a later
  Notion/Sheets exporter; define `Row` now, ship nothing.

**Delivery (MV3-safe):** the background SW **cannot** mint `blob:` URLs (no
`URL.createObjectURL` in a service worker — confirmed: the only such call is in the
offscreen doc). Two paths:
1. **Default — `data:` URL** via the existing `sidecarDataUrl` pattern
   (`core/download/destination.ts:45`): `data:application/json;charset=utf-8,${encodeURIComponent(text)}`
   handed to `chrome.downloads.download`. Zero host permission, no offscreen doc. Used for
   per-thread JSON/Markdown and JSONL **below a size threshold (~2 MB)**.
2. **Large bulk JSONL (> threshold)** — route the text through the existing **offscreen
   `saveBlob` port** (`core/download/fetched-strategy.ts:246`), which mints the `blob:` URL
   in the offscreen document and returns it for `chrome.downloads.download`. This requires
   the optional **`offscreen`** permission (already declared, `wxt.config.ts:45`).

Filenames: `xharvest-{YYYYMMDD}.jsonl`, `thread-{conversationId}.json`,
`thread-{conversationId}.md`.

## 11. Privacy & posture (⚠ posture change → ADR-0017)

The Convex mirror is documented as *"metadata only — never bytes, captures, or auth"* in
three places (`core/sync/events.ts` header, `schema.ts` `cloudSyncEnabled` comment,
ADR-0009). Mirroring tweet **text/threads** is content and **extends** that scope:

1. **New ADR-0017** "Capture mirror extends Convex scope to tweet text": the deliberate
   change, its bound (tweet text + link metadata only; still **never** media bytes, media
   captures, or auth), and the separate opt-in.
2. Mirror rides its **own** toggle `captureMirrorEnabled` (default OFF), independent of
   media `cloudSyncEnabled`. Local capture never implies mirroring.
3. Re-scope the three posture comments to **media** and point at ADR-0017.
4. Whole feature **default OFF** (`captureEnabled=false`): nothing harvested, stored, or
   mirrored until opt-in.

## 12. UI & settings

**New `Settings` flags** (`core/schema/index.ts`, `withDecodingDefaultKey`, all default
`false`): `captureEnabled` (master), `captureAllScrolled` (breadth, D4),
`captureMirrorEnabled` (mirror, D7; meaningful only with sync configured).

**New options panel** `src/entrypoints/options/panels/capture.tsx` ("Knowledge Capture"),
registered in the `SECTIONS` array in `options/App.tsx`:
- The three toggles (mirror greyed until Convex configured).
- Live counts from `summarize`; recent-conversation list from `recentConversations`, each
  with **Export tree** / **Export Markdown**.
- **Export all (JSONL)** + **Clear harvest**.

**New messages** (`Message` union + `messageHandlers` table; responses via `sendResponse`):
- `CaptureTweets{ records }` (content→bg): dispatcher → `capture-db.putRecords` +
  `capture-outbox.mirrorCaptures`. `{ stored }` back.
- `CaptureSummaryRequest` (panel→bg): `{ tweets, conversations, recent }` back.
- `ExportCaptureRequest{ kind: 'jsonl'|'tree'|'markdown', conversationId? }` (panel→bg):
  builds via the pure converters, delivers per §10. `{ ok, filename }` back.
- `ClearCaptureRequest` (panel→bg): `{ cleared }` back.

(Optional, deferrable) in-overlay "Export this thread ⤓" affordance on status pages.

## 13. Testing strategy

`src/core/capture/**` and `src/core/sync/captures.ts` are under the **100% gate** (`src/core`
+ `src/lib`; entrypoints/background/components excluded by design). The `adapters/x/`
refactor (§6.0) is guarded by existing `xadapter.test.ts` plus new cases.

- `walk.test.ts` (or extend `xadapter.test.ts`) — shared `forEachTweetNode`: one visit per
  node; tombstone skip; visibility-wrapper unwrap; nested quote/retweet yield separate
  visits; `detectFromJson` output unchanged.
- `record.test.ts` — field extraction incl. `rest_id`/`legacy.id_str` fallback, `views.count`,
  metrics; `findAuthor` returns the **outer** author's name/userId when quoting.
- `card.test.ts` — index-safe `expandText` incl. an **astral/emoji** tweet with a `t.co` at
  a known offset; flat card keys; `unified_card` blob; malformed card = no-throw.
- `tree.test.ts` — **multi-level** chain (root → A → B, B grandchild of root); orphan reply;
  missing root; self-thread; ordering; cycle defense.
- `store.test.ts` — §6.4 merge: thin-then-rich upgrades, **rich-then-later-thin stays rich**;
  `recentConversations`; corrupt-data decode.
- `export.test.ts` — JSONL line shape; tree JSON; Markdown indentation + link/media lines;
  **quoted text inlined**; empty/edge inputs.
- `core/sync/captures.test.ts` — ledger enqueue dedupe-by-tweetId, cap, idempotency key.
- `backend/convex/captures.test.ts` — `convex-test`: `assertSecret`; **same** §6.4 merge as
  the local store (rich-then-thin stays rich) so the two are provably consistent.

**New fixtures** (derive/trim from `study/TwitterMediaHarvest/.../test-data`):
`tweet-detail-thread.json` — a real `threaded_conversation_with_injections_v2` with a
**genuine multi-level reply chain** authored inside the `conversationthread` `items[]`
module shape (not flat children), so `buildTree` depth and module-nested extraction are
actually exercised; `tweet-with-links.json` (`entities.urls[]` + `expanded_url`);
`tweet-with-card.json` (a flat card **and** a `unified_card`). IDB shell + panel validated
via the real extension (out of gate).

## 14. Build phases (for the implementation plan)

1. **Phase 1 — Local capture + export (whole core value, local-only).**
   - `adapters/x/walk.ts` (extract shared traversal) + refactor `detectFromJson` + tests.
   - `core/capture/record.ts`, `card.ts`, `harvest.ts`, `tree.ts`, `store.ts`, `export.ts`
     — **each with its `.test.ts`** + the three new fixtures.
   - Messages `CaptureTweets`/`CaptureSummaryRequest`/`ExportCaptureRequest`/`ClearCaptureRequest`;
     content-script flush; `background/capture-db.ts`; delivery (§10).
   - Settings `captureEnabled` + `captureAllScrolled`; `unlimitedStorage` permission; the
     options panel. Ships fully usable with **no** cloud dependency.
2. **Phase 2 — Convex mirror.** `core/sync/captures.ts` **+ `captures.test.ts`**;
   `background/capture-outbox.ts`; `backend/convex/captures.ts` **+
   `backend/convex/captures.test.ts`** + `tweet_captures` table; `captureMirrorEnabled`
   setting; **ADR-0017** + posture-comment updates.
3. **Phase 3 (deferred, out of v1).** Notion/Sheets off the `toRows` seam; active link
   enrichment; in-overlay thread-export affordance.

## 15. Resolved decisions (spec review, 2026-06-27)

1. **Mirror payload:** mirror full expanded `text` + all `links` (it's the point of the
   feature). Matches §9.
2. **`captureAllScrolled` default once `captureEnabled` is on:** **OFF** (narrow: media +
   opened threads). Matches §12 defaults.
3. **`rawText`:** **local-only.** The Convex `tweet_captures` row carries expanded `text`
   only (no `rawText`), to bound row size. Matches the §9 schema.

## 16. File manifest

**New (gated, `src/core`):** `adapters/x/walk.ts`; `capture/record.ts`, `capture/card.ts`,
`capture/harvest.ts`, `capture/tree.ts`, `capture/store.ts`, `capture/export.ts`;
`sync/captures.ts` — **each with a co-located `.test.ts`**.

**New (shell/UI, ungated):** `src/background/capture-db.ts`, `src/background/capture-outbox.ts`,
`src/entrypoints/options/panels/capture.tsx`.

**New (backend):** `backend/convex/captures.ts` + `backend/convex/captures.test.ts`;
`tweet_captures` in `schema.ts`.

**New (fixtures):** `src/test/fixtures/tweet-detail-thread.json`, `tweet-with-links.json`,
`tweet-with-card.json`.

**New (docs):** `docs/adr/0017-capture-mirror-extends-convex-scope.md`.

**Changed:** `src/core/adapters/x/index.ts` (refactor `detectFromJson` onto `walk.ts`;
export/relocate `walk`/`findAuthor`/`NESTED_TWEET_KEYS`); `src/core/schema/index.ts`
(settings + messages); `src/entrypoints/background.ts` (handlers + dispatcher + wiring);
`src/entrypoints/options/App.tsx` (SECTIONS); the tee listener in
`src/entrypoints/overlay.content/index.tsx`; `wxt.config.ts` (`unlimitedStorage`); the
three Convex posture comments (`core/sync/events.ts`, `core/schema/index.ts`, ADR-0009).
