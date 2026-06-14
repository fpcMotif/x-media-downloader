# Task 003 — Cloud-sync settings schema (impl / Green)

- **type:** impl
- **depends-on:** ["002"]
- **files:** `src/core/schema/index.ts` (modify `Settings`)

## Objective

Add the three fields to the `Settings` struct so task 002's tests pass, matching the existing
`Schema.…pipe(Schema.withDecodingDefaultKey(Effect.succeed(...)))` pattern. Off-by-default and
corrupt-recovering by construction.

## Contracts (signatures only — no bodies)

```ts
export const SyncTrigger = Schema.Literals(['onDownload', 'onDemand', 'both'])

// added inside Settings = Schema.Struct({ … }):
//   cloudSyncEnabled: Schema.Boolean      default false
//   syncTrigger:      SyncTrigger          default 'onDownload'
//   cloudConvexUrl:   Schema.String        default ''   (no vendor URL — ADR-0011)
```

## BDD Scenario

```gherkin
Scenario: Cloud sync is off on a fresh install
  Given a user who has never opened settings
  When the extension decodes its settings
  Then cloudSyncEnabled is false
  And syncTrigger defaults to "onDownload"
  And cloudConvexUrl is empty (no vendor default)

Scenario: Corrupt settings recover to safe defaults
  Given a settings blob with an unknown/invalid syncTrigger value
  When settings are decoded
  Then decoding succeeds with cloudSyncEnabled false and syncTrigger "onDownload"
```

## Steps

1. Define `SyncTrigger` literal union.
2. Add `cloudSyncEnabled`, `syncTrigger`, `cloudConvexUrl` to `Settings` with decoding defaults.
3. Export `SyncTrigger` type for reuse by `src/core/sync`.

## Verification

- `bun run test src/core/settings` and `src/core/schema` → **GREEN**.
- `bun run typecheck` passes.
