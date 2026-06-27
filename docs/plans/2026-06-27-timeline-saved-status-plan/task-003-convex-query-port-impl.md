# Task 003 (impl) — ConvexPort.query over POST /api/query + caller

**type**: impl
**depends-on**: ["003-test"]
**files**: `src/core/sync/convex.ts`

Make Task 003's tests pass (Green): add a `query()` method symmetric to
`mutation()`, plus a thin `queryDownloadedAmong` caller.

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

Scenario: queryDownloadedAmong shapes the call
  Given a mock ConvexPort whose query resolves ["T1"]
  When queryDownloadedAmong(port, secret, ["T1","T2"]) is called
  Then it invokes path "sync:downloadedAmong" with { secret, tweetIds:["T1","T2"] }
  And resolves to ["T1"]
```

## Steps

- Extend the `ConvexPort` interface. Contract (signatures only — no body logic):
  ```ts
  export interface ConvexPort {
    readonly mutation: (path: string, args: Record<string, unknown>) => Promise<unknown>
    readonly query: (path: string, args: Record<string, unknown>) => Promise<unknown>
  }
  ```
- In `makeConvexHttpPort`, implement `query` against `POST {base}/api/query`, reusing
  the same `bindFetch` detachment (SW "Illegal invocation" footgun) and the same
  envelope handling / error vocabulary (`ConvexHttpError`, `ConvexFunctionError`,
  `ConvexMalformedError`) as `mutation`. Factor the shared request/parse logic so the
  two methods do not drift.
- Add the caller. Contract:
  `export function queryDownloadedAmong(port: ConvexPort, secret: string, tweetIds: string[]): Promise<string[]>`
  — calls `port.query('sync:downloadedAmong', { secret, tweetIds })` and returns the
  decoded `string[]`.

## Verification

- `bun run test src/core/sync/convex.test.ts` — Task 003 cases **pass** (Green).
- Existing `mutation()` cases still pass (shared-helper refactor introduced no regression).
