# 002 — Coalesce pointer hit-tests

- **Workflow**: improve-react
- **Status**: TODO
- **Commit**: cf787c6
- **Severity**: HIGH
- **Category**: Performance
- **Rule**: Beyond the scan
- **Estimated scope**: 3 files, about 120 lines

## Problem

Every raw `mousemove` can traverse descendants and force style/layout reads:

```ts
// src/entrypoints/overlay.content/index.tsx:395 — current
for (const el of container.querySelectorAll('img,video')) {
  if (!isImageElement(el) && !isVideoElement(el)) continue
  if (getComputedStyle(el).pointerEvents !== 'none') continue
  const r = el.getBoundingClientRect()
```

The listener at `src/entrypoints/overlay.content/index.tsx:1727-1786` calls this
path through `resolveHoverMedia`, resolves a key, mutates interaction state, and
may render once per event. Mouse events can arrive faster than paint frames.

The scroll path already uses one requestAnimationFrame task at
`src/entrypoints/overlay.content/index.tsx:1821-1832`. Mouse movement should use
the same cadence while retaining only the newest pointer sample.

## Target

Add a small, testable scheduler:

```ts
// src/core/latest-frame.ts — target
export interface LatestFrameTask<T> {
  readonly push: (value: T) => void
  readonly clear: () => void
}

export function makeLatestFrameTask<T>(
  requestFrame: (run: () => void) => void,
  run: (value: T) => void,
): LatestFrameTask<T> {
  let queued = false
  let hasLatest = false
  let latest!: T

  return {
    push(value) {
      latest = value
      hasLatest = true
      if (queued) return
      queued = true
      requestFrame(() => {
        queued = false
        if (!hasLatest) return
        const value = latest
        hasLatest = false
        run(value)
      })
    },
    clear() {
      hasLatest = false
    },
  }
}
```

In the overlay, import `makeLatestFrameTask` and `ModifierFlags`. Add:

```ts
// src/entrypoints/overlay.content/index.tsx — target
interface MouseMoveSample extends ModifierFlags {
  readonly target: Element | null
  readonly clientX: number
  readonly clientY: number
}
```

Change `syncGrabFromPointer` to accept `ModifierFlags`. Move the current costly
listener body into `runMouseHitTest(sample)`. Keep this exact order:

1. Recheck `qgEnabled || badgeEnabled`.
2. Sync the grab modifier.
3. Refresh whole-post mode.
4. Ignore `XMD-OVERLAY`.
5. Resolve media and preview key.
6. Run the existing DEV diagnostic unchanged.
7. Call `focusHover`, then `focusBadge`.

Wire it through the scheduler:

```ts
// src/entrypoints/overlay.content/index.tsx — target
const mouseHitTest = makeLatestFrameTask<MouseMoveSample>(
  (run) => ctx.requestAnimationFrame(run),
  runMouseHitTest,
)

ctx.addEventListener(
  document,
  'mousemove',
  (event) => {
    const e = event as MouseEvent
    lastX = e.clientX
    lastY = e.clientY
    pointerSeen = true
    if (!qgEnabled && !badgeEnabled) return
    mouseHitTest.push({
      target: e.target as Element | null,
      clientX: e.clientX,
      clientY: e.clientY,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
    })
  },
  { passive: true },
)
```

Call `mouseHitTest.clear()` on `mouseleave`, at the start of
`wxt:locationchange`, and on invalidation. A pre-navigation sample must not
re-arm UI against detached DOM. Never retain the event object or cache resolved
DOM nodes across frames.

## Repo conventions to follow

- Imitate `queueScrollHitTest` at `index.tsx:1821-1832`.
- Keep modifier logic in `src/core/quickgrab.ts:8-18` using `ModifierFlags`.
- Put pure scheduling logic and behavior tests under `src/core`, matching the
  coverage boundary documented in `vitest.config.ts:9-21`.

## Steps

1. Add `latest-frame.ts` and `latest-frame.test.ts`.
2. Test that A/B/C before one frame runs only C, a later push gets a new frame,
   and `clear()` before the frame runs nothing.
3. Add `MouseMoveSample`; widen `syncGrabFromPointer` to `ModifierFlags`.
4. Move the old listener body without changing its branch order or DEV log.
5. Replace the raw work with the passive, latest-sample listener above.
6. Clear the queued sample on leave, SPA route change, and invalidation.
7. Re-read the diff. No scroll-path changes.

## Boundaries

- Keep the 500 ms dwell, hit-test rules, modifier behavior, diagnostics, and UI.
- Use rAF, not a timeout debounce.
- Do NOT alter scroll hit-testing.
- Do NOT cache elements, rects, or media results between frames.
- Add no dependency.
- STOP if code differs from `cf787c6`; reconcile first.

## Verification

- **Mechanical**:
  - `bun run test -- src/core/latest-frame.test.ts src/core/quickgrab.test.ts`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
  - `npx --yes react-doctor@latest . --scope changed` adds no issue and lowers no score.
- **Behavior check**: Sweep the pointer quickly over X, Instagram, and Threads.
  The final item must win. Modifier press/release and whole-post mode must remain
  correct. In Chrome Performance, one frame must contain at most one mouse
  `elementsFromPoint`/layout path. In React/Preact DevTools Profiler and
  Highlight updates, overlay renders must not increase.
- **Done when**: burst input runs only the latest sample per frame, interaction
  behavior is unchanged, and all checks pass.
