# Task 029: captureMirrorEnabled setting + panel toggle

**depends-on**: task-017-schema-wiring-impl, task-022-options-capture-panel

## Description
Wire a UI toggle in the Knowledge Capture panel that binds to the `settings.captureMirrorEnabled` flag, giving the Convex mirror its own opt-in switch that is entirely independent of the media `cloudSyncEnabled` flag. The toggle must be greyed out / disabled whenever Convex is not yet configured, communicating to the user that mirroring tweet text is only meaningful once a Convex deployment and secret are present, and that turning on local capture never implies mirroring.

## Execution Context
**Task Number**: 029 of 30
**Phase**: Mirror
**Prerequisites**: Task 017 has already added the `captureMirrorEnabled` field (default `false`) to the `Settings` schema in `src/core/schema/index.ts` and wired it through decoding. Task 022 has already created the Knowledge Capture panel `src/entrypoints/options/panels/capture.tsx` and registered it in the `SECTIONS` array. This task only adds the mirror toggle UI to that existing panel.

## BDD Scenario
```gherkin
Scenario: the mirror has its own opt-in, independent of media sync
  Given the Knowledge Capture panel
  When the user toggles captureMirrorEnabled
  Then it is greyed/disabled until Convex is configured
  And it is independent of media cloudSyncEnabled (local capture never implies mirroring)
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§11, §12)

## Files to Modify/Create
- Modify: `src/entrypoints/options/panels/capture.tsx` (add the mirror toggle)
- Note: the `captureMirrorEnabled` field itself is added in task 017; this wires the UI.

## Contracts (signatures/types ONLY — no bodies)
```ts
// UI toggle bound to settings.captureMirrorEnabled; disabled unless isSyncConfigured.
```

## Steps
1. In `src/entrypoints/options/panels/capture.tsx`, derive whether Convex is configured from the loaded settings (a non-empty `convexUrl` together with a non-empty `convexSyncSecret`, mirroring the gate already used in `cloud.tsx`). Add a `Switch` (from `@/components/ui/switch`) labelled for the Convex mirror, with `id="captureMirrorEnabled"`, `checked={settings.captureMirrorEnabled}`, an `onCheckedChange` that calls the panel's settings `update({ captureMirrorEnabled: checked })`, and `disabled` set when Convex is not configured.
   - Verification: `grep -n "captureMirrorEnabled" src/entrypoints/options/panels/capture.tsx` shows the new `Switch` bound to the field and a `disabled` expression tied to the Convex-configured condition.
2. Ensure the disabled state is purely a function of Convex configuration and NOT of `cloudSyncEnabled` — the mirror toggle must remain operable (when Convex is configured) and OFF by default regardless of the media cloud-sync setting.
   - Verification: `grep -n "cloudSyncEnabled" src/entrypoints/options/panels/capture.tsx` returns no match in the mirror toggle's `disabled`/`checked` logic (the mirror gate references only `convexUrl`/`convexSyncSecret`, never `cloudSyncEnabled`).
3. Add concise helper/label copy next to the toggle indicating it mirrors tweet text to Convex and is meaningful only when Convex is configured (greyed until then), consistent with the panel's existing field layout and the sibling `cloud.tsx` styling.
   - Verification: the rendered panel shows the mirror toggle greyed when Convex is unconfigured and enabled once configured (confirmed in the manual extension check below).

## Verification Commands
```bash
bun run check
# Manual: build + load the extension, open Options → Knowledge Capture:
#   - With no Convex URL/secret set: the mirror toggle is greyed/disabled and OFF.
#   - After configuring Convex (URL + secret in the Cloud panel): the mirror toggle
#     becomes enabled and can be turned on; turning it on does NOT depend on, and is
#     unaffected by, the media "Cloud sync" (cloudSyncEnabled) toggle.
#   - Default state of captureMirrorEnabled is OFF.
```

## Success Criteria
- The Knowledge Capture panel renders a toggle bound to `settings.captureMirrorEnabled` that persists via the panel's settings `update`.
- The toggle is greyed/disabled until Convex is configured (non-empty `convexUrl` and `convexSyncSecret`), satisfying the scenario's "greyed/disabled until Convex is configured".
- The toggle's enabled/checked state is independent of media `cloudSyncEnabled` — local capture never implies mirroring — satisfying the scenario's independence clause.
- `captureMirrorEnabled` defaults to OFF.
- `bun run check` passes (build, lint, types) — this is an ungated UI/entrypoints task with no 100% unit gate; correctness is confirmed by the manual extension check above.
