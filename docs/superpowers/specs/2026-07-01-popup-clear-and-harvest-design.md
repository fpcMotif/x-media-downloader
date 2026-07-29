# Popup: whole-list clear + harvest controls — design

> **Superseded for direct Release (2026-07-26).** Popup page/list Release was
> removed. Clear now runs only through verified download completion. Keep this
> file as design history.

**Date:** 2026-07-01
**Status:** Approved for planning

## Goal

Surface two domains directly in the extension popup ([`src/entrypoints/popup/App.tsx`](../../../src/entrypoints/popup/App.tsx)) so the user need not open Settings:

1. **Clearing the browser** — a _new_ "Clear entire list" action (auto-scroll the whole Likes/Bookmarks list, un-like/un-bookmark every post, no download), plus the existing per-surface clear-on-save toggles, plus buttons to wipe the extension's own stored data.
2. **Harvest history** — turn tweet harvesting on/off, see the harvested-conversation list, and export it.

Only #1's "Clear entire list" requires new engineering. Everything else is wiring already-built messages and settings into the popup.

## Scope

**In:**

- New `core/clear/list-clear.ts` pure orchestration + `ClearWholeListRequest` content handler + popup button.
- Popup UI for: per-surface clear toggles, clear download history, clear harvest archive, harvest on/off, harvested-conversation list, per-conversation exports.

**Out (unchanged):**

- The Settings panels ([`capture.tsx`](../../../src/entrypoints/options/panels/capture.tsx), [`history.tsx`](../../../src/entrypoints/options/panels/history.tsx)) keep their full surfaces; the popup mirrors a subset.
- Cloud sync / Convex mirror config stays in Settings.
- No new download behavior; no change to the verified clear-on-save (worklist) pipeline.

## The new capability: "Clear entire list"

### Problem

[`handleClearVisible`](../../../src/entrypoints/overlay.content/handlers.ts) clears only the ~30 posts currently mounted, because X virtualizes the timeline. To clear an _entire_ list you must auto-scroll it, clearing each post as it mounts, until the bottom.

### Approach (chosen)

A new pure module `core/clear/list-clear.ts` modeled on [`makeScrollDrain`](../../../src/core/clear/scroll-drain.ts) — same injected `ScrollPort` + `Clock` seams, same bounded-step / stall-detection / restore-scroll-position guards — but driven by "clear whatever is mounted for the page scope each pass" instead of a known set of tweetIds.

```ts
// core/clear/list-clear.ts
export interface ListClearDeps {
  readonly scroll: ScrollPort // reuse the seam from scroll-drain.ts
  readonly clock: Clock // reuse the seam from scroll-drain.ts
  readonly path: () => string // live pathname; a mid-run nav away ends the run
  /** Click the clear control on every mounted clearable post for the page's
   *  scope (Likes→un-like, Bookmarks→un-bookmark), paced one at a time.
   *  Returns how many were clicked this pass. */
  readonly clearVisibleForPage: () => Promise<number>
  readonly report: (stage: string, detail: string) => void
}

export interface ListClearResult {
  readonly cleared: number
  readonly reason?: 'not-list-page'
}

export function makeListClear(deps: ListClearDeps): { run: () => Promise<ListClearResult> }
```

`ScrollPort` and `Clock` are already `export interface`s in `scroll-drain.ts`, so `list-clear.ts` imports them directly — no new seam file needed.

**Orchestration of `run()`:**

1. If `pageScope(path())` is `None` → return `{ cleared: 0, reason: 'not-list-page' }` (only Likes/Bookmarks have a clear scope; For You / profiles / search are out).
2. Record `startY = scroll.position()`.
3. Loop, bounded by a generous `MAX_STEPS` backstop:
   - `clearedThisStep = await clearVisibleForPage()`; accumulate into `cleared`.
   - `clock.sleep(SETTLE_MS)` (let the un-cleared rows reflow / detach).
   - `before = scroll.position()`; `scroll.by(viewport * 0.9)`; `clock.sleep(SETTLE_MS)`.
   - Termination: increment `noProgress` only when **both** `clearedThisStep === 0` **and** scroll did not advance; reset it whenever either happened. Break when `noProgress >= BOTTOM_STALLS`. This correctly stops at "bottom reached and nothing left to clear" while tolerating X's lazy virtualized re-render.
