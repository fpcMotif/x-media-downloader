# Task 003 (test) — ConvexPort.query + queryDownloadedAmong

**type**: test
**depends-on**: []
**files**: `src/core/sync/convex.test.ts`

Write failing tests (Red) for a new `query()` method on `ConvexPort` and a
`queryDownloadedAmong` caller. All network is isolated via a fetch mock (mirror the
existing `mutation()` cases in `convex.test.ts`).

## BDD Scenario

```gherkin
Scenario: Successful query returns the value
  Given the deployment answers 200 {status:'success', value:["T1"]}
  When port.query("sync:downloadedAmong", args) is called
  Then it resolves to ["T1"]

Scenario: Non-2xx maps to ConvexHttpError
  Given the edge answers HTTP 500
  When port.query is called
  Then it throws ConvexHttpError with status 500

Scenario: Function error maps to ConvexFunctionError
  Given the deployment answers 200 {status:'error', errorMessage:"unauthorized…"}
  When port.query is called
  Then it throws ConvexFunctionError carrying that message

Scenario: Non-Convex 200 maps to ConvexMalformedError
  Given a 200 whose body is an HTML page
  When port.query is called
  Then it throws ConvexMalformedError

Scenario: queryDownloadedAmong shapes the call
  Given a mock ConvexPort whose query resolves ["T1"]
  When queryDownloadedAmong(port, secret, ["T1","T2"]) is called
  Then it invokes path "sync:downloadedAmong" with { secret, tweetIds:["T1","T2"] }
  And resolves to ["T1"]
```

## Steps

- Add `query()` cases mirroring the existing `mutation()` tests: success, non-2xx
  → `ConvexHttpError`, `{status:'error'}` → `ConvexFunctionError`, HTML body →
  `ConvexMalformedError`. Assert the request targets `POST {base}/api/query` with a
  `{path, args, format:'json'}` body.
- Add a `queryDownloadedAmong` test using a stub `ConvexPort` (no real fetch):
  assert it calls `port.query` with path `"sync:downloadedAmong"` and args
  `{ secret, tweetIds }`, and returns the value.
- Use the same injected-`fetch` mock approach as the existing file.

## Verification

- `bun run test src/core/sync/convex.test.ts` — the new cases **fail** (Red).
