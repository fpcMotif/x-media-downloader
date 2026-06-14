# Task 015 — Reconciliation spike vs elegant-franklin seam

- **type:** spike
- **depends-on:** ["005", "009"]
- **files:** `docs/adr/0014-catalog-seam-reconciliation.md` (new); possibly patches to `task-004/005/009` and `convex/`

## Objective

The spec flags an **open reconciliation**: branch `claude/elegant-franklin-g4ofol` already shipped a
Convex metadata mirror using `sync_events`/`media_state` + an Outbox, while this plan introduces
`catalogItems`/`syncItems` for the same seam. Investigate both, choose **one** seam, and record the
decision so the Convex tasks converge instead of forking the schema.

This is investigative — the deliverable is a **decision**, not a feature. Despite its `depends-on`,
**run it early** in execution: if it changes the table shape, 004/005 (and possibly 009) must be
revised before they are treated as final.

## BDD Scenario

```gherkin
Scenario: The two Phase-1 catalog designs are reconciled
  Given branch claude/elegant-franklin-g4ofol shipped sync_events/media_state + an Outbox
  And this plan introduces catalogItems/syncItems for the same seam
  When the reconciliation spike completes
  Then a single seam is chosen and recorded in an ADR
  And the affected tasks (004/005/009) are updated to match, or confirmed unchanged
```

## Steps

1. `git show`/diff the `claude/elegant-franklin-g4ofol` Convex schema + functions (`sync_events`,
   `media_state`, Outbox) against this plan's `catalogItems`/`syncItems`.
2. Compare on: idempotency model, per-user scoping, status derivation, and Phase-2 fit (uploadJobs).
3. Choose one seam; write `docs/adr/0014-catalog-seam-reconciliation.md` (Status: Accepted) with the
   rationale.
4. Open follow-up edits to tasks 004/005/009 if the chosen seam differs, or annotate them as confirmed.

## Verification

- `docs/adr/0014-catalog-seam-reconciliation.md` exists and names the chosen seam.
- Tasks 004/005/009 either updated to match or explicitly marked "no change needed."

## Outcome (RESOLVED 2026-06-14)

Done as the opening move of execution (read-only). Verdict: **adopt the shipped `media_state` seam;
retire this plan's `catalogItems`/`syncItems`.** Grounded in `main:backend/convex/schema.ts` + `sync.ts`
+ `src/core/sync/convex.ts`, consistent with the
[A0 reconciliation brief](../2026-06-14-cloud-destinations-plan/A0-reconciliation.md) — which is the
authoritative reconciliation record, so **no separate ADR-0014 was written** (avoiding the very
duplication this spike exists to prevent).

Findings → see the **Reconciliation outcome** table in [_index.md](./_index.md). In short: the Phase-1
link catalog is already shipped on `main`; backend lives in `backend/convex/`; new extension code
belongs in `src/core/cloud/`; identity stays `deviceId` (Auth deferred, A0 §3 Option B); presign-
everything confirmed. Blocking prereq: rebase this branch onto `main` (`bbdad24`) first.

Tasks 004/005/006/007 (and 001's top-level `convex/`) are **superseded — do not execute**. Tasks
002/003 (settings) and 012/013 (popup consent + status) plus the flexible-trigger idea may survive as
a thin increment on the shipped seam, if the user wants it.
