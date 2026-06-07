# Task 007 — DownloadQueue (test)

**type:** test
**depends-on:** ["005-filename-impl"]

## BDD Scenario

```gherkin
Scenario: Respect the concurrency limit
  Given a queue with concurrency 3 and 10 enqueued MediaItems
  When the queue runs (with a controlled clock)
  Then at most 3 downloads are in-flight at any instant

Scenario: Retry a transient failure with backoff
  Given chrome.downloads fails twice then succeeds for one item
  When the queue processes it
  Then it retries with backoff and ultimately reports success

Scenario: Emit progress updates
  Given items are enqueued
  When each completes
  Then a QueueUpdate event is emitted with completed/total counts

Scenario: Survive a service-worker restart
  Given items were enqueued and their state was persisted to storage
  When the SW is terminated, restarts, and rehydrates
  Then it reconciles against chrome.downloads.search and resumes/recounts correctly
```

## Files

- `src/core/download/queue.test.ts`

## Steps

1. Fake `chrome.downloads` via WXT `fakeBrowser`; control time with `TestClock`
   from the `effect/testing` subpath.
2. Failing tests for concurrency cap (Semaphore), retry/backoff (`Schedule`),
   and progress events.

## Verification

- `bun test src/core/download/queue` — runs and **fails** (red).
