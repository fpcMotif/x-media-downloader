# 005 — Announce overlay save status

- **Workflow**: improve-react
- **Status**: TODO
- **Commit**: cf787c6
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Rule**: Beyond the scan
- **Estimated scope**: 7 files, about 170 lines

## Problem

The overlay's visual progress text is hidden from assistive tools:

```tsx
// src/entrypoints/overlay.content/index.tsx:1496 — current
aria-label={BADGE_ARIA[type ?? 'photo']}
aria-busy={badge.phase === 'queued'}

// src/entrypoints/overlay.content/index.tsx:1548 — current
aria-label={`Download all detected media (${store.count})`}
aria-busy={launcher === 'queued'}

// src/entrypoints/overlay.content/index.tsx:1560 — current
<span class="xmd-launcher__tip" aria-hidden="true">
  {LAUNCHER_LABEL[launcher]}
</span>
```

`Saving…`, `Saved`, and `Retry` are visible but never announced. `aria-busy`
covers only queued state. Screen-reader users receive no success or failure.

One adjacent defect must be fixed with the names: the launcher visibly says
`Retry`, but `beginSendAll('failed')` is currently a no-op at
`src/core/launcher.ts:10-18`. Exposing a non-working Retry name would be false.

## Target

Add pure copy helpers to `src/core/badge.ts` using `MediaType`:

| Phase | Button name for photo | Status |
| --- | --- | --- |
| hidden/shown/nudged | Download photo | empty |
| queued | Saving photo | Saving photo. |
| saved | Photo saved | Photo saved. |
| failed | Retry photo download | Photo save failed. Retry available. |

Export:

```ts
badgeAriaLabel(phase: BadgePhase, type: MediaType): string
badgeStatusMessage(phase: BadgePhase, type: MediaType): string
```

Use `video` and uppercase `GIF` in the same sentences.

Use these exact pure functions:

```ts
const MEDIA_NOUN: Record<MediaType, string> = {
  photo: 'photo',
  video: 'video',
  gif: 'GIF',
}
const MEDIA_TITLE: Record<MediaType, string> = {
  photo: 'Photo',
  video: 'Video',
  gif: 'GIF',
}

export function badgeAriaLabel(phase: BadgePhase, type: MediaType): string {
  const noun = MEDIA_NOUN[type]
  if (phase === 'queued') return `Saving ${noun}`
  if (phase === 'saved') return `${MEDIA_TITLE[type]} saved`
  if (phase === 'failed') return `Retry ${noun} download`
  return `Download ${noun}`
}

export function badgeStatusMessage(phase: BadgePhase, type: MediaType): string {
  const noun = MEDIA_NOUN[type]
  if (phase === 'queued') return `Saving ${noun}.`
  if (phase === 'saved') return `${MEDIA_TITLE[type]} saved.`
  if (phase === 'failed') return `${MEDIA_TITLE[type]} save failed. Retry available.`
  return ''
}
```

Add matching helpers to `src/core/launcher.ts`:

```ts
launcherAriaLabel(phase: LauncherPhase, count: number): string
launcherStatusMessage(phase: LauncherPhase, count: number): string
```

Exact copy:

- idle: `Download all detected media (3)`; empty status.
- queued: `Saving all detected media (3)`; `Saving 3 media items.`
- saved: `All detected media saved (3)`; `3 media items saved.`
- failed: `Retry all detected media (3)`;
  `Some media failed to save. Retry available.`
- For one item, use `1 media item`.

Use:

```ts
const mediaItemCount = (count: number): string =>
  `${count} media ${count === 1 ? 'item' : 'items'}`

export function launcherAriaLabel(phase: LauncherPhase, count: number): string {
  if (phase === 'queued') return `Saving all detected media (${count})`
  if (phase === 'saved') return `All detected media saved (${count})`
  if (phase === 'failed') return `Retry all detected media (${count})`
  return `Download all detected media (${count})`
}

export function launcherStatusMessage(phase: LauncherPhase, count: number): string {
  if (phase === 'queued') return `Saving ${mediaItemCount(count)}.`
  if (phase === 'saved') return `${mediaItemCount(count)} saved.`
  if (phase === 'failed') return 'Some media failed to save. Retry available.'
  return ''
}
```

Make the existing visible Retry real:

```ts
// src/core/launcher.ts — target
export function beginSendAll(phase: LauncherPhase): LauncherPhase {
  return phase === 'idle' || phase === 'failed' ? 'queued' : phase
}
```

Wire the helpers into both `aria-label` values. Keep one already-mounted status
region beside each control:

```tsx
// src/entrypoints/overlay.content/index.tsx — target pattern
<span class="xmd-sr-only" role="status" aria-live="polite" aria-atomic="true">
  {statusMessage}
</span>
```

The region must exist while its idle status is empty, before queued/saved/failed
updates. Do not mount a pre-filled live region.

Add the standard clipped class to `overlay.content/style.css`:

```css
.xmd-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

## Repo conventions to follow

- Imitate the polite hidden region at `src/components/confirm-strip.tsx:165-167`.
- Keep phase transitions pure in `src/core/badge.ts` and `src/core/launcher.ts`.
- Extend their exhaustive phase tests rather than testing copy in the entrypoint.
- Add a small overlay source-contract test, matching the entrypoint test style.

## Steps

1. Add badge name/status helpers and tests for every phase, type, and GIF casing.
2. Add launcher name/status helpers and singular/plural tests.
3. Allow `failed -> queued`; update the old no-op assertion in
   `src/core/launcher.test.ts:25-28`.
4. Replace static badge/launcher names with helper calls.
5. Add one persistent live region for each control and the clipped CSS class.
6. Add `src/entrypoints/overlay.content/accessibility.test.ts` to pin both
   `role="status"` regions, `aria-atomic`, helper wiring, and CSS.
7. Re-read the diff. Do not touch visual phase copy or animation.

## Boundaries

- Do NOT change visual copy, timing, layout, animation, or queue contracts.
- Keep `aria-busy` on queued controls.
- Do NOT announce idle hover or duplicate announcements.
- Retry only changes `failed -> queued`; queued and saved clicks remain inert.
- Add no dependency.
- If plans 002/003 ran, preserve their controller/lifecycle behavior.
- STOP on other drift from `cf787c6`; reconcile first.

## Verification

- **Mechanical**:
  - `bun run test -- src/core/badge.test.ts src/core/launcher.test.ts src/entrypoints/overlay.content/accessibility.test.ts`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
  - `npx --yes react-doctor@latest . --scope changed` adds no issue and lowers no score.
- **Behavior check**: With NVDA or another screen reader, trigger badge and
  launcher saves. Hear one announcement for queued and one for saved/failed.
  Confirm a late saved-to-failed correction is announced, idle hover is silent,
  focused names match state, and failed launcher Retry starts a new request.
- **Done when**: both controls expose truthful state and action, live updates are
  announced once, visuals are unchanged, and all checks pass.
