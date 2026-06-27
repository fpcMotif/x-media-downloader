# Task 017: Capture settings + message schema impl (Green)

**depends-on**: task-016-schema-wiring-test

## Description
CONFIRMED (pair with 016): this Green task COMPLETES the schema. Make the failing schema-wiring test from task 016 pass by adding the three Knowledge Capture toggles to the `Settings` struct and the four capture messages to the `Message` union in `src/core/schema/index.ts`. The settings additions are `captureEnabled` (master), `captureAllScrolled` (breadth), and `captureMirrorEnabled` (Convex mirror) — change each of the three from `Schema.optional(Schema.Boolean)` to `Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)))` so `decode({})` yields `false`. Add the four message `TaggedStruct`s — `CaptureTweets`, `CaptureSummaryRequest`, `ExportCaptureRequest`, and `ClearCaptureRequest` — to the `Message` union, so they decode as valid wire messages. The `CaptureTweets` `records` array references the runtime `TweetRecord` Schema imported from `../capture/record` (ensure this import resolves; Task 007 exports it). No handler logic, no UI, and no body beyond schema/type declarations belongs in this task.

## Execution Context
**Task Number**: 017 of 30
**Phase**: Integration
**Prerequisites**: Task 016 has landed the failing test `src/core/schema/capture-schema.test.ts` (the "capture settings default OFF and capture messages decode" scenario), along with any stub additions it required to compile. The `Settings` and `Message` schemas already exist in `src/core/schema/index.ts` and use the `withDecodingDefaultKey` / `Schema.TaggedStruct` / `Schema.Union` patterns established for the surrounding fields and messages.

## BDD Scenario
```gherkin
Scenario: capture settings default OFF and capture messages decode
  Given the Settings + Message schema additions
  When decoded
  Then defaults are false and all four capture messages are valid union members
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§12)

## Files to Modify/Create
- Modify: src/core/schema/index.ts (Settings fields + the four messages + Message union)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Implement the schema additions described in task 016.
//
// Settings struct — three boolean fields, changed from Schema.optional(Schema.Boolean)
// to Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))) so
// decode({}) yields false:
//   captureEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)))
//   captureAllScrolled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)))
//   captureMirrorEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)))
//
// Four new capture messages (Schema.TaggedStruct), each also added as a member of
// the existing Message union and given an exported `type X = typeof X.Type`:
//   CaptureTweets          — { records: Schema.Array(TweetRecord) }  // TweetRecord imported from '../capture/record' (Task 007)
//   CaptureSummaryRequest  — {}
//   ExportCaptureRequest   — { kind: 'jsonl' | 'tree' | 'markdown', conversationId?: string }
//   ClearCaptureRequest    — {}
```

## Steps
1. Read the failing test added in task 016 (`src/core/schema/capture-schema.test.ts`) and the current `Settings` / `Message` definitions in `src/core/schema/index.ts` to learn the exact field names, message shapes, and union membership the test asserts on.
   - Verification: the test's Given/When/Then maps cleanly onto three boolean settings defaulting to `false` and four tagged messages that must decode as `Message` union members.
2. Change the three boolean fields `captureEnabled`, `captureAllScrolled`, and `captureMirrorEnabled` in the `Settings` struct from `Schema.optional(Schema.Boolean)` to `Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false)))`, matching the surrounding default-false fields, so `decode({})` yields `false`.
   - Verification: `typeof Settings.Type` exposes the three boolean fields; decoding `{}` yields `false` for each.
3. Define the four capture messages as `Schema.TaggedStruct` declarations alongside the existing message schemas (`CaptureTweets` with a `records: Schema.Array(TweetRecord)` field — `TweetRecord` imported from `../capture/record` (Task 007), ensure the import resolves; `CaptureSummaryRequest` and `ClearCaptureRequest` empty; `ExportCaptureRequest` with a `kind` literal of `'jsonl' | 'tree' | 'markdown'` plus an optional `conversationId`), each with its exported `type` alias.
   - Verification: each message schema compiles and exposes a `_tag` literal equal to its name.
4. Add all four message schemas as members of the existing `Message` `Schema.Union` so they participate in wire decoding.
   - Verification: decoding each tagged payload through `Message` succeeds and round-trips its `_tag`.
5. Run the paired test `src/core/schema/capture-schema.test.ts`, confirm it MUST PASS, then run the full unit gate.
   - Verification: the task-016 scenario in `capture-schema.test.ts` is green and the coverage gate stays at 100% over `src/core` + `src/lib`.

## Verification Commands
```bash
bunx vitest run src/core/schema/capture-schema.test.ts
bun run test:coverage
```

## Success Criteria
- The task-016 scenario "capture settings default OFF and capture messages decode" passes: decoding an empty settings object yields `false` for `captureEnabled`, `captureAllScrolled`, and `captureMirrorEnabled`, and all four of `CaptureTweets`, `CaptureSummaryRequest`, `ExportCaptureRequest`, and `ClearCaptureRequest` decode as valid `Message` union members.
- Only `src/core/schema/index.ts` is changed; the additions are schema/type declarations only (no handler logic, UI, or function bodies).
- `bunx vitest run src/core/schema` is green and `bun run test:coverage` passes the 100% gate over `src/core` + `src/lib`.
