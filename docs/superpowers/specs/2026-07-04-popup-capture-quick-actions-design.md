# Popup: capture quick actions (export all + clear archive) — design

**Date:** 2026-07-04
**Status:** Approved for planning

## Goal

The R4 popup trim ([`b7a4e3c`](../../../src/entrypoints/popup/App.tsx) era, see [`popup-layout.test.ts`](../../../src/entrypoints/popup/popup-layout.test.ts)) deliberately removed the harvest-archive clear and the per-conversation export list from the popup, leaving only a toggle + tweet count + "Archive ›" link that opens the full Settings tab. In practice this makes harvesting inconvenient: exporting or clearing what you've captured requires leaving the popup and opening a whole new browser tab every time.

This spec reverses that trim **for the Capture/harvest surface only** (not for download-history clear, which stays in Settings): the popup gets a collapsed "Recent ›" disclosure under the Capture row that, when opened, shows the 3 most recent captured conversations with per-row export links, plus "Export all · JSONL" and "Clear archive…" buttons — all without leaving the popup.

## Scope

**In:**

- New `CaptureQuickActions` component (own file) rendered inside the popup's existing Capture `Field`.
- A collapsed-by-default disclosure ("Recent ›"), shown only when `tweets > 0`.
- Expanded: up to 3 recent conversations (handle, snippet, count, date) each with `JSON` / `Markdown` export links; an "Export all · JSONL" button; a confirm-gated "Clear archive…" button; an aria-live status line.
- Popup fetches `fetchCaptureSummary(3)` instead of `fetchCaptureSummary(0)` on mount (always — no separate lazy-fetch-on-expand path).
- Edits to `popup-layout.test.ts` to flip the two assertions that currently forbid this (see Testing).

**Out (unchanged):**

- The Archive tab (`archive.tsx`) keeps its full surface — search, pagination beyond 3, "Showing newest N of M" — the popup mirrors only a 3-row slice of it.
- Download-history clear (`ClearHistoryRequest`) stays Settings-only; this spec does not touch it or its test assertions.
- No backend/message changes: `fetchCaptureSummary`, `runCaptureExport`, and `ClearCaptureRequest` already exist and already generalize for this (the `capture-export.ts` header comment already calls itself "used by the options panel AND the popup").
- No changes to the Cloud/Convex mirror config, capture toggle behavior, or capture settings panel (`capture.tsx`).

## Component design

### `src/entrypoints/popup/capture-quick-actions.tsx`

A new, self-contained component — pulled out of `App.tsx` rather than inlined, because `App.tsx` is already ~510 lines wiring drain/sweep/clear-page/monitor/settings; a mini archive browser (list rendering, per-row export, clear-confirm, status line) is a distinct enough unit to own its own file and be testable in isolation. It mirrors `archive.tsx`'s pattern closely (same helpers, same row shape), just trimmed to 3 rows and no search.

```ts
interface CaptureQuickActionsProps {
  readonly summary: CaptureSummary | null // already fetched by App.tsx with limit 3
  readonly onCleared: () => void // App.tsx resets its captureSummary state to zeroed
}

export function CaptureQuickActions({ summary, onCleared }: CaptureQuickActionsProps)
```

Internal state: `open` (disclosure, default `false`), `statusMsg` (aria-live, auto-clears after 5s — same pattern as `archive.tsx`).

Rendering:

