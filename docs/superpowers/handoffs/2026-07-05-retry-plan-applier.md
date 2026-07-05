# Handoff: applyRetryPlan — one Retry Scheduler shell, with an honest Clock

- **Date:** 2026-07-05 · **Origin:** round-4 /improve-codebase-architecture (8 survey lenses → 21
  adversarial skeptics → survivors grilled; decisions adjudicated by the lead architect)
- **Status:** READY — not started. **Branch discipline:** implement on a fresh branch off main (or the
  current branch per the user's instruction at execution time); this handoff is self-contained.
- **Skeptic tally:** 3–0. Strength: STRONG.

## Problem

The pure decision `planInterruptRetry` (`src/core/download/interrupt-retry.ts:53`) is shared and clean,
but the post-decision bookkeeping around it is duplicated nearly line-for-line at three sites in
`src/entrypoints/background.ts`:

- `fireInterruptRetry`'s catch block, lines 540–566 — computes `attempt`, calls `planInterruptRetry`,
  and on `schedule: true` sets `interruptAttemptById`, calls `recordRetry(live, id)`, builds the
  `PendingInterruptRetry` row, calls `syncPendingRetries()`, sets a `setTimeout` into `retryTimeouts`,
  traces, and persists the snapshot.
- `scheduleInterruptRetry`, lines 569–611 — the same attempt/plan/state-mutation/timer/trace/persist
  sequence, called from the `onChanged` interrupt handler.
- `rehydrateInterruptRetries`, lines 613–630 — a third, partial copy: restores `requestMetaById` /
  `interruptAttemptById` / `pendingRetries` from the durable queue and re-arms the same
  timer-triad (`clearRetryTimeout` + `setTimeout` + `retryTimeouts.set`).

`background.ts` has zero tests. A new `PendingInterruptRetry` field, or a change to the backoff/attempt
bookkeeping, can silently miss one of the three copies with nothing to catch it.

Separately, `CONTEXT.md:81–84`'s Clock Port glossary entry currently claims an injected clock shared by
Retry and Settle. Verified false: both use raw `setTimeout` today. Retry's timers live in
`retryTimeouts` (a plain `Map<string, ReturnType<typeof setTimeout>>`, background.ts:133) driven by
literal `setTimeout(() => void fireInterruptRetry(id), plan.delayMs)` calls at lines 556, 603, and 627.
Settle's confirm-window timer is also a raw `setTimeout` at
`src/background/clear-coordinator.ts:273`, exercised in tests only via `vi.useFakeTimers()`.

## Grilled design decisions

1. **Home → `src/background/retry-plan.ts`, factory `makeRetryPlanApplier(deps)`.** Follows the
   DI-shell pattern of the tested siblings in the same directory (`admission-gate.ts`,
   `clear-coordinator.ts`): a `make*(deps)` factory returning an object of methods, unit-tested with
   hand-built fakes, called from `background.ts`. NOT `src/core/` — the state here (attempt counters,
   pending-retry rows, live timer handles) is retry-specific browser bookkeeping, not a pure decision.
   NOT left inline — inline is what makes `background.ts` untestable today.

2. **Deps are enumerated against the real module singletons, not invented.** Verified against
   `background.ts`:
   - `interruptAttemptById` (`Map<string, number>`, line 131)
   - `pendingRetries` (`Map<string, PendingInterruptRetry>`, line 132)
   - `syncPendingRetries` (lines 140–142, persists `pendingRetries` to `session:interruptRetries`)
   - `traceBackground` (lines 205–210)
   - `persistSnapshot` (line 189)
   - `failBrowserDownload` (lines 495–496, itself `settleBrowserDownload(id, downloadId, 'failed', now)`)
   - a `recordRetry`-over-live-metrics wrapper, exposed to the applier as `deps.recordRetry(id): void`
     (background.ts calls `if (live) live = recordRetry(live, id)` at lines 545 and 589 — the applier
     should not reach into the module-level `live` variable directly; the wrapper closes over it)
   - `requestMetaById` (`Map<string, RequestMeta>`, line 130)

   The `retryTimeouts` map plus its schedule/clear wrappers (`clearRetryTimeout` at line 167,
   the raw `setTimeout(...)` call sites at 556/603/627) **move inside `retry-plan.ts` as private
   factory state** — they are retry-specific, not a generic clock concern, and should not leak back
   into `background.ts` as a dep.

3. **The applier computes `attempt` internally and calls `planInterruptRetry` itself** — it is the
   Retry Scheduler shell per `CONTEXT.md`'s glossary entry, not just a bookkeeping tail bolted onto
   call sites that already decided. Both current call sites compute
   `interruptAttemptById.get(id) ?? 0` identically (background.ts:541 inside the catch, and :575 in
   `scheduleInterruptRetry`) immediately before calling `planInterruptRetry` — that duplicated
   read-and-decide step moves in, too.

   Per-call args: `{ id, downloadId, url, filename, item?, reason, now }`, where `downloadId` is a
   sentinel (e.g. `-1`) for the `fireInterruptRetry` catch path (no live download handle exists yet
   at that point — mirrors the existing `failBrowserDownload(id, -1, Date.now())` sentinel usage at
   lines 504, 565). Returns whether a retry was scheduled (`boolean`, or a richer
   `{ scheduled: true } | { scheduled: false }` if the caller needs to branch — decide during
   implementation, keep it boolean-shaped unless a caller needs more).

4. **Call-site differences that stay OUTSIDE the applier, at the call site:**
   - `scheduleInterruptRetry`'s `requestIdByDownloadId.delete(downloadId)` plus
     `transfersState = settleTransfer(transfersState, id)` / `persistTransfers()` (lines 583–587) stay
     at that call site — `fireInterruptRetry`'s catch path has no transfer-ledger entry yet (the
     `browser.downloads.download(...)` call that would have created one already threw), so folding
     this into the shared applier would either no-op wrongly for one caller or need a conditional that
     defeats the point of sharing.
   - `rehydrateInterruptRetries` (lines 613–630): fold **only its timer triad**
     (`clearRetryTimeout` + `setTimeout(() => void fireInterruptRetry(item.id), delay)` +
     `retryTimeouts.set`) through the applier's internal scheduling primitive. Its row-restoration —
     re-populating `requestMetaById`, `interruptAttemptById`, `pendingRetries`, and `inFlight` from the
     durable queue — stays inline in `background.ts`: rehydrate is *restoring* already-decided state
     from disk, not *deciding* a new retry, so it doesn't belong in a shell whose job is deciding.

