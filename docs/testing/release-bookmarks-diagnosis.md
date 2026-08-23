# Diagnosing a failed Release on the X Bookmarks page

Read this with an exported `xmd-release-diagnostics-*.jsonl` open. It maps each new
diagnostic line to the specific root cause it confirms or eliminates.

## Run the test

1. **Rebuild and reload the extension**, then **reload the X tab.** A content script
   orphaned by a rebuild behaves exactly like the old code, and is itself one of the
   causes below — so a stale overlay makes the run meaningless.
2. Open `/i/history`. Make sure **Release after download** and **Un-bookmark on save**
   are on (Options → Release).
3. Run **“One by one”** from the toolbar popup (the durable sweep — this is the path that
   downloads then releases). Let it finish.
4. Options → Release → **Export diagnostics**. The file lands in Downloads.

The log is capped at **1000 events** (~10-15 per released post). If a run is bigger, the
first line of the export (`clear-export-meta`) reports what was dropped.

## Read the export

Every line is one JSON object. The first is always:

```
clear-export-meta   entries=… evicted=… appended=… decodeDropped=… cap=1000
```

- `evicted > 0` — the run overran the cap; the **oldest** events are gone. Retest with a
  shorter run before trusting the head of the timeline.
- `appended - entries - evicted - decodeDropped > 0` — storage **refused** writes. The
  log is incomplete for a reason unrelated to Release.

Sort by `t` to interleave the two producers (`source:"clear"` is the page, everything
else is the worker). Join a post's story on `tweetId`.

## The five causes, and the line that decides each

### 1. A flip was reported that never happened (virtualizer detach)

The confirm rule accepts “the node disappeared” as proof of an un-bookmark. On Bookmarks,
removing one row re-renders its siblings — so clearing post A can detach post B's node
mid-poll and B is recorded as released while still bookmarked.

```
clear-flip              scope=bookmark arm=detached attempt=1 elapsedMs=200 target=button disabled=false reresolved=member origin=settle
clear-flip-fabricated   scope=bookmark arm=detached attempt=1 elapsedMs=200 target=button disabled=false reresolved=member origin=settle
```

