# Task 007 (test) — overlay sweep + Saved chip render

**type**: test
**depends-on**: ["005"]
**files**: `src/entrypoints/overlay.content/handlers.test.ts`

Write failing tests (Red) for the status sweep and chip render using happy-dom.
Inject a fake `document` (timeline articles) and a stub `requestSavedStatus` so no
real background/message bus is needed.

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

- Build a happy-dom document with two articles whose `tweetIdOfArticle` yields T1/T2
  (reuse the test helpers used by existing `handlers.test.ts`).
- Drive the sweep with a stub `requestSavedStatus(tweetIds) => Promise<string[]>`.
- Assert chip count per article (exactly one on saved, zero otherwise), idempotency
  on a second sweep, scope gating (no chip on a profile-scope document), and the
  empty-reply fail-safe.

## Verification

- `bun run test src/entrypoints/overlay.content/handlers.test.ts` — new cases **fail** (Red).
