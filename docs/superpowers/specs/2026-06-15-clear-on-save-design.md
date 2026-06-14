# Clear-on-Save — Design Spec

- **Date:** 2026-06-15
- **Status:** Approved + live-verified. **v1 scope = un-like-on-save (Likes
  page).** Un-bookmark **deferred** — live verification (§6) found no inline
  un-bookmark control on the Bookmarks page.
- **v1 surface:** Likes page `/{handle}/likes` (and lightboxes opened from it).
- **Deferred:** Bookmarks page / un-bookmark (revisit if X restores an inline
  control, or design an explicit non-silent detail-page flow).
- **Related ADRs:** ADR-0001 (passive-first), ADR-0002 (fire-and-track queue);
  introduces **ADR-0015** (extension-initiated UI actions)

## 1. Overview

When the user works through their **Likes** list and downloads a post's media,
**Clear-on-save** removes that post from the list once *all* of its media is
**confirmed saved to disk** — turning the list into a self-clearing
"to-download" queue. (The same mechanism was intended for the Bookmarks list,
but live verification found no inline un-bookmark control there — see §6 — so
**un-bookmark is deferred** and v1 ships un-like only.)

A Tweet carries up to four photos (**or** one video **or** one GIF). All of a
Tweet's downloaded Media Items must reach a **confirmed-complete** terminal
state before the post is cleared. If any item fails or is interrupted, the post
is **kept** so the user can retry.

Removal is **silent and immediate** on confirmed completion — no toast, no undo,
no per-action confirmation (chosen in session). This places the entire safety
burden on (a) acting only on genuinely-confirmed completion and (b) matching the
exact post — both are hard requirements below.

### Goals

- A Likes list that clears itself as the user downloads, with zero happy-path
  friction.
- Remove a post **only** after every Media Item the user downloaded for it is
  **confirmed written to disk** — never on the optimistic "started" signal.
- A default-**off** setting `autoUnlikeOnSave` (v1). `autoUnbookmarkOnSave` is
  deferred until an inline un-bookmark control exists.
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
user downloads a post's media on the Likes surface
  → background fires chrome.downloads.download() per Media Item        [existing]
  → onChanged reports each item complete | failed                      [existing, ADR-0002]
  → background feeds each outcome into the pure `removal` tracker, keyed by tweetId
  → tracker emits exactly one decision per tweet: REMOVE | KEEP | (pending)
  → on REMOVE → background messages the originating tab's content script
  → content script's `xActions` seam finds article[tweetId], clicks the
    un-like control ([data-testid="unlike"]) when autoUnlikeOnSave is on
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
   - `findLikeControl(article): Element | null` — resolves the already-liked
     control, `article [data-testid="unlike"]` (verified §6). **`data-testid`,
     not aria-label** — aria-labels are localized.
   - `clearFromList(tweetId, { unlike }): Result`
   - *(deferred)* `findBookmarkControl` — no inline control exists on the list
     (§6); not built in v1.
   Selector resolution lives behind one resolver so live-DOM drift is contained
   to one place.

3. **Page-context guard** (content script): arm Clear-on-save only when the
   active surface is the **Likes** list — `pathname` matches `/^\/[^/]+\/likes$/`
   (verified §6). (Bookmarks `'/i/bookmarks'` is recognized but inert in v1,
   since un-bookmark is deferred.) Path-based so it is locale-independent.

4. **Settings** (`core/schema/index.ts`, Effect v4 Schema):
   - `autoUnlikeOnSave: boolean` — default `false` (v1)
   - *(deferred)* `autoUnbookmarkOnSave: boolean` — added when un-bookmark ships.
   Surfaced as a popup toggle in the settings panel.

### 3.2 Messaging

Background already maps `downloadId → requestId`. Extend tracking so a
`requestId` (and thus each item's outcome) resolves to its `tweetId` and the
originating `tabId`. On a `'remove'` decision, background sends
`{ type: 'clearFromList', tweetId, unlike: true }` to that tab. The content
script validates it is still on the Likes surface before acting. (Payload keeps
room for an `unbookmark` flag when that ships.)

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
- **Lightbox.** The Likes-list photo lightbox exposes `[data-testid="unlike"]`
  too (verified §6), and the underlying list article stays in the DOM behind the
  modal — so the un-like clear applies whether the user downloaded from the list
  thumbnail or from inside the lightbox.
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

## 6. Live Verification — RESULTS (verified 2026-06-15, live X, logged-in)

Done against live X via the Chrome MCP. Findings:

- **No "history" merge.** Bookmarks is its own page at **`/i/bookmarks`**; Likes
  is the profile tab at **`/{handle}/likes`** (profile tabs:
  Posts/Replies/Highlights/Articles/Media/Likes). They are separate; the worried
  "merged into history" surface does not exist on this build. → page-context
  matcher: `pathname === '/i/bookmarks'` and `/^\/[^/]+\/likes$/`.
- **Selectors must be `data-testid`, never aria-label.** The test account's UI is
  Traditional Chinese; all `aria-label`s are localized (e.g. the like control is
  `aria="…已喜歡"`). `data-testid` values are stable across locale.
- **Un-like — feasible inline, single click.** `[data-testid="unlike"]` is
  present in the action bar of every tweet on **both** the Bookmarks list and the
  Likes list. (Active/liked state = `unlike`; unliked = `like`.) One click, no
  menu.
- **Un-bookmark — BLOCKED on the list (key finding).** `data-testid="removeBookmark"`
  exists **only on the tweet detail page** action bar. On the **Bookmarks list**,
  X renders the view-count/analytics button in that slot instead — there is **no
  `removeBookmark` (or `bookmark`) control anywhere on the list page**, not in the
  action bar (before or after hover) and not in the per-tweet "…" (`caret`) menu
  (which offers follow/lists/mute/block/engagements/embed/report/note — no remove
  option). The only DOM path to remove a bookmark is the detail page, reached by
  navigating away from the list (scroll-loss, disruptive).

Consequence: un-like is cleanly implementable as designed; **un-bookmark on the
list has no inline control and needs a separate decision** — see §10.

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

## 10. Decisions & Open Items

- **Un-bookmark — DEFERRED (resolved in session).** Live verification (§6) found
  no inline un-bookmark control on the Bookmarks list. Rather than navigate to
  each tweet's detail page (scroll-loss, jarring under silent mode), v1 ships
  un-like only. Revisit if X restores an inline control, or design an explicit
  non-silent detail-page flow.
- **Scroll-off behavior** (§4): queue-and-apply-on-re-sighting (default) vs.
  drop-silently — still open; confirm during the plan or first implementation.
