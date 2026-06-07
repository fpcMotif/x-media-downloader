# Task 009 — MAIN-world tee (test)

**type:** test
**depends-on:** ["003-resolver-impl"]

## BDD Scenario

```gherkin
Scenario: Capture a GraphQL response without consuming it for the page
  Given the page calls fetch() for a TweetDetail GraphQL URL
  When the patched fetch intercepts it
  Then the page still receives an intact, readable Response
  And a postMessage with the cloned JSON payload is emitted to the content script

Scenario: Ignore non-GraphQL requests
  Given the page fetches a non-x.com analytics URL
  When the patched fetch runs
  Then no postMessage is emitted

Scenario: Issue no network requests of its own
  Given the tee is installed
  When no page request occurs
  Then the tee performs zero fetch/XHR calls itself
```

## Files

- `src/entrypoints/inject/tee.test.ts`

## Steps

1. Unit-test the pure parts: URL-match predicate (GraphQL allowlist) and the
   `Response.clone().json()` → postMessage payload builder, with a stubbed fetch.
2. Assert the original Response body remains readable by the caller.

## Verification

- `bun test src/entrypoints/inject` — runs and **fails** (red).
