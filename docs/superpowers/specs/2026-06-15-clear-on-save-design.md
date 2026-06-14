# Clear-on-Save — Design Spec

- **Date:** 2026-06-15
- **Status:** Approved (design reviewed in session; spec awaiting user sign-off)
- **Surfaces:** Bookmarks page + Likes page (and lightboxes opened from them)
- **Related ADRs:** ADR-0001 (passive-first), ADR-0002 (fire-and-track queue);
  introduces **ADR-0015** (extension-initiated UI actions)

## 1. Overview

When the user works through their **Bookmarks** or **Likes** list and downloads
a post's media, **Clear-on-save** removes that post from the list once *all* of
its media is **confirmed saved to disk** — turning the list into a
self-clearing "to-download" queue.

A Tweet carries up to four photos (**or** one video **or** one GIF). All of a
Tweet's downloaded Media Items must reach a **confirmed-complete** terminal
state before the post is cleared. If any item fails or is interrupted, the post
is **kept** so the user can retry.

Removal is **silent and immediate** on confirmed completion — no toast, no undo,
no per-action confirmation (chosen in session). This places the entire safety
burden on (a) acting only on genuinely-confirmed completion and (b) matching the
exact post — both are hard requirements below.

### Goals

- A bookmark/like list that clears itself as the user downloads, with zero
  happy-path friction.
- Remove a post **only** after every Media Item the user downloaded for it is
  **confirmed written to disk** — never on the optimistic "started" signal.
- Two independent, default-**off** settings: un-bookmark on save, un-like on
  save.
- Reuse the repo's pure-core state-machine idiom so the tricky tally/timing
  logic is unit-testable and prototype-able.

### Non-goals

- **No "drain my whole list" sweep button** (deferred; may layer on later).
- **No behavior outside the Bookmarks/Likes surfaces** — never auto-removes a
  post the user happens to have bookmarked while scrolling the home feed.
- **No new network calls.** The extension synthesizes a click on X's own
  control; X issues whatever request it would have issued for a manual click.
- **No removal of posts the user did not download** — mere on-screen *detection*
  of media never triggers a clear.

## 2. Trust Model — what "complete" means

This feature exists downstream of a documented blind spot (handoff
integration test, `background.ts:202`): the overlay's "Saved" verdict
(`sendTracked` → `r.completed === r.total`) fires when each download **starts**,
not when bytes land. A transfer can start and then die on a `twimg` 403 or
network timeout; the UI still shows "Saved."

**Clear-on-save must never use the hand-off verdict.** The only trustworthy
signal is the `chrome.downloads.onChanged` listener reaching
`state: 'complete'` (mapped by `outcomeFromState()` in `core/download/metrics.ts`
to outcome `'complete'`). `'interrupted'` maps to `'failed'`; anything else is
still pending.

- A Media Item is **confirmed** only on `onChanged` outcome `'complete'`.
- A Media Item is **failed** on outcome `'failed'`.
- A post is **cleared** only when every downloaded item for it is confirmed and
  **none** failed.

## 3. Architecture

The hard constraint is a **context split**: completion truth lives in the
**background** service worker (`onChanged`); the removal action (clicking a
control) must run in the **content script** on the list page. The chosen
topology (approach "C") keeps the tally as a pure core reducer and uses the
background only as the event source and the content script only as the DOM hand.

```
user downloads a post's media on a Bookmarks/Likes surface
  → background fires chrome.downloads.download() per Media Item        [existing]
  → onChanged reports each item complete | failed                      [existing, ADR-0002]
  → background feeds each outcome into the pure `removal` tracker, keyed by tweetId
  → tracker emits exactly one decision per tweet: REMOVE | KEEP | (pending)
  → on REMOVE → background messages the originating tab's content script
  → content script's `xActions` seam finds article[tweetId], clicks the
    un-bookmark / un-like control(s) enabled in settings
```

### 3.1 New units

1. **`src/core/removal.ts` — pure tracker (no DOM, no chrome APIs).**
   Events: `arm(tweetId, total)`, `itemComplete(tweetId)`, `itemFailed(tweetId)`.
   State per armed tweetId: `{ total, completed, failed, fired }`. Emits
   `'remove'` exactly once, only when `completed === total && failed === 0`;
   emits nothing further for a fired or failed tweet. `itemComplete`/`itemFailed`
   for an un-armed tweet are ignored. Mirrors the idiom of `quickgrab.ts`,
   `badge.ts`, `launcher.ts`. **Validated by prototype (§7).**
   - **The counter assumes one terminal event per item.** The tracker stays a
     simple counter (not a Set of ids); correctness therefore depends on the
     background emitting **at most one** terminal event per `downloadId` — see
     §3.2. (Decision taken in session over the self-deduping Set alternative.)

2. **`src/core/adapters/x/actions.ts` — the "write" seam.** The first adapter
   code that *acts on* the page rather than reading it.
   - `findBookmarkControl(article): Element | null`
   - `findLikeControl(article): Element | null`
   - `clearFromList(tweetId, { unbookmark, unlike }): Result`
   Selector resolution lives behind one resolver so live-DOM drift is contained
   to one place. Exact selectors confirmed at live verification (§6).

3. **Page-context guard** (content script): arm Clear-on-save only when the
   active surface is a Bookmarks or Likes list. URL-path based so it is
   resilient to whether X keeps them as separate pages or merges them into a
   "history" surface. The path matcher set is finalized at live verification.

4. **Settings** (`core/schema/index.ts`, Effect v4 Schema):
   - `autoUnbookmarkOnSave: boolean` — default `false`
   - `autoUnlikeOnSave: boolean` — default `false`
   Surfaced as two popup toggles in the settings panel.

### 3.2 Messaging

