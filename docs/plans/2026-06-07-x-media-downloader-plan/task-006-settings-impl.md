# Task 006 — SettingsService (impl)

**type:** impl
**depends-on:** ["006-settings-test"]

## Contract

```ts
import { Context, Effect, Layer } from 'effect'
class SettingsService extends Context.Service<SettingsService, {
  readonly get: Effect.Effect<Settings>
  readonly set: (patch: Partial<Settings>) => Effect.Effect<Settings>
}>()('app/SettingsService') {}
export const SettingsServiceLive = Layer.effect(SettingsService, /* ... */)
```

## Files

- `src/core/settings/index.ts`

## Steps

1. Read via WXT `storage.defineItem<Settings>('local:settings', { fallback, version: 1 })`;
   decode with the `Settings` schema; on `SchemaError` return defaults.
2. `set` merges a patch, validates, writes, returns the new settings.
   **Single-writer:** storage read-modify-write is non-atomic, so all writes go
   through the background SW; popup/content observe via `item.watch` /
   `storage.onChanged`.

## Verification

- `bun test src/core/settings` — all green.
