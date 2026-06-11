# Plan — Bookmarks/Likes archive job (ADR-0010)

Module contracts for `src/core/archive/`. Every behavior below is normative:
tests are written against this contract, implementations satisfy it. All
modules are pure (injected time, injected fetch) per repo convention.

## `links.ts`

```ts
export type LinkKind = 'scholarly' | 'other'
export interface ArchivedLink { url: string; kind: LinkKind; publisher?: string }
export type LinkMode = 'all' | 'scholarly' | 'none'
export function classifyLink(url: string): ArchivedLink
export function extractLinks(entities: unknown): ArchivedLink[]
export function filterLinks(links: ReadonlyArray<ArchivedLink>, mode: LinkMode): ArchivedLink[]
```

- `classifyLink` matches the URL host against a publisher table by **whole
  label suffix** (`arxiv.org` and `*.arxiv.org` match; `notarxiv.org` must
  not). Case-insensitive host; path/query never affect the match. Unparsable
  URLs ⇒ `{ url, kind: 'other' }` (no publisher key).
- Publisher tags (kind `scholarly`): `arxiv` (arxiv.org), `doi` (doi.org),
  `springer` (springer.com, springernature.com), `cambridge` (cambridge.org),
  `oup` (oup.com, academic.oup.com), `nature` (nature.com), `science`
  (science.org), `elsevier` (sciencedirect.com, elsevier.com), `wiley`
  (wiley.com), `ieee` (ieee.org), `acm` (acm.org), `jstor` (jstor.org),
  `pnas` (pnas.org), `cell` (cell.com), `lancet` (thelancet.com), `nejm`
  (nejm.org), `taylor-francis` (tandfonline.com), `sage` (sagepub.com),
  `biorxiv` (biorxiv.org), `medrxiv` (medrxiv.org), `ssrn` (ssrn.com), `acl`
  (aclanthology.org), `openreview` (openreview.net), `semantic-scholar`
  (semanticscholar.org), `aps` (aps.org), `iop` (iop.org), `royal-society`
  (royalsocietypublishing.org), `pubmed` (ncbi.nlm.nih.gov), `plos`
  (plos.org), `mdpi` (mdpi.com), `frontiers` (frontiersin.org).
- `extractLinks` reads X's `entities.urls[]`, preferring `expanded_url` over
  `url` (the `t.co` shortener), skipping entries with neither; dedupes by the
  chosen URL (first wins); tolerates any malformed `entities` shape (⇒ `[]`).
- `filterLinks`: `all` ⇒ identity; `scholarly` ⇒ only `kind === 'scholarly'`;
  `none` ⇒ `[]`.

## `ledger.ts`

```ts
export interface LedgerEntry { key: string; savedAt: number }
export interface Ledger { entries: ReadonlyArray<LedgerEntry> } // oldest → newest
export const LEDGER_CAP = 5000
export function emptyLedger(): Ledger
export function mediaKey(url: string): string
export function recordKey(tweetId: string): string // `tweet:{id}:record`
export function hasKey(ledger: Ledger, key: string): boolean
export function markSaved(ledger: Ledger, keys: ReadonlyArray<string>, at: number): Ledger
export function filterUnsaved<T>(ledger: Ledger, items: ReadonlyArray<T>, keyOf: (t: T) => string): T[]
export function decodeLedger(raw: unknown): Ledger
```

- `mediaKey` canonicalizes: lowercase host, **path case preserved** (twimg
  media keys are case-sensitive), query+fragment dropped, a trailing
  `.{1-5 alphanumeric}` extension stripped from the last segment. So
  `https://PBS.twimg.com/media/AbC.jpg?name=orig` and
  `https://pbs.twimg.com/media/AbC?format=jpg&name=orig` both ⇒
  `pbs.twimg.com/media/AbC`. Non-URL input falls back to the trimmed string.
- `markSaved`: existing keys keep their original `savedAt` (idempotent);
  duplicate keys within one call collapse to one entry; new entries append in
  given order; overflow beyond `LEDGER_CAP` drops the **oldest**. Never
  mutates its input.
- `filterUnsaved` drops items whose key is in the ledger **and** intra-batch
  duplicates (first occurrence wins).
- `decodeLedger`: anything that doesn't decode to the schema ⇒ `emptyLedger()`
  (corrupt-recovery, mirrors settings).

## `capture.ts`

```ts
export type ArchiveSource = 'bookmarks' | 'likes'
export interface TweetCandidate {
  tweetId: string; handle: string; source: ArchiveSource
  text: string; createdAt?: string
  links: ReadonlyArray<ArchivedLink>
  items: ReadonlyArray<MediaItem>
}
export function sourceFromPath(path: string): ArchiveSource | null
export function detectCandidates(json: unknown, source: ArchiveSource): TweetCandidate[]
```