5. **Clock → inject `clock: { schedule(fn, ms): CancelHandle }`.** Cancellation is required (both
   `fireInterruptRetry` and `rehydrateInterruptRetries` call `clearRetryTimeout(id)` before
   re-arming). Do **not** force-reuse `core/clear`'s `Clock` shape
   (`{ sleep(ms): Promise<void>; after(ms, fn): () => void }`, `src/core/clear/scroll-drain.ts:52–56`)
   — it's a different, already-serving interface for a different problem (drain/list-clear await a
   settle-wait *inside* a loop; `after` already returns a cancel function shaped as `() => void`,
   which is close but belongs to the Drain's own module boundary, not Retry's). Retry gets its own
   minimal port.

   `retry-plan.test.ts` uses a **hand-rolled fake clock object** (the `core/clear` idiom of a literal
   fake implementing the port), **not** `vi.useFakeTimers()`. This is a deliberate, disclosed
   divergence from `clear-coordinator.test.ts` (which still drives its raw `setTimeout` via
   `vi.useFakeTimers()` — see `src/background/clear-coordinator.test.ts` and
   `clear-coordinator.ts:273`). `retry-plan.ts` becomes the first `src/background` module on the
   injected-clock idiom.

6. **`CONTEXT.md`'s Clock Port entry (lines 81–84) is corrected NOW**, in this docs pass, to describe
   reality (both Retry and Settle use raw `setTimeout` today — no shared injected clock exists yet).
   After this handoff's implementation lands, update the entry again to say: Retry schedules via its
   own injected clock; Settle still raw. **Follow-on candidate, explicitly queued, NOT in this
   handoff's scope:** fold Settle's `clear-coordinator.ts:273` `setTimeout` onto the same (or a
   twin) injected clock and migrate `clear-coordinator.test.ts` off `vi.useFakeTimers()`. Do not do
   this as part of implementing this handoff.

## Interface sketch

