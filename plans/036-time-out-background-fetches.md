# Plan 036: Give every background fetch a timeout and unblock the Backfill reply

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/kernel/fetch.ts src/packages/cloud/cloud-services.ts src/packages/cloud/lib/source-fetch.ts src/background/cloud-upload.ts src/background/cloud-upload.test.ts src/entrypoints/background.ts`
> The command compares the working tree with the planning commit, so
> uncommitted changes show. `cloud-upload.ts`, `cloud-upload.test.ts`, and
> `background.ts` had uncommitted changes when this plan was written. Locate
> edits in those files by the quoted text, not by line number. A quoted line
> that you cannot find is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none. Plans 037 and 039 depend on this plan.
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17 (working tree had uncommitted changes)
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/110

## Why this matters

No `fetch` in the service worker has a timeout. A provider, a media host, or a
Convex deployment that accepts a connection and then goes silent hangs the
call forever. The upload queue is serial, so one hung upload stops every later
upload. The job's lease then expires, the next wake reclaims it, and the hung
request still holds its memory. The Backfill button has a second problem: its
reply waits on the same serial queue as the drain, so the popup can wait for
many minutes. After this plan every outbound request has a bound, a stalled
body is cut off, and Backfill replies at once.

## Current state

Files:

- `src/packages/kernel/fetch.ts` — `bindFetch`, the one rule for calling an
  injected `fetch` in the service worker.
- `src/packages/kernel/fetch-service.ts` — the Effect `FetchService`. No
  timeout.
- `src/packages/cloud/cloud-services.ts` — builds the cloud service layer.
- `src/packages/cloud/lib/source-fetch.ts` — the guarded media fetch.
- `src/background/cloud-upload.ts` — upload module. Passes `fetchImpl` to the
  runtime, to `makeRemoteUpload`, and to `revokeViaRecipe`.
- `src/entrypoints/background.ts` — service-worker entry. Hands the global
  `fetch` to each module.
- `src/packages/kernel/tests/fetch.test.ts` — test pattern, including the
  non-arrow brand-check stub.

`src/packages/kernel/fetch.ts:16`:

```ts
export const bindFetch = (fetchImpl: typeof fetch): typeof fetch => fetchImpl.bind(globalThis)
```

`src/packages/cloud/cloud-services.ts:18-19`:

```ts
export const makeCloudServicesLive = (fetchImpl: typeof fetch): Layer.Layer<CloudServices> =>
  Layer.mergeAll(makeFetchServiceLive(fetchImpl), makeSourceFetchLive(fetchImpl), FolderCacheLive)
```

`src/packages/cloud/lib/source-fetch.ts:20`:

```ts
        try: () => guardedFetch(url, {}, fetchImpl),
```

Fetch sites in `src/entrypoints/background.ts` (find each by its text):

```ts
const syncOutbox = makeSyncOutbox({ queueError, fetchImpl: fetch })
    const res = await fetch(url.value)
      Effect.provide(makeFetchServiceLive(fetch)),
