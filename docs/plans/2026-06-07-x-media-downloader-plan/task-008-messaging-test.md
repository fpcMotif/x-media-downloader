# Task 008 — Messaging (test)

**type:** test
**depends-on:** ["002-schema-impl"]

## BDD Scenario

```gherkin
Scenario: Round-trip a typed request/response
  Given a DownloadRequest message sent from content to background
  When the background handler replies with a QueueUpdate
  Then the content side receives a schema-valid QueueUpdate

Scenario: Reject a malformed message
  Given an incoming message that fails Message schema decoding
  When the dispatcher handles it
  Then it is rejected and does not invoke any handler
```

## Files

- `src/core/messaging/messaging.test.ts`

## Steps

1. Fake the runtime messaging channel via `fakeBrowser`.
2. Failing tests for typed round-trip and malformed-message rejection.

## Verification

- `bun test src/core/messaging` — runs and **fails** (red).
