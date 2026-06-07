# Task 006 — SettingsService (impl)

**type:** impl
**depends-on:** ["006-settings-test"]

## Contract

```ts
export class SettingsService extends Effect.Service<SettingsService>()("SettingsService", {
  // get: Effect<Settings>
  // set: (patch: Partial<Settings>) => Effect<Settings>
}) {}
```

## Files

- `src/core/settings/index.ts`

## Steps

1. Read `chrome.storage.local` key `settings`; decode with the `Settings` schema;
   on `ParseError` return defaults.
2. `set` merges a patch, validates, writes, returns the new settings.

## Verification

- `bun test src/core/settings` — all green.
