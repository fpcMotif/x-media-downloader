# Download Admission Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Load `superpowers:executing-plans` skill using the Skill tool to implement this plan task-by-task.

**Goal:** A single pre-scheduling admission gate that decides, per media item, whether each download is admitted or skipped — unifying per-tweet duplicate prevention and four download filters/caps (media-type, min-resolution, per-file size, daily byte+count budget).

**Architecture:** A pure decision core in `src/core/download/admission.ts` (`freeReason` / `sizeReason` / `budgetReason` / composed `evaluateAdmission`) plus a pure daily-budget record module (`src/core/download/daily-budget.ts`) and an injected-fetch size probe (`src/core/download/size-probe.ts`) — all I/O-free and 100%-covered. A thin async shell `src/background/admission-gate.ts` orders the checks (cheap → costly), resolves dedup via the existing `SavedIndex`, probes survivors only when a size/byte cap is active, and maintains a running daily-budget projection. The shell slots into `handleDownload` **before** `planDownloads()`, so skipped items are never planned and never reach the queue.

**Tech Stack:** TypeScript strict, Effect v4 beta Schema (load the `effect-v4` skill before editing schema/settings code), WXT storage, Preact (options UI), vitest, oxlint/oxfmt, bun.

**Design Support:**
- [Design spec](../../superpowers/specs/2026-06-27-download-admission-gate-design.md) — single source of truth (architecture, locked decisions, error handling, testing)

## Context

The only duplicate guard today is an in-memory `inFlight: Set<MediaItem.id>` ([background.ts:105,696](../../../src/entrypoints/background.ts)) that prevents *concurrent* double-downloads and is cleared when a download settles — so re-encountering an already-saved post in a later session re-downloads it. There are no user-configurable download filters at all (only a non-configurable 96 MiB OOM guard in the Fetched strategy). The `SavedIndex` machinery already answers "is this tweet saved?" (local-first → Convex `by_tweet` backstop) for the timeline badge, so per-tweet dedup reuses it with zero new backend. Approved in session on 2026-06-27.

| Aspect | Current State | Target State |
|--------|--------------|--------------|
| Duplicate prevention | In-memory `inFlight` only (concurrent, session-scoped) | Durable per-tweet dedup via `SavedIndex` before scheduling |
| Download filters | None (only a 96 MiB OOM guard) | Media-type, min-resolution, per-file size cap, daily byte+count budget |
| Pre-schedule seam | `planDownloads()` output filtered by `inFlight` only | Admission gate runs on `MediaItem[]` before `planDownloads()` |
| `src/core/download` | `queue.ts`, `strategy.ts`, `metrics.ts`, … | + `admission.ts`, `daily-budget.ts`, `size-probe.ts` (pure, 100% covered) |
| Settings schema | existing keys (`downloadConcurrency`, …) | + `preventDuplicateDownloads`, `skipTypes`, `minWidth`, `minHeight`, `maxFileSizeMB`, `dailyMaxMB`, `dailyMaxCount` (all default off/zero) |
| Options UI | `general.tsx` and other panels | + `filters.tsx` ("Downloads & Filters") with usage + "reset today" |
| Download feedback | per-item saved badge | + aggregated "N downloaded · M skipped (reasons)" summary |

## Execution Plan

```yaml
tasks:
  - id: "001-test"
    subject: "Filter settings schema test (Red)"
    slug: "settings-schema-test"
    file: "task-001-settings-schema-test.md"
    type: "test"
    depends-on: []
  - id: "001-impl"
    subject: "Filter settings schema impl (Green)"
    slug: "settings-schema-impl"
    file: "task-001-settings-schema-impl.md"
    type: "impl"
    depends-on: ["001-test"]
  - id: "002-test"
    subject: "Admission core test (Red)"
    slug: "admission-core-test"
    file: "task-002-admission-core-test.md"
    type: "test"
    depends-on: []
  - id: "002-impl"
    subject: "Admission core impl (Green)"
    slug: "admission-core-impl"
    file: "task-002-admission-core-impl.md"
    type: "impl"
    depends-on: ["002-test"]
  - id: "003-test"
    subject: "Daily-budget record test (Red)"
    slug: "daily-budget-test"
    file: "task-003-daily-budget-test.md"
    type: "test"
    depends-on: []
  - id: "003-impl"
    subject: "Daily-budget record impl (Green)"
    slug: "daily-budget-impl"
    file: "task-003-daily-budget-impl.md"
    type: "impl"
    depends-on: ["003-test"]
  - id: "004-test"
    subject: "Size probe test (Red)"
    slug: "size-probe-test"
    file: "task-004-size-probe-test.md"
    type: "test"
    depends-on: []
  - id: "004-impl"
    subject: "Size probe impl (Green)"
    slug: "size-probe-impl"
    file: "task-004-size-probe-impl.md"
    type: "impl"
    depends-on: ["004-test"]
  - id: "005-test"
    subject: "Daily-budget store adapter test (Red)"
    slug: "budget-store-test"
    file: "task-005-budget-store-test.md"
    type: "test"
    depends-on: ["003-impl"]
  - id: "005-impl"
    subject: "Daily-budget store adapter impl (Green)"
    slug: "budget-store-impl"
    file: "task-005-budget-store-impl.md"
    type: "impl"
    depends-on: ["005-test", "003-impl"]
  - id: "006-test"
    subject: "Admission shell test (Red)"
    slug: "admission-shell-test"
    file: "task-006-admission-shell-test.md"
    type: "test"
    depends-on: ["001-impl", "002-impl", "004-impl"]
  - id: "006-impl"
    subject: "Admission shell impl (Green)"
    slug: "admission-shell-impl"
    file: "task-006-admission-shell-impl.md"
    type: "impl"
    depends-on: ["006-test", "001-impl", "002-impl", "004-impl"]
  - id: "007"
    subject: "Background wiring + completion accounting"
    slug: "background-wiring-impl"
    file: "task-007-background-wiring-impl.md"
    type: "impl"
    depends-on: ["005-impl", "006-impl"]
  - id: "008"
    subject: "Settings panel + auto-enable history"
    slug: "settings-panel-impl"
    file: "task-008-settings-panel-impl.md"
    type: "impl"
    depends-on: ["001-impl"]
  - id: "009"
    subject: "Skipped-summary feedback"
    slug: "skipped-summary-impl"
    file: "task-009-skipped-summary-impl.md"
    type: "impl"
    depends-on: ["007"]
```