- `sourceFromPath` recognizes a tee'd pathname whose **final segment** is the
  op: `/i/api/graphql/{qid}/Bookmarks` ⇒ `'bookmarks'`, `…/Likes` ⇒ `'likes'`,
  anything else (including `/BookmarksFoo`) ⇒ `null`.
- `detectCandidates` walks the whole JSON tree (any endpoint shape). A node is
  a candidate iff it has a `legacy` object whose **viewer flag matches the
  source** (`bookmarked === true` for bookmarks, `favorited === true` for
  likes) and a tweet id (`rest_id` or `legacy.id_str`). Retweet wrappers
  (nodes with `legacy.retweeted_status_result`) are skipped — the inner tweet
  is visited on its own. Dedupe by tweetId (first wins). Per candidate:
  `text` = `legacy.full_text` (`''` when absent), `createdAt` =
  `legacy.created_at` when a string, `links` = `extractLinks(legacy.entities)`,
  `items` = `resolveTweetMedia` over `legacy.extended_entities.media` (may be
  `[]` — text-only tweets are still archived), `handle` = nearest
  `screen_name` under the node (`''` fallback).

## `record.ts`

```ts
export interface ArchiveOptions { includeText: boolean; linkMode: LinkMode }
export interface ArchiveRecord {
  tweetId: string; handle: string; tweetUrl: string; source: ArchiveSource
  savedAt: string; createdAt?: string; text?: string
  links?: ReadonlyArray<ArchivedLink>
  media: ReadonlyArray<{ index: number; type: MediaItem['type']; url: string }>
}
export function buildArchiveRecord(c: TweetCandidate, opts: ArchiveOptions, savedAtIso: string): ArchiveRecord
export function archiveRecordFilename(template: string, c: TweetCandidate): string
export function planArchiveRecord(template: string, c: TweetCandidate, opts: ArchiveOptions, savedAtIso: string): PlannedDownload
```

- `tweetUrl`: `https://x.com/{handle}/status/{tweetId}`; with an empty handle,
  `https://x.com/i/web/status/{tweetId}`.
- `text` present iff `includeText`; `links` present iff `linkMode !== 'none'`
  (filtered by mode — possibly `[]`). `createdAt` present iff the candidate
  has one. `media` lists the resolved items (index/type/url) — always present.
- `archiveRecordFilename`: render the user's media template for a synthetic
  photo item (`index 0`, ext `json`) of this tweet, then replace the basename
  with `{tweetId}_tweet.json`, preserving the rendered directory. Template
  `{handle}/{tweetId}_{index}.{ext}` + tweet `123` by `alice` ⇒
  `alice/123_tweet.json`.
- `planArchiveRecord` ⇒ `PlannedDownload` with `id` = `archive:{tweetId}`,
  `url` = sidecar-style `data:application/json` URL of the record (ADR-0007
  round-trip rules), `filename` as above.

## `session.ts`

```ts
export type CleanupState = 'kept' | 'pending' | 'removed' | 'failed'
export interface SessionTweet {
  tweetId: string; source: ArchiveSource
  unitIds: ReadonlyArray<string>   // request ids this tweet waits on
  savedIds: ReadonlyArray<string>; failedIds: ReadonlyArray<string>
  skipped: number                  // units the ledger already covered
  cleanup: CleanupState
}
export interface ArchiveSession {
  id: string; source: ArchiveSource; startedAt: number
  tweets: ReadonlyArray<SessionTweet>
}
export interface SessionSummary {
  source: ArchiveSource; startedAt: number
  tweets: number; saved: number; failed: number; skipped: number
  removed: number; removeFailed: number; done: boolean
}
export function startSession(opts: {
  id: string; source: ArchiveSource; startedAt: number; removeAfterSave: boolean
  tweets: ReadonlyArray<{ tweetId: string; unitIds: ReadonlyArray<string>; skipped: number }>
}): ArchiveSession
export function recordUnitOutcome(s: ArchiveSession, unitId: string, ok: boolean): ArchiveSession
export function isTweetSaved(t: SessionTweet): boolean
export function cleanupCandidates(s: ArchiveSession): ReadonlyArray<SessionTweet>
export function markCleanup(s: ArchiveSession, tweetId: string, ok: boolean): ArchiveSession
export function summarize(s: ArchiveSession): SessionSummary
```

- `startSession` seeds every tweet with `cleanup: removeAfterSave ? 'pending' : 'kept'`.
- `recordUnitOutcome` is **idempotent per unit**: a unit already in
  `savedIds`/`failedIds` is not re-counted (duplicate `onChanged` deltas must
  not corrupt counts). Unknown unit ids are ignored. No mutation.
- `isTweetSaved`: every unit settled and none failed. A tweet with zero units
  (everything skipped) **is** saved.
