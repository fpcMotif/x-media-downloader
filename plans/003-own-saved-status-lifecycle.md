# 003 — Own saved-status lifecycle

- **Workflow**: improve-react
- **Status**: TODO
- **Commit**: cf787c6
- **Severity**: MEDIUM
- **Category**: Bugs & correctness
- **Rule**: Beyond the scan
- **Estimated scope**: 5 files, about 220 lines

## Problem

The overlay constructs a whole-document observer on every X page, even when the
setting or route is out of scope:

```ts
// src/entrypoints/overlay.content/index.tsx:997 — current
let savedSweepTimer: ReturnType<typeof setTimeout> | null = null
const scheduleSavedSweep = (): void => {
  if (savedSweepTimer !== null) clearTimeout(savedSweepTimer)
  savedSweepTimer = setTimeout(() => {
    savedSweepTimer = null
    void sweepSavedStatus({ document, inScope: () => savedStatusVisible(...), requestSavedStatus })
  }, SAVED_SWEEP_DEBOUNCE_MS)
}
if (adapter.platform === 'x') {
  const savedSweepObserver = new MutationObserver(scheduleSavedSweep)
  savedSweepObserver.observe(document.body, { childList: true, subtree: true })
}
```

The observer is block-local, so teardown at `index.tsx:1951-1974` cannot
disconnect it. The timer tracks no in-flight request, so a later mutation can
start another full article scan and request while the prior one waits.
`sweepSavedStatus` checks scope only before its await at `handlers.ts:138-150`.

The raw response listener at `index.tsx:1669-1692` is also anonymous and is not
removed on invalidation. A stale tab can retain duplicate callbacks.

## Target

Add `src/entrypoints/overlay.content/saved-status-lifecycle.ts`:

```ts
export interface SavedStatusLifecycle {
  readonly sync: () => void
  readonly schedule: () => void
  readonly dispose: () => void
}

export interface SavedStatusLifecycleDeps {
  readonly isActive: () => boolean
  readonly root: Node
  readonly delayMs: number
  readonly makeObserver: (notify: () => void) => {
    observe(target: Node, options: MutationObserverInit): void
    disconnect(): void
  }
  readonly clock: { after(ms: number, run: () => void): () => void }
  readonly sweep: () => Promise<void>
}
```

Implement these exact state rules with private `observer`, `cancelTimer`,
`running`, `rerun`, and `disposed` fields:

- `sync()` observes only while `isActive()` is true.
- Every active `sync()` also calls `schedule()`. Settings load/toggle and route
  entry therefore paint once without waiting for a later DOM mutation.
- Inactive `sync()` disconnects, cancels the timer, and clears `rerun`.
- `schedule()` returns while inactive or disposed.
- If `running`, `schedule()` sets only `rerun = true`.
- Otherwise it replaces the pending debounce.
- After a sweep settles, one requested rerun is debounced. Never overlap sweeps.
- `dispose()` permanently disconnects and cancels. An in-flight promise may
  finish but must not paint or rearm work.

Use this implementation shape; only local observer type spelling may vary:

```ts
export function makeSavedStatusLifecycle(
  deps: SavedStatusLifecycleDeps,
): SavedStatusLifecycle {
  let observer: ReturnType<SavedStatusLifecycleDeps['makeObserver']> | null = null
  let cancelTimer: (() => void) | null = null
  let running = false
  let rerun = false
  let disposed = false

  const cancelPending = (): void => {
    cancelTimer?.()
    cancelTimer = null
  }

  const stop = (): void => {
    observer?.disconnect()
    observer = null
    cancelPending()
    rerun = false
  }

  const schedule = (): void => {
    if (disposed || !deps.isActive()) return
    if (running) {
      rerun = true
      return
    }
    cancelPending()
    cancelTimer = deps.clock.after(deps.delayMs, () => {
      cancelTimer = null
      void run().catch(() => {})
    })
  }

  const run = async (): Promise<void> => {
    if (disposed || !deps.isActive()) return
    if (running) {
      rerun = true
      return
    }
    running = true
    try {
      await deps.sweep()
    } finally {
      running = false
      if (!disposed && deps.isActive() && rerun) {
        rerun = false
        schedule()
      } else {
        rerun = false
      }
    }
  }

  const sync = (): void => {
    if (disposed) return
    if (!deps.isActive()) {
      stop()
      return
    }
    if (observer === null) {
      observer = deps.makeObserver(schedule)
      observer.observe(deps.root, { childList: true, subtree: true })
    }
    schedule()
  }

  const dispose = (): void => {
    disposed = true
    stop()
  }

  return { sync, schedule, dispose }
}
```

