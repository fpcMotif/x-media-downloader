# Task 002 (test): autoUnlikeOnSave schema test (Red)

- **Type:** test
- **depends-on:** []
- **Files:** `src/core/schema/schema.test.ts` (extend existing)

Load the `effect-v4` skill before touching Effect Schema code. Add a failing test asserting the new `autoUnlikeOnSave` settings key decodes to `false` by default and round-trips. Follow the existing decode/encode test patterns already in `schema.test.ts` for booleans like `quickGrabEnabled`.

## Contract under test (added in 002-impl)

```ts
// within Settings = Schema.Struct({ ... })
autoUnlikeOnSave: Schema.Boolean  // default false
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

- Decode `{}` (or a minimal partial settings object) and assert `autoUnlikeOnSave === false`.
- Decode an object with `autoUnlikeOnSave: true` and assert it stays `true`.
- Use the same decode helper the existing schema tests use (Effect Schema decode).

## Verification

- `bun run test src/core/schema/schema.test.ts` — new assertion **fails** (key not yet in schema). Red.
