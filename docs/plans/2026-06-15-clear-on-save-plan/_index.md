# Clear-on-Save (Un-like) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Load `superpowers:executing-plans` skill using the Skill tool to implement this plan task-by-task. Load the `effect-v4` skill before editing any schema/settings code.

**Goal:** On the X **Likes** page, once *all* of a post's downloaded media is **confirmed written to disk** (via `chrome.downloads.onChanged` → `state:'complete'`, never the optimistic hand-off badge), the extension **silently un-likes** that post — turning the Likes list into a self-clearing download queue. Gated by a default-off `autoUnlikeOnSave` setting.

**Design spec (source of truth):** [../../superpowers/specs/2026-06-15-clear-on-save-design.md](../../superpowers/specs/2026-06-15-clear-on-save-design.md) — live-verified 2026-06-15.

**Tech Stack:** TypeScript strict, Effect v4 beta Schema (load `effect-v4` skill before schema edits), WXT, Preact, vitest, oxlint/oxfmt, bun.

## Context

The Likes list is a natural "to-download" queue, but X gives no way to clear an item as you save it. This feature does so automatically and **safely**: it removes a post only after every Media Item the user downloaded for it reaches a genuinely-confirmed terminal `complete` (the `chrome.downloads.onChanged` signal), never the hand-off "Saved" badge — which a documented blind spot (`background.ts:202`, handoff integration test) fires the instant a download *starts*, before a possible `twimg` 403/timeout. Removal is silent and irreversible-feeling, so the safety burden sits entirely on (a) trusting only confirmed completion and (b) matching the exact post.

**Scope was set by live verification (spec §6):** un-*like* has a single inline control (`[data-testid="unlike"]`) on the Likes list and lightbox; un-*bookmark* has **no** inline control on the Bookmarks page (only the tweet detail page), so it is **deferred**. v1 ships un-like only.

| Aspect | Current State | Target State |
|--------|--------------|--------------|
| `src/core` state machines | `quickgrab.ts`, `badge.ts`, `launcher.ts` (pure, tested) | + `removal.ts` (pure per-tweet tally; prototype-validated) |
| X adapter | reads DOM → Media Items only | + `adapters/x/actions.ts` — first "write" seam (clicks `[data-testid="unlike"]`) + `isLikesSurface` matcher |
| Settings schema | 15 keys | + `autoUnlikeOnSave: boolean` default `false` |
| Popup settings | toggles for quick-grab/badge/dock | + "Un-like after saving (Likes page)" toggle |
| Background | `onChanged` records metrics outcome | + per-`downloadId` dedup → feeds `removal` tracker → messages `clearFromList` to tab |
| Content script | renders overlay, fires downloads | + gates on Likes-surface + setting; arms tracker; handles `clearFromList` by un-liking |
| Docs | no Bookmark/Like vocabulary | + CONTEXT.md nouns/action + ADR-0015 (extension mutates X state) |

## Execution Plan

```yaml
tasks:
  - id: "001-test"
    subject: "Removal tracker state machine test (Red)"
    slug: "removal-tracker-test"
    file: "task-001-removal-tracker-test.md"
    type: "test"
    depends-on: []
  - id: "001-impl"
    subject: "Removal tracker state machine impl (Green)"
    slug: "removal-tracker-impl"
    file: "task-001-removal-tracker-impl.md"
    type: "impl"
    depends-on: ["001-test"]
  - id: "002-test"
    subject: "autoUnlikeOnSave schema test (Red)"
    slug: "settings-schema-test"
    file: "task-002-settings-schema-test.md"
    type: "test"
    depends-on: []
  - id: "002-impl"
    subject: "autoUnlikeOnSave schema impl (Green)"
    slug: "settings-schema-impl"
    file: "task-002-settings-schema-impl.md"
    type: "impl"
    depends-on: ["002-test"]
  - id: "003-test"
    subject: "Popup un-like toggle test (Red)"
    slug: "popup-toggle-test"
    file: "task-003-popup-toggle-test.md"
    type: "test"
    depends-on: ["002-impl"]
  - id: "003-impl"
    subject: "Popup un-like toggle impl (Green)"
    slug: "popup-toggle-impl"
    file: "task-003-popup-toggle-impl.md"
    type: "impl"
    depends-on: ["003-test", "002-impl"]
  - id: "004-test"
    subject: "X actions + likes-surface test (Red)"
    slug: "x-actions-test"
    file: "task-004-x-actions-test.md"
    type: "test"
    depends-on: []
  - id: "004-impl"
    subject: "X actions + likes-surface impl (Green)"
    slug: "x-actions-impl"
    file: "task-004-x-actions-impl.md"
    type: "impl"
    depends-on: ["004-test"]
  - id: "005-test"
    subject: "Background coordinator + dedup test (Red)"
    slug: "background-wiring-test"
    file: "task-005-background-wiring-test.md"
    type: "test"
    depends-on: []
  - id: "005-impl"
    subject: "Background coordinator + dedup impl (Green)"
    slug: "background-wiring-impl"
    file: "task-005-background-wiring-impl.md"
    type: "impl"
    depends-on: ["005-test", "001-impl"]
  - id: "006-impl"
    subject: "Content-script wiring (arm + clearFromList handler)"
    slug: "content-wiring-impl"
    file: "task-006-content-wiring-impl.md"
    type: "impl"
    depends-on: ["002-impl", "004-impl", "005-impl"]
  - id: "007-docs"
    subject: "CONTEXT.md vocabulary + ADR-0015"
    slug: "docs"
    file: "task-007-docs.md"
    type: "doc"
    depends-on: []
```

