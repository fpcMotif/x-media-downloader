# Task 002 — Schema models (test)

**type:** test
**depends-on:** ["001"]

## BDD Scenario

```gherkin
Scenario: Decode a valid MediaItem
  Given a raw object with id, tweetId, handle, type "photo", url, ext "jpg", index 0
  When it is decoded with the MediaItem schema
  Then decoding succeeds and yields a typed MediaItem

Scenario: Reject an invalid MediaItem
  Given a raw object whose type is "audio" (not photo|video|gif)
  When it is decoded with the MediaItem schema
  Then decoding fails with a SchemaError whose issue points at the type field

Scenario: Settings provides defaults
  Given an empty stored-settings object
  When decoded with the Settings schema using defaults
  Then filenameTemplate, downloadConcurrency, authFallbackEnabled, theme are populated
```

## Files

- `src/core/schema/schema.test.ts`

## Steps

1. Write failing tests asserting `Schema.decodeUnknownResult` (+ `Result.isFailure`)
   / `decodeUnknownSync` success/failure for `MediaItem`, `Settings` (defaults
   filled on decode), and the `Message` tagged union. (v4: no `decodeUnknownEither`;
   failure type is `SchemaError`, not `ParseError`.)
2. Assert `authFallbackEnabled` default is `false` and template default is
   `{handle}/{tweetId}_{index}.{ext}`.

## Verification

- `bun test src/core/schema` — tests run and **fail** (red), module not yet implemented.
