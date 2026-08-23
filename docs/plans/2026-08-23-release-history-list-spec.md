# Release on the X Bookmarks list (now `/i/history`) — throughput and honesty

**Status:** spec → build (2026-08-23). Supersedes the uncommitted `RELEASE_POLL_ATTEMPTS 16→30`
edit and the partial `/history` regex in `pageScope`. Absorbs the core of GitHub issue #73.

## What was actually observed (evidence, not hypothesis)

Read live off the debug Chrome profile (CDP on `:9222`) and the durable Release log in
`chrome.storage.local.releaseDiagnostics` (last 1000 events, 2026-08-17 08:05–08:07 local):

1. **X moved both lists under a History surface.** `/i/bookmarks` and `/i/bookmarks/*` now
   302 → `/i/history` (Bookmarks tab). `/{handle}/likes` → `/i/history/likes`.
   `/i/history/bookmarks` → `/i/history`. The row controls are unchanged
   (`removeBookmark` / `unlike`), and the list region carries
   `aria-label="Timeline: Bookmarks"` / `"Timeline: Likes"`. The loaded build already
   matches `/history` by regex, so URL recognition is *not* what the user is hitting.
2. **The Bookmarks tab releases only what is mounted.** X keeps ~10 `article[data-testid="tweet"]`
   mounted. In the window, 9 posts released in place (`outcome=mounted`, real `clear-flip`).
3. **Everything else goes to the permalink leg, which failed 100 %.** At t≈0 the ledger
   re-settled ~93 posts in 200 ms (a `clear-claim` burst). Each un-mounted dispatch queues a
   **serialized** release-tab leg. Five legs fit in the window; every one ran the full poll
   (30 × ~650 ms ≈ 20 s) and every probe answered `pageScope=none articles=0`
   (`reason=exhausted attempts=30`, `fabricated=true`, `bookmark:fail like:fail`). The release
   tab had already answered `articles=0` in the *fan-out* before the leg navigated it, i.e. it
   was sitting on a zero-article page and every navigation stayed there. ~90 queued legs ×
   20 s ≈ 30 min of guaranteed failure → "Release does nothing".
4. **The same five ids mount in 1.2–3.9 s today** when driven through the extension's own
   `tabs.update` + `tabs.sendMessage` path from a hidden tab, with 200s on `TweetDetail`. The
   leg mechanics work; the failure was a *page state* the leg cannot see or recover from. X's
   bundle ships a `data-testid="error-detail"` block with "Something went wrong. Try
   reloading." / "Rate limit exceeded" / "This post is unavailable." — a zero-article
   permalink is one of those, or a page that never committed.
5. **Per-probe logging ate the durable log.** Each leg wrote 30 `clear-tweet-request` +
   30 `clear-tweet-not-mounted` pairs; five legs = 300 of the 1000-event cap.
6. One tab in the window was orphaned (`no-receiver`), re-probed on every dispatch.

## Goal

A Bookmarks/Likes Release on the History surface that (a) recognises the new URLs exactly,
(b) spends seconds, not tens of seconds, on a permalink that will never mount, (c) recovers a
stuck release tab by reloading it once, (d) names the world it failed in, (e) stops a burst of
queued legs from hammering an erroring page, and (f) stops paying for dead tabs. Nothing here
widens what gets clicked.

## Non-negotiables (unchanged)

- Origin-first ordering and its short-circuit; one `clear-dispatch` line per dispatch;
  `sendClearToTabs` never throws.
- The seed-time `ReleaseScopePin` is the only click authority on a permalink when
  "clear from every list" is off. **The release leg never calls `tabs.get` to decide what to click.**
- Fail-closed skip when no claimed scope can fire (`release-skipped`).
- One release tab, legs serialized through `releaseQueue`.
- Diagnostics are observation-only: a failed trace can never change whether a post clears.
- X-only. No IG/Threads change.

## Part A — History surface recognition

`src/packages/clear/clearer.ts` `pageScope(pathname)`:

```
like     ⇐ ^/i/history/likes(/|$)   |  ^/[A-Za-z0-9_]{1,15}/likes(/|$)   (legacy, still redirected by X)
bookmark ⇐ ^/i/history(/|$)         |  ^/i/bookmarks(/|$)               (legacy)
```

- Evaluate `like` first so `/i/history/likes` never reads as bookmark.
- Delete the `?tab=` branches: `pageScope` receives a *pathname*; a query string can never be
  present. Delete the unanchored `/\/history(...)/` (it would match `/{handle}/history`).