**Task File References (for detailed BDD scenarios):**
- [Task 001: Filter settings schema test](./task-001-settings-schema-test.md)
- [Task 001: Filter settings schema impl](./task-001-settings-schema-impl.md)
- [Task 002: Admission core test](./task-002-admission-core-test.md)
- [Task 002: Admission core impl](./task-002-admission-core-impl.md)
- [Task 003: Daily-budget record test](./task-003-daily-budget-test.md)
- [Task 003: Daily-budget record impl](./task-003-daily-budget-impl.md)
- [Task 004: Size probe test](./task-004-size-probe-test.md)
- [Task 004: Size probe impl](./task-004-size-probe-impl.md)
- [Task 005: Daily-budget store adapter test](./task-005-budget-store-test.md)
- [Task 005: Daily-budget store adapter impl](./task-005-budget-store-impl.md)
- [Task 006: Admission shell test](./task-006-admission-shell-test.md)
- [Task 006: Admission shell impl](./task-006-admission-shell-impl.md)
- [Task 007: Background wiring + completion accounting](./task-007-background-wiring-impl.md)
- [Task 008: Settings panel + auto-enable history](./task-008-settings-panel-impl.md)
- [Task 009: Skipped-summary feedback](./task-009-skipped-summary-impl.md)

## BDD Coverage

Every testable decision in the spec maps to a `src/core` unit test: the five skip reasons and their precedence — both *free-before-size* and *size-before-budget* — plus fail-open paths (task 002), daily-budget rollover/whichever-first/projection (task 003), probe fail-open incl. auth-401 non-ok (task 004), the store adapter's reset-on-read and completion accumulation (task 005), and the shell's ordering / probe-gating / dedup-union / **Convex-failure degrade-to-local** / skipped-summary shape (task 006). Settings defaults + corrupt recovery are pinned in task 001, and the "dedup auto-enables history" coupling is a unit-tested pure helper (`dedupeToggleDelta`) in task 008. Integration-only behavior that cannot be unit-tested — the gate's insertion in `handleDownload` and completion accounting (task 007), the options panel UI (task 008), and the overlay summary render (task 009) — carries a manual verification checklist; their underlying logic is already covered by tasks 002–006/008-helper.

## Dependency Chain

```
FOUNDATIONS (start immediately, in parallel)
  001-settings-schema-test ─→ 001-settings-schema-impl ─┐
  002-admission-core-test  ─→ 002-admission-core-impl  ─┤
  004-size-probe-test      ─→ 004-size-probe-impl       ─┤
                                                         ├─→ 006-admission-shell-test ─→ 006-admission-shell-impl ─┐
  003-daily-budget-test ─→ 003-daily-budget-impl ─┐      │                                                          │
                                                  └─→ 005-budget-store-test ─→ 005-budget-store-impl ──────────────┤
                                                                                                                   ├─→ 007-background-wiring-impl ─→ 009-skipped-summary-impl
  001-settings-schema-impl ─→ 008-settings-panel-impl                                                              │
                              (independent UI branch) ─────────────────────────────────────────────────────────────┘ (008 joins at integration; no code dep on 007)
```

**Analysis**:
- **No circular dependencies.** Red precedes Green in every feature pair (001–006).
- **Immediate parallel starts:** 001-test, 002-test, 003-test, 004-test (all four foundations, plus 008 once 001-impl lands).
- **006 (shell)** depends only on 001-impl/002-impl/004-impl — it consumes `evaluateAdmission` + `FilterSettings` (002), `SizeProbePort` (004), and the new `Settings` keys (001). It does **not** depend on 003/005 because the running budget is injected (`readTodayBudget`) and the comparison lives in `admission.ts`.
- **005 (store)** sits on 003-impl (reuses the pure daily-budget ops); it joins at **007**, which is the single integration point consuming both the shell (006) and the store (005).
- **Critical path:** `00x-test → 00x-impl → 006-test → 006-impl → 007 → 009` (≈6 deep). 008 runs off to the side after 001-impl.

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-06-27-download-admission-gate-plan/`. Execution options:**

**1. Orchestrated Execution (Recommended)** - Load `superpowers:executing-plans` skill using the Skill tool.

**2. Direct Agent Team** - Load `superpowers:agent-team-driven-development` skill using the Skill tool.

**3. BDD-Focused Execution** - Load `superpowers:behavior-driven-development` skill using the Skill tool for specific scenarios.
