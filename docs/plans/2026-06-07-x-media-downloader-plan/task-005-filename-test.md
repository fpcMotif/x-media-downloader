# Task 005 — Filename engine (test)

**type:** test
**depends-on:** ["002-schema-impl"]

## BDD Scenario

```gherkin
Scenario: Render a template with all tokens
  Given the template "{handle}/{tweetId}_{index}.{ext}" and a MediaItem
  When the filename engine renders it
  Then it produces "alice/12345_0.jpg"

Scenario: Sanitize filesystem-unsafe characters
  Given a handle containing "../" and a colon
  When rendered
  Then path traversal and illegal characters are stripped/replaced

Scenario: Unknown token is left empty, not crashing
  Given a template containing "{bogus}"
  When rendered
  Then the unknown token resolves to an empty string
```

## Files

- `src/core/download/filename.test.ts`

## Steps

1. Failing tests for token expansion, sanitization (`..`, `/`, `:`, control chars),
   and unknown-token handling.

## Verification

- `bun test src/core/download/filename` — runs and **fails** (red).