- Returns `null` when `(summary?.tweets ?? 0) === 0` — nothing to act on, keep the popup compact for new users.
- Collapsed: a single button/row, `Recent ›` (or `Recent ‹` when open) toggling `open`.
- Expanded: `summary.recent.slice(0, 3)` rendered exactly like `archive.tsx`'s list rows (handle/snippet/count/date + `JSON`/`Markdown` export links calling `runCaptureExport('tree'|'markdown', conversationId)`), then the two buttons:
  - **Export all · JSONL** → `runCaptureExport('jsonl')`, flashes the returned `detail` into `statusMsg`.
  - **Clear archive…** → `confirm('Delete all N captured tweets? This cannot be undone.')` (N = `summary.tweets`, same copy as `archive.tsx`'s `clearArchive`) → `browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' })` → on success, flash "Cleared N tweets from the archive." and call `onCleared()` so the parent zeroes its state (mirrors `archive.tsx`'s local reset of `summary` to `{ tweets: 0, conversations: 0, recent: [] }`).

No new messages, no new backend code — this is 100% wiring already-generalized helpers into a new place.

### `App.tsx` changes

- Bump the mount-time fetch from `fetchCaptureSummary(0)` to `fetchCaptureSummary(3)` (comment at [`App.tsx:227`](../../../src/entrypoints/popup/App.tsx#L227) gets updated — it currently says "limit 0: the popup shows only the tweet count").
- Render `<CaptureQuickActions summary={captureSummary} onCleared={() => setCaptureSummary({ tweets: 0, conversations: 0, recent: [] })} />` directly under the existing Capture `Field` (the "N tweets · Archive ›" row is unchanged above it).

## Safety & correctness

- Clear is a single `confirm()`-gated, irreversible, local-only action — identical copy and semantics to the existing Archive-tab clear, so there's exactly one clear behavior to reason about across the extension, not two.
- The disclosure being closed by default and the whole block being hidden at `tweets === 0` keeps the popup's default view exactly as compact as it is today; only users who have actually captured something see the new controls, and only after one extra tap.
- The popup's fixed 380×600 frame already has `overflow: auto` on `.xmd-popup` ([`app.css:154`](../../../src/app.css#L154)), so the expanded disclosure scrolls within the popup rather than breaking its bounds — no CSS changes needed.

## Testing

- **`popup-layout.test.ts`**:
  - Flip "popup local-data wipes moved to Settings" (currently forbids `ClearCaptureRequest`/`'Clear harvest archive'`) — narrow it to only forbid `ClearHistoryRequest`/`'Clear download history'` (harvest-archive clear is intentionally back; download-history clear is not touched).
  - Flip "no longer hosts the captured-conversation list or per-conversation exports" (currently forbids `'exportConvo'`/`'Export all (JSONL)'`) — remove/rewrite since the popup now does host a (trimmed) list and bulk export.
  - Add assertions that the new disclosure/component wiring is present (e.g. `CaptureQuickActions` import, `fetchCaptureSummary(3)`).
- **New `capture-quick-actions.test.ts`** (or inline in the popup's existing test suite, following whatever convention `App.test.ts` already uses for component-level tests): disclosure starts closed; hidden entirely at 0 tweets; expands to show ≤3 rows; per-row export calls `runCaptureExport` with the right kind/conversationId; "Export all" calls `runCaptureExport('jsonl')`; "Clear archive…" is confirm-gated, calls `ClearCaptureRequest`, and invokes `onCleared` only on success.
- `bun run check` + `bun run test:coverage` green before finishing (UI/entrypoints aren't under the 100% `src/core`/`src/lib` gate, but existing popup tests must still pass).

## Files touched

- **New:** `src/entrypoints/popup/capture-quick-actions.tsx` (+ its test).
- **Edit:** `src/entrypoints/popup/App.tsx` (fetch limit bump, render the new component), `src/entrypoints/popup/popup-layout.test.ts` (flip the two now-stale assertions).
- **Unchanged (verified, not touched):** `src/components/capture-export.ts`, `src/entrypoints/options/panels/archive.tsx`, `src/entrypoints/options/panels/capture.tsx`, `src/entrypoints/options/panels/history.tsx`, background message handlers.

## Out of scope / non-goals

- Search/filter inside the popup (Archive tab only).
- Pagination beyond 3 rows, or a "show more" affordance in the popup.
- Any change to download-history clear, Cloud/Convex config, or the Archive tab's own UI.
- Lazy-fetching the recent list only on first expand (the eager `limit=3` fetch is simpler and the payload is negligible).