- Tests: the existing `pageScope` cases plus `/i/history`, `/i/history/`, `/i/history/likes`,
  `/i/history/bookmarks` (→ bookmark), `/i/history/likes/` , `/i/historyx` (→ none),
  `/someone/history` (→ none), `/i/likes` (→ none).
- Copy (`src/components/action-copy.ts`): the three `not-list-page` sentences say
  "Likes or Bookmarks" — keep the nouns, add where they live: e.g.
  `Open your Bookmarks or Likes (x.com/i/history) — "Release this page" only runs on a list.`
  Update the corresponding test expectations.
- Docs: `docs/testing/release-bookmarks-diagnosis.md` step 2 → `/i/history`; the
  `clearer.ts` doc comments and `tab-broadcaster.ts` comments that cite `/i/bookmarks`.
- `NOTES.md` "whether bookmarks/likes merged into a history surface" — answered: yes.

## Part B — Page-state evidence from the content script

`src/packages/schema/index.ts`:

```ts
ClearTweetRequest  += probe: Schema.optional(Schema.Boolean)
ClearTweetResponse += page:  Schema.optional(Schema.Struct({
  articles: Schema.Number,             // article[data-testid="tweet"] count
  cells:    Schema.Number,             // [data-testid="cellInnerDiv"] count — 0 ⇒ nothing rendered at all
  ready:    Schema.Literals(['loading','interactive','complete']),
  error:    Schema.Boolean,            // [data-testid="error-detail"] present (X's own error block)
}))
```

`handleClearTweet` (`overlay.content/handlers.ts`):

- Every **unmounted** answer carries `page` (pure helper `pageEvidence(document)` in
  `packages/clear/clearer.ts`, 100 %-covered).
- When `req.probe === true` and the post is unmounted, the handler **does not** emit
  `clear-tweet-request` / `clear-tweet-not-mounted` — the leg's folded line (Part C) is the
  evidence. A mounted answer on a probe behaves exactly as today (it clicks and reports).
- The first leg attempt is sent **without** `probe` so the trace still shows the request reached
  the tab once; attempts ≥ 2 set `probe: true`.

## Part C — Release leg: wall-clock budget, early exits, reload, one folded line

`src/background/tab-broadcaster.ts`, all behind the existing `TabsPort` + `deps.clock`:

```ts
interface TabsPort {
  …existing…
  reloadReleaseTab(tabId: number): Promise<void>   // browser.tabs.reload; rejects if gone
  releaseTabId(): number | undefined               // current reusable tab, if any
}
deps.clock: { sleep(ms): Promise<void>; now(): number }   // now() added; default Date.now
```

Constants (module-level, exported for tests):

```
RELEASE_POLL_INTERVAL_MS   = 600
RELEASE_POLL_BUDGET_MS     = 12_000   // wall clock, replaces RELEASE_POLL_ATTEMPTS
RELEASE_UNREACHABLE_MS     = 4_000    // no probe ever answered for this long ⇒ give up
RELEASE_STUCK_MS           = 4_000    // answered, articles=0, cells=0, ready=complete for this long ⇒ reload once
RELEASE_BACKOFF_MS         = 60_000   // after a page-error leg, later legs fail fast until this passes
```

Leg algorithm (`releaseViaStatusTab`):

1. Breaker: if `now() < backoffUntil` → trace `clear-release-poll … reason=backoff` and return
   `{ok:false}` **without navigating**.
2. Navigate (existing). On rejection → existing `clear-tab-error phase=release-nav` line **and**
   a `clear-release-poll … reason=nav-failed` line.
3. Loop until `elapsed ≥ RELEASE_POLL_BUDGET_MS`, sleeping `RELEASE_POLL_INTERVAL_MS` between probes:
   - `probes++`; send `ClearTweetRequest` (`probe: true` from the 2nd attempt).
   - threw → `threw++`. If `threw === probes && elapsed ≥ RELEASE_UNREACHABLE_MS` → exit `unreachable`.
   - `mounted:true` → exit `mounted` with results (clears the breaker).
   - unmounted → `unmounted++`, remember `page`.
     - Two consecutive `page.error` answers → if not yet reloaded: reload, `reloaded=true`, continue;
       else exit `page-error` and set `backoffUntil = now() + RELEASE_BACKOFF_MS`.
     - `page.articles===0 && page.cells===0 && page.ready==='complete'` continuously for
       `≥ RELEASE_STUCK_MS` and not yet reloaded → reload, `reloaded=true`, continue.
4. Budget end → `exhausted` if anything answered, else `unreachable`.

Every exit path emits exactly one line:

