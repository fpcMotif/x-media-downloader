# ADR-0009 — Bookmarks & Likes archive: history records, DOM-click removal, durable index

- **Status:** Accepted (2026-06-11)

## Context

Bookmarks and Likes pile up as a reading queue. Users want to **drain** them:
save each tweet's media at original quality, keep a durable history of what the
tweet said and linked to (notably scholarly links — arXiv, DOI, Springer,
Cambridge, OUP, …), then remove the bookmark/like so the queue shrinks. Three
tensions with the existing design:

1. Removing a bookmark/like is a **mutation** — ADR-0001's passive capture
   issues no requests, and this project never uses the official API.
2. "Never re-download what a previous run saved" needs memory across browser
   restarts — ADR-0005 decided _no persistent download history in v1_.
3. "Save job done" must be honest: removal is destructive, so it has to gate on
   the same signal the rest of the UI treats as success.

## Decision

- **Capture stays passive.** The MAIN-world tee already scopes `Bookmarks` and
  `Likes` GraphQL ops; the adapter additionally extracts **Tweet Captures**
  (text — including `note_tweet` long form — expanded URL entities, created-at,
  media) from those responses. `quoted_status_result` subtrees are pruned: the
  bookmark belongs to the outer tweet, and the quote's permalink survives in
  its links.
- **History rides the download path.** Each archived tweet gets a
  `{tweetId}.tweet.json` record (a `data:` URL, like the sidecar) saved next to
  its media; each run that processed anything writes a session manifest under
  `x-archive/sessions/{sessionId}.json`. Settings decide whether the record
  carries text and which links it keeps (`all` / `scholarly` / `none`); the
  scholarly host list lives in `core/archive/links.ts`.
- **Removal is a DOM click, opt-in, default-off.** After a tweet's downloads
  all start, the content script clicks X's **own** `removeBookmark` / `unlike`
  action-bar button — a user-gesture-driven mutation executed by X's own code;
  no credential handling, no GraphQL replay, no queryId scraping. Clicks are
  staggered (~350 ms). Only articles still rendered in the virtualized timeline
  can be clicked; anything else stays saved on X and is removed by a later run.
- **Idempotency via a durable Archive Index.** `local:archiveIndex` maps
  tweetId → `{archivedAt, sessionId, media}`. Planned tweets already in the
  index are skipped whole (still reported, so a later run can finish removal);
  in-flight request de-duplication continues to guard within a session. This
  deliberately **amends ADR-0005** for this feature: the index stores ids and
  timestamps only — no captured content — so the privacy posture holds.
- **Historical decision — "Done" meant started.** This was the 2026-06 rule.
  It is superseded below; the history record still preserves the permalink.

## Consequences

- Re-running Archive after an interruption downloads nothing twice and finishes
  any removals the previous run could not reach — the job is safely repeatable.
- The historical start-time rule could remove a bookmark before its bytes landed.
  The later amendment closes that gap.
- DOM-click removal depends on X's `data-testid` attributes (`removeBookmark`,
  `unlike`) — the same stability class the overlay already accepts for
  `article[data-testid="tweet"]`.

## Alternatives considered

- **Replaying `DeleteBookmark` / `UnfavoriteTweet` GraphQL mutations** — needs
  bearer/csrf handling and build-specific queryIds; violates the no-API-replay
  posture and is the most fingerprintable option. Rejected.
- **Archive index in `storage.session`** — idempotency would not survive a
  browser restart, which is precisely when a half-drained bookmark queue gets
  re-run. Rejected.
- **Historical alternative — gating removal on terminal states** — was deferred
  before durable correlation existed.

## Amendment (2026-07-22) — verified browser completion

Clear-after-download now requires terminal browser evidence, its Chrome
`downloadId`, and the later Settle probe proving the file still exists. The
durable Registry records terminal evidence; Clear remains blocked until Settle.
aria2 media is observed through `tellStatus`, but has no Chrome download id and
is never eligible for Clear.