## Task File References

- [Task 001 (test): Removal tracker test](./task-001-removal-tracker-test.md)
- [Task 001 (impl): Removal tracker impl](./task-001-removal-tracker-impl.md)
- [Task 002 (test): Settings schema test](./task-002-settings-schema-test.md)
- [Task 002 (impl): Settings schema impl](./task-002-settings-schema-impl.md)
- [Task 003 (test): Popup toggle test](./task-003-popup-toggle-test.md)
- [Task 003 (impl): Popup toggle impl](./task-003-popup-toggle-impl.md)
- [Task 004 (test): X actions + surface test](./task-004-x-actions-test.md)
- [Task 004 (impl): X actions + surface impl](./task-004-x-actions-impl.md)
- [Task 005 (test): Background coordinator test](./task-005-background-wiring-test.md)
- [Task 005 (impl): Background coordinator impl](./task-005-background-wiring-impl.md)
- [Task 006 (impl): Content-script wiring](./task-006-content-wiring-impl.md)
- [Task 007 (doc): Docs](./task-007-docs.md)

## BDD Coverage

All scenarios live in [bdd-specs.md](./bdd-specs.md) and are embedded verbatim in their task files:

| Scenario | Task |
|----------|------|
| Single-media post fully saved → remove | 001 |
| Multi-media partially saved → no emit | 001 |
| Multi-media fully saved → remove once | 001 |
| Any failed item → keep | 001 |
| Events for un-armed tweet → ignored | 001 |
| `autoUnlikeOnSave` defaults false + round-trips | 002 |
| Popup toggle renders + binds setting | 003 |
| Likes surface recognized by path | 004 |
| `findLikeControl` resolves `[data-testid="unlike"]` | 004 |
| `clearFromList` clicks control / no-op if absent | 004 |
| Duplicate `onChanged complete` counted once | 005 |
| All items complete → `clearFromList` to tab | 005 |
| Interrupted item → no `clearFromList` | 005 |
| Likes-page download arms tracker + un-likes on message | 006 (manual) |
| CONTEXT.md + ADR-0015 | 007 |

## Dependency Chain

```
001-test → 001-impl ─┐
005-test ────────────┴→ 005-impl ─┐
                                   ├→ 006-impl
004-test → 004-impl ───────────────┤
002-test → 002-impl ─┬─────────────┘
                     └→ 003-test → 003-impl
007-docs (independent)
```

**Analysis (reflected & corrected in Phase 4):**
- No circular dependencies; the graph is a DAG.
- Red precedes Green within every feature (001, 002, 003, 004, 005). Task 006 is integration/DOM wiring with no unit-testable surface — it carries a manual verification checklist instead of a paired Red test (justified, not a red-green violation). Task 007 is docs (no test).
- **Independent, can start immediately:** 001-test, 002-test, 004-test, 005-test, 007-docs.
- **Corrected over-chaining:** `005-test` depends on nothing (it exercises the coordinator's injected-port interface, not the tracker directly); `005-impl` does **not** depend on `004-impl` (the coordinator emits a message and never imports `actions.ts`).
- **Integration points:** `005-impl` consumes the tracker (001-impl); `006-impl` consumes the setting (002-impl), the click seam (004-impl), and the coordinator/message contract (005-impl).
