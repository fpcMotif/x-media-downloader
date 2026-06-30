# Task 008: Settings panel + auto-enable history (impl)

**depends-on**: task-001-settings-schema-impl

## Description

Add a "Downloads & Filters" options panel exposing the seven new settings, plus a daily-usage readout with a "reset today" action. Toggling `preventDuplicateDownloads` on must also enable `downloadHistoryEnabled` (its data source). UI task — verification is the build gate plus a manual checklist; the settings logic is already covered by task 001.

## Execution Context

**Task Number**: 14 of 15
**Phase**: UI
**Prerequisites**: task-001-settings-schema-impl committed

## BDD Scenario

```gherkin
Scenario: Filters panel edits settings and couples history
  Given the options page Downloads & Filters panel
  When the user sets a size cap, daily budget, skip types, and min resolution
  Then those settings persist via setSettings
  And enabling "prevent duplicate downloads" also sets downloadHistoryEnabled = true
  And "reset today" zeroes the daily-budget tally
```

**Spec Source**: `docs/superpowers/specs/2026-06-27-download-admission-gate-design.md` (Settings & UI)

## Files to Modify/Create

- Create: `src/core/settings/coupling.ts` + `src/core/settings/coupling.test.ts` — a **pure, unit-tested** helper that encodes the locked "enabling dedup also enables history" decision (so the coupling isn't manual-only). Contract:
  ```ts
  import type { Settings } from '../schema'
  /** Settings delta when the dedup toggle changes. Enabling also enables history (its data source); disabling leaves history untouched. */
  export function dedupeToggleDelta(enabled: boolean): Partial<Settings>
  // enabled  -> { preventDuplicateDownloads: true, downloadHistoryEnabled: true }
  // disabled -> { preventDuplicateDownloads: false }
  ```
- Create: `src/entrypoints/options/panels/filters.tsx` — controls for: `preventDuplicateDownloads` (toggle, with a "requires download history — enables it automatically" note), `skipTypes` (photo/video/gif checkboxes), `minWidth`/`minHeight`, `maxFileSizeMB`, `dailyMaxMB`, `dailyMaxCount`, and a daily-usage readout + "reset today" button.
  - The dedup toggle's handler applies `setSettings(dedupeToggleDelta(next))` — it does **not** re-implement the coupling inline.
  - "Reset today" sends a message to the background to call `budgetStore.resetToday()` (add a small message handler), or resets the `local:daily-budget` item directly if the panel has storage access — follow the existing panel/messaging convention.
- Modify: the options page panel registration (the nav/list that mounts `general.tsx`, under `src/entrypoints/options/`) to include the new panel — follow exactly how `general.tsx` is registered.

## Steps

### Step 1: Coupling helper (Red → Green)
- Write `coupling.test.ts` first: enabling yields `{ preventDuplicateDownloads: true, downloadHistoryEnabled: true }`; disabling yields `{ preventDuplicateDownloads: false }` and does **not** touch `downloadHistoryEnabled`.
- **Verification**: `bunx vitest run src/core/settings/coupling.test.ts` FAILS, then implement `dedupeToggleDelta` and it PASSES (100% covered — `src/core` gate).

### Step 2: Implement Panel
- Build the panel reusing the existing options panel components/styling (mirror `general.tsx`). Numeric inputs clamp at ≥ 0; 0 means "off". The dedup toggle uses `dedupeToggleDelta`.
- Register it in the options nav.

### Step 3: Verify
- **Verification**: `bun run check` clean.
- **Manual checklist**: each control round-trips through `getSettings`/`setSettings`; enabling dedup flips history on; "reset today" zeroes the readout.

## Verification Commands

```bash
bunx vitest run src/core/settings/coupling.test.ts
bun run check
```

## Success Criteria

- `dedupeToggleDelta` is unit-tested and 100% covered; panel present and registered; all seven settings editable; dedup auto-enables history via the helper; reset works; `bun run check` clean.