```ts
// src/background/retry-plan.ts

export interface CancelHandle {
  (): void
}

export interface RetryClock {
  readonly schedule: (fn: () => void, ms: number) => CancelHandle
}

export interface RetryPlanApplierDeps {
  readonly interruptAttemptById: Map<string, number>
  readonly pendingRetries: Map<string, PendingInterruptRetry> // from core/download/interrupt-retry
  readonly requestMetaById: Map<string, RequestMeta> // RequestMeta as defined at background.ts:125-129
  readonly syncPendingRetries: () => void
  readonly recordRetry: (id: string) => void // wraps `if (live) live = recordRetry(live, id)`
  readonly trace: typeof traceBackground // (stage, opts) => void, background.ts:205
  readonly persistSnapshot: (now: number) => Promise<void>
  readonly failBrowserDownload: (id: string, downloadId: number, now: number) => Promise<void>
  readonly clock: RetryClock
  readonly fire: (id: string) => void // re-entry point: `() => void fireInterruptRetry(id)`
}

export interface ApplyRetryPlanArgs {
  readonly id: string
  readonly downloadId: number // sentinel (e.g. -1) when no live handle exists yet
  readonly url: string
  readonly filename: string
  readonly item?: MediaItem
  readonly reason: string | undefined
  readonly now: number
}

export interface RetryPlanApplier {
  /** Compute attempt, decide via planInterruptRetry, and either schedule a retry
   *  (state + timer + trace + persist) or call failBrowserDownload. Returns
   *  whether a retry was scheduled. */
  readonly apply: (args: ApplyRetryPlanArgs) => Promise<boolean>
  /** Re-arm a durable row's timer on boot (rehydrateInterruptRetries' timer triad
   *  only — row restoration stays in background.ts). */
  readonly rehydrateTimer: (row: PendingInterruptRetry, now: number) => void
  /** Cancel + drop a pending retry's timer (wraps the current clearRetryTimeout). */
  readonly cancel: (id: string) => void
}

export function makeRetryPlanApplier(deps: RetryPlanApplierDeps): RetryPlanApplier
```

`RequestMeta` (background.ts:125–129) and `PendingInterruptRetry`
(`src/core/download/interrupt-retry.ts:42–50`) are re-used as-is, not redefined. `fire` is the
applier's own re-entry hook so `retry-plan.ts` never imports `fireInterruptRetry` from
`background.ts` (that would invert the dependency); `background.ts` passes
`(id) => void fireInterruptRetry(id)` as `deps.fire` at construction time.

## Out of scope — DO NOT

- Relocate or rewrite `planInterruptRetry` itself (`src/core/download/interrupt-retry.ts:53`) — it
  stays pure, unmoved, untouched in interface.
- Touch retry *policy* — backoff math (`interruptBackoffMs`, `INTERRUPT_RETRY_MAX`,
  `RETRYABLE_REASONS`) is unchanged.
- Fold Settle's `clear-coordinator.ts:273` timer onto the new clock, or migrate
  `clear-coordinator.test.ts` off `vi.useFakeTimers()` — explicitly queued as a follow-on, not this
  handoff.
- Introduce any Drainer-shaped generic abstraction over "things with a timer and a queue" — refuted
  in the round-4 skeptic pass (this is a straight DI-shell extraction, not a new abstraction layer).
- Reuse `core/clear`'s `Clock` (`{ sleep, after }`) shape for Retry — different port, decided above.

## Plan with verifiable goals

1. Write `src/background/retry-plan.ts` with `makeRetryPlanApplier` per the interface sketch, moving
   `retryTimeouts` + `clearRetryTimeout` in as private factory state.
   → verify: `bun run typecheck` (i.e. `wxt prepare && tsgo --noEmit`) passes with no callers yet.
2. Write `src/background/retry-plan.test.ts` (TDD: write this alongside/before step 1) covering:
   schedule path, exhausted path (`failBrowserDownload` called), cancel-then-reschedule, and a
   drift-guard test asserting the `PendingInterruptRetry` row the applier builds matches exactly what
   `syncPendingRetries` would persist (field-for-field against `core/download/interrupt-retry.ts`'s
   `PendingInterruptRetry` type).
   → verify: `bunx vitest run src/background/retry-plan.test.ts`
