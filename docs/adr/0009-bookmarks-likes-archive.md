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
   restarts — ADR-0005 decided *no persistent download history in v1*.
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
- **"Done" means started.** A tweet is `ok` when every one of its downloads
  started (the same bar as `QueueUpdate` and the Quick Grab badge). Removal and
  index marking gate on that; the history record itself preserves the permalink
  for recovery if a started transfer later fails.

## Consequences

- Re-running Archive after an interruption downloads nothing twice and finishes
  any removals the previous run could not reach — the job is safely repeatable.
- A removed bookmark whose download later fails mid-transfer loses its place in
  the queue but not its identity: the `.tweet.json` record carries the
  permalink, text, and links. Removal stays opt-in for exactly this reason.
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
- **Gating removal on terminal download states** — requires correlating
  `downloads.onChanged` completions per tweet across SW recycles; complexity
  not justified while the whole pipeline treats "started" as success.
