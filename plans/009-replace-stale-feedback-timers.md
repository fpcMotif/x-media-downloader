# 009 — Replace stale feedback timers

- **Workflow**: improve-react
- **Status**: TODO
- **Commit**: cf787c6
- **Severity**: LOW
- **Category**: Bugs & correctness
- **Rule**: Beyond the scan
- **Estimated scope**: 8 files, about 110 lines

## Problem

Four feedback paths create a fresh timeout without canceling the prior one:

```tsx
// src/entrypoints/popup/App.tsx:771 — current
setSettingsState(await setSettings(patch))
setSaved(true)
setTimeout(() => setSaved(false), 1200)

// src/entrypoints/options/App.tsx:87 — current
setSettingsState(await setSettings(patch))
setSaved(true)
setTimeout(() => setSaved(false), 1400)

// capture-quick-actions.tsx:45 and options/panels/archive.tsx:44 — current
setStatusMsg(msg)
setTimeout(() => setStatusMsg(null), 5000)
```

If action B follows action A, A's timer can clear B's newer feedback early.
Timers also outlive unmount.

## Target

Use one owned ref per component. Names: `savedTimer` in popup/options and
`statusTimer` in capture/archive.

```tsx
// target pattern; place beside the related state
const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

useEffect(() => {
  return () => {
    if (savedTimer.current !== null) clearTimeout(savedTimer.current)
  }
}, [])
```

Replace each raw timer with cancel-before-rearm:

```tsx
// target pattern
if (savedTimer.current !== null) clearTimeout(savedTimer.current)
savedTimer.current = setTimeout(() => {
  setSaved(false)
  savedTimer.current = null
}, 1200) // retain each site's current delay
```

For status messages, use `statusTimer` and `setStatusMsg(null)`. In
`CaptureQuickActions`, every hook must remain before the conditional return at
line 44.

Imports:

- Popup already imports `useEffect` and `useRef`.
- Options adds `useRef`.
- Capture quick actions adds `useEffect` and `useRef`.
- Archive adds `useRef`; it already imports `useEffect`.

## Repo conventions to follow

- Imitate cancel-before-rearm at `src/background/retry-plan.ts:101-112`.
- Imitate owned timer cleanup in `src/entrypoints/popup/App.tsx:751-760`.
- Keep source-contract UI tests, as documented in
  `capture-quick-actions.test.ts:4-7`.

## Steps

1. Execute plan 004 first. Preserve its `active` poll cleanup.
2. Add the ref and unmount cleanup in all four components.
3. Replace each timer. Keep 1200, 1400, and 5000 ms exactly.
4. Update `popup/App.test.ts` and `options/App.test.ts`.
5. Replace the stale raw-timeout assertion in
   `capture-quick-actions.test.ts:20`; assert cancel-before-rearm and cleanup.
6. Add `src/entrypoints/options/panels/archive.test.ts` with the same contract.
7. Re-read the diff. Keep async save/export/erase order unchanged.

## Boundaries

- Keep all current delay values and visible copy.
- Do NOT merge or change the separate 6-second cluster-status effects.
- Do NOT create a shared hook for four small sites.
- Do NOT change async ordering or error behavior.
- Add no dependency.
- STOP until plan 004 drift is reconciled; stop on other drift from `cf787c6`.

## Verification

- **Mechanical**:
  - `bun run test -- src/entrypoints/popup/App.test.ts src/entrypoints/options/App.test.ts src/entrypoints/popup/capture-quick-actions.test.ts src/entrypoints/options/panels/archive.test.ts`
  - `bun run typecheck`
  - `bun run lint`
  - `bun run build`
  - `npx --yes react-doctor@latest . --scope changed` adds no issue and lowers no score.
- **Behavior check**: Trigger each feedback twice inside its delay. The first
  timer must not hide the second message. Close popup/options before expiry and
  confirm no later state update or console warning.
- **Done when**: only the latest timer owns each feedback state, unmount cancels
  it, delays/copy remain unchanged, and all checks pass.

