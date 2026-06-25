# task-003 — Repoint overlay call sites to the DetectionStore (M2)

Type: refactor · Depends on: 002 · Behavior change: NO

## Context
Replace the four loose closures in `overlay.content/index.tsx` with one
`makeDetectionStore()` instance; repoint all ~35 call sites
(byId: size×5, values×4, has×3, set×3, clear×2, get×1; byKey: set×3, clear×2,
keys×1, get×1, has×1; recoveredKeys/recoveryAttempted ×13) across hover,
download-all, Drain, Sweep, RefreshMediaUrl, the launcher count, and clear handlers.

## Scenario
- Given makeDetectionStore exists (task-002),
- When the overlay uses one store instance instead of the four maps/sets,
- Then no `byId`/`byKey`/`recoveredKeys`/`recoveryAttempted` identifiers remain,
  the compiler accepts every repointed site, and runtime behavior is unchanged.

## Implementation notes
- Map: `byId.size`→`store.count`, `byId.values()`→`store.values()`,
  `byId.get`→`store.get`, `byKey.get`→`store.resolve`, the add/clear/needsRecovery
  flows→store methods. The Sweep filter
  `[...byId.values()].filter(i=>i.tweetId===id)`→`store.valuesForTweet(id)`.
- Delete the moved `keysForItem` from the overlay.

## Verification
```
rg -n "\b(byId|byKey|recoveredKeys|recoveryAttempted)\b" src/entrypoints/overlay.content/index.tsx
# expect: 0 matches
bun run typecheck    # compiler proves every call site repointed
bun run lint
bunx vitest run
```
### MANUAL GATE (loop pauses here — human required)
`/verify` in a real extension on https://x.com/ooaoau/status/2068286123399676218:
count + video download + hover + recovery behave IDENTICALLY to pre-refactor.
Done when: 0 stray identifiers, typecheck/lint/tests green, AND the manual /verify
parity check passes.
