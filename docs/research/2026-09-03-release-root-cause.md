# Release instability — root cause and open research questions

Date: 2026-09-03. Status: static analysis + fix landed; live verification pending.

## What the code does today

A release (un-like / un-bookmark) is confirmed only by DOM heuristics
(`src/packages/clear/clearer.ts` `flipConfirmed`, driven by
`src/packages/clear/tweet-clear.ts` `clearScope`):

- the `data-testid="unlike"` / `"removeBookmark"` control disappears from the
  captured `<article>` within 6 × 200 ms, **or**
- the captured `<article>` detaches from the document.

Both signals are guesses about what X's virtualized `/i/history` list renders.
The list can render stale rows (a post already released from another tab still
shows the active control), and sibling re-renders detach nodes of posts that are
still members. Every fix since #62 (`classifyFlip`, ghost memo, poll budget 16 → 30,
snowflake gate, orphan tabs) is a heuristic on top of a heuristic.

The ground truth already exists in-page and is thrown away: the MAIN-world tee
(`src/entrypoints/inject.content.ts`) intercepts `UnfavoriteTweet` /
`DeleteBookmark` and reports `{status, errors[], variables.tweet_id}`. Until now it
only fed the diagnostics log (`clear-mutation` lines, `correlate.ts`).

## Root cause (as far as static reading can establish)

Confirmation is decoupled from the server outcome. A click that X accepted but the
list did not re-render reads as `no-flip`, gets re-clicked every sweep, and a click
that X rejected can still read as a flip when the row detaches. That is the exact
shape of the 2026-08-23 log (settle no-flip ×6 on the list tab, success via the
permalink tab, then every sweep pass re-failing the same row).

## Fix landed

`src/packages/clear/mutation-witness.ts` records recent release mutations per page;
`clearScope` and the manual sweep consult it after each click. Precedence is now:

1. server mutation `ok` (200, no `errors`) → cleared, `arm=mutation`
2. server mutation error → fail, `reason=mutation-error`
3. no mutation seen → existing DOM flip logic (unchanged fallback)

## What I could not verify statically (deep-research targets)

These decide whether the fallback still matters and whether constants are sane.
Each needs either a live DOM capture or an exported diagnostics log.

1. **`/i/history` row markup.** Does a row on `/i/history` and `/i/history/likes`
   carry `data-testid="unlike"` / `"removeBookmark"` on a `<button>` inside
   `article[data-testid="tweet"]`, or a different control? Grab one row's outerHTML
   (strip text) and check `actionTestids` output on it.
2. **Optimistic UI on `/i/history`.** After clicking unlike on that list, does X flip
   the testid in place, remove the row, or leave the row untouched until refetch?
   Time from click to first DOM change matters: the DOM poll window is 1.2 s.
3. **Server reply on an already-released post.** When `UnfavoriteTweet` is sent for a
   post that is already un-liked, does X return 200 with data, or 200 with
   `errors[]`? This decides whether a ghost row resolves as `ok` (drops off the
   worklist) or `mutation-error` (still re-claimable). If it is an error, the
   witness should treat "already not a member" errors as success; find the exact
   error code/message.
4. **Hidden-tab timers.** The permalink release tab is created inactive. Chrome
   aligns timers in hidden tabs to 1 s, and after ~5 min hidden applies intensive
   throttling (1/min) to chained timers. The in-page poll is a chain of `setTimeout`
   calls. Confirm whether the release tab's `clearScope` polls stretch past the
   service worker's 12 s `RELEASE_POLL_BUDGET_MS` in a long session. If yes, drive the
   poll from the service worker (probe messages) instead of in-page timers.
5. **Synthetic click acceptance.** `HTMLElement.click()` on X's like button is
   documented as working from the console; confirm it still holds on `/i/history`
   rows, and whether X now needs `pointerdown`/`pointerup` first.

## Evidence to collect from a failing session

Export the Release diagnostics from the options panel and look at, per tweet id:
`clear-attempt-fail … testids=… target=… disabled=…`, `clear-flip … arm=…
reresolved=…`, and the nearby `clear-mutation op=… status=… error=…` lines. With
the witness in place, a mutation `ok` on a `no-flip` row is now impossible by
construction; any remaining `no-flip` means the click never produced a request
(targets 1 and 5 above).
