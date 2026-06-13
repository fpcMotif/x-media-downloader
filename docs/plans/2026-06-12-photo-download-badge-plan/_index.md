# Photo Download Badge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Load `superpowers:executing-plans` skill using the Skill tool to implement this plan task-by-task.

**Goal:** A per-media download badge that bounces into a photo's bottom-right corner on timeline hover and in the lightbox, and downloads that Media Item at Original quality on click.

**Architecture:** A pure state machine in `src/core/badge.ts` (modeled on `core/quickgrab.ts`) drives phases and visibility predicates; the existing `overlay.content` shadow-root Preact app renders the badge reusing its hover tracking, hit-testing, rect positioning, and `sendTracked` download pipeline. A new `downloadBadgeEnabled` setting (default on) gates the feature, surfaced as a popup toggle.

**Tech Stack:** TypeScript strict, Effect v4 beta Schema (load the `effect-v4` skill before editing schema/settings code), WXT, Preact, vitest, oxlint/oxfmt, bun.

**Design Support:**
- [Design spec](../../superpowers/specs/2026-06-12-photo-download-badge-design.md) — single source of truth (interaction model §2, motion §3, architecture §4, settings §5, edge cases §6, testing §7)
- Figma state sheet: https://www.figma.com/design/h1EIKvAveBTW45TXaqog3D

## Context

Quick Grab (modifier + dwell) and the global launcher cover the power-user and bulk paths, but a user who simply *sees* a photo has no visible per-photo affordance — the spec adds one, borrowed from X's native corner-badge pattern, with a lively-but-restrained bounce. Approved in session on 2026-06-12.

| Aspect | Current State | Target State |
|--------|--------------|--------------|
| Per-media affordance | None (deliberately avoided; Quick Grab only) | Corner badge on hover/lightbox, gated by setting |
| `src/core` state machines | `quickgrab.ts` (pure, tested) | + `badge.ts` (pure, tested, same idiom) |
| Settings schema | 12 keys, `quickGrabEnabled` etc. | + `downloadBadgeEnabled: boolean` default `true` |
| Popup settings panel | Quick Grab toggle + modifier picker | + "Show download badge on media" toggle |
| Overlay CSS | `.xmd-launcher`, `.xmd-grab` | + `.xmd-badge` block with entrance/nudge keyframes |
| Download path | Launcher bulk + Quick Grab `sendTracked` | Badge clicks ride the same `sendTracked` pipeline |

## Execution Plan

```yaml
tasks:
  - id: "001-test"
    subject: "Badge state machine test (Red)"
    slug: "badge-core-test"
    file: "task-001-badge-core-test.md"
    type: "test"
    depends-on: []
  - id: "001-impl"
    subject: "Badge state machine impl (Green)"
    slug: "badge-core-impl"
    file: "task-001-badge-core-impl.md"
    type: "impl"
    depends-on: ["001-test"]
  - id: "002-test"
    subject: "downloadBadgeEnabled schema test (Red)"
    slug: "settings-schema-test"
    file: "task-002-settings-schema-test.md"
    type: "test"
    depends-on: []
  - id: "002-impl"
    subject: "downloadBadgeEnabled schema impl (Green)"
    slug: "settings-schema-impl"
    file: "task-002-settings-schema-impl.md"
    type: "impl"
    depends-on: ["002-test"]
  - id: "003-test"
    subject: "Popup toggle test (Red)"
    slug: "popup-toggle-test"
    file: "task-003-popup-toggle-test.md"
    type: "test"
    depends-on: ["002-impl"]
  - id: "003-impl"
    subject: "Popup toggle impl (Green)"
    slug: "popup-toggle-impl"
    file: "task-003-popup-toggle-impl.md"
    type: "impl"
    depends-on: ["003-test", "002-impl"]
  - id: "004"
    subject: "Overlay badge rendering and wiring"
    slug: "overlay-render-impl"
    file: "task-004-overlay-render-impl.md"
    type: "impl"
    depends-on: ["001-impl", "002-impl"]
  - id: "005"
    subject: "Badge motion CSS"
    slug: "motion-css-impl"
    file: "task-005-motion-css-impl.md"
    type: "impl"
    depends-on: []
```

**Task File References (for detailed BDD scenarios):**
- [Task 001: Badge state machine test](./task-001-badge-core-test.md)
- [Task 001: Badge state machine impl](./task-001-badge-core-impl.md)
- [Task 002: Settings schema test](./task-002-settings-schema-test.md)
- [Task 002: Settings schema impl](./task-002-settings-schema-impl.md)
- [Task 003: Popup toggle test](./task-003-popup-toggle-test.md)
- [Task 003: Popup toggle impl](./task-003-popup-toggle-impl.md)
- [Task 004: Overlay badge rendering](./task-004-overlay-render-impl.md)
- [Task 005: Badge motion CSS](./task-005-motion-css-impl.md)

## BDD Coverage

All testable behavior from spec §2 (interaction model), §5 (settings), and §6 (edge cases) maps to tasks 001–003; presentation behavior (§2 surfaces, §3 motion) that cannot be unit-tested is covered by task 004/005 manual verification checklists. Every task file embeds its full Gherkin scenarios.

## Dependency Chain

```
task-001-badge-core-test ──→ task-001-badge-core-impl ──┐
                                                         ├─→ task-004-overlay-render-impl
task-002-settings-schema-test ─→ task-002-settings-schema-impl ─┤
                                          │                      │
                                          └─→ task-003-popup-toggle-test ─→ task-003-popup-toggle-impl
task-005-motion-css-impl (independent; shares the .xmd-badge class contract with task 004)
```

**Analysis**:
- No circular dependencies.
- Red precedes Green within every feature.
- 001-test, 002-test, and 005 can start in parallel immediately.
- Task 004 is the integration point and depends only on the two impls it consumes.

---

## Execution Handoff

**Plan complete and saved to `docs/plans/2026-06-12-photo-download-badge-plan/`. Execution options:**

**1. Orchestrated Execution (Recommended)** - Load `superpowers:executing-plans` skill using the Skill tool.

**2. Direct Agent Team** - Load `superpowers:agent-team-driven-development` skill using the Skill tool.

**3. BDD-Focused Execution** - Load `superpowers:behavior-driven-development` skill using the Skill tool for specific scenarios.
