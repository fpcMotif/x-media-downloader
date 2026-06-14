# Task 005 (test): Background wiring + dedup test (Red)

- **Type:** test
- **depends-on:** []
- **Files:** `src/core/download/clear-on-save.test.ts` (new) — exercises a pure background coordinator extracted for testability

Rather than test `background.ts` directly (hard to isolate the SW), test a pure coordinator module that the background delegates to. It owns the `downloadId → {tweetId, tabId}` map, per-`downloadId` dedup, and the `removal` tracker, and returns the messages to send. **Isolate all chrome APIs behind the injected port/callback** (no real `chrome.downloads`).

## Contract under test (implemented in 005-impl)

```ts
export type ClearMsg = { type: 'clearFromList'; tweetId: string; unlike: true }
export interface ClearOnSaveCoordinator {
  arm(tweetId: string, tabId: number, downloadIds: readonly number[]): void
  onChanged(downloadId: number, outcome: 'complete' | 'failed' | null): ClearMsg & { tabId: number } | null
}
export function makeClearOnSaveCoordinator(): ClearOnSaveCoordinator
```

## BDD Scenario

```gherkin
Scenario: Duplicate onChanged complete for one downloadId is counted once
  Given a tweet "t1" armed with total 2 and two downloadIds d1,d2 on tab 42
  When onChanged fires complete for d1 twice and complete for d2 once
  Then the tracker receives exactly one itemComplete per downloadId
  And exactly one clearFromList(t1) message is produced

Scenario: All items complete sends clearFromList to the originating tab
  Given a tweet "t1" downloaded from tab 42, total 1
  When its item confirms complete
  Then onChanged returns { type:'clearFromList', tweetId:'t1', unlike:true, tabId:42 }

Scenario: An interrupted item prevents clearFromList
  Given a tweet "t1" armed with total 2
  When one item completes and the other is interrupted (outcome 'failed')
  Then no clearFromList message is produced for t1
```

## Steps (what, not how)

- Drive the coordinator with `arm` then a sequence of `onChanged` calls; assert the returned messages (and that `null` outcomes and duplicates produce no extra messages).
- Assert the duplicate-`complete` for the same `downloadId` does not advance the tally twice (the fire stays single).

## Verification

- `bun run test src/core/download/clear-on-save.test.ts` — tests exist and **fail**. Red.
