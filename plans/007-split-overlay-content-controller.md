# 007 — Split the overlay controller

- **Workflow**: improve-react
- **Status**: NOT STARTED — the one outstanding plan (all five dependencies 001/002/003/005/006 are now landed)
- **Commit**: cf787c6
- **Severity**: MEDIUM
- **Category**: Maintainability & architecture
- **Rule**: react-doctor/no-multi-comp
- **Estimated scope**: 8 files, about 650 moved or changed lines

## Problem

`src/entrypoints/overlay.content/index.tsx` is 1,976 lines. One `main` closure
owns quick-grab, badge, launcher, scan, observer, capture, listener, render, and
teardown state:

```ts
// src/entrypoints/overlay.content/index.tsx:782 — current excerpt
const store = makeDetectionStore({ mediaKeyFromUrl: adapter.mediaKeyFromUrl })
let host: HTMLElement | null = null
let grab: QuickGrabState = idleQuickGrab
let badge: BadgeState = hiddenBadge
let launcher: LauncherPhase = 'idle'

const rerender = (): void => {
  if (host) render(<Overlay />, host)
}
```

It also declares `BadgeButton` and `Overlay` at `index.tsx:1483-1589`. React
Doctor reports `react-doctor/no-multi-comp`. Runtime messages cross a 28-field
getter/setter bag:

```ts
// src/entrypoints/overlay.content/handlers.ts:47 — current excerpt
export interface HandlerDeps {
  readonly adapter: PlatformAdapter
  readonly store: DetectionStore
  readonly getBadge: () => BadgeState
  readonly setBadge: (b: BadgeState) => void
  readonly getLauncher: () => LauncherPhase
  readonly setLauncher: (p: LauncherPhase) => void
  // ...
}
```

`handlers.test.ts:45-62,339-497` bypasses this contract with 13
`as unknown as HandlerDeps` casts. Type checks therefore do not prove the real
wiring used in the always-on content script.

## Target

The canonical rule recipe is: move secondary components into their own files;
keep tightly coupled helpers co-located behind one public component. Source:
<https://www.react.doctor/docs/rules/react-doctor/no-multi-comp>.

Use this exact module boundary:

```text
src/entrypoints/overlay.content/
├── index.tsx                  # WXT composition and event binding only
├── interaction.ts            # quick-grab, badge, launcher controller
├── interaction.test.ts
├── overlay-view.tsx           # one Preact component: OverlayView
├── overlay-view.test.tsx
├── badge-button.tsx           # one Preact component: BadgeButton
├── phase-glyphs.tsx           # one Preact component: PhaseGlyphs
├── capture-controller.ts     # capture buffer/debounce
├── capture-controller.test.ts
├── handlers.ts
└── handlers.test.ts
```

`overlay-view.tsx` exports one component and value-only types:

```tsx
export interface OverlayViewModel {
  readonly grab: {
    readonly key: string
    readonly rect: Rect
    readonly phase: QuickGrabUiPhase
    readonly all: boolean
    readonly allCount?: number
  } | null
  readonly badge: {
    readonly key: string
    readonly rect: Rect
    readonly phase: BadgePhase
    readonly type: MediaType
    readonly lightbox: boolean
  } | null
  readonly launcher: {
    readonly visible: boolean
    readonly phase: LauncherPhase
    readonly count: number
    readonly glass: boolean
    readonly rescanning: boolean
  }
}

export interface OverlayViewActions {
  readonly downloadBadge: () => void
  readonly downloadAll: () => void
  readonly rescan: () => void
}

export function OverlayView(props: {
  readonly model: OverlayViewModel
  readonly actions: OverlayViewActions
}): VNode
```

Rename `Overlay` to `OverlayView`. Move `BadgeButton` and `PhaseGlyphs` to the
two named files and import them. One file must declare one Preact component, as
the canonical rule requires. The model must contain no DOM node, adapter, store,
timer, browser API, or mutable collection. Preserve plan 005's labels/live regions.

`interaction.ts` exports one controller:

```ts
export interface OverlayMessageActions {
  readonly settleTransfer: (
    requestId: string,
    outcome: 'complete' | 'failed',
  ) => void
  readonly clearDetectedMedia: (
    rescanVisible: boolean,
  ) => { readonly cleared: number; readonly rescanned: number }
}

export interface OverlayInteractions {
  readonly snapshot: () => OverlayViewModel
  readonly configure: (settings: Settings) => void
  readonly actions: OverlayViewActions
  readonly events: OverlayInputEvents
  readonly messages: OverlayMessageActions
  readonly dispose: () => void
}
```