- `cleanupCandidates`: saved tweets with `cleanup === 'pending'`.
- `markCleanup` ⇒ `removed`/`failed`; only from `pending`.
- `summarize.saved`/`failed` count **units** across tweets; `skipped` sums
  skips; `removed`/`removeFailed` count tweets; `done` = every unit settled
  *and* no tweet is left `pending` for cleanup among saved tweets.

## `cleanup.ts`

```ts
export interface CleanupRequest {
  tweetId: string; source: ArchiveSource
  op: 'DeleteBookmark' | 'UnfavoriteTweet'; url: string; body: string
}
export const CLEANUP_QUERY_IDS: Record<'DeleteBookmark' | 'UnfavoriteTweet', string>
export function buildCleanupRequest(tweetId: string, source: ArchiveSource): CleanupRequest
export function csrfFromCookie(cookie: string): string | null
export function cleanupHeaders(csrf: string): Record<string, string>
export function isCleanupSuccess(body: unknown): boolean
export function makeCleanupPort(deps: { fetchImpl: typeof fetch; getCookie: () => string })
  : { run: (req: CleanupRequest) => Promise<boolean> }
```

- `bookmarks` ⇒ `DeleteBookmark`, `likes` ⇒ `UnfavoriteTweet`. `url` =
  `https://x.com/i/api/graphql/{queryId}/{op}`; `body` JSON =
  `{ variables: { tweet_id }, queryId }`.
- `csrfFromCookie` parses `ct0` out of a `document.cookie` string (`null`
  when absent/empty). `cleanupHeaders` carries `content-type:
  application/json`, `x-csrf-token`, and the public web bearer.
- `isCleanupSuccess`: a parsed body with a `data` object and no non-empty
  `errors` array. Network errors / missing csrf ⇒ `run` resolves `false`
  (never throws).

## `remote.ts`

```ts
export type ArchiveSyncKind = 'off' | 'cloudflare' | 'convex'
export interface RemoteSyncConfig { kind: ArchiveSyncKind; url: string; secret: string }
export interface SavedEntryPayload { key: string; tweetId: string; source: ArchiveSource; savedAt: number }
export function buildSyncRequest(cfg: RemoteSyncConfig, entries: ReadonlyArray<SavedEntryPayload>)
  : { url: string; headers: Record<string, string>; body: string } | null
export function makeRemoteLedgerPort(cfg: RemoteSyncConfig, fetchImpl: typeof fetch)
  : { record: (entries: ReadonlyArray<SavedEntryPayload>) => Promise<void> }
```

- `null` when `kind === 'off'`, `url` blank, or `entries` empty.
- `cloudflare`: `POST {base}/saved` (base = url sans trailing `/`), body
  `{ entries }`, `authorization: Bearer {secret}` only when secret non-empty.
- `convex`: `POST {base}/api/mutation`, body
  `{ path: 'archive:recordSaved', args: { entries } | { entries, secret }, format: 'json' }`
  (ADR-0009 envelope).
- `record` is fire-and-forget: swallows every rejection/non-OK; resolves void.

## Settings (schema) additions — decoding defaults

`archiveIncludeText: true`, `archiveLinkMode: 'all'`,
`archiveRemoveAfterSave: false`, `archiveSyncKind: 'off'`,
`archiveSyncUrl: ''`, `archiveSyncSecret: ''`.

## Messages added to the `Message` union

`ArchiveStatusRequest {}` (popup→content) ⇒ plain
`{ _tag: 'ArchiveStatusResponse', bookmarks, likes }`;
`ArchiveStartRequest { source }` (popup→content) ⇒
`{ _tag: 'ArchiveStartResponse', ok, queued, reason? }`;
`ArchiveSaveRequest { source, tweets }` (content→background);
`ArchiveCleanupRequest { requests }` (background→content, tab-targeted);
`ArchiveCleanupReport { results: [{ tweetId, ok }] }` (content→background);
`ArchiveSessionRequest {}` (popup→background) ⇒ last `SessionSummary | null`.

## Wiring (entrypoints, thin)

- overlay.content: accumulate candidates per source from tee events whose
  path maps via `sourceFromPath`; answer status/start; execute cleanup via
  `makeCleanupPort` with `document.cookie`.
- background: on `ArchiveSaveRequest` — load ledger, plan media (existing
  `planDownloads`, sidecar off for archive media; the record IS the metadata)
  + record plans, `filterUnsaved` both, start session, reuse the shared
  enqueue path; on every unit outcome feed `recordUnitOutcome`; when a tweet
  flips saved: `markSaved` ledger keys, persist, mirror remote, and (if
  pending) send `ArchiveCleanupRequest` to the originating tab; persist
  summary on every transition.