Background already maps `downloadId → requestId`. Extend tracking so a
`requestId` (and thus each item's outcome) resolves to its `tweetId` and the
originating `tabId`. On a `'remove'` decision, background sends
`{ type: 'clearFromList', tweetId, unbookmark, unlike }` to that tab. The
content script validates it is still on a Bookmarks/Likes surface before acting.

**Per-item terminal dedup (background responsibility).** `chrome.downloads.onChanged`
can deliver duplicate `state:'complete'` transitions for one `downloadId`. The
background tracks which `downloadId`s have already settled and feeds the tracker
**at most one** `itemComplete`/`itemFailed` per item — otherwise a double-counted
completion could reach `total` and fire `'remove'` before all distinct items are
done (a premature, silent clear). This guard is the counterpart to the simple
counter in §3.1.

## 4. Behavior Rules (edge cases)

- **Partial failure → KEEP.** If any downloaded item for a Tweet fails or
  interrupts, the post is not cleared. (Safety backbone under silent mode.)
- **Only user-downloaded posts.** Clearing is armed only for a Tweet the user
  actually triggered a download for (badge / Quick Grab / Download-all),
  never for merely-detected media.
- **Scrolled off-screen at completion → queue & apply on re-sighting.** Photos
  finish in ~1s (article usually still present); a large video may finish after
  the user scrolls. Default: queue the tweetId and clear it when it next enters
  the list DOM (MutationObserver), discarding the queue on navigation away from
  the surface. *(Open decision flagged in session; alternative is "drop
  silently / leave bookmarked" when off-screen.)*
- **Outer post only.** Match the user's list-level Tweet, never a quoted
  tweet's media nested inside it.
- **Single-item media.** Video/GIF Tweets have one item; photo Tweets 1–4. The
  tracker handles N = 1..4 uniformly via `arm(tweetId, total)`.
- **Both states set.** If a post is both bookmarked and liked and both settings
  are on, clear both in one `clearFromList` call.
- **Lightbox.** Downloading from a lightbox opened off the list still resolves
  to the underlying list article, which remains in the DOM behind the modal;
  the clear applies on close (or immediately if the control is reachable).
- **Fire-once.** The tracker latches per tweetId; re-detection or duplicate
  `onChanged` events never double-fire a clear.

## 5. Documentation & Domain Impact (grill-with-docs)

This feature introduces vocabulary and a behavioral class the docs do not yet
cover. Both updates land as part of the work, not after it.

- **CONTEXT.md — new nouns/actions:**
  - **Bookmark** / **Like** — the user's engagement state on a Tweet (X
    surfaces, distinct from media).
  - **Clear-on-save** — removing a post from a saved list (un-bookmark /
    un-like) once all its downloaded Media Items are confirmed saved.
- **ADR-0015 — Extension-initiated UI actions (clear-on-save).** ADR-0001
  established *passive-first extraction: issues no extra network requests.*
  Clicking X's own bookmark/like control is the first time this extension
  **mutates X state** rather than reading it. The ADR states the boundary
  honestly: we only synthesize clicks on controls the user could click
  themselves, only on the user's own lists, only after the user's own download
  is confirmed complete, and we issue no direct API calls (X issues its own
  request, exactly as for a manual click).

## 6. Live Verification (the "check it" task)

Empirical, to be done against live X (logged-in) via the Chrome MCP, before or
as the first implementation step:

1. Are **Bookmarks** and **Likes** still separate pages, or merged into a
   "history"-style surface in the current X build? Capture the URL path(s).
2. The real selectors for the **bookmark** and **like** controls in their
   *active* (already-bookmarked / already-liked) state, and the
   confirmation/menu (if any) that a click triggers.
3. Whether un-bookmark / un-like is a single click or a click-through-menu.

Findings feed the `actions.ts` resolver and the page-context matcher. Until
verified, both are written behind a single resolver so updates are localized.

## 7. Prototype (/prototype — business-logic branch)

Before committing, build a throwaway runnable terminal harness that drives
`removal.ts` with sequences of `arm` / `itemComplete` / `itemFailed` events for
multi-media Tweets and prints each emitted decision. Lets us "play with" the
partial-failure, ordering, and fire-once logic in isolation. Pure state machine,
no DOM — the terminal-app branch of the prototype skill.

## 8. Testing

- **`removal.ts` (TDD, red→green):** single photo complete → remove; 4 photos,
  3 complete + 1 pending → no emit; 4 photos all complete → remove once; 1
  failed among complete → keep; duplicate events → idempotent.
- **`onChanged` completion seam:** add the integration coverage the handoff test
  explicitly notes is missing — confirmed-complete and interrupted-after-start
  both drive the tracker correctly.
- **`actions.ts` selectors:** fixture-HTML unit test for control resolution; a
  manual live-X checklist for the click-through behavior found in §6.
- **Settings:** schema defaults (`false`/`false`) and popup toggle wiring.

## 9. Prototype Verdict

`src/core/removal.prototype.ts` (throwaway terminal harness) drove the reducer
through the §8 cases plus awkward orderings. Findings:

- Partial-failure backbone and fire-once latch behave correctly, including when
  the failure arrives **before** the completions and when a duplicate completion
  arrives **after** the fire (no re-emit).
- Surfaced the duplicate-`onChanged` premature-fire risk → resolved as the
  background-dedup decision now recorded in §3.1 / §3.2.

Verdict: logic approved. The reducer folds directly into `removal.ts`; the
prototype file is deleted (absorbed) once `removal.ts` lands in the plan.

## 10. Open Decisions

- **Scroll-off behavior** (§4): queue-and-apply-on-re-sighting (default) vs.
  drop-silently. Confirm during spec review or after live verification.