3. Wire `background.ts`: replace the catch block in `fireInterruptRetry` (lines 540–566) and the body
   of `scheduleInterruptRetry` (lines 569–611) with calls to `applier.apply(...)`, preserving the
   call-site-only logic named in decision 4 (transfer-ledger settle in `scheduleInterruptRetry`, none
   in `fireInterruptRetry`'s catch).
   → verify: `bun run check` (oxfmt --check, oxlint, wxt prepare, tsgo --noEmit, vitest run) — full
   green, and manually diff-read both call sites to confirm no dropped side effect.
4. Wire `rehydrateInterruptRetries` (lines 613–630): keep row-restoration inline, replace the
   `clearRetryTimeout` + `setTimeout` + `retryTimeouts.set` triad with `applier.rehydrateTimer(item,
   now)`.
   → verify: existing behavior preserved — no dedicated rehydrate test exists yet; add one to
   `retry-plan.test.ts` if `rehydrateTimer` has any branch not covered by the schedule-path test.
5. Delete the now-dead module-level `retryTimeouts` map and `clearRetryTimeout` function from
   `background.ts` (they moved into `retry-plan.ts` in step 1).
   → verify: `rg -n "retryTimeouts|clearRetryTimeout" src/entrypoints/background.ts` returns nothing
   outside the applier's construction/wiring lines.
6. Run the coverage gate — `retry-plan.ts` lives under `src/background/`, which is NOT part of the
   100%-gated `src/core` + `src/lib` surface, but keep it fully covered anyway (it mirrors
   `admission-gate.ts`/`clear-coordinator.ts`, both of which carry their own dedicated test files).
   → verify: `bun run test:coverage` stays green (100% over `src/core` + `src/lib` unaffected by this
   change; confirm no regression).
7. Update `CONTEXT.md:81–84`'s Clock Port entry per decision 6 (raw `setTimeout` → Retry now uses its
   injected clock; Settle still raw; note the queued follow-on).
   → verify: read the entry back, confirm it names `src/background/retry-plan.ts` and no longer
   claims a *shared* clock.
8. Full gate sweep before calling this done.
   → verify: `bun run check` AND `bun run build` (`wxt build`) both exit 0.

## Files

- `src/background/retry-plan.ts` — new
- `src/background/retry-plan.test.ts` — new
- `src/entrypoints/background.ts` — edit (both call sites in `fireInterruptRetry` /
  `scheduleInterruptRetry`, plus `rehydrateInterruptRetries`; delete `retryTimeouts` +
  `clearRetryTimeout`; construct `makeRetryPlanApplier` alongside the other `make*` collaborators,
  near where `clearCoordinator`/`cloudUpload`/`syncOutbox` are constructed, lines ~239–329)
- `CONTEXT.md` — edit (Clock Port glossary entry, lines 81–84)

## Test plan

New file `src/background/retry-plan.test.ts`, mirroring the DI-shell idiom of
`src/background/admission-gate.test.ts` and `src/background/clear-coordinator.test.ts`: construct
`makeRetryPlanApplier` with a `deps` object of hand-built fakes (plain `Map`s for the three id-keyed
maps, a spy for `trace`/`persistSnapshot`/`failBrowserDownload`/`syncPendingRetries`/`recordRetry`,
and — per decision 5 — a **hand-rolled fake `RetryClock`** object exposing `schedule` that records
`(fn, ms)` calls and returns a cancel spy, NOT `vi.useFakeTimers()`).

Cases:
- schedule path: retryable reason, attempt below max → `pendingRetries` gets the row,
  `interruptAttemptById` bumps, `clock.schedule` called with the backoff delay, `recordRetry` called,
  returns `true`.
- exhausted path: attempt at `INTERRUPT_RETRY_MAX` (or non-retryable reason) → `failBrowserDownload`
  called with the given `id`/`downloadId`/`now`, no timer scheduled, returns `false`.
- cancel-then-reschedule: `cancel(id)` invokes the fake clock's returned cancel handle and drops the
  pending row; a subsequent `apply` re-schedules cleanly (no stale handle leak).
- drift-guard: the `PendingInterruptRetry` object passed to `pendingRetries.set` (asserted via the
  fake map) has exactly the fields `core/download/interrupt-retry.ts`'s `PendingInterruptRetry`
  interface declares — catches a future field added to one but not the other.
- `rehydrateTimer`: given a durable row and a `now`, schedules via `clock.schedule` with
  `Math.max(0, row.nextRetryAt - now)` delay (mirrors current line 625 logic).

## Coordination

`src/entrypoints/background.ts` is also touched by the concurrent 2026-07-05 clear-seed-plan handoff,
but at a different function (`handleDownload`, not the retry call sites). The two are mergeable in
either order — coordinate only on line-number drift when rebasing one atop the other's edits to
`background.ts` (both add a new `make*` construction near lines ~239–329 and both touch
call-site bodies elsewhere in the file).
