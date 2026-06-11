# Handoff — out of scope for the archive-job PR (ADR-0010)

What this PR ships, and the work it deliberately leaves for follow-ups. Each
item lists what's grounded vs. what still needs live verification.

## Shipped here

- Pure core (`src/core/archive/`): link classification, idempotency ledger,
  capture/candidate parsing, record building, session state machine, cleanup
  request building + port, remote-mirror request building + port. 126 tests.
- Wiring: passive capture of Bookmarks/Likes candidates in the overlay content
  script; background save job (plan → ledger-filter → enqueue → per-unit
  reconcile → ledger commit → remote mirror → cleanup dispatch); popup Archive
  section (counts, save buttons, options, last-job summary).
- No new install-time permissions: records are `data:` URLs (ADR-0007),
  cleanup is a same-origin fetch from inside the X tab (ADR-0010).

## 1. Cleanup queryIds + bearer must be verified against a live session

`src/core/archive/cleanup.ts` hardcodes `CLEANUP_QUERY_IDS` for `DeleteBookmark`
/ `UnfavoriteTweet` and the public web bearer. These are X's public web-app
GraphQL ids; **they rotate** and could not be confirmed current from this
environment. The design fails safe — a stale id 404s, `run` returns false, the
bookmark is kept and reported as `removeFailed` — but **removal will not work
until these are verified**. Next step: open x.com logged in (the `web-browser`
skill / a live pass), trigger a real un-bookmark + un-like, read the actual
`queryId`s and `authorization` header from the network panel, and update the
constant map. Add a tiny "removal failed — update query ids" hint in the popup
if `removeFailed > 0 && removed === 0`.

## 2. Full-list enumeration via Auth fallback (passive-only today)

The job archives only tweets the user has **scrolled past** (passive capture,
ADR-0001). Archiving an entire multi-thousand bookmark list needs the opt-in
Auth fallback (ADR, default off) to page `Bookmarks`/`Likes` with a cursor.
That's a separate feature with its own consent UX; the ledger + session +
record pipeline here already handle arbitrary batch sizes, so it's purely an
input-source addition.

## 3. Backends that receive the mirror

`remote.ts` *sends* saved-key entries; the receivers are the existing cloud PRs
and are not built here:

- **Cloudflare (PR #1/#2):** add `POST /saved` accepting `{ entries: [{ key,
  tweetId, source, savedAt }] }`, upserting into a `saved_keys` table keyed by
  `key` (idempotent). Optional `Authorization: Bearer` gate.
- **Convex (ADR-0009 / PR #3):** add an `archive:recordSaved` mutation taking
  `{ entries, secret? }`, skip-on-seen by `key` (mirrors `sync:recordEvents`).

Until a receiver exists, leave sync on `off` (the default) — the local ledger
is the source of truth regardless.

## 4. Cross-device / rehydrated ledger

The ledger is local. A second device re-downloads everything. A follow-up could
seed the local ledger from the remote saved-keys index on first enable (one
read, then local wins). Also: the 5000-cap drops oldest keys silently; a user
with a huge history could see old items re-download. Consider a compaction or a
remote-backed "have I saved this?" check before that becomes real.

## 5. SW-recycle resilience for an in-flight job

Like the monitor (ADR-0008), the archive **session** lives in SW memory. If the
service worker recycles mid-job, per-unit reconciliation for already-started
browser downloads is lost (the ledger commits that already happened persist, so
re-running is still safe and skips them). Durable session rehydration —
persisting `ArchiveSession` to `storage.session` and rebuilding the
`requestIdByDownloadId` map on wake — is the same open work item as the
monitoring accumulator.

## 6. Selectors / media coverage (shared with the existing handoff)

Candidate media comes from `resolveTweetMedia` over `extended_entities.media`,
which is robust for photos/videos/GIFs in the captured JSON. Video poster
matching and exact in-page anchoring for the archive UI reuse the same
selectors flagged for a live x.com pass in the precision-monitoring handoff.

## 7. Retry-from-history UX

PR #2 frames per-item history as the basis for retry. With the ledger +
per-tweet session outcomes now recorded, a "retry failed" action could re-enqueue
only the `failedIds` of the last session. Out of scope here; the data is present.
