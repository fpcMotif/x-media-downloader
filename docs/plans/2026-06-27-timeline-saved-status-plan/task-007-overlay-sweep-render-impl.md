# Task 007 (impl) — overlay status sweep + Saved ✓ chip

**type**: impl
**depends-on**: ["007-test", "005"]
**files**: `src/entrypoints/overlay.content/handlers.ts`, `src/entrypoints/overlay.content/index.tsx`, `src/entrypoints/overlay.content/style.css`

> Depends on `005`: the overlay's `requestSavedStatus` sends a `SavedStatusRequest`
> and awaits a `SavedStatusResponse` — both message structs are defined in 005.

Make Task 007's tests pass (Green) and wire the sweep to the overlay lifecycle.

## BDD Scenario

```gherkin
Scenario: A saved post gets one chip
  Given a timeline with articles for T1 and T2, and the background replies saved:["T1"]
  When the status sweep runs
  Then T1's article carries exactly one "Saved ✓" chip
  And T2's article carries none

Scenario: Injection is idempotent
  Given T1's article already carries a chip
  When the sweep runs again
  Then T1's article still carries exactly one chip

Scenario: Out-of-scope pages are skipped
  Given the current page is a profile (not For You / Following / List)
  When the overlay mounts
  Then no sweep runs and no chip is injected

Scenario: No data means no chip (fail-safe)
  Given the background replies saved:[]
  When the sweep runs
  Then no article is marked
```

## Steps

- Add a `sweepSavedStatus` to `handlers.ts`. Contract (signatures only):
  ```ts
  function sweepSavedStatus(deps: {
    document: Document
    inScope: () => boolean
    requestSavedStatus: (tweetIds: string[]) => Promise<string[]>
  }): Promise<void>
  ```
  Behavior (described): bail if `!inScope()`; enumerate `TWEET_ARTICLE_SEL`, map to
  `tweetId` via `tweetIdOfArticle`, de-dupe (reuse the existing sweep pattern at
  `handlers.ts:210`); request status; inject an idempotent chip (mark the node, e.g.
  a `data-` attribute, so re-sweeps never double-inject) onto saved articles only.
- In `index.tsx`: debounce and call `sweepSavedStatus` on mount and from the existing
  scroll/observer machinery; `requestSavedStatus` sends a `SavedStatusRequest` and
  awaits the `SavedStatusResponse`. Gate on in-scope timelines (For You / Following /
  List) using existing page-scope detection.
- In `style.css`: add the "Saved ✓" chip styles using existing overlay/brand tokens.

## Verification

- `bun run test src/entrypoints/overlay.content/handlers.test.ts` — Task 007 cases **pass**.
- `bun run typecheck` — overlay wiring type-checks.
