# 006 — Debounce video recovery scans

- **Workflow**: improve-react
- **Status**: TODO
- **Commit**: cf787c6
- **Severity**: MEDIUM
- **Category**: Performance
- **Rule**: Beyond the scan
- **Estimated scope**: 5 files, about 130 lines

## Problem

Every scroll frame queues `scanRenderedMedia`, which always performs a second,
X-specific full player scan:

```ts
// src/entrypoints/overlay.content/index.tsx:890 — current
const scanRenderedMedia = (): void => {
  if (store.addDetected(adapter.detectRenderedMedia(document, location.pathname)).length > 0) {
    rerender()
  }
  recoverMissingVideos()
}
```

```ts
// src/core/adapters/detection-store.ts:276 — current
needsRecovery: (root) => videoTweetsNeedingRecovery(root, new Set(byKey.keys())),
```

`videoTweetsNeedingRecovery` calls `root.querySelectorAll(VIDEO_PLAYER_SEL)` at
`src/core/adapters/x/index.ts:245`. Attempted tweet IDs are rejected only later
by `markAttempted`, after the document walk. Continuous scrolling repeats the
work once per queued frame.

## Target

Keep rendered-media detection per frame. Request video recovery explicitly:

```ts
// src/entrypoints/overlay.content/index.tsx — target
const VIDEO_RECOVERY_SCROLL_IDLE_MS = 250

let renderedScanQueued = false
let renderedScanNeedsRecovery = false
let scrollRecoveryTimer: ReturnType<typeof setTimeout> | null = null

const scanRenderedMedia = (): void => {
  if (store.addDetected(adapter.detectRenderedMedia(document, location.pathname)).length > 0) {
    rerender()
  }
}

const queueRenderedMediaScan = (recoverVideos = false): void => {
  renderedScanNeedsRecovery ||= recoverVideos
  if (renderedScanQueued) return
  renderedScanQueued = true
  ctx.requestAnimationFrame(() => {
    renderedScanQueued = false
    const recover = renderedScanNeedsRecovery
    renderedScanNeedsRecovery = false
    scanRenderedMedia()
    if (recover) recoverMissingVideos()
  })
}
```

Startup and SPA settlement remain complete:

```ts
// settleRenderedScan target calls
queueRenderedMediaScan(true)
setTimeout(() => queueRenderedMediaScan(true), 700)
setTimeout(() => queueRenderedMediaScan(true), 2000)
```

Scroll detects each frame, then requests one trailing recovery:

```ts
const scheduleScrollVideoRecovery = (): void => {
  if (adapter.platform !== 'x') return
  if (scrollRecoveryTimer !== null) clearTimeout(scrollRecoveryTimer)
  scrollRecoveryTimer = setTimeout(() => {
    scrollRecoveryTimer = null
    queueRenderedMediaScan(true)
  }, VIDEO_RECOVERY_SCROLL_IDLE_MS)
}

// existing scroll listener target
queueRenderedMediaScan()
scheduleScrollVideoRecovery()
queueScrollHitTest()
```

Clear `scrollRecoveryTimer` before each settle sequence and on invalidation.
Also reset `renderedScanNeedsRecovery` during invalidation.

Skip attempted tweets inside the X scan:

```ts
// src/core/adapters/x/index.ts — target signature
export function videoTweetsNeedingRecovery(
  root: ParentNode,
  detectedKeys: ReadonlySet<string>,
  attemptedTweetIds: ReadonlySet<string> = new Set(),
): string[]
```

For each player, resolve its article/tweet ID first. Before poster/key/layout
work, continue when the ID is absent, already seen, or attempted. Add an ID to
`seen` only after accepting a valid missing-poster candidate. This preserves a
second valid player when the first same-tweet player has no poster.

```ts
// src/core/adapters/detection-store.ts — target
needsRecovery: (root) =>
  videoTweetsNeedingRecovery(root, new Set(byKey.keys()), attempted),
```

Keep `markAttempted` as the final atomic guard and `unmarkAttempted` on transient
send failure.

## Repo conventions to follow

- Imitate the current rAF flag at `index.tsx:897-904`.
- Imitate cancel-before-rearm at `index.tsx:997-1007`.
- Extend recovery fixtures in `detection-store.test.ts:180-193` and the existing
  X adapter DOM tests.

## Steps

1. Split detection-only scan from optional recovery using the target flag.
2. Mark all startup, delayed settle, SPA, and manual rescan paths as full scans.
3. Add the 250 ms trailing scroll recovery and teardown.
4. Pass attempted IDs into `videoTweetsNeedingRecovery`.
5. Test that attempted tweet 55 is absent, `unmarkAttempted('55')` restores it,
   and a different candidate remains.
6. Preserve existing poster, dedupe, and missing-player tests.
7. Re-read the diff. Do not add another observer.

## Boundaries

- Keep startup, SPA-settle, and manual-rescan recovery.
- Keep X-only gating, syndication request shape, and transient retry rearming.
- Do NOT change rendered-media detection.
- Do NOT add an always-on MutationObserver.
- Add no dependency.
- Preserve plans 002/003 if already applied.
- STOP on other drift from `cf787c6`; reconcile first.

## Verification

- **Mechanical**:
  - `bun run test -- src/core/adapters/detection-store.test.ts src/core/adapters/x/xadapter.test.ts`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
  - `npx --yes react-doctor@latest . --scope changed` adds no issue and lowers no score.
- **Behavior check**: Record continuous X scrolling, then stop on a video missed
  by the tee. Chrome Performance must show no recovery scan per scroll frame and
  one after about 250 ms idle. The video must still recover and download. In the
  React/Preact Profiler and Highlight updates, overlay rendering must not grow.
- **Done when**: scrolling keeps fast detection, recovery runs once after idle,
  attempted tweets are skipped early, startup/manual behavior remains, and all
  checks pass.

