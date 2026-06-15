# ADR-0010 — Bookmarks/Likes archive job: tweet history, idempotency ledger, opt-in cleanup

- **Status:** Accepted (2026-06-11)

## Context

Bookmarks and Likes pile up as a reading queue. Users want a **save job**: scoop
every Media Item out of the bookmarked/liked tweets, keep a durable record of
*the tweets themselves* (text and outbound links — above all scholarly links:
arXiv, DOI, Springer, Cambridge UP, OUP, …), then **clear the bookmark/like**
so the queue empties itself. Re-running the job must never re-download media it
already saved, and the saved state should be mirrorable to the user's own
cloud backend (Cloudflare Worker — PR #1/#2 — or Convex — PR #3/ADR-0009),
never as a requirement of the local flow.

Constraints inherited from ADR-0001/0003/0005/0007:

- **Passive first.** Candidates come only from the tee's captures of X's own
  `Bookmarks` / `Likes` GraphQL responses (already in `MEDIA_OPS`) — the job
  archives what the user has scrolled past, it never enumerates.
- **No new install-time permissions.** Tweet-history records ride the sidecar
  `data:`-URL download path (ADR-0007).
- **Removing a like/bookmark is a write** against the user's own session — the
  same class as Auth fallback: **opt-in, default off**, executed in the X tab
  (same-origin fetch, `ct0` cookie) so the extension needs no `cookies`
  permission and no header smuggling.

## Decision

1. **Tweet candidates** are parsed from captured `Bookmarks`/`Likes` responses
   by a pure walker that keeps only nodes the payload itself marks as the
   viewer's (`legacy.bookmarked === true` / `legacy.favorited === true`) and
   skips retweet wrappers — quoted strangers' tweets never enter the job.
2. **Archive record per tweet** (`{dir}/{tweetId}_tweet.json` next to the
   media): tweet URL, author, source, save time, optional `full_text`,
   optional outbound links classified `scholarly`/`other` with a publisher tag.
   Options: include text (default on) and link mode `all | scholarly | none`
   (default `all`).
3. **Idempotency ledger** in `storage.local` (`local:archive-ledger`): a pure,
   capped (5000), append-ordered set of canonical saved keys — media keys are
   the normalized media URL (lowercased host + path sans trailing extension,
   query dropped), record keys are `tweet:{id}:record`. The job plans only
   unsaved work; a completed key is never downloaded again, across sessions
   and browser restarts. This intentionally extends ADR-0005 ("no persistent
   history") — the ledger is *minimal provenance-free keys*, not history.
4. **Sessions are marked.** The latest job's summary (saved / failed / skipped
   / cleaned counts) persists in `local:archive-session`; the popup shows it.
5. **Cleanup** (`DeleteBookmark` / `UnfavoriteTweet` GraphQL mutations, the
   exact calls X's own web app makes) runs **only** after a tweet's media
   *and* record have all completed, only when `archiveRemoveAfterSave` is on,
   and executes inside the X tab. Failures are tolerated and reported, never
   retried into a loop.
6. **Remote mirror, never the gate.** When configured, saved keys are mirrored
   fire-and-forget to a Cloudflare Worker (`POST {base}/saved`) or a Convex
   deployment (`POST {base}/api/mutation`, `archive:recordSaved`) following the
   transport patterns of PR #1 and ADR-0009. The local ledger remains the
   source of truth; sync failure never blocks or fails a download.

## Consequences

- Bookmarks/Likes become a self-emptying queue with a durable, greppable
  archive of what was saved and which papers/links each tweet pointed at.
- Re-runs are cheap and safe: the ledger filters them to zero work.
- The cleanup mutation depends on X's public web `queryId`s, which rotate
  rarely but do rotate; they are isolated in one constant map with a
  tolerated-failure path, so rotation degrades to "bookmark kept", never data
  loss.

## Alternatives considered

- **Enumerate bookmarks via Auth fallback** — rejected: violates passive-first
  scope for a v1; scroll-to-capture is predictable and visible to the user.
- **Ledger in `storage.session`** — rejected: idempotency across restarts is
  the whole point.
- **Remote ledger as source of truth** — rejected: reintroduces a remote
  dependency into the download path (contradicts PRODUCT.md local-only).