Wire it with:

```ts
// src/entrypoints/overlay.content/index.tsx — target
let savedStatusAlive = true
const savedStatusIsActive = (): boolean =>
  savedStatusAlive &&
  adapter.platform === 'x' &&
  savedStatusVisible(location.pathname, savedStatusOn)

// controller dependency and sweepSavedStatus.inScope both use this function
isActive: savedStatusIsActive
```

`applySettings` assigns `savedStatusOn` then calls `savedStatusLifecycle.sync()`.
The `wxt:locationchange` listener also calls `sync()`. Invalidation calls
`savedStatusAlive = false` before `dispose()`. Remove the old observer and timer.

Close the post-await race:

```ts
// src/entrypoints/overlay.content/handlers.ts:146 — target
const saved = await deps.requestSavedStatus([...byTweet.keys()])
if (!deps.inScope()) return
for (const tweetId of saved) {
  // existing marking loop
}
```

Name and remove the raw listener:

```ts
// src/entrypoints/overlay.content/index.tsx — target
const handleMediaResponse = (event: Event): void => {
  const detail = (event as CustomEvent<{ path: string; body: string }>).detail
  // current listener body, unchanged
}
document.addEventListener('xmd:media-response', handleMediaResponse)

// inside ctx.onInvalidated
document.removeEventListener('xmd:media-response', handleMediaResponse)
```

## Repo conventions to follow

- Model observer ownership after `setAutoReveal` at `index.tsx:937-949`.
- Model named teardown after `handleRuntimeMessage` at `index.tsx:1944-1973`.
- Model injected clocks/controllers after `src/core/clear/scroll-drain.ts:88-173`.
- Preserve `savedStatusVisible` and the existing chip logic in `handlers.ts`.

## Steps

1. Build the controller and focused fake-clock/fake-observer tests.
2. Prove inactive state creates no observer or timer.
3. Prove active state creates one observer; inactive transition disconnects it.
4. Prove mutation during a deferred sweep causes one later rerun, never overlap.
5. Prove disposal blocks pending and in-flight rearming.
6. Wire settings, route change, and invalidation to the controller.
7. Recheck scope after the saved-status request resolves; extend
   `handlers.test.ts` with a promise that flips `inScope` before resolution.
8. Name and remove `handleMediaResponse`; keep its body byte-for-byte except
   changes required by plan 001.
9. Re-read the diff. Remove old observer/timer code.

## Boundaries

- Preserve `/home` and `/i/lists/{id}` scope and the 500 ms debounce.
- Preserve request shape, chip text/class/ARIA, and late push updates.
- Do NOT remove existing chips when the setting turns off.
- Do NOT add cancellation messages or an always-on observer.
- Never create the observer off X.
- Add no dependency.
- If plan 001 ran, preserve its URL filtering inside `handleMediaResponse`.
- STOP on other drift from `cf787c6`; reconcile first.

## Verification

- **Mechanical**:
  - `bun run test -- src/entrypoints/overlay.content/saved-status-lifecycle.test.ts src/entrypoints/overlay.content/handlers.test.ts`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
- `npx --yes react-doctor@latest . --scope changed` adds no issue and lowers no score.
- **Behavior check**: With Saved status off and on an out-of-scope X route,
  mutate the timeline and confirm zero saved-status requests. On `/home` with it
  on, hold one reply pending while causing mutations: only one request may be in
  flight and one debounced rerun may follow. Reload the extension and confirm one
  response handler and one observer remain.
- **Done when**: work exists only in active scope, never overlaps, cannot outlive
  invalidation, cannot paint after scope loss, and all checks pass.
