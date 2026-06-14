# Task 005 (impl): Background wiring + dedup impl (Green)

- **Type:** impl
- **depends-on:** ["005-test", "001-impl"]
- **Files:** `src/core/download/clear-on-save.ts` (new, pure coordinator); `src/entrypoints/background.ts` (wire it in)

Implement the pure coordinator (passing 005-test), then wire it into `background.ts`'s existing `onChanged` listener and download-start path.

## Contract (signatures only)

```ts
export type ClearMsg = { type: 'clearFromList'; tweetId: string; unlike: true }
export interface ClearOnSaveCoordinator {
  arm(tweetId: string, tabId: number, downloadIds: readonly number[]): void
  onChanged(downloadId: number, outcome: 'complete' | 'failed' | null): (ClearMsg & { tabId: number }) | null
}
export function makeClearOnSaveCoordinator(): ClearOnSaveCoordinator
```

## Behavior contract (spec §2, §3.2)

- `arm` records, per `downloadId`, its `tweetId` + `tabId`, and calls `reduce(arm(tweetId, downloadIds.length))` once per tweet.
- `onChanged(downloadId, outcome)`:
  - dedup: if this `downloadId` already settled, return `null` (the per-`downloadId` guard — spec §3.2).
  - on first `'complete'` → feed `itemComplete`; on first `'failed'` → feed `itemFailed`; `null` → no-op.
  - if `reduce` emits `remove(tweetId)`, return `{ type:'clearFromList', tweetId, unlike:true, tabId }`, else `null`.
- Pure: no chrome APIs inside the coordinator.

## Background wiring (`background.ts`)

- On the download-start path, when the originating tab is on a Likes surface **and** `autoUnlikeOnSave` is on, call `coordinator.arm(tweetId, tabId, downloadIds)` for the tweet's items. (The start path already knows the items/`tweetId` and tab.)
- In the existing `browser.downloads.onChanged` listener, after recording metrics, call `coordinator.onChanged(id, outcomeFromState(delta.state?.current))`; if it returns a message, `browser.tabs.sendMessage(msg.tabId, { type:'clearFromList', tweetId, unlike:true })`.
- Reuse `outcomeFromState()` from `core/download/metrics.ts`.

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

## Verification

- `bun run test src/core/download/clear-on-save.test.ts` — passes (Green).
- `bun run typecheck` — clean.
- `bun run test` — full suite still green (no regression to existing download/metrics tests).