`makeOverlayInteractions(ports)` owns only the current quick-grab, badge,
launcher, hover, rescan, and related timers. `ports.render()` receives a fresh
`snapshot()`. Literal-move current state transitions and event order. Do not
convert them to hooks or a new state library.

`capture-controller.ts` owns the current lines 1591-1667:

```ts
export interface CaptureController {
  readonly configure: (enabled: boolean, includeTextOnly: boolean) => void
  readonly ingest: (json: unknown, path: string) => void
  readonly flush: () => void
  readonly dispose: () => void
}
```

Preserve batch size 64 and debounce 750 ms. `dispose()` cancels its timer and
clears its buffer after `pagehide` has called `flush()`.

Replace raw handler state fields with semantic actions:

```ts
type TransferOutcomeDeps = Pick<HandlerDeps, 'interactions'>
type ClearTweetDeps = Pick<
  HandlerDeps,
  'adapter' | 'document' | 'location' | 'clearScope' | 'clearLog' | 'queueDrain'
>
```

`handleTransferOutcome` calls `interactions.settleTransfer`. The clear-detected
handler calls `interactions.clearDetectedMedia`. Every exported handler accepts
its narrow exact type. Remove every `as unknown as HandlerDeps` test cast.

`index.tsx` then only selects the adapter, creates store/controllers/UI, binds
WXT/browser/DOM events to controller methods, routes decoded messages, and calls
all `dispose()` methods on invalidation.

## Repo conventions to follow

- Follow the behavior-preserving relocation note in `handlers.ts:1-9`.
- Follow the injected-port factory at `src/core/clear/scroll-drain.ts:39-88`.
- Follow the small controller interface at `src/background/saved-status.ts:18-42`.
- Follow typed view props at `src/components/confirm-strip.tsx:29-52`.
- Keep Preact imports and local CSS unchanged.

## Steps

1. Run plans 001, 002, 003, 005, and 006 first. Reconcile this plan against
   their final code; do not restore the old ingestion, scheduling, or ARIA paths.
2. Add characterization tests for current badge/launcher/grab transitions,
   latest-frame input, rescan, disposal, and capture timing.
3. Extract `phase-glyphs.tsx`, `badge-button.tsx`, then `overlay-view.tsx`.
   Pass value props and callbacks. Compare markup/classes/ARIA before changing
   other ownership.
4. Create `makeOverlayInteractions`. Literal-move interaction state and helpers
   in cohesive blocks. After each block, run its focused tests.
5. Create capture controller. Test disabled ingest, 64-item flush, 750 ms flush,
   pagehide flush, and disposal.
6. Replace handler getters/setters with `OverlayMessageActions` and narrow
   `Pick` types. Rewrite fixtures without unsafe casts.
7. Reduce `index.tsx` to composition/event binding. Preserve listener order,
   fail-closed defaults, platform gates, and route-change order.
8. Route invalidation through both controllers and plan 003 lifecycle disposal.
9. Run the static search below. Remove dead closure state and imports.

## Boundaries

- No new state library, hooks conversion, dependency, or public extension API.
- No CSS, copy, ARIA, selector, delay, payload, permission, or storage change.
- Do NOT move adapter, download, clear, or sync domain logic.
- Add only the named view files and controllers. Do not fragment further.
- Preserve event order and fail-closed defaults.
- This plan depends on 001/002/003/005/006. STOP until reconciled with them.
- STOP on unexplained drift from `cf787c6`; never improvise a rewrite.

## Verification

- **Mechanical**:
  - `bun run test -- src/entrypoints/overlay.content/interaction.test.ts src/entrypoints/overlay.content/overlay-view.test.tsx src/entrypoints/overlay.content/capture-controller.test.ts src/entrypoints/overlay.content/handlers.test.ts`
  - `bun run test`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
  - `npx --yes react-doctor@latest . --scope changed` clears
    `react-doctor/no-multi-comp` and lowers no score.
  - `rg -n "function (Overlay|BadgeButton|PhaseGlyphs)|as unknown as HandlerDeps|getBadge|setBadge|getLauncher|setLauncher" src/entrypoints/overlay.content` returns no old view/bridge match.
- **Behavior check**: On X, test badge, quick grab, Download all, rescan, scroll,
  and SPA navigation. On Instagram/Threads, test whole-post grab. Confirm popup
  clear messages still work, capture flushes at debounce and pagehide, and an
  extension reload mid-action leaves no later timer or render. Compare Profiler
  render counts and Highlight updates before/after; they must not increase.
- **Done when**: the view is pure, controllers own disposal, handlers use narrow
  typed seams, unsafe fixture casts are gone, behavior is unchanged, the rule is
  clear, and all checks pass.
