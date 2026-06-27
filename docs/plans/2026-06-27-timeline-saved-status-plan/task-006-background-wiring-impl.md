# Task 006 (impl) — background wiring

**type**: impl
**depends-on**: ["006-test", "003-impl"]
**files**: `src/background/saved-status.ts` (new), `src/entrypoints/background.ts`

Make Task 006's tests pass (Green) and wire the coordinator into the SW: seed from
local history, mark on completion, and answer `SavedStatusRequest` messages.

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

- Implement the coordinator. Contract (signatures only):
  ```ts
  export interface SavedStatusCoordinator {
    readonly handle: (req: SavedStatusRequest) => Promise<SavedStatusResponse>
    readonly onCompleted: (tweetId: string) => void
  }
  export function makeSavedStatusCoordinator(deps: {
    index: SavedIndex
    queryConvex: QueryConvex
  }): SavedStatusCoordinator
  ```
- In `background.ts`: build a `SavedIndex`, `seed()` it from the local download-history
  store on boot, bind `queryConvex` to `queryDownloadedAmong(port, secret, …)` when
  sync is configured (else a no-op resolving `[]`), call `onCompleted(tweetId)` from
  the existing completed-download path, and route `SavedStatusRequest` messages to
  `handle`.
- Keep `background.ts` edits minimal — the testable logic lives in `saved-status.ts`.

## Verification

- `bun run test src/background/saved-status.test.ts` — Task 006 cases **pass** (Green).
- `bun run typecheck` — background wiring type-checks.