4. `finally`: `scroll.to(startY)` (restore the user's position), `report('clear-list-end', …)`.
5. Return `{ cleared }`.

Constants mirror `scroll-drain.ts` (`SETTLE_MS ≈ 600`, `BOTTOM_STALLS = 3`) with a larger `MAX_STEPS` (e.g. 400) since traversing a long list is the explicit intent; the real terminator is bottom-stall, not the cap.

### Content handler

New `handleClearWholeList` in [`handlers.ts`](../../../src/entrypoints/overlay.content/handlers.ts), registered in the `messageHandlers` dispatch table next to `ClearVisibleRequest`:

- Builds `clearVisibleForPage` from a **shared helper** extracted from the existing `handleClearVisible` inner loop — `clearMountedForScope(document, scope, paceMs)` — so both the one-shot visible clear and the per-pass whole-list clear use one click path (`clearControl` → `closest('button,[role=button]')` → `.click()`, paced ~350ms). This is a small deepening that removes duplication.
- Builds `ScrollPort` from `window` (`scrollY`, `scrollTo`, `scrollBy`, `innerHeight`) and `Clock` from `setTimeout`/`Promise`.
- Runs `makeListClear(...).run()` and replies `{ _tag: 'ClearWholeListResponse', cleared, reason? }`.
- Returns `true` (async reply). If the popup closes mid-run, the async IIFE keeps clearing; only the dropped reply is lost (acceptable — the action still completes).

### Popup wiring

A new `usePageAction` call in `App.tsx` (the existing pattern — confirm → query active tab → `sendMessage` → format):

- **Single `confirm()` gate** spelling out scope: _"Un-like / un-bookmark EVERY post on this {Likes|Bookmarks} list by scrolling through all of it? This can affect hundreds of posts and cannot be undone."_
- Button **only enabled on a Likes/Bookmarks page** (reuse the page-scope check; otherwise disabled with a hint "Open a Likes or Bookmarks list").
- Result copy: `not-list-page` → "Open a Likes or Bookmarks list."; else "Cleared N posts across the list." (or "No posts to clear.").
- Placed in the existing **"On this page"** card, below "Clear this page now (no download)", visually marked as the heavier/destructive action.

## Wiring of existing capabilities (popup UI only)

### Per-surface clear toggles

In the existing clear-config card (the one holding the `clearOnSave` `Switch`), when `clearOnSave` is on, render three `Field`+`Switch` rows bound to existing settings — replacing the current "Manage in settings" deep-link:

- `autoUnbookmarkOnSave` — "Un-bookmark on Bookmarks"
- `autoUnlikeOnSave` — "Un-like on Likes"
- `autoNotInterestedOnSave` — "Not interested on For You"

Uses the existing `update(patch)` helper (writes via `setSettings`, shows the "Saved" badge). The `clearScopeNote` summary stays.

### Clear local data (new small "Local data" card)

Two confirm-gated buttons sending existing, already-handled messages:

- **Clear download history** → `{ _tag: 'ClearHistoryRequest' }` (handled in [`background.ts`](../../../src/entrypoints/background.ts)). After ok, refresh the popup's `history` state to `[]`.
- **Clear harvest archive** → `{ _tag: 'ClearCaptureRequest' }` (handled in `background.ts`). After ok, reset `captureSummary` to zeroed.

Each gated by `confirm()` ("Delete the local download history? Files on disk are untouched." / "Delete the entire harvested-tweet archive? This cannot be undone."). Local-only; never touches files on disk.

### Harvest controls (extend the "Knowledge Capture" card)

The card currently renders only when `captureEnabled || tweets>0`. **Always render it** so the toggle is reachable when harvesting is off.

- **Harvest on/off** — `Field`+`Switch` bound to `captureEnabled` via `update({ captureEnabled })`.
- **Harvested-conversation list** — render `captureSummary.recent` (the `{ conversationId, rootHandle, rootText, count, lastAt }[]` already returned by `fetchCaptureSummary`), mirroring the Settings panel's list, each row with **Export tree** and **Export Markdown** buttons calling `runCaptureExport('tree'|'markdown', conversationId)`.
- Keep the existing **Export all (JSONL)** button (`runCaptureExport('jsonl')`).
- Empty state when nothing harvested: "Nothing harvested yet. Turn on Harvest tweets and browse X."

All harvest plumbing already exists in [`@/components/capture-export`](../../../src/components/capture-export.ts); the popup already imports `fetchCaptureSummary` and `runCaptureExport`.

## Popup organization (flat — all visible)

Card order, top to bottom (existing cards keep their place):

1. Download monitor (existing, conditional)
2. **On this page** (existing) + **Clear entire list** (new)
3. Clear config (existing `clearOnSave`) + **3 per-surface toggles** (new)
4. **Knowledge Capture** (existing, now always shown) + **toggle / list / per-convo exports** (new)
5. **Local data** (new) — clear download history, clear harvest archive
6. Recent downloads (existing)

No new visual language — reuse `Card`/`CardHeader`/`Field`/`Switch`/`Button`/`Badge` and the icon set already imported. Destructive buttons use the muted/ghost or destructive variant already in use for clear actions.

## Safety & correctness

- "Clear entire list" is destructive + irreversible → single explicit `confirm()`, list-page-only, bounded loop, restores scroll position.
- Clear-data buttons are `confirm()`-gated and local-only (no file deletion, no remote effect).
- Whole-list clear never downloads and never touches the worklist/Settle pipeline — it is a pure UI-driven click sweep, independent of clear-on-save.

## Testing

- **`core/clear/list-clear.ts`** — full unit coverage with a fake `ScrollPort`, fake `Clock` (à la `scroll-drain.test.ts`) and a fake `clearVisibleForPage`: bottom-stall termination, not-list-page early return, scroll-position restore, cleared-count accumulation, mid-run stall tolerance. Holds the 100% `src/core` gate.
- **`clearMountedForScope`** shared helper — covered via the existing `handleClearVisible` behavior plus a direct test.
- **Popup** — extend `popup-layout.test.ts` for the new sections' presence/gating (toggle reachable when harvest off; per-surface toggles shown only when `clearOnSave` on; clear-entire-list disabled off a list page).
- `bun run check` + `bun run test:coverage` green before finishing.

## Files touched

- **New:** `src/core/clear/list-clear.ts` (+ test) — imports `ScrollPort`/`Clock` from `scroll-drain.ts`.
- **Edit:** `src/entrypoints/overlay.content/handlers.ts` (new handler + `clearMountedForScope` extraction + dispatch entry), `src/entrypoints/popup/App.tsx` (all popup wiring), `src/entrypoints/popup/popup-layout.test.ts`.
- Possibly a message-tag registration spot if dispatch is gated by a central union (planning verifies; `ClearVisibleRequest` is currently registered only in the `messageHandlers` table).

## Out of scope / non-goals

- Live streaming progress of the whole-list clear (request/response final count only).
- A type-to-confirm or dry-run-count gate (single `confirm()` chosen).
- Collapsible/disclosure popup layout (flat chosen).
- Resuming an interrupted whole-list clear; undo of any clear.
