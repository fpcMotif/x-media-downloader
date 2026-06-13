# Task 004: Overlay badge rendering and wiring

**depends-on**: task-001-badge-core-impl, task-002-settings-schema-impl

## Description

Render the badge in the existing `overlay.content` shadow-root Preact app and wire it to `core/badge.ts`. Reuse — do not duplicate — the existing plumbing: `mousemove`/`scroll` hover tracking, `mediaAtPoint`, `previewKeyFromMedia`, `byKey`/`byId` lookup, `rectOf` fixed positioning with scroll refresh, `sendTracked`, and `watchSettings`. This is DOM/integration code; its behavior contract is verified by the checklist below plus the project gate (the pure logic is already covered by task 001).

## Execution Context

**Task Number**: 7 of 8
**Phase**: Integration
**Prerequisites**: `core/badge.ts` and `downloadBadgeEnabled` exist. Task 005's `.xmd-badge` CSS may land before or after; the class contract below is shared.

## BDD Scenarios (manually verified)

```gherkin
Scenario: Timeline hover shows the badge
  Given downloadBadgeEnabled is true and the page has detected media
  When the pointer enters a photo preview
  Then a 34px badge bounces into the photo's bottom-right corner (10px inset)
  And leaves with a quiet 150ms fade when the pointer exits

Scenario: Lightbox shows the larger badge
  Given the user opened X's photo viewer
  When the viewer image is hovered
  Then the badge renders at 40px with a 12px inset on the image rect

Scenario: Click downloads exactly one item
  Given the badge is visible on a resolvable item
  When the user clicks it
  Then sendTracked fires with exactly that MediaItem
  And the badge morphs arrow → spinner → check (or failure state, retryable)
  And DownloadTraceEvent entries appear with source "badge" (shown/nudged/queued/start-ack/start-failed)

Scenario: Quick Grab wins while held
  Given the badge is visible
  When the Quick Grab modifier is pressed
  Then the badge hides until release

Scenario: Virtualized-timeline guard
  Given a badge click is in flight
  When the underlying element was recycled, detached, or scrolled away
  Then the click is dropped using the same guards as fireGrab (isConnected, same media key, element under rect)

Scenario: SPA navigation resets
  When wxt:locationchange fires
  Then badge state clears alongside the existing overlay resets

Scenario: Corner collision fallback
  Given X chrome occupies the bottom-right corner of the media rect
  When the badge would overlap it
  Then the badge insets upward 44px instead of overlapping
```

**Spec Source**: `docs/superpowers/specs/2026-06-12-photo-download-badge-design.md` §2, §4, §6

## Files to Modify/Create

- Modify: `src/entrypoints/overlay.content/index.tsx`

## Shared class contract with task 005

Root `button.xmd-badge`, size modifier `xmd-badge--lightbox`, phase modifiers `xmd-badge--shown|nudged|queued|saved|failed`, child `span.xmd-badge__icon` (three stacked icons: arrow/spinner/check cross-faded by phase).

## Steps

### Step 1: State + render
- Hold a `BadgeState` alongside the existing `grabUi` state; drive it from `core/badge.ts` transitions on the existing pointer/scroll/keydown/keyup/locationchange handlers. Schedule the nudge with `setTimeout(badgeNudgeDelayMs)`, cleared on leave/click/invalidate.
- Render the badge `<button>` (aria-label "Download photo"/"Download video"/"Download GIF" by item type) positioned from `rectOf(media)`; lightbox = media inside `[aria-modal="true"]`/`[role="dialog"]` ancestor.
- Hit area ≥44px via CSS pseudo-element (task 005); the button itself stays 34/40px.

### Step 2: Click path
- `beginSave` → `sendTracked([item])` → `resolveSave(ok)`; trace via the existing `traceQuickGrab`-style helper generalized or duplicated as `traceBadge` with `source: 'badge'`; apply the fireGrab guards before sending.

### Step 3: Settings + lifecycle
- Gate on `downloadBadgeEnabled` from `getSettings`/`watchSettings` (render nothing until settings resolve); clear badge state in the `ClearDetectedMediaRequest` handler and `ctx.onInvalidated`.

### Step 4: Manual verification checklist
- `bun run dev`, load the extension, then walk every Gherkin scenario above on x.com (timeline + lightbox), plus `prefers-reduced-motion` (badge fades, never jumps) and X dark/dim/light themes.

## Verification Commands

```bash
bun run check          # fmt + lint + typecheck + full test suite (no regressions)
bun run dev            # manual checklist on x.com
```

## Success Criteria

- All checklist scenarios pass manually; `bun run check` clean; no new permissions; no duplicated hover/tracking plumbing.
