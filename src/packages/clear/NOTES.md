# Prototype notes — Completion Ledger state machine

**File:** `ledger.prototype.ts` (throwaway — delete or absorb into `ledger.ts`).
**Run:** `bun run src/core/clear/ledger.prototype.ts` (suite) · `… tui` (drive by hand).

## Question

Does the Completion-Ledger data shape + reducer correctly gate the **irreversible
Clear** across the 8 race/edge cases the grill-with-docs pass surfaced?

## Verdict: YES — 21/21 assertions pass

The shape from spec §4.1 holds. Two refinements the prototype forced (fold back into
the spec + ADR-0016):

1. **`inProgress` must be an explicit set with its own `Settle` action — distinct from
   `done`.** "Truly Complete" = `done == expected` **AND `inProgress` is empty**. This is
   what makes the late-`interrupted`-after-`complete` case safe (scenario 4): a recorded
   completion that interrupts before settling is moved `done → failed` and the Clear
   never fires. Modeling completion as a single "done" set would have cleared it. The
   spec's "leave the in-progress set" line is therefore load-bearing, not a nuance.

2. **The per-scope latch's `failed` state is RE-CLAIMABLE; `cleared` and `clearing` are
   NOT.** `canClaim = trulyComplete && inScope && (status==='none' || status==='failed')`.
   This is what lets a failed un-like retry (scenario 5) while a succeeded un-bookmark is
   never re-fired (no double mutation), and what makes the user-re-bookmark case
   (scenario 8) a no-op. Spec §4.1 should state which latch states are retryable.

## Confirmed design surfaces (lift into real code)

- `reduce(entry, action)` pure reducer; actions `Complete | Settle | Fail | LateInterrupt
| ClaimClear | ResolveClear`.
- `tryClaim(entry, scope) → {entry, won}` is the atomic compare-and-set the hook and the
  drain both call — only one wins (scenario 6). This is the single-writer guard the spec
  §4.6 needs.
- `strategy: 'browser' | 'aria2'` on the entry; `isStrategyEligible` excludes aria2 from
  auto-clear (scenario 7) — matches spec §4.2.
- `isFullyCleared` (every scope cleared) is the "removable from worklist" predicate.

## NOT covered here (needs the second spike — live X DOM probe)

- Real `data-testid`s for un-bookmark / un-like + the "…" caret menu.
- How X virtualizes the list (mount/unmount cadence) and whether tweetId resolution from
  a recycled `<article>` stays stable (the wrong-id guard in §4.4).
- ~~Whether bookmarks/likes merged into a "history" surface.~~ Yes — `/i/history` (Bookmarks)
  and `/i/history/likes` (Likes); `pageScope` recognizes both, legacy `/i/bookmarks` and
  `/{handle}/likes` still redirect there and are kept as alternatives.
- The MV3 persistence/reconcile behavior (storage.local + downloads.search on SW wake) —
  that's integration, not pure logic.
