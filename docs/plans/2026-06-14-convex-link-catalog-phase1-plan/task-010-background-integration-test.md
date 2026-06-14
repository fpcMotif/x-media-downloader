# Task 010 — Background sync seam (test / Red)

- **type:** test
- **depends-on:** ["005", "009"]
- **files:** `src/core/sync/seam.test.ts` (new)

## Objective

Write failing tests for the sync seam that connects a completed browser download to the queue+flush,
gated by settings and sign-in, and **never altering the existing download/metrics path**. To keep
`background.ts` testable, the seam logic lives in an injectable `src/core/sync/seam.ts` (built in 011);
this task tests it with doubles for settings, queue, client, and sign-in state.

**External-dependency isolation:** all of `browser.downloads`, the queue, the `SyncClient`, and auth
state are test doubles.

## BDD Scenario

```gherkin
Scenario: A completed download is captured and flushed under onDownload
  Given cloudSyncEnabled is true and syncTrigger is "onDownload"
  And the user is signed in
  When a download transitions to complete for an item
  Then the item is enqueued to the local:sync-queue
  And a flush runs that calls syncItems for it

Scenario: With sync off, the download path is never altered
  Given cloudSyncEnabled is false
  When a download transitions to complete
  Then no capture is attempted
  And neither the queue nor the SyncClient is touched

Scenario: Signed-out with sync on does not call the backend
  Given cloudSyncEnabled is true but the user is signed out
  When a download transitions to complete
  Then no syncItems call is made
```

## Steps

1. Build doubles: `getSettings`, `getQueue` (records enqueue/flush), `getClient`, `isSignedIn`.
2. Assert the onDownload + signed-in path enqueues then flushes.
3. Assert sync-off and signed-out paths are inert (no queue/client interaction).

## Verification

- `bun run test src/core/sync` → seam cases **FAIL** (module absent).