`arm=detached` + `reresolved=member` is **proof of a fabricated flip.** `arm=testid` with
`reresolved=cleared` is a genuine release. This is the most likely cause and it
self-amplifies: each real release manufactures the next fake one. The fabricated case
ALSO emits the distinct `clear-flip-fabricated` line (identical detail, separate stage)
so it's greppable without parsing `arm=`/`reresolved=` out of every ordinary `clear-flip`
line. `origin=` names which path fired this clear: `settle` (a per-tweet dispatch — the
live post-download hook or the durable sweep's re-dispatch, indistinguishable from here),
`drain` (the in-page auto-scroll recovery loop), or `manual` (the popup's "Release this
page…"/"Release the whole list…" — these get only ONE check, `attempt=1` always, not a
6-attempt poll, so they can't slow down a bulk release).

### 2. X reverted the un-bookmark server-side

The flip poll starts 200 ms after the click, before X answers. A 429/4xx on
`DeleteBookmark` reports as success. The watchdog re-probes up to **6 times, 5 s
apart** (a 30 s window) — not just once — so a revert that surfaces late in that
window is still caught:

```
clear-recheck      scope=bookmark origin=settle attempt=1 elapsedMs=5000 state=member articles=… page=bookmark
clear-reappeared   scope=bookmark origin=settle attempt=1 elapsedMs=5000 articles=… page=bookmark freshTimeline=present
```

`state=member` on a `clear-recheck` line means **the release did not stick** — the
post is bookmarked again. `state=cleared` means it held. `state=absent` is
inconclusive (check `articles`: `0` means you had scrolled away). `state=probe-error`
means the re-read itself threw and the line says nothing about membership — treat it
as no data, not as a pass. `origin=` names which path fired the original clear
(`settle`/`drain`/`manual` — see `clear-flip`'s own `origin=` below).

A `state=member` verdict ALSO emits the distinct `clear-reappeared` line — grep this
stage alone to skip past every ordinary attempt. Its `freshTimeline=` is the
ghost-vs-real split: `present` means the tweet id is in the most recent captured
`Bookmarks`/`Likes` timeline response too (H1 — a genuine server-side member);
`absent` means the DOM shows it but the last real timeline fetch didn't (H4 — a
client-cache ghost; a hard refresh should clear it); `unknown` means no fresh capture
exists yet to check against (nothing has fetched that list since the SPA loaded).

`elapsedMs=` is `attempt × 5000`, the same derived (not wall-clock-measured)
convention `clear-flip`'s own `elapsedMs=` uses — Chrome throttles timers in a
backgrounded tab, so a probe can fire later than its nominal slot; a run of
`state=absent` lines on a tab that was backgrounded is more likely late probes than a
real release. A chain that runs all 6 attempts without ever reporting
`clear-reappeared` disarms silently — there is no 7th "gave up" line, the 6
`clear-recheck` lines already say what happened.

### 3. The click never reached a live content script

```
clear-dispatch   tabs=… prefer=… preferHonored=… answered=42:no-receiver,… outcome=exhausted fabricated=true
```

`fabricated=true` means the `ok:false` was **synthesized, not observed** — nothing was
ever clicked. `no-receiver` on the tab you were watching = orphaned overlay (reload the
tab). `preferHonored=false` = a different X tab answered. A missing `clear-tweet-request`
for that `tweetId` confirms it. Any `clear-tab-error` names the underlying rejection.

### 4. The post was skipped because a previous run latched it

```
clear-sweep-skipped   scope=bookmark skipped=11 ids=1234,5678,…
```

Any id here that is **still on screen and still bookmarked** is direct evidence of cause
1 or 2 from an _earlier_ run: the durable worklist believes it is cleared, so it will
never be retried. Diff against `clear-sweep-candidates`. This is the reason “Release did
nothing” on a second run.

### 5. The Release was abandoned after a verified settle

```
clear-settle   … truly=true
clear-not-attempted   reason=no-entry | not-truly-complete | clear-off | no-claimable-scopes
```

`clear-not-attempted` is why a settled download never released. `no-claimable-scopes`
also prints the per-scope latch states and the enabled scopes, which distinguishes “the
scope isn't switched on” from “it was already cleared”. `clear-reset` means a monitor
Reset threw the run away; `clear-queue-error` means the release chain itself threw —
previously invisible in the export.

## Failing to flip, separated from selector rot

```
clear-attempt-fail   scope=bookmark reason=no-flip attempts=6 elapsedMs=1200 target=button disabled=false testids=removeBookmark,bookmark
clear-already-cleared  scope=bookmark clicked=false alreadyCleared=true testids=bookmark
```

`testids=` lists the bookmark/like `data-testid`s actually present. Three readings:

- **`removeBookmark` absent** — X renamed the control. Update `CLEAR_TESTID` in
  `src/packages/clear/clearer.ts`.
- **`testids=` present but empty** — the action bar has no bookmark/like control at all
  (deeper selector rot). Distinct from `reason=no-article`, where the token is omitted
  entirely because the post was not mounted.
- **`removeBookmark` still present with `reason=no-flip`** — the click landed and nothing
  changed. `target=testid-node` means we may have dispatched at a wrapper X ignores;
  `disabled=true` means the control was inert. Both exonerate the selector and point at
  cause 2.

`clear-already-cleared` is a **success without a click**, not a failure.

## Privacy

The log carries only stage names, scopes, `data-testid` strings, numeric post/download/tab
ids, counts, elapsed ms, a coarse `page=` token, and compacted error messages. No post
text, handles, media URLs, or filenames — the pathname is classified to
`bookmark|like|home|other` before it is ever written.
