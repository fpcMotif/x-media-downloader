# 004 — Stop popup polling after unmount

- **Workflow**: improve-react
- **Status**: DONE
- **Commit**: cf787c6
- **Severity**: MEDIUM
- **Category**: Bugs & correctness
- **Rule**: react-doctor/effect-needs-cleanup
- **Estimated scope**: 2 files, about 45 lines

## Problem

The popup poll owns an optional timer plus an in-flight promise, but cleanup
assumes the timer already exists:

```tsx
// src/entrypoints/popup/App.tsx:725 — current
useEffect(() => {
  let handle: ReturnType<typeof setTimeout>
  const poll = (): void => {
    void browser.runtime
      .sendMessage({ _tag: 'MetricsRequest' })
      .then((m) => {
        const snapshot = m as MetricsSnapshot | null
        setMetrics(snapshot)
        const next = snapshot && snapshot.total > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS
        handle = setTimeout(poll, next)
        return next
      })
      .catch(() => {
        handle = setTimeout(poll, POLL_IDLE_MS)
      })
  }
  poll()
  return () => clearTimeout(handle)
}, [])
```

If the popup closes before `sendMessage` settles, `handle` is unassigned during
cleanup. The promise can then update state and rearm a poll after unmount.

## Target

The canonical React Doctor recipe says to retain an async-created resource ID,
clear it from one teardown, and prevent the async callback from rearming after
cleanup. Source: <https://www.react.doctor/docs/rules/react-doctor/effect-needs-cleanup>.

Replace the effect exactly with:

```tsx
// src/entrypoints/popup/App.tsx — target
useEffect(() => {
  let active = true
  let handle: ReturnType<typeof setTimeout> | undefined

  const schedule = (delayMs: number): void => {
    if (!active) return
    handle = setTimeout(poll, delayMs)
  }

  const poll = (): void => {
    void browser.runtime
      .sendMessage({ _tag: 'MetricsRequest' })
      .then((m) => {
        if (!active) return
        const snapshot = m as MetricsSnapshot | null
        setMetrics(snapshot)
        schedule(snapshot && snapshot.total > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS)
      })
      .catch(() => schedule(POLL_IDLE_MS))
  }

  poll()
  return () => {
    active = false
    if (handle !== undefined) clearTimeout(handle)
  }
}, [])
```

## Repo conventions to follow

- Imitate timer cleanup at `src/entrypoints/popup/App.tsx:751-760`.
- Imitate resource cleanup at `src/components/confirm-strip.tsx:84-123`.
- Keep the source-contract test style already used in `popup/App.test.ts:1-5`.

## Steps

1. Replace only the metrics polling effect.
2. In `src/entrypoints/popup/App.test.ts`, pin the optional handle, the `active`
   check before `setMetrics`, guarded scheduling in both promise branches, and
   cleanup order (`active = false` before `clearTimeout`).
3. Re-read the diff. Keep every nearby 6-second status effect unchanged.

## Boundaries

- Keep the immediate first poll.
- Keep 1 second while active and 3 seconds while idle or failed.
- Do NOT change monitor UI, message contracts, or polling overlap behavior.
- Do NOT use `isMounted` state or add a dependency.
- STOP if code differs from `cf787c6`; reconcile first.

## Verification

- **Mechanical**:
  - `bun run test -- src/entrypoints/popup/App.test.ts`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
  - `npx --yes react-doctor@latest . --scope changed` clears
    `react-doctor/effect-needs-cleanup` and lowers no score.
- **Behavior check**: Delay `MetricsRequest`, close the popup, then resolve or
  reject it. Confirm no state update and no new timeout. Reopen the popup and
  confirm active/idle cadence still switches at `snapshot.total > 0`.
- **Done when**: cleanup is safe before the first timer, async completion cannot
  rearm after unmount, the diagnostic is clear, and all checks pass.

