# Task 005 (config) — SavedStatus messages + showSavedStatus setting

**type**: config
**depends-on**: []
**files**: `src/core/schema/index.ts`, `src/core/schema/schema.test.ts`

Add the message contracts the overlay↔background use and the `showSavedStatus`
setting. Type/contract definitions plus a light decode/default verification (no
behavior logic).

## BDD Scenario

```gherkin
Scenario: SavedStatusRequest/Response round-trip
  Given a SavedStatusRequest carrying tweetIds ["T1","T2"]
  Then it decodes successfully
  And a SavedStatusResponse carrying saved ["T1"] decodes successfully

Scenario: showSavedStatus defaults on
  Given the default Settings
  Then showSavedStatus is true
```

## Steps

- Add tagged message structs (contracts only):
  ```ts
  export const SavedStatusRequest = Schema.TaggedStruct('SavedStatusRequest', {
    tweetIds: Schema.Array(Schema.String),
  })
  export const SavedStatusResponse = Schema.TaggedStruct('SavedStatusResponse', {
    saved: Schema.Array(Schema.String),
  })
  ```
- Add `showSavedStatus: Schema.Boolean` to the `Settings` struct, defaulting to
  `true` wherever Settings defaults are constructed.
- Add decode tests for both messages and a default-value test for `showSavedStatus`
  in `schema.test.ts`.

## Verification

- `bun run test src/core/schema/schema.test.ts` — the new decode + default cases pass.
- `bun run typecheck` — no type errors from the new structs/field.
