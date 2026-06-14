# Task 002 (impl): autoUnlikeOnSave schema impl (Green)

- **Type:** impl
- **depends-on:** ["002-test"]
- **Files:** `src/core/schema/index.ts` (extend `Settings` struct)

Load the `effect-v4` skill before editing. Add the `autoUnlikeOnSave` boolean key to the `Settings` struct, default `false`, matching the existing `withDecodingDefaultKey` idiom used by every other boolean key.

## Contract (exact idiom to follow)

```ts
// Add inside Settings = Schema.Struct({ ... }), grouped near the overlay/behavior toggles.
// Un-like a post on the Likes page after all its downloaded media is confirmed saved
// (clear-on-save). Default off — destructive (removes your Like) and silent.
autoUnlikeOnSave: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
```

## BDD Scenario

```gherkin
Scenario: autoUnlikeOnSave defaults to false and round-trips
  Given a settings object with no autoUnlikeOnSave key
  When it is decoded by the Settings schema
  Then autoUnlikeOnSave is false
  And encoding then decoding a settings object with autoUnlikeOnSave true preserves true
```

## Steps (what, not how)

- Add the one key above to `Settings`.
- Do not change any other key; do not reorder existing keys.

## Verification

- `bun run test src/core/schema/schema.test.ts` — 002-test passes (Green).
- `bun run typecheck` — no type errors (the `Settings` type now includes `autoUnlikeOnSave: boolean`).
