# Task 006: downloadHistoryEnabled setting (default off) — impl

**Type:** impl
**depends-on:** ["005"]
**Files:**
- `src/core/schema/index.ts` (modify — `Settings` struct)
- `src/core/settings/index.ts` (modify — only if defaults are declared here rather than in the schema)

## Objective
Make task 005's Red tests pass (Green) by adding `downloadHistoryEnabled` (boolean, default **false**) to the `Settings` schema following the exact pattern used by `cloudSyncEnabled`. OUT of scope: consuming the flag.

## Contract (signatures & types ONLY)
```ts
// In the Settings Schema.Struct:
//   downloadHistoryEnabled: <boolean with default false>   // same idiom as cloudSyncEnabled
```

## BDD Scenarios
```gherkin
Scenario: 005's scenarios pass
  Given downloadHistoryEnabled is added to Settings with default false
  When task 005's tests run
  Then every scenario passes (Green) and no existing settings test regresses
```

## Steps
1. Locate the `cloudSyncEnabled` field in the `Settings` struct in `src/core/schema/index.ts`.
2. Add `downloadHistoryEnabled` with the identical default-false treatment.
3. Update any settings-defaults constant in `src/core/settings/index.ts` if defaults are duplicated there.

## Verification
- `bun run test src/core/settings/settings.test.ts src/core/schema/schema.test.ts` — **passes (Green)**.
- `bun run check` stays green (no regression in existing settings/schema tests).

## Notes
- Do not change unrelated settings. Copy the `cloudSyncEnabled` idiom exactly to stay consistent with the decode/default behaviour.
