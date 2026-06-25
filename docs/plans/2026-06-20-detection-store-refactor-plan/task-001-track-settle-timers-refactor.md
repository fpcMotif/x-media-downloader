# task-001 — Track and clear settleRenderedScan timers (M1)

Type: refactor · Depends on: none · Behavior change: NO

## Context
`settleRenderedScan` (src/entrypoints/overlay.content/index.tsx) fires two bare
`setTimeout(queueRenderedMediaScan, 700|2000)` that aren't stored or cleared —
inconsistent with every other timer in the file (dwell, badgeNudge, badgeRevert,
launcherRevert, rescanSpin are all tracked handles cleared on teardown). Benign
(the late fire is a harmless no-op via `safeSend` + the `if (host)` guard), but a
discipline gap the review flagged.

## Scenario
- Given the overlay content script,
- When `settleRenderedScan` schedules its two re-scans,
- Then both timer handles are stored, and `ctx.onInvalidated` clears them on
  teardown — so no timer outlives the context.

## Implementation notes
- Hold the two handles (e.g. `let settleTimers: ReturnType<typeof setTimeout>[] = []`).
- Clear + reset them in the `ctx.onInvalidated` block (alongside the other timer
  clears) and when starting a fresh `settleRenderedScan`.
- Do NOT add the keysForItem→[] host-check (review finding 3) — out of scope.

## Verification
```
bun run typecheck
bun run lint
bunx vitest run
rg -n "setTimeout\(" src/entrypoints/overlay.content/index.tsx
# expect: only the `await new Promise(r => setTimeout(r,…))` sleeps remain bare;
#         the two settle timers are stored in handles and cleared in onInvalidated.
git diff src/entrypoints/overlay.content/index.tsx   # only timer-tracking, no logic change
```
Done when: typecheck + lint + tests green; diff shows only timer tracking.