```
clear-release-poll  tab=<id> probes=<n> threw=<n> unmounted=<n> lastArticles=<n|none>
                    lastCells=<n|none> lastReady=<loading|interactive|complete|none>
                    lastError=<true|false|none> reloaded=<true|false> elapsedMs=<n>
                    reason=<mounted|exhausted|unreachable|nav-failed|page-error|backoff>
```

The old `clear-tab-error … phase=release-poll reason=exhausted attempts=N` line is **removed**
(its tests move to the new line). `clear-dispatch` keeps `outcome=release-tab|release-failed` and
`fabricated=`.

## Part D — Fan-out: exclude the release tab, skip proven-dead tabs, surface the count

In `sendClearToTabs`:

- The immediate fan-out excludes `tabs.releaseTabId()`; the dispatch line gains
  `excluded=<id|none>`. The leg still targets it directly. If the release tab *is* the
  `preferTabId` (it can't be in practice) it is still excluded — the leg covers it.
- Orphan record (session-scoped, in the broadcaster closure, keyed by tab id):
  `{ misses: number; skippedSince?: number; skippedDispatches: number }`.
  - A tab that answered `no-receiver` on **2 consecutive** dispatches is **skipped** thereafter.
  - A skipped tab is re-probed when `now() - skippedSince ≥ 30_000` **or** after 10 skipped
    dispatches, whichever first; a successful answer (any non-throw) deletes its record.
  - Ids absent from `queryXTabs()` are forgotten on every dispatch.
  - The dispatch line gains `skipped=<n>` (tabs not probed this dispatch) and `stale=<n>`
    (tabs currently in skipped state after this dispatch).
- `TabBroadcaster.staleTabCount(): number` (pure read). `MetricsSnapshot` gains
  `staleTabs: Schema.optional(Schema.Number)`; the `MetricsRequest` handler fills it only when
  > 0. The popup's Release cluster renders an advisory (not a blocker) when present:
  `N open X tabs run a stale copy of the extension — refresh them so Release can use them.`
  Absent at zero. Pure copy helper in `action-copy.ts`, unit-tested.

## Part E — Console label names the tab and the post

`packages/clear/diagnostics.ts` gains `formatTraceLabel(entry: DownloadTraceEntry): string` —
`[stage, type, itemId, tab=<tabId>, post=<tweetId>, <elapsedMs>ms, detail]` with absent fields
dropped (no empty tokens). `recordTrace` (`entrypoints/background.ts`) calls it. Durable entry
shape unchanged. 100 % covered.

## Testing

- `clearer.test.ts`: `pageScope` matrix above; `pageEvidence` on a fake document (articles /
  cells / error-detail / readyState).
- `tab-broadcaster.test.ts` (fake port + instant clock with a settable `now`):
  - all probes throw → `reason=unreachable`, `threw=probes`, exits before budget.
  - unmounted `articles=0 cells=0 ready=complete` throughout → `reloaded=true`, `reason=exhausted`.
  - `error:true` twice → `reason=page-error`; the **next** leg → `reason=backoff` with no
    `navigateReleaseTab` call; after `RELEASE_BACKOFF_MS` the leg navigates again.
  - mounted on probe 3 → `reason=mounted probes=3`, first request has no `probe`, later ones do.
  - release tab in query ids → not in `tried`, `excluded=77`, leg still uses it.
  - orphan: dispatch 1 & 2 with tab X throwing → dispatch 3 does not send to X (`skipped=1`,
    `stale=1`); advance `now` 30 s → dispatch 4 probes X again; X answers → record cleared.
  - existing assertions that counted 16/30 release-tab sends are rewritten against the budget.
- `diagnostics.test.ts`: `formatTraceLabel` with/without tabId/tweetId/elapsedMs.
- `action-copy.test.ts`: new sentences.
- Gates: `bun run check` (fmt, lint, varlock, tsgo, depcruise, vitest) and
  `bun run test:coverage` (100 % over core+packages) and `bun run build`.
- Live (CDP `:9222`, debug profile, extension reloaded): popup context on `/i/history` reads
  `X · Bookmarks list`; a release leg driven on a **non-bookmarked** post (safe: membership
  gating no-ops) produces a `clear-release-poll … reason=mounted` line in the durable log with
  `probes ≤ 6`; the label in the SW console carries `tab=` and `post=`.

## Out of scope (explicitly)

- Wiring a producer for `ClearDrainRequest` (Scroll Drain) — separate decision.
- Authenticated `DeleteBookmark` replay — ADR-only, not built.
- Discriminated flip-confirm (#62), tee mutation observation (#63).
- Changing shipped defaults for clear-from-every-list / un-bookmark / un-like.
- The durable log cap/export format.
