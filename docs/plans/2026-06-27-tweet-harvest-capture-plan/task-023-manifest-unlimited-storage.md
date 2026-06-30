# Task 023: Manifest unlimitedStorage permission

**depends-on**:   <!-- none — independent -->

## Description
Declare the `unlimitedStorage` permission in the WXT manifest so the Tweet Harvest IndexedDB store (`xmd-capture`) is not evicted under browser storage pressure. The breadth flag can harvest tens of thousands of text records; without `unlimitedStorage` the harvest competes with the rest of the extension's quota and risks eviction. This is a manifest-config-only change: add `'unlimitedStorage'` to the existing `manifest.permissions` array in `wxt.config.ts`, leaving every other permission, host permission, and the seedsConvex branching untouched.

## Execution Context
**Task Number**: 023 of 30
**Phase**: Setup
**Prerequisites**: None. This is an independent config task that can run before, after, or alongside the capture-store and DB tasks; it does not depend on the IndexedDB shell existing yet.

## BDD Scenario
```gherkin
Scenario: the harvest is not evicted under storage pressure
  Given the WXT manifest config
  When the extension is built
  Then the manifest declares the 'unlimitedStorage' permission so IndexedDB harvest data persists
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§8)

## Files to Modify/Create
- Modify: `wxt.config.ts` (add `'unlimitedStorage'` to `manifest.permissions`)

## Contracts (signatures/types ONLY — no bodies)
```ts
// manifest.permissions: [...existing, 'unlimitedStorage']
```

## Steps
1. Confirm the scenario: the goal is that the built manifest's `permissions` array contains `'unlimitedStorage'` so the IndexedDB `xmd-capture` store survives storage pressure (§8 rationale: IndexedDB isolates harvest volume; `unlimitedStorage` prevents eviction).
   - Verification: re-read §8 of the spec and confirm `unlimitedStorage` is the named permission, added to `manifest.permissions` (not host or optional permissions).
2. In `wxt.config.ts`, locate the existing `permissions: ['downloads', 'storage', 'activeTab', 'identity', 'alarms']` line inside `manifest` and append `'unlimitedStorage'` to that array. Do not modify `host_permissions`, `optional_permissions`, `optional_host_permissions`, or the `seedsConvex` logic.
   - Verification: `permissions` now ends with `'unlimitedStorage'`; all other manifest fields are byte-for-byte unchanged.
3. Build the extension so WXT emits the manifest.
   - Verification: `.output/*/manifest.json` exists and its `permissions` array lists `unlimitedStorage`.

## Verification Commands
```bash
bun run check
# Confirm built manifest (.output/*/manifest.json) lists unlimitedStorage.
```

## Success Criteria
- `wxt.config.ts` `manifest.permissions` includes `'unlimitedStorage'` alongside the pre-existing `downloads`, `storage`, `activeTab`, `identity`, `alarms` entries — nothing else in the manifest is changed.
- `bun run check` passes (build, lint, types green) — this is an ungated config task, so there is no 100% unit-coverage gate.
- The built `.output/*/manifest.json` `permissions` array contains `unlimitedStorage`, satisfying the scenario's "the manifest declares the 'unlimitedStorage' permission".
