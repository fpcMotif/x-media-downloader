# Task 016: Capture settings + message schema test (Red)

**depends-on**: task-007-record-extraction-impl

## Description
Add a GENUINELY FAILING test that pins down the schema surface for the Capture feature: the three new `Settings` flags must all default to `false` when an empty object is decoded, and the four new capture messages (`CaptureTweets`, `CaptureSummaryRequest`, `ExportCaptureRequest`, `ClearCaptureRequest`) must decode from their tagged shapes and be valid members of the `Message` union. To keep this a true Red task (the assertion must actually fail), the schema additions here are intentionally incomplete: the three `Settings` flags are added as `Schema.optional(Schema.Boolean)` WITHOUT `withDecodingDefaultKey` (so `decode({})` yields `undefined`, not `false`), and the four message `TaggedStruct`s are declared but NOT yet added to the `Message` union. The paired Green task wires in the decoding defaults and union membership. This task only adds these minimal declarations enough for the test to compile and then assert the defaults and decoding behavior; it does not build handlers, DB, or UI.

## Execution Context
**Task Number**: 016 of 30
**Phase**: Integration
**Prerequisites**: The runtime `TweetRecord` Effect Schema is defined and exported from `src/core/capture/record.ts` (task-007). The existing `Settings` struct and `Message` union live in `src/core/schema/index.ts` and use `Schema.withDecodingDefaultKey` for defaulted fields and `Schema.TaggedStruct` for message variants.

## BDD Scenario
```gherkin
Scenario: capture settings default OFF and capture messages decode
  Given the Settings schema
  When decoded from {}
  Then captureEnabled, captureAllScrolled, captureMirrorEnabled all default false
  And a CaptureTweets-tagged object decodes successfully via the Message union
  And CaptureTweets / CaptureSummaryRequest / ExportCaptureRequest / ClearCaptureRequest decode from their tagged shapes and are members of the Message union
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§12)

## Files to Modify/Create
- Create: `src/core/schema/capture-schema.test.ts` (new test file)
- Modify: `src/core/schema/index.ts` — add the three `Settings` boolean flags as `Schema.optional(Schema.Boolean)` WITHOUT `withDecodingDefaultKey` (so `decode({})` yields `undefined`), and declare the four capture `TaggedStruct` messages but do NOT add them to the `Message` union yet (minimal additions so the test compiles, then fails on its assertions). The Green task adds the decoding defaults and union membership.

## Contracts (signatures/types ONLY — no bodies)
```ts
// Import the runtime TweetRecord Effect Schema from the capture module:
import { TweetRecord } from '../capture/record'

// Settings additions for the Red task — Schema.optional WITHOUT withDecodingDefaultKey
// (decode({}) yields undefined for each; the Green task adds withDecodingDefaultKey(Effect.succeed(false))):
//   captureEnabled, captureAllScrolled, captureMirrorEnabled

// Messages (Schema.TaggedStruct) — DECLARED here but NOT yet added to the Message union (Green task adds them):
export const CaptureTweets: Schema.TaggedStruct<
  'CaptureTweets',
  { records: Schema.Array$<typeof TweetRecord> }
>
export const CaptureSummaryRequest: Schema.TaggedStruct<'CaptureSummaryRequest', {}>
export const ExportCaptureRequest: Schema.TaggedStruct<
  'ExportCaptureRequest',
  {
    kind: Schema.Literals<['jsonl', 'tree', 'markdown']>
    conversationId: Schema.optional<typeof Schema.String>
  }
>
export const ClearCaptureRequest: Schema.TaggedStruct<'ClearCaptureRequest', {}>
```

## Steps
1. Verify the scenario maps to a concrete schema surface: read §12 of the spec and confirm the three flag names (`captureEnabled`, `captureAllScrolled`, `captureMirrorEnabled`) and the four message tags + payload shapes, plus that the runtime `TweetRecord` Effect Schema is already exported from `src/core/capture/record.ts` (task-007).
   - Verification: `grep -n "TweetRecord" src/core/capture/record.ts` shows the export; spec §12 lists the same three flags and four messages.
2. In `src/core/schema/index.ts`, import `TweetRecord` from `../capture/record`, add the three `Settings` boolean fields as `Schema.optional(Schema.Boolean)` WITHOUT `withDecodingDefaultKey` (so `decode({})` yields `undefined` for each — intentionally leaving the defaults unwired for the Red), and declare the four capture `TaggedStruct` messages but do NOT add them to the `Message` union yet. Keep these additions minimal — just schema declarations matching the Contracts. (No `throw new Error("not implemented")` stubs are needed here: a schema task has no function bodies; the test asserts decoding behavior directly.)
   - Verification: `bunx tsc --noEmit` (or the project type step) compiles; the four message identifiers and the three settings keys are referenceable from the test import.
3. Create `src/core/schema/capture-schema.test.ts` mapping the Gherkin Given/When/Then: Given the `Settings` schema, When `Schema.decodeUnknownSync(Settings)({})` is run (Result/`Schema` decode per the existing test conventions in `schema.test.ts`), Then assert `captureEnabled`, `captureAllScrolled`, and `captureMirrorEnabled` are each `false` (FAILS now: they decode to `undefined`); And assert that a `CaptureTweets`-tagged raw object (e.g. `{ _tag: 'CaptureTweets', records: [...] }`) decodes successfully via the `Message` union (FAILS now: not yet a union member); And assert each of `CaptureTweets`, `CaptureSummaryRequest`, `ExportCaptureRequest`, `ClearCaptureRequest` decodes from its tagged raw shape and that the same raw shapes decode as members of the `Message` union.
   - Verification: the test file imports `Settings`, `Message`, `CaptureTweets`, `CaptureSummaryRequest`, `ExportCaptureRequest`, `ClearCaptureRequest` from `./index` and contains assertions for all behaviors named in the scenario.
4. Run the suite and confirm it FAILS on an assertion (a defaults/decoding expectation), not on a compile or import error. The expected failures are: the three flags decode to `undefined` instead of `false`, and the `CaptureTweets`-tagged object is rejected by the `Message` union.
   - Verification: `bunx vitest run src/core/schema` reports a failing assertion in the new test (an expected `false` default that is `undefined`, and/or a union decode that does not yet hold), with no TypeScript/import errors.

## Verification Commands
```bash
bunx vitest run src/core/schema   # MUST FAIL (Red)
```

## Success Criteria
- `bunx vitest run src/core/schema` runs the new test and it fails on an assertion tied to the scenario (defaults `false` and/or capture-message union decoding), not on a compile/import error.
- The test asserts every clause of the scenario: the three `Settings` flags default `false` from `{}`, and all four capture messages decode from their tagged shapes and are accepted as `Message` union members.
- No implementation bodies/handler logic are introduced — only schema declarations and the test.
- The full 100% core unit-coverage + build gate stays satisfiable once the paired Green task implements behavior; this Red task intentionally leaves the suite red.
