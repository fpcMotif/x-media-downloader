# Task 014: Export converters test (Red)

**depends-on**: task-007-record-extraction-impl, task-009-conversation-tree-impl

## Description
Author the failing specification for the capture export converters: given a built `ConversationTree` and the full set of extracted records, the module must serialize the captured conversation into the three AI-ingestion artifacts described by the spec — line-delimited JSONL, pretty nested tree JSON, and a threaded Markdown document — plus a future flat `Row[]` projection seam. This is a Red task: it creates the test that pins down the converter behavior (JSONL field carry-over, depth-indented Markdown with author/timestamp/expanded-text/link-bullets/media-count lines, cross-conversation quote inlining, and empty-input handling) and a stub module so the test compiles but fails on assertions.

## Execution Context
**Task Number**: 014 of 30
**Phase**: Core
**Prerequisites**: Task 007 (record extraction) has shipped `src/core/capture/record.ts` exporting the `TweetRecordShape` type, and Task 009 (conversation tree) has shipped `src/core/capture/tree.ts` exporting the `ConversationTree` type. Both are importable from `src/core/capture/`.

## BDD Scenario
```gherkin
Scenario: records export to JSONL, nested JSON, and threaded Markdown
  Given a built ConversationTree plus the full record set
  When the converters run
  Then toJsonl emits one record per line carrying conversationId + inReplyToTweetId
  And toMarkdown renders depth-indented replies with author, timestamp, expanded text, link bullets and [media: type xN] lines
  And a quotedTweetId is resolved against the full set so the quoted tweet's text is INLINED
  And toTreeJson emits valid nested JSON; empty input is handled
  And toRows returns a minimal Row[] projection — one Row per record with tweetId, conversationId, handle, text and links
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§10)

## Files to Modify/Create
- Create: src/core/capture/export.test.ts
- Create (stubs only): src/core/capture/export.ts

## Contracts (signatures/types ONLY — no bodies)
```ts
import type { TweetRecordShape } from './record'
import type { ConversationTree } from './tree'
export function toJsonl(records: ReadonlyArray<TweetRecordShape>): string
export function toTreeJson(tree: ConversationTree, all: ReadonlyArray<TweetRecordShape>): string
export function toMarkdown(tree: ConversationTree, all: ReadonlyArray<TweetRecordShape>): string
export type Row = { tweetId: string; conversationId: string; handle: string; text: string; links: string }
export function toRows(records: ReadonlyArray<TweetRecordShape>): Row[]   // future Notion/Sheets seam
```

## Steps
1. Verify the scenario and its source. Re-read §10 of the spec to confirm the three converter behaviors (JSONL carries `conversationId` + `inReplyToTweetId`; Markdown is depth-indented with author + timestamp, expanded text, `title — url` link bullets, and `[media: type ×N]` lines; quote inlining resolves `quotedTweetId` against the full record set; `toTreeJson` is valid nested JSON and empty input is handled) and confirm `TweetRecordShape` (from `./record`) and `ConversationTree` (from `./tree`) are the types to import.
   - Verification: the Given/When/Then in the test maps 1:1 to the four `Then`/`And` clauses of the scenario, and the imports resolve to the task-007 and task-009 modules.
2. Create `src/core/capture/export.ts` with the exported type and function STUBS exactly matching the Contracts block above — `Row`, `toJsonl`, `toTreeJson`, `toMarkdown`, `toRows` — each function body being only `throw new Error("not implemented")` so the test compiles and the module type-checks.
   - Verification: `bunx tsc --noEmit` (or the project type-check) reports no errors for `export.ts`; every signature is present and matches the Contracts verbatim.
3. Write `src/core/capture/export.test.ts` mapping Given/When/Then:
   - Given: build a small fixture `ConversationTree` plus a full record set of `TweetRecordShape` values that includes a reply with an `inReplyToTweetId`, a tweet carrying links and media, and a tweet whose `quotedTweetId` points at another record that lives in a different `conversationId`.
   - When/Then (JSONL): assert `toJsonl(records)` yields exactly one line per record (split on `\n`), and that each parsed line carries `conversationId` and `inReplyToTweetId`.
   - When/Then (Markdown): assert `toMarkdown(tree, all)` contains depth-indentation for nested replies, the author handle and timestamp, the expanded text, a link bullet rendered as `title — url`, and a `[media: type ×N]` line.
   - When/Then (quote inlining): assert the quoted tweet's text is INLINED in `toMarkdown` output even though the quoted record is in a different conversation group (resolved via the full `all` set).
   - When/Then (tree JSON + empty): assert `JSON.parse(toTreeJson(tree, all))` succeeds (valid nested JSON) and that an empty-input case (empty tree / empty record set) is handled without throwing.
   - When/Then (rows projection): assert `toRows(records)` returns a minimal `Row[]` projection — exactly one `Row` per input record, each carrying the `tweetId`, `conversationId`, `handle`, `text` and `links` fields — so the gated `toRows` seam has explicit Red coverage and the 100% `src/core` gate is satisfiable.
   - Verification: the assertions reference real fields from `TweetRecordShape` / `ConversationTree`; the test file imports only the Contracts symbols from `./export`.
4. Run the test and confirm it FAILS on an assertion, not on a compile or import error.
   - Verification: `bunx vitest run src/core/capture/export.test.ts` shows the test executing and failing because the stubbed converters threw `not implemented` (or produced no output) at the assertion — not a module-resolution/TypeScript error.

## Verification Commands
```bash
bunx vitest run src/core/capture/export.test.ts   # MUST FAIL (Red)
```

## Success Criteria
- `src/core/capture/export.test.ts` and the stub `src/core/capture/export.ts` exist; the test file imports `toJsonl`, `toTreeJson`, `toMarkdown`, `toRows`, and the `Row` type from `./export`, and the `TweetRecordShape` / `ConversationTree` types from their task-007/task-009 modules.
- The test encodes all four scenario clauses: per-line JSONL with `conversationId` + `inReplyToTweetId`, depth-indented Markdown with author/timestamp/expanded text/link bullets/`[media: type ×N]` lines, cross-conversation `quotedTweetId` inlining, and valid `toTreeJson` plus empty-input handling.
- `bunx vitest run src/core/capture/export.test.ts` FAILS on an assertion (Red), establishing the executable spec the paired Green impl task will satisfy; the module compiles cleanly so the failure is behavioral, keeping the 100% `src/core` unit-coverage gate satisfiable once implemented.
