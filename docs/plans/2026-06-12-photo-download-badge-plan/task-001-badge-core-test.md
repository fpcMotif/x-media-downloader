# Task 001: Badge state machine test (Red)

**depends-on**: none

## Description

Write the failing vitest suite for `src/core/badge.ts` — a pure state machine for the photo download badge, modeled on the existing `src/core/quickgrab.ts` idiom (plain exported functions over readonly state, no DOM, no timers — timing is exported constants the caller schedules).

## Execution Context

**Task Number**: 1 of 8
**Phase**: Foundation
**Prerequisites**: none (pure module; test doubles not needed — there are no external dependencies)

## BDD Scenarios

```gherkin
Scenario: Badge shows for a resolvable item when enabled
  Given downloadBadgeEnabled is true
  And the hovered element resolves to a MediaItem key
  And the Quick Grab modifier is not held
  When the pointer enters the media
  Then the badge state becomes "shown" for that key

Scenario: Badge never shows when the setting is off
  Given downloadBadgeEnabled is false
  When the pointer enters resolvable media
  Then the badge stays hidden

Scenario: Badge hides while the Quick Grab modifier is held
  Given the badge is shown
  When the Quick Grab modifier becomes held
  Then the badge state becomes hidden

Scenario: Badge never shows for unresolvable media
  Given the hovered element has no MediaItem mapping
  When the pointer enters it
  Then the badge stays hidden

Scenario: One nudge per entrance
  Given the badge is shown and unclicked
  When the nudge delay elapses
  Then the state becomes "nudged"
  And a second nudge for the same entrance is rejected

Scenario: Click queues then saves
  Given the badge is shown or nudged
  When the user clicks the badge
  Then the state becomes "queued"
  When the background acknowledges the start
  Then the state becomes "saved"

Scenario: Failure is retryable
  Given a click ended in "failed"
  When the user clicks again
  Then the state becomes "queued" again

Scenario: Leaving the media resets the entrance
  Given the badge is shown, nudged, saved, or failed
  When the pointer leaves the media
  Then the state becomes hidden
  And a fresh entrance may nudge again
```

**Spec Source**: `docs/superpowers/specs/2026-06-12-photo-download-badge-design.md` §2, §4, §6

## Files to Modify/Create

- Create: `src/core/badge.test.ts`

## Contract under test (signatures only — implemented in task-001-impl)

```ts
export type BadgePhase = 'hidden' | 'shown' | 'nudged' | 'queued' | 'saved' | 'failed'
export interface BadgeState {
  readonly phase: BadgePhase
  readonly key: string | null
}
export const hiddenBadge: BadgeState
export const badgeNudgeDelayMs: number   // 2200
export const badgeSavedRevertMs: number  // revert delay after saved
export interface BadgeVisibilityInput {
  readonly enabled: boolean
  readonly resolvable: boolean
  readonly modifierHeld: boolean
}
export function canShowBadge(input: BadgeVisibilityInput): boolean
export function enterMedia(state: BadgeState, key: string, input: BadgeVisibilityInput): BadgeState
export function leaveMedia(state: BadgeState): BadgeState
export function nudgeBadge(state: BadgeState): BadgeState        // shown → nudged, else identity
export function beginSave(state: BadgeState): BadgeState         // shown|nudged|failed → queued, else identity
export function resolveSave(state: BadgeState, ok: boolean): BadgeState // queued → saved|failed
```

## Steps

### Step 1: Verify Scenarios
- Confirm each Gherkin scenario above maps to at least one `it(...)` block. Follow the naming/style of `src/core/quickgrab.test.ts`.

### Step 2: Implement Test (Red)
- Create `src/core/badge.test.ts` covering every scenario, including identity transitions (e.g. `nudgeBadge` on `queued` returns the same state) and that `enterMedia` with a different key while `queued` does not clobber an in-flight save for the old key (decide and pin behavior: in-flight save state is keyed; entering new media replaces the entrance).
- **Verification**: `bunx vitest run src/core/badge.test.ts` FAILS (module does not exist yet).

## Verification Commands

```bash
bunx vitest run src/core/badge.test.ts   # must FAIL at this stage
```

## Success Criteria

- Suite compiles its expectations against the contract above and fails only because `src/core/badge.ts` does not exist.
- Every BDD scenario has a corresponding test.
