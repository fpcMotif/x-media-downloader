# Task 022: Knowledge Capture options panel

**depends-on**: task-017-schema-wiring-impl

## Description
Add a new "Knowledge Capture" panel to the WXT options page that exposes the capture feature's controls and exports. The panel surfaces the capture settings toggles (`captureEnabled`, `captureAllScrolled`, and `captureMirrorEnabled` greyed until Convex is configured), shows live counts of harvested tweets and conversations plus a recent-conversation list with per-conversation export actions, and provides whole-harvest export and clear actions. All data and side effects are driven by sending the existing capture background messages (`CaptureSummaryRequest`, `ExportCaptureRequest`, `ClearCaptureRequest`) and by the standard `update` settings hook — the panel itself contains no harvest logic.

## Execution Context
**Task Number**: 022 of 30
**Phase**: Integration
**Prerequisites**: The `Settings` schema carries `captureEnabled`, `captureAllScrolled`, and `captureMirrorEnabled` (task-017). The capture background message handlers (`CaptureSummaryRequest`, `ExportCaptureRequest`, `ClearCaptureRequest`) are wired in the background dispatcher and respond with the shapes from §13. The options page provides the shared `PanelProps` contract (`settings`, `update`, `reload`) and the `SECTIONS` registry in `App.tsx`.

## BDD Scenario
```gherkin
Scenario: a settings panel controls capture and exports
  Given the options page SECTIONS array
  When the user opens Knowledge Capture
  Then toggles for captureEnabled and captureAllScrolled are shown (captureMirrorEnabled added in Phase 2, greyed until Convex configured)
  And live counts (tweets, conversations) and a recent-conversation list render, each with Export tree / Export Markdown
  And Export all (JSONL) and Clear harvest buttons work via the capture messages
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§12)

## Files to Modify/Create
- Create: `src/entrypoints/options/panels/capture.tsx`
- Modify: `src/entrypoints/options/App.tsx` (register in `SECTIONS`)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Panel accepts the standard PanelProps { settings, update, reload }.
// Uses CaptureSummaryRequest / ExportCaptureRequest / ClearCaptureRequest.

// src/entrypoints/options/panels/capture.tsx
import type { PanelProps } from '../ui'

export function CapturePanel(props: PanelProps): JSX.Element

// Message shapes consumed (defined upstream — do not redeclare here):
//   CaptureSummaryRequest  (panel→bg)  →  { tweets, conversations, recent }
//   ExportCaptureRequest{ kind: 'jsonl' | 'tree' | 'markdown', conversationId? }  →  { ok, filename }
//   ClearCaptureRequest    (panel→bg)  →  { cleared }
```

## Steps
1. Implement `CapturePanel` in `src/entrypoints/options/panels/capture.tsx` following the existing panel conventions (mirror `HistoryPanel`: `PanelHeader`, `SettingGroup`, `Field`/`FieldContent`/`FieldLabel`/`FieldDescription`, `Switch`, `Button`). Render the master `captureEnabled` toggle and the `captureAllScrolled` toggle, both wired to `update({ ... })` from `PanelProps`.
   - Verification: `bun run check` passes; the file compiles and exports `CapturePanel` typed as a panel consuming `PanelProps`.
2. Add the `captureMirrorEnabled` toggle wired to `update`, disabled/greyed when Convex is not configured (derive configured-state the same way the Cloud panel gates its mirror controls), with a description noting it is meaningful only with sync configured.
   - Verification: `bun run check` passes; toggle renders disabled when sync is unconfigured and enabled otherwise.
3. On mount, send `CaptureSummaryRequest` via `browser.runtime.sendMessage` and hold the `{ tweets, conversations, recent }` response in local component state; render live `tweets` and `conversations` counts and the `recent` conversation list. Swallow message errors so an unwired background never throws (match the `.catch(() => {})` pattern in `HistoryPanel`).
   - Verification: `bun run check` passes; counts and recent list render from the response shape.
4. For each recent conversation, render an **Export tree** button and an **Export Markdown** button that send `ExportCaptureRequest{ kind: 'tree', conversationId }` and `ExportCaptureRequest{ kind: 'markdown', conversationId }` respectively.
   - Verification: `bun run check` passes; buttons appear per recent conversation and dispatch the correct `kind`/`conversationId`.
5. Add the panel-level **Export all (JSONL)** button (`ExportCaptureRequest{ kind: 'jsonl' }`) and **Clear harvest** button (`ClearCaptureRequest`); after a successful clear, reset local count/recent state.
   - Verification: `bun run check` passes; both panel-level buttons send the right messages.
6. Register the panel in `src/entrypoints/options/App.tsx`: import `CapturePanel`, add a `SECTIONS` entry `{ id: 'capture', label: 'Knowledge Capture', icon: <existing icon>, Panel: CapturePanel }` so it appears in the sidebar and is reachable by `#capture` hash.
   - Verification: `bun run check` passes; `SECTIONS` still satisfies the `Section` type and `isSectionId('capture')` resolves true.

## Verification Commands
```bash
bun run check
# Manual: open the options page, verify the panel renders, toggles persist, counts update, exports trigger downloads.
```

## Success Criteria
- `bun run check` (build + lint + types) passes; `CapturePanel` is registered in the `App.tsx` `SECTIONS` array and reachable from the sidebar.
- Toggles for `captureEnabled` and `captureAllScrolled` are shown and persist via `update`; `captureMirrorEnabled` is shown but greyed until Convex is configured.
- Live `tweets` and `conversations` counts and a recent-conversation list render from the `CaptureSummaryRequest` response, each conversation offering **Export tree** and **Export Markdown**.
- **Export all (JSONL)** and **Clear harvest** dispatch `ExportCaptureRequest{ kind: 'jsonl' }` and `ClearCaptureRequest` respectively; manual extension check confirms toggles persist, counts update, and exports trigger downloads.
