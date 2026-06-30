# Task 021: Content-script harvest flush (batch + debounce)

**depends-on**: task-011-harvest-breadth-impl, task-017-schema-wiring-impl

## Description
Wire tweet harvesting into the existing content-script tee listener so that every `xmd:media-response` event runs `harvestTweets` alongside the current `detectFromJson` call, then batches the resulting records and ships them to the background as `CaptureTweets` messages. The producer must batch (not send per-tweet), debounce idle activity, enforce a hard per-message cap, and flush any pending batch when the page is being hidden or unloaded. Capture must be gated on the `captureEnabled` setting, and breadth is governed by the `captureAllScrolled` setting; the content script performs no identity dedup of its own — re-sending the same tweet is intentionally a cheap no-op at the durable merge so that a later rich `TweetDetail` sighting can upgrade an earlier thin one.

## Execution Context
**Task Number**: 021 of 30
**Phase**: Integration
**Prerequisites**: Task 011 (`harvestTweets` breadth rule implemented and returning `TweetRecord[]`) and Task 017 (capture settings/schema wiring — `captureEnabled`, `captureAllScrolled` — and the `CaptureTweets` message type available) are complete and green. Familiarity with the existing `xmd:media-response` listener in `src/entrypoints/overlay.content/index.tsx` and how it currently calls `detectFromJson`.

## BDD Scenario
```gherkin
Scenario: the tee listener harvests and flushes batched records
  Given captureEnabled is on
  When an xmd:media-response event fires
  Then harvestTweets(json, { source from path, includeTextOnly = captureAllScrolled, capturedAt }) runs beside detectFromJson
  And records are batched (debounce ~750ms, hard cap MAX_CAPTURE_BATCH=64 per CaptureTweets message) with NO producer-side identity dedup
  And a pending batch also flushes on pagehide / visibilitychange:hidden
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§7)

## Files to Modify/Create
- Modify: `src/entrypoints/overlay.content/index.tsx` (the existing `xmd:media-response` listener)

## Contracts (signatures/types ONLY — no bodies)
```ts
// const MAX_CAPTURE_BATCH = 64; debounce ~750ms; gate on settings.captureEnabled.
```

## Steps
1. Locate the existing `xmd:media-response` event listener in `src/entrypoints/overlay.content/index.tsx` and the point where it currently parses the response and calls `detectFromJson`. Confirm the parsed `json`, the tee `path`, and access to current settings (`captureEnabled`, `captureAllScrolled`) are reachable at that site.
   - Verification: Reading the listener shows where `detectFromJson(json, ...)` is invoked and that `json` + `path` + settings are in scope for the new call.
2. Inside the listener, gate the new behavior on `settings.captureEnabled`. When enabled, run `harvestTweets(json, { source, includeTextOnly, capturedAt })` beside (not replacing) the existing `detectFromJson` call, where `source` is derived from the tee `path` (`/TweetDetail` → `'tweetDetail'`), `includeTextOnly = settings.captureAllScrolled`, and `capturedAt` is the current timestamp. Append the returned `TweetRecord[]` to a module-level pending buffer with NO identity dedup.
   - Verification: `bun run check` passes; when `captureEnabled` is off no records are buffered and the existing detection path is unchanged.
3. Add the batching/debounce layer: define `MAX_CAPTURE_BATCH = 64` and a ~750ms idle debounce. On each harvest, (a) schedule a debounced flush, and (b) if the pending buffer reaches `MAX_CAPTURE_BATCH`, flush immediately. A flush slices at most `MAX_CAPTURE_BATCH` records into one `browser.runtime.sendMessage(CaptureTweets{ records })` and clears that slice from the buffer; if more remain, continue flushing so no records are dropped.
   - Verification: `bun run check` passes; flush sends batched `CaptureTweets` messages capped at 64 records each, never one message per tweet.
4. Register lifecycle flush hooks: on `pagehide` and on `visibilitychange` when `document.visibilityState === 'hidden'`, synchronously flush any pending batch so in-flight records are not lost on navigation/unload.
   - Verification: `bun run check` passes; a pending (sub-debounce) batch is flushed when the page is hidden or unloaded.
5. Ensure no unbounded per-session `Set` or identity cache is introduced — the only state is the bounded pending buffer plus the debounce timer (§7 cost bound). Confirm the existing `detectFromJson` behavior and overlay detection are untouched.
   - Verification: `bun run check` passes; no new long-lived collections beyond the pending buffer; existing detection unaffected.

## Verification Commands
```bash
bun run check
# Manual: scroll a timeline and open a thread; confirm CaptureTweets messages batch (not per-tweet) and a later TweetDetail upgrades an earlier thin record.
```

## Success Criteria
- With `captureEnabled` on, an `xmd:media-response` event runs `harvestTweets(json, { source from path, includeTextOnly = captureAllScrolled, capturedAt })` beside the existing `detectFromJson` call (scenario Then-1/2).
- Records are batched with a ~750ms idle debounce and a hard cap of `MAX_CAPTURE_BATCH = 64` records per `CaptureTweets` message, with no producer-side identity dedup (scenario And-1).
- A pending batch also flushes on `pagehide` and on `visibilitychange:hidden` (scenario And-2).
- With `captureEnabled` off, no records are buffered or sent and existing detection is unchanged.
- `bun run check` (build/lint/types) passes; this is an ungated content-script integration task (no 100% unit gate), verified additionally by the described manual extension check.
