# Task 006 (test) — background seed + markSaved + request handler

**type**: test
**depends-on**: ["004-impl", "005"]
**files**: `src/background/saved-status.test.ts` (new background unit, fakeBrowser)

Write failing tests (Red) for the background-side wiring that bridges messages to
the `SavedIndex`. Test the extracted handler logic in isolation (inject a
`SavedIndex` and a `queryConvex`); do not require a live SW. Mirror the existing
background unit-test setup (`fakeBrowser`, per `clear-coordinator.test.ts`).

## BDD Scenario

```gherkin
Scenario: Handler resolves via SavedIndex
  Given a background with a SavedIndex seeded with ["T1"]
  When a SavedStatusRequest({ tweetIds:["T1","T2"] }) message arrives and queryConvex returns []
  Then it replies SavedStatusResponse({ saved:["T1"] })

Scenario: A local completion marks the index
  Given the background download pipeline
  When a download for tweetId "T7" reaches completed
  Then SavedIndex.markSaved("T7") is invoked

Scenario: Sync-off runs C-only
  Given Convex sync is not configured
  When a SavedStatusRequest arrives
  Then resolve runs with a no-op queryConvex (returns []) and answers from local history only
```

## Steps

- Extract the wiring as a pure-ish unit, e.g. `makeSavedStatusCoordinator({ index, queryConvex })`
  with a `handle(request): Promise<SavedStatusResponse>` and an `onCompleted(tweetId)` hook,
  so it can be tested without the SW message bus.
- Assert `handle` delegates to `index.resolve` and shapes a `SavedStatusResponse`.
- Assert `onCompleted("T7")` calls `index.markSaved("T7")`.
- Assert that when sync is unconfigured the coordinator is built with a no-op
  `queryConvex` (resolves `[]`), so resolution is local-only.

## Verification

- `bun run test src/background/saved-status.test.ts` — the new cases **fail** (Red).
