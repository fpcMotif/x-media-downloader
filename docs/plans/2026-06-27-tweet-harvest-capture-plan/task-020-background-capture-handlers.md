# Task 020: Background capture handlers + dispatcher + export delivery

**depends-on**: task-015-export-converters-impl, task-017-schema-wiring-impl, task-019-capture-db-shell

## Description
Wire the four Knowledge Capture messages into the existing `messageHandlers` table in `src/entrypoints/background.ts`. The `CaptureTweets` handler is the dispatcher that fans incoming records out to the durable `capture-db.putRecords` store (and, when Phase 2 is wired, `capture-outbox.mirrorCaptures`). `CaptureSummaryRequest` returns the panel's live counts and recent conversations from the store. `ExportCaptureRequest` reads records from the store, builds the artifact text with the pure `core/capture/export.ts` converters, and delivers it MV3-safely — a `data:` URL via the `sidecarDataUrl` pattern by default, routing artifacts above the ~2 MB threshold through the offscreen `saveBlob` port — then hands the resulting URL to `chrome.downloads.download`. `ClearCaptureRequest` empties the store. This task is the integration glue only; the converters, schema/message types, and store shell already exist from the dependency tasks.

## Execution Context
**Task Number**: 020 of 30
**Phase**: Integration
**Prerequisites**: Task 015 (pure export converters `toJsonl`/`toTreeJson`/`toMarkdown` implemented and gated), Task 017 (the `Message` union members `CaptureTweets`/`CaptureSummaryRequest`/`ExportCaptureRequest`/`ClearCaptureRequest` and the `Settings` capture flags wired into `core/schema/index.ts`), and Task 019 (the `src/background/capture-db.ts` shell exposing `putRecords`/`allRecords`/`conversation`/`count`/`clear`) are all complete. Background.ts already owns the `messageHandlers` table (background.ts:1007) and the `onMessage` listener that pipes a handler's return value through `sendResponse` (background.ts:1130). The delivery primitives already exist: `sidecarDataUrl` (`core/download/destination.ts:45`) and the offscreen `saveBlob` port (`core/download/fetched-strategy.ts:246`); the `offscreen` permission is already declared in `wxt.config.ts`.

## BDD Scenario
```gherkin
Scenario: background routes capture messages and delivers exports MV3-safely
  Given the messageHandlers table in background.ts
  When CaptureTweets arrives
  Then the dispatcher calls capture-db.putRecords (and capture-outbox.mirrorCaptures when wired in Phase 2)
  And CaptureSummaryRequest returns { tweets, conversations, recent }
  And ExportCaptureRequest builds via the pure converters and downloads via a data: URL (sidecarDataUrl pattern), routing artifacts > ~2MB through the offscreen saveBlob port
  And ClearCaptureRequest clears the store
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§5, §10, §12)

## Files to Modify/Create
- Modify: `src/entrypoints/background.ts` (capture handlers added to the `messageHandlers` table, the `CaptureTweets` dispatcher, and the export-delivery wiring that selects the `data:` URL vs offscreen `saveBlob` path by size threshold)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Handlers wired into the existing messageHandlers table; responses via sendResponse.
// Delivery: data:application/json;charset=utf-8,<encoded> (see core/download/destination.ts sidecarDataUrl); offscreen saveBlob port (core/download/fetched-strategy.ts) for large bulk.

// Handler entries added to `const messageHandlers: MessageHandlers` in background.ts,
// keyed by the `_tag` of each capture message; each returns the response shape declared
// in core/schema/index.ts (Task 017):
//   CaptureTweets        -> { stored: number }
//   CaptureSummaryRequest -> { tweets: number; conversations: number; recent: ConversationSummary[] }
//   ExportCaptureRequest  -> { ok: boolean; filename: string }
//   ClearCaptureRequest   -> { cleared: number }

// Filenames per §10: xharvest-{YYYYMMDD}.jsonl, thread-{conversationId}.json, thread-{conversationId}.md
```

## Steps
1. Confirm the scenario and its dependencies are in place: re-read §5 (the dispatcher fan-out box) and §10/§12 (delivery + message contracts) of the spec, and verify the `Message` union members, the `capture-db` store API (`putRecords`/`allRecords`/`conversation`/`count`/`clear`), and the export converters are all importable from background.ts.
   - Verification: `bun run check` resolves the imports of `capture-db`, the export converters, `sidecarDataUrl`, and the offscreen `saveBlob` port without type errors.
2. Add a `CaptureTweets` entry to the `messageHandlers` table that acts as the dispatcher: it calls `capture-db.putRecords(records)` and returns `{ stored }`. Leave a clearly marked seam (no body, just the call site) where `capture-outbox.mirrorCaptures(...)` will be invoked in Phase 2; do not import or call the outbox yet.
   - Verification: `bun run check` passes; the `CaptureTweets` key type-checks against the `MessageHandlers` map and its return matches the schema's `{ stored }` shape.
3. Add a `CaptureSummaryRequest` handler that loads records via `capture-db.allRecords()`, then computes the `{ tweets, conversations, recent }` response using the pure selectors `summarize()` (returns `{ tweets, conversations }`) and `recentConversations()` from `src/core/capture/store.ts` — `summarize()` alone does NOT return `recent` — returning the shape exactly as the panel consumes it.
   - Verification: `bun run check` passes; the return type matches the schema's summary response.
4. Add an `ExportCaptureRequest` handler that loads records via `capture-db.allRecords()`, branches on `kind` (`'jsonl'` → `toJsonl`, `'tree'` → `toTreeJson`, `'markdown'` → `toMarkdown`, using `conversationId` where required), computes the filename per §10, and produces the delivery URL: a `data:application/json;charset=utf-8,${encodeURIComponent(text)}` URL via the `sidecarDataUrl` pattern when the encoded text is at/below the ~2 MB threshold, otherwise routing the text through the offscreen `saveBlob` port to mint a `blob:` URL. Hand the resulting URL to `chrome.downloads.download` and return `{ ok, filename }`.
   - Verification: `bun run check` passes; both delivery branches type-check and `chrome.downloads.download` receives a URL + filename.
5. Add a `ClearCaptureRequest` handler that calls `capture-db.clear()` and returns `{ cleared }`.
   - Verification: `bun run check` passes; return matches the schema's `{ cleared }` shape.
6. Run the full build/lint/type gate and confirm no regressions to the existing `messageHandlers` table or the `onMessage` dispatch.
   - Verification: `bun run check` is green end to end.

## Verification Commands
```bash
bun run check
# Manual: from the Knowledge Capture panel, click Export all (JSONL) and Export thread; confirm files download with expected contents.
```

## Success Criteria
- The `messageHandlers` table in `src/entrypoints/background.ts` has working entries for all four capture messages, each returning the response shape declared in the schema (Task 017).
- `CaptureTweets` dispatches to `capture-db.putRecords` and carries a marked, unwired seam for the Phase 2 `capture-outbox.mirrorCaptures` fan-out (no premature import).
- `CaptureSummaryRequest` returns `{ tweets, conversations, recent }`; `ClearCaptureRequest` returns `{ cleared }` after emptying the store.
- `ExportCaptureRequest` builds artifacts via the pure converters and delivers via a `data:` URL using the `sidecarDataUrl` pattern, routing artifacts above ~2 MB through the offscreen `saveBlob` port, with `§10` filenames.
- `bun run check` (build/lint/types) is green — this is an ungated shell file (`src/entrypoints/background.ts`), so the 100% unit gate does not apply; correctness is confirmed by `check` plus the manual extension export check above.
