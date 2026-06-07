# Task 004 — XAdapter (test)

**type:** test
**depends-on:** ["003-resolver-impl"]

## BDD Scenario

```gherkin
Scenario: Detect all media in a single tweet from teed JSON
  Given a captured TweetDetail JSON for a tweet with 3 photos
  When XAdapter.detectMedia runs against it
  Then it returns 3 MediaItems with the tweet's handle and tweetId

Scenario: Fall back to DOM when no JSON is teed
  Given no teed JSON but the DOM has two pbs.twimg.com <img> elements under a tweet article
  When XAdapter.detectMedia runs
  Then it returns 2 photo MediaItems upgraded to orig
```

## Files

- `src/core/adapters/x/xadapter.test.ts`
- `src/test/fixtures/tweet-detail.json`

## Steps

1. Provide a `MediaResolver` test layer.
2. Write failing tests for the JSON path and the DOM-only fallback (use a parsed
   DOM fragment / happy-dom).

## Verification

- `bun test src/core/adapters` — runs and **fails** (red).