const headFetch = bindFetch(fetch)
const captureOutbox = makeCaptureOutbox()
```

The second line is inside `recoverSyndicationBody`. The third is inside
`queryConvexSaved`. A second `makeFetchServiceLive(fetch)` exists for the
aria2 RPC. That one and `makeFetchPort(fetch)` are out of scope.

In `src/background/cloud-upload.ts`, `makeRemoteUpload({` receives
`fetchImpl,` and `revokeViaRecipe(` receives `fetchImpl,` as its last
argument.

The Backfill enqueue in `backfillCloudUploads` (`cloud-upload.ts`):

```ts
    const queued = await uploadQueue
      .run(async () => {
        const now = nowFn()
        let added = 0
        await updateLedger((current) => {
          let next = current
          const before = current.length
          for (const r of records) {
            const target = cloudTargetFor(r.media, r.filename)
            for (const p of providers) {
              next = enqueue(
                next,
                { mediaId: r.requestId, provider: p, url: r.media.url, target },
                now,
              )
            }
          }
          added = next.length - before
          return next
        })
        return added
      })
      .catch(() => 0)
    uploadQueue.push(() => drainUploadJobs()) // drain in the background; don't block the reply
```

`uploadQueue.run` waits behind a running drain. A drain handles up to 1000
jobs per pass. `updateLedger` already serializes on its own `storeQueue` and
is an atomic read-modify-write, and `enqueue` is a no-op for a job that is
`uploading`. The outer `uploadQueue.run` is therefore not needed for safety.

Correction to the original audit finding: the reconcile calls are not blocked
in a way the user sees. Their callers are fire-and-forget, and
`cloudUploadStatus` calls `remote.reconcile()` directly. Leave reconcile on
the queue.

Binding decisions:

- ADR-0017: `FetchService` is bound once, `fetchPromise` serves the chunker
  sink, and the runtime is built once per service-worker life. Wrap the
  injected `fetch` before it reaches the layer. Do not add a second runtime.
- ADR-0013: the source fetch is "the one sanctioned media-byte egress" and
  goes through `guardedFetch`. Keep that call. Wrap only the `fetchImpl` that
  is passed into it.
- ADR-0009 (cited in `fetch.ts`): every injected `fetch` must be detached
  with `bindFetch` before a property call.

Platform facts used:

- `AbortSignal.timeout(ms)` and `AbortSignal.any([...])` exist in Chrome 116
  and later. Check `minimum_chrome_version` in `wxt.config.ts`. If it is set
  below 116, STOP.
- A signal passed to `fetch` also aborts reading of the response body.

Repo rules (root `AGENTS.md`): no `oxlint-disable`, `eslint-disable`,
`@ts-ignore`, or `@ts-expect-error`. No new `as` casts. Name numeric
constants.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Format check | `bun run fmt:check` | exit 0 |
| Boundaries | `bun run lint:boundaries` | exit 0 |
| Focused tests | `bun run test <path>` | all pass |
| Full gate | `bun run check` | exit 0 |
| Build | `bun run build` | exit 0 |

If the format check fails, run `bunx oxfmt --write <files you changed>`.
Package manager is bun. Never use npm or npx.

## Scope

**In scope** (the only files you may modify):

- `src/packages/kernel/fetch-timeout.ts` (create)
- `src/packages/kernel/tests/fetch-timeout.test.ts` (create)
- `src/packages/cloud/cloud-services.ts`
- `src/background/cloud-upload.ts`
- `src/background/cloud-upload.test.ts`
- `src/entrypoints/background.ts`

**Out of scope** (do NOT touch):

- `src/packages/kernel/fetch-service.ts`, `src/packages/sync/url-guard.ts`,
  `src/packages/kernel/source-policy.ts`. The wrappers go around the injected
  `fetch`, so these files need no edit.
- `src/packages/cloud/lib/chunk.ts`. Plan 015 finished it.
- The aria2 `makeFetchServiceLive(fetch)` site and `makeFetchPort(fetch)`.
- `MAX_DRAIN_JOBS_PER_PASS`. Tests rely on one drain call finishing the work.
- `reconcileCloudOnlyHistory`. Plan 038 owns it.
- `backend/`. Convex actions have their own limits.
- Every Markdown file except the `plans/README.md` status row.

## Git workflow

- Branch: `advisor/036-time-out-background-fetches`.
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
- The working tree has uncommitted changes that are not yours. Never revert
  them and never stash them. Before you start, run `git status --short` on
  each in-scope path. If a file already shows changes, make your edits but do
  not commit that file. Report it as edited and uncommitted. Stage only by
  explicit path.
- Do NOT push. Do NOT open a PR.

## Comment rule

A `doc-lock` hook can block edits that add or change comments or Markdown.
Write no new comments. Keep every existing comment as written, even the
comment above the Backfill enqueue that this plan makes stale. Report stale
comments in your reply. If the hook rejects an edit, STOP and report the
rejection text.

## Steps

### Step 1: Write the timeout tests

Create `src/packages/kernel/tests/fetch-timeout.test.ts`. Model it on
`src/packages/kernel/tests/fetch.test.ts`. Use real timers with small values
(20 to 50 ms). Do not use fake timers: `AbortSignal.timeout` does not follow
them.

Helper for a fetch that honors its signal and never answers:

```ts
const never: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
  })
```

Cases for `withTotalTimeout`:

1. `withTotalTimeout(never, 20)('https://x.test')` rejects.
2. A fetch that resolves at once passes its `Response` through unchanged.
3. A caller signal that aborts before the timeout still rejects the call.
4. A non-arrow stub that throws when `this !== globalThis` does not throw.
   Copy the brand-check stub from `fetch.test.ts`.

Cases for `withStallTimeout(fetchImpl, headersMs, idleMs)`:

5. `withStallTimeout(never, 20, 20)('https://x.test')` rejects.
6. A response whose body sends one chunk and then nothing: reading the body
   with `response.arrayBuffer()` rejects.
7. A response whose body sends five chunks 10 ms apart with `idleMs` 30:
   `arrayBuffer()` resolves with all bytes. Total time is longer than
   `idleMs`, so this proves the timer is per chunk.
8. A response with a `null` body (`new Response(null, { status: 204 })`) is
   returned as the same object.
9. Status and headers of a wrapped response equal those of the original.

Build the bodies with `new ReadableStream<Uint8Array>({ start(controller) { ... } })`
and `setTimeout`.

**Verify**: `bun run test src/packages/kernel/tests/fetch-timeout.test.ts` →
fails because the module does not exist.

### Step 2: Create the wrappers

Create `src/packages/kernel/fetch-timeout.ts`:

```ts
import { bindFetch } from './fetch'

const joined = (caller: AbortSignal | null | undefined, own: AbortSignal): AbortSignal =>
  caller ? AbortSignal.any([caller, own]) : own

export const withTotalTimeout = (fetchImpl: typeof fetch, timeoutMs: number): typeof fetch => {
  const bound = bindFetch(fetchImpl)
  return (input, init) =>
    bound(input, { ...init, signal: joined(init?.signal, AbortSignal.timeout(timeoutMs)) })
}

const timeoutError = (what: string): DOMException => new DOMException(what, 'TimeoutError')

export const withStallTimeout = (
  fetchImpl: typeof fetch,
  headersMs: number,
  idleMs: number,
): typeof fetch => {
  const bound = bindFetch(fetchImpl)
  return async (input, init) => {
    const controller = new AbortController()
    const headerTimer = setTimeout(
      () => controller.abort(timeoutError('response headers timed out')),
      headersMs,
    )
    let response: Response
    try {
      response = await bound(input, { ...init, signal: joined(init?.signal, controller.signal) })
    } finally {
      clearTimeout(headerTimer)
    }
    const body = response.body
    if (body === null) return response
    const reader = body.getReader()
    const guarded = new ReadableStream<Uint8Array>({
      async pull(sink) {
        let idleTimer: ReturnType<typeof setTimeout> | undefined
        const stalled = new Promise<never>((_resolve, reject) => {
          idleTimer = setTimeout(() => reject(timeoutError('response body stalled')), idleMs)
        })
        try {
          const step = await Promise.race([reader.read(), stalled])
          if (step.done) sink.close()
          else sink.enqueue(step.value)
        } catch (error) {
          controller.abort(error)
          sink.error(error)
        } finally {
          clearTimeout(idleTimer)
        }
      },
      cancel(reason) {
        controller.abort(reason)
        return reader.cancel(reason)
      },
    })
    return new Response(guarded, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}
```

The early return for a `null` body also covers a redirect answer under
`redirect: 'manual'`, which has no body.

The rebuilt `Response` has an empty `url`. Run
`rg -n "res\.url|response\.url" src/packages/sync/url-guard.ts src/packages/kernel/source-policy.ts src/packages/cloud/lib/source.ts`.
If any of these files reads the response URL, STOP.

If the type checker rejects the returned function as `typeof fetch`, do not
add a cast. STOP and report the error text.

**Verify**: `bun run test src/packages/kernel/tests/fetch-timeout.test.ts` →
9 pass. `bun run typecheck` and `bun run lint` → exit 0.

### Step 3: Apply timeouts to the cloud byte path

In `src/packages/cloud/cloud-services.ts`, add constants and wrap:

```ts
const PROVIDER_FETCH_TIMEOUT_MS = 300_000
const SOURCE_HEADERS_TIMEOUT_MS = 30_000
const SOURCE_IDLE_TIMEOUT_MS = 60_000

export const makeCloudServicesLive = (fetchImpl: typeof fetch): Layer.Layer<CloudServices> =>
  Layer.mergeAll(
    makeFetchServiceLive(withTotalTimeout(fetchImpl, PROVIDER_FETCH_TIMEOUT_MS)),
    makeSourceFetchLive(
      withStallTimeout(fetchImpl, SOURCE_HEADERS_TIMEOUT_MS, SOURCE_IDLE_TIMEOUT_MS),
    ),
    FolderCacheLive,
  )
```

Import both wrappers from `@/packages/kernel/fetch-timeout`.

The provider budget covers one request. The largest request is one 8 MiB
chunk. 300 s allows an uplink as slow as about 224 kbit/s. The source fetch
gets no total limit, because a large video may take long. It gets a header
limit and a per-chunk idle limit.

**Verify**: `bun run test src/packages/cloud` → all pass.
`bun run lint:boundaries` → exit 0.

### Step 4: Apply timeouts to control calls in the upload module

In `src/background/cloud-upload.ts`, inside `makeCloudUpload` after
`const { getSettings, fetchImpl } = deps`, add:

```ts
  const controlFetch = withTotalTimeout(fetchImpl, CONTROL_FETCH_TIMEOUT_MS)
```

Add `const CONTROL_FETCH_TIMEOUT_MS = 60_000` beside
`MAX_DRAIN_JOBS_PER_PASS`. Then pass `fetchImpl: controlFetch,` to
`makeRemoteUpload({` and pass `controlFetch` in place of `fetchImpl` to
`revokeViaRecipe(`. Leave `defaultRuntimePort(fetchImpl)` as it is. Step 3
already covers the runtime.

**Verify**: `bun run typecheck` → exit 0.
`bun run test src/background/cloud-upload.test.ts src/background/remote-upload.test.ts`
→ all pass.

### Step 5: Apply timeouts in the service-worker entry

In `src/entrypoints/background.ts`, add near the other module-level
constants:

```ts
const CONVEX_FETCH_TIMEOUT_MS = 60_000
const SYNDICATION_FETCH_TIMEOUT_MS = 15_000
const SIZE_PROBE_TIMEOUT_MS = 5_000
const convexFetch = withTotalTimeout(fetch, CONVEX_FETCH_TIMEOUT_MS)
const syndicationFetch = withTotalTimeout(fetch, SYNDICATION_FETCH_TIMEOUT_MS)
```

Then make these five replacements:

| Find | Replace with |
| --- | --- |
| `makeSyncOutbox({ queueError, fetchImpl: fetch })` | `makeSyncOutbox({ queueError, fetchImpl: convexFetch })` |
| `await fetch(url.value)` in `recoverSyndicationBody` | `await syndicationFetch(url.value)` |
| `Effect.provide(makeFetchServiceLive(fetch)),` in `queryConvexSaved` | `Effect.provide(makeFetchServiceLive(convexFetch)),` |
| `const headFetch = bindFetch(fetch)` | `const headFetch = withTotalTimeout(fetch, SIZE_PROBE_TIMEOUT_MS)` |
| `makeCaptureOutbox()` | `makeCaptureOutbox({ fetchImpl: convexFetch })` |

`makeCaptureOutbox` takes an optional `fetchImpl` (see
`src/background/capture-outbox.ts:49`). If its parameter shape does not
accept `{ fetchImpl }`, STOP. After the fourth replacement, run
`rg -n "bindFetch" src/entrypoints/background.ts`. If `bindFetch` has no
remaining use, remove it from the import. Leave the `makeCloudUpload({`
argument `fetchImpl: fetch,` unchanged.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -n "await fetch\(" src/entrypoints/background.ts` → no matches.

### Step 6: Take the Backfill enqueue off the drain queue

Test first, in `src/background/cloud-upload.test.ts`, modeled on the backfill
tests near lines 846-904:

- Name: "backfill replies while a drain is in flight".
- Arrange: one pending job, and a fake runtime whose upload returns a promise
  that the test resolves later. Start the drain with the module's public
  entry that existing tests use, and wait until the upload was called.
- Act: call `backfillCloudUploads()` with one history record. Race it against
  a 200 ms timer that resolves to the string `'blocked'`.
- Assert: the race result is the reply object with `ok: true` and
  `queued: 1`.
- Cleanup: resolve the held upload and flush.

**Verify**: the test FAILS with `'blocked'` before the source edit.

Then replace the quoted `const queued = await uploadQueue.run(...)` block in
`backfillCloudUploads` with:

```ts
    const now = nowFn()
    let added = 0
    const queued = await updateLedger((current) => {
      let next = current
      for (const r of records) {
        const target = cloudTargetFor(r.media, r.filename)
        for (const p of providers) {
          next = enqueue(
            next,
            { mediaId: r.requestId, provider: p, url: r.media.url, target },
            now,
          )
        }
      }
      added = next.length - current.length
      return next
    })
      .then(() => added)
      .catch(() => 0)
```

Keep the following `uploadQueue.push(() => drainUploadJobs())` line. If plan
035 already added a skip for remembered keys inside the inner loop, keep that
skip.

**Verify**: `bun run test src/background/cloud-upload.test.ts` → all pass.

### Step 7: Full gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

- `src/packages/kernel/tests/fetch-timeout.test.ts`: nine cases from Step 1.
  Pattern: `src/packages/kernel/tests/fetch.test.ts`.
- `src/background/cloud-upload.test.ts`: the Backfill case from Step 6.
- Each new test must be seen failing before its source edit.
- Not covered by tests: the five wiring edits in `background.ts`. The grep in
  Step 5 and the typecheck cover them.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "await fetch\(" src/entrypoints/background.ts` returns no matches
- [ ] `rg -n "withTotalTimeout|withStallTimeout" src --glob '!*.test.ts'` shows uses in `cloud-services.ts`, `cloud-upload.ts`, and `background.ts`
- [ ] `rg -n "uploadQueue\s*\.run" src/background/cloud-upload.ts` no longer matches inside `backfillCloudUploads`
- [ ] The ten new tests exist and pass
- [ ] `git status --short` shows only in-scope files as newly changed
- [ ] `plans/README.md` status row updated, or the status reported in the reply

## STOP conditions

Stop and report if:

- A quoted line in "Current state" cannot be found in the live file.
- `minimum_chrome_version` is below 116, or the test runtime lacks
  `AbortSignal.any`.
- The returned wrapper is not assignable to `typeof fetch` without a cast.
- Any guarded-fetch file reads `Response.url`.
- An existing cloud or sync test starts to fail with a timeout error. That
  means a test stub depends on a request that never settles.
- A verification fails twice after one reasonable fix.
- The fix appears to need a file outside the in-scope list.

## Maintenance notes

- The constants are estimates from reading the code. Nothing was measured. A
  user on an uplink slower than about 224 kbit/s will see provider timeouts on
  8 MiB chunks. Raise `PROVIDER_FETCH_TIMEOUT_MS` or lower the chunk size if
  that is reported.
- A timeout surfaces as an ordinary upload failure and consumes one attempt.
  Plan 039 decides which failures are transient.
- A new fetch site must take one of the two wrappers. Reviewers should search
  for a bare `fetch` in `src/entrypoints/background.ts`.
- Plans 013, 018, 019, and 022 also edit `src/entrypoints/background.ts`.
  Plans 019 and 035 also edit `src/background/cloud-upload.ts`. Run them one
  at a time and rerun the next plan's drift check.
- Deferred: a timeout for the aria2 RPC call and for `makeFetchPort(fetch)`.
  Both talk to a local endpoint and were not part of the audit finding.
