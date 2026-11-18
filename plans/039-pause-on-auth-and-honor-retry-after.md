# Plan 039: Pause a provider on lost authorization and wait as long as the provider asks

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/kernel/backoff.ts src/packages/cloud/oauth.ts src/packages/cloud/types.ts src/packages/cloud/lib/http.ts src/packages/cloud/drive.ts src/packages/cloud/dropbox.ts src/packages/cloud/upload-job.ts src/background/cloud-upload.ts`
> The command compares the working tree with the planning commit, so
> uncommitted changes show. `upload-job.ts` and `cloud-upload.ts` had
> uncommitted changes when this plan was written. Plans 035 and 036 edit the
> same files and should land first. Compare every excerpt with the live file.
> A mismatch is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/036-time-out-background-fetches.md. Run after 035.
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17 (working tree had uncommitted changes)
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/113

## Why this matters

Every failed upload attempt counts toward a limit of five. The waits between
attempts are 5, 10, 20, and 40 seconds. When a refresh token is revoked, each
job fails at the token step, so every queued job is dead after about 75
seconds. The user then has to reconnect and click Retry for the whole
library. A provider rate limit (HTTP 429) is handled the same way: the queue
retries within seconds, ignores the provider's `Retry-After` header, and
kills the jobs. All jobs also retry at the same instants, with no jitter.
After this plan a lost authorization pauses that provider without consuming
attempts, a reconnect resumes it, and rate limits and server errors wait for
the time the provider names.

## Provider facts (from official documentation, checked 2026-11-17)

Dropbox, <https://docs.dropboxapi.com/dropbox-api/docs/error-handling>:

- 429: "Rate limit responses may include a Retry-After header indicating how
  long to wait before retrying." The value is in seconds. "If not returned,
  your app should pause briefly before retrying, ideally using an exponential
  backoff."

Google Drive, <https://developers.google.com/workspace/drive/api/guides/handle-errors>:

- 403 rate limits use the reason strings `userRateLimitExceeded` and
  `rateLimitExceeded`. 429 means "too many requests were sent to the API too
  quickly." 500, 502, 503, and 504 are backend errors. The documented fix for
  all three groups is to retry with exponential backoff.
- 401 `authError`: "the access token that you're using is either expired or
  invalid." The fix is to refresh the token, and to send the user through
  OAuth again when the refresh fails.
- 403 `storageQuotaExceeded` is not a rate limit and must not be retried as
  one.
- The page does not mention a `Retry-After` header. This plan reads the
  header when present and falls back to backoff.

## Current state

Files:

- `src/packages/kernel/backoff.ts` — `expBackoffMs`, the one backoff ladder.
  No jitter.
- `src/packages/cloud/oauth.ts` — token exchange and refresh.
- `src/packages/cloud/lib/http.ts` — `CloudHttpError`, `runUpload`.
- `src/packages/cloud/types.ts` — `UploadOutcome`.
- `src/packages/cloud/upload-job.ts` — job transitions.
- `src/packages/cloud/status.ts` — user-facing error text. Read only.
- `src/background/cloud-upload.ts` — the drain, `ensureAccessToken`,
  `scheduleUploadWake`, `runOAuthConnect`.
- Tests: `src/packages/kernel/tests/backoff.test.ts`,
  `src/packages/cloud/lib/http.test.ts`,
  `src/packages/cloud/tests/upload-job.test.ts`,
  `src/background/cloud-upload.test.ts` (harness `makeCU`, `fakeRuntime`,
  `seedJobs`, `connected()`, `NOW`).

`src/packages/cloud/oauth.ts:170-174`. The error code is lost whenever a
description exists. Google answers a revoked token with `error:
"invalid_grant"` and a description:

```ts
    if (!res.ok || json.error !== undefined)
      return yield* new OAuthError({
        message: json.error_description ?? json.error ?? `token endpoint HTTP ${res.status}`,
        context: 'token-endpoint',
      })
```

`src/packages/cloud/status.ts:32` already expects the code in the text:

```ts
  [/HTTP 401|invalid_grant|unauthorized|no refresh_token/i, AUTH],
```

`src/packages/cloud/lib/http.ts:55-59` and `106-108`:

```ts
export class CloudHttpError extends Data.TaggedError('CloudHttpError')<{
  readonly provider: string
  readonly status: number
  readonly body: string
}> {
```

```ts
      Effect.catchTag('CloudHttpError', (e) =>
        Effect.succeed<UploadOutcome>({ kind: 'failure', reason: e.message, status: e.status }),
      ),
```

`src/packages/cloud/upload-job.ts`, `recordFailure`:

```ts
  return onHeldLease(ledger, jobId, token, (job) => {
    const attempts = job.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      return { ...job, status: 'dead', attempts, leaseUntil: null, error: reason }
    }
    return {
      ...job,
      status: 'failed',
      attempts,
      leaseUntil: null,
      nextAttemptAt: now + backoffMs(attempts),
      error: reason,
    }
  })
```

`src/background/cloud-upload.ts`, inside `drainUploadJobs`:

```ts
      const job = readyJobs(ledger, now)[0]
```

```ts
      let outcome: UploadOutcome
      try {
        const accessToken = await ensureAccessToken(settings, job.provider, now)
        settings = await getSettings() // re-read after a possible token write
        outcome = await dispatchToProvider(job, accessToken, settings)
      } catch (err) {
        outcome = { kind: 'failure', reason: err instanceof Error ? err.message : String(err) }
      }
```

`scheduleUploadWake`:

```ts
    const due = ledger
      .filter((j) => !isTerminal(j) && j.attempts < MAX_ATTEMPTS)
      .map((j) => j.nextAttemptAt)
      .filter((t) => t > now)
```

`ensureAccessToken` refreshes when `t.accessToken === ''` or the token is
near expiry, and stores the result with
`persistAccessToken(p, refreshed.accessToken, refreshed.expiresAt)`.

Binding decisions:

- ADR-0013: "The local UploadJob ledger owns retries." All new retry state
  lives on the job row.
- ADR-0013: a path that is unavailable "fails visibly". A paused provider
  must show the existing "Authorization expired — reconnect the provider."
  line through `lastUploadError`.
- ADR-0020: "Cloud Upload fencing and alarm logic stay unchanged." New
  transitions go through `onHeldLease`. `claim` is not edited.

Repo rules (root `AGENTS.md`): no `oxlint-disable`, `eslint-disable`,
`@ts-ignore`, `@ts-expect-error`. No new `as` casts. `unknown` is banned in
parameters and return types. Name numeric constants.

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

- `src/packages/kernel/backoff.ts`
- `src/packages/kernel/tests/backoff.test.ts`
- `src/packages/cloud/oauth.ts` and its test file (find it with
  `fd oauth src/packages/cloud`)
- `src/packages/cloud/types.ts`
- `src/packages/cloud/lib/http.ts`
- `src/packages/cloud/lib/http.test.ts`
- `src/packages/cloud/drive.ts`
- `src/packages/cloud/dropbox.ts`
- `src/packages/cloud/upload-job.ts`
- `src/packages/cloud/tests/upload-job.test.ts`
- `src/background/cloud-upload.ts`
- `src/background/cloud-upload.test.ts`

**Out of scope** (do NOT touch):

- The "provider disconnected" branch at the top of the drain loop. A user who
  disconnects a provider still gets failed jobs, as today.
- `MAX_ATTEMPTS`, `LEASE_MS`, `claim`, and the alarm port.
- `src/packages/cloud/status.ts`. Its text rules already cover the new
  reasons.
- Other users of `expBackoffMs` (downloads, sync drains). Only uploads get
  jitter here.
- The Convex relay in `backend/`.
- Every Markdown file except the `plans/README.md` status row.

## Git workflow

- Branch: `advisor/039-pause-on-auth-and-honor-retry-after`.
- Conventional commits, for example
  `fix(cloud): pause a provider when its refresh token is revoked`.
- The working tree may hold uncommitted changes that are not yours. Never
  revert them and never stash them. Before you start, run
  `git status --short` on each in-scope path. If a file already shows
  changes, make your edits but do not commit that file. Report it as edited
  and uncommitted. Stage only by explicit path.
- Do NOT push. Do NOT open a PR.

## Comment rule

A `doc-lock` hook can block edits that add or change comments or Markdown.
Write no new comments. Keep every existing comment as written, even where
this plan makes it stale. Report stale comments in your reply. If the hook
rejects an edit, STOP and report the rejection text.

## Steps

### Step 1: Keep the OAuth error code in the message

Test first, in the oauth test file, modeled on an existing refresh test: a
token endpoint that answers HTTP 400 with
`{ "error": "invalid_grant", "error_description": "Token has been expired or revoked." }`
makes `refreshAccessToken` fail with a message that contains both
`invalid_grant` and the description.

**Verify**: the test FAILS. The message holds only the description.

Change the message expression in `oauth.ts` to:

```ts
        message:
          [json.error, json.error_description].filter((part) => part !== undefined).join(': ') ||
          `token endpoint HTTP ${res.status}`,
```

If an existing test asserts the old description-only text, update that
expectation. The requirement changed.

**Verify**: the oauth test file passes.

### Step 2: Add full jitter to the backoff module

Tests first, in `src/packages/kernel/tests/backoff.test.ts`:

1. `fullJitterMs(1000, () => 0)` is 0.
2. `fullJitterMs(1000, () => 0.5)` is 500.
3. `fullJitterMs(1000, () => 0.999999)` is below 1000.

Add to `backoff.ts`:

```ts
export function fullJitterMs(delayMs: number, random: () => number): number {
  return Math.floor(random() * delayMs)
}
```

**Verify**: `bun run test src/packages/kernel/tests/backoff.test.ts` → all
pass.

### Step 3: Carry `Retry-After` and the transient flag on the outcome

In `types.ts`, add two optional fields to the `failure` member of
`UploadOutcome`:

```ts
      readonly retryAfterMs?: number
      readonly transient?: boolean
```

Tests first, in `lib/http.test.ts`:

1. `retryAfterMs(new Headers({ 'retry-after': '30' }))` is `30_000`.
2. A missing header, an HTTP date, a negative number, and `'abc'` all give
   `undefined`.
3. `'99999'` is capped at `RETRY_AFTER_CAP_MS`.
4. `isTransientHttp(429, '')`, `isTransientHttp(503, '')` are true.
5. `isTransientHttp(403, '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}')`
   is true. The same with `rateLimitExceeded` is true.
6. `isTransientHttp(403, '{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}')`,
   `isTransientHttp(400, '')`, and `isTransientHttp(0, '')` are false.
7. `runUpload` with a sink that fails with a 429 `CloudHttpError` carrying
   `retryAfterMs: 30_000` returns
   `{ kind: 'failure', status: 429, transient: true, retryAfterMs: 30_000 }`
   plus the reason.

In `lib/http.ts`:

```ts
export const RETRY_AFTER_CAP_MS = 15 * 60 * 1000
const MS_PER_SECOND = 1000

export const retryAfterMs = (headers: Headers): number | undefined => {
  const raw = headers.get('retry-after')
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined
  return Math.min(Number(raw.trim()) * MS_PER_SECOND, RETRY_AFTER_CAP_MS)
}

const RATE_LIMIT_REASON = /userRateLimitExceeded|rateLimitExceeded|too_many_requests/

export const isTransientHttp = (status: number, body: string): boolean =>
  status === 429 || status >= 500 || (status === 403 && RATE_LIMIT_REASON.test(body))
```

- Add `readonly retryAfterMs?: number` to the `CloudHttpError` fields.
- Add a Promise helper that builds the error from a response:

```ts
export const httpFailure = async (provider: string, res: Response): Promise<CloudHttpError> => {
  const wait = retryAfterMs(res.headers)
  return new CloudHttpError({
    provider,
    status: res.status,
    body: await errText(res),
    ...(wait !== undefined ? { retryAfterMs: wait } : {}),
  })
}
```

- Change the `catchTag('CloudHttpError', ...)` mapping in `runUpload` to add
  `...(isTransientHttp(e.status, e.body) ? { transient: true } : {})` and
  `...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {})`.

In `drive.ts` and `dropbox.ts`, replace every
`new CloudHttpError({ provider: ..., status: res.status, body: await errText(res) })`
that is built from a response with `await httpFailure('<provider>', res)`.
Make `driveFail` and `dropboxFail` use `httpFailure` through
`Effect.promise`. Leave the `status: 0` constructions as they are.

**Verify**: `bun run test src/packages/cloud` → all pass.
`rg -n "body: await errText\(res\)" src/packages/cloud` → no matches outside
`lib/http.ts`.

### Step 4: Add the two transitions

Tests first, in `tests/upload-job.test.ts`, with the file's `spec` and
`claimFirst` helpers:

1. `releaseClaim` on a claimed job yields `status: 'pending'`, the same
   `attempts` as before the claim, `leaseUntil: null`, and
   `nextAttemptAt === now`.
2. `releaseClaim` with a stale token returns `changed: false`.
3. `applyUploadOutcome` with
   `{ kind: 'failure', reason: 'r', status: 429, transient: true, retryAfterMs: 120_000 }`
   and `random: () => 0` yields `status: 'failed'`, unchanged `attempts`,
   `transientFailures: 1`, and `nextAttemptAt === now + 120_000`.
4. The same without `retryAfterMs` and with `random: () => 0.5` yields
   `nextAttemptAt === now + 2_500` (half of the 5 s first backoff step).
5. Twenty-one transient failures in a row: the twenty-first counts as an
   ordinary failure and `attempts` becomes 1.
6. A non-transient failure with `random: () => 0.5` waits
   `Math.floor(0.5 * backoffMs(1))`.
7. `recordSuccess`, the `enqueue` revive, and `retry` each remove
   `transientFailures`.
8. A ledger row without `transientFailures` still decodes.

In `upload-job.ts`:

- Add `transientFailures: Schema.optionalKey(Schema.Number),` to
  `UploadJobSchema`.
- Add `export const MAX_TRANSIENT_FAILURES = 20`.
- Add:

```ts
export function releaseClaim(
  ledger: JobLedger,
  jobId: string,
  token: number,
  now: number,
  reason: string,
): TransitionResult {
  return onHeldLease(ledger, jobId, token, (job) => ({
    ...job,
    status: 'pending',
    leaseUntil: null,
    nextAttemptAt: now,
    error: reason,
  }))
}
```

- Give `recordFailure` a sixth parameter
  `wait: { readonly retryAfterMs?: number; readonly random?: () => number } = {}`.
  Compute the delay as
  `Math.max(wait.retryAfterMs ?? 0, fullJitterMs(backoffMs(attempts), wait.random ?? NO_JITTER))`
  where `const NO_JITTER = (): number => 1`. With `NO_JITTER`,
  `fullJitterMs` returns the full delay, so existing tests keep their exact
  times. Use `Math.ceil` semantics carefully: `Math.floor(1 * d)` equals `d`.
- Add `recordTransient(ledger, jobId, token, now, reason, wait)`. Through
  `onHeldLease`: let `count = (job.transientFailures ?? 0) + 1`. When
  `count > MAX_TRANSIENT_FAILURES`, return what `recordFailure` would return
  for this job. Otherwise return the job with `status: 'failed'`, unchanged
  `attempts`, `transientFailures: count`, `leaseUntil: null`, `error: reason`,
  and `nextAttemptAt: now + Math.max(wait.retryAfterMs ?? 0, fullJitterMs(backoffMs(count), wait.random ?? NO_JITTER))`.
  Share the delay code with `recordFailure` in one local function.
- Give `applyUploadOutcome` a sixth parameter
  `random: () => number = NO_JITTER`. In the failure branch call
  `recordTransient` when `outcome.transient === true`, else `recordFailure`.
  Pass `{ retryAfterMs: outcome.retryAfterMs, random }` without assigning
  `undefined` to an optional key (build the object with a conditional
  spread).
- Remove `transientFailures` in `recordSuccess`, in the `enqueue` revive
  branch, and in `retry` (destructure it out).

`backoffMs` caps at 5 minutes. Twenty transient failures therefore take at
most about 100 minutes before attempts start to count.

**Verify**: `bun run test src/packages/cloud/tests/upload-job.test.ts` → all
pass. `bun run typecheck` → exit 0.

### Step 5: Pause the provider in the drain

Tests first, in `src/background/cloud-upload.test.ts`:

1. "pauses a provider whose refresh token is revoked". Seed three jobs for a
   connected provider whose access token is expired. `fakeRuntime`'s
   `refreshAccessToken` rejects with
   `new Error('invalid_grant: Token has been expired or revoked.')`. Drain.
   Assert: `refreshAccessToken` was called once. All three jobs are
   `pending` with `attempts: 0`. No upload was attempted. The status reply's
   `lastError` is the "Authorization expired" line. No alarm was created.
2. "resumes a paused provider after reconnect". After case 1, make refresh
   and upload succeed, run the OAuth connect entry the existing connect tests
   use, and flush. Assert: all three jobs are `succeeded`.
3. "a paused provider does not block another provider". One Drive job and
   one Dropbox job. Drive refresh fails with `invalid_grant`. Assert: the
   Dropbox job succeeds.
4. "a 401 upload forces a token refresh, not a pause". The upload returns
   `{ kind: 'failure', reason: 'gdrive HTTP 401', status: 401 }` once and
   then succeeds. Advance `now` past the backoff and drain again. Assert:
   `refreshAccessToken` was called, the job is `succeeded`, and `attempts`
   never exceeded 0.
5. "a rate-limited upload waits for Retry-After". The upload returns
   `{ kind: 'failure', reason: 'dropbox HTTP 429', status: 429, transient: true, retryAfterMs: 120_000 }`.
   Assert: `attempts` is 0, `nextAttemptAt` is `NOW + 120_000`, and the alarm
   was created for that time.

**Verify**: all five FAIL before the source edit.

Then, in `cloud-upload.ts`:

1. Add an optional dependency `readonly random?: () => number` to
   `CloudUploadDeps`. Inside `makeCloudUpload`:
   `const randomFn = deps.random ?? Math.random` and
   `const authPaused = new Set<CloudProviderId>()`. In the test harness,
   pass `random: () => 1` from `makeCU` by default so existing timing
   assertions hold.
2. Add `const AUTH_REVOKED = /invalid_grant/i` at module level.
3. Job selection: replace `readyJobs(ledger, now)[0]` with
   `readyJobs(ledger, now).find((candidate) => !authPaused.has(candidate.provider))`.
4. Split the token step from the upload step:

```ts
      let accessToken: string
      try {
        accessToken = await ensureAccessToken(settings, job.provider, now)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        if (AUTH_REVOKED.test(reason)) {
          authPaused.add(job.provider)
          await updateLedger(
            (current) => releaseClaim(current, job.jobId, token!, nowFn(), reason).ledger,
          )
          lastUploadError = classifyUploadError(reason)
          continue
        }
        accessToken = ''
        tokenFailure = reason
      }
```

   Declare `let tokenFailure: string | null = null` before the `try`. When
   `tokenFailure` is not null, set
   `outcome = { kind: 'failure', reason: tokenFailure }` and skip the upload.
   Otherwise re-read settings and call `dispatchToProvider` inside the
   existing `try`/`catch`, exactly as today. The existing `token!` assertion
   style is already used in this function. Reuse it. Do not add a new
   suppression.
5. After the outcome is known and before the settle write: when
   `outcome.kind === 'failure' && outcome.status === 401`, call
   `await persistAccessToken(job.provider, '', 0)` and replace the outcome
   with `{ ...outcome, transient: true }`. The next attempt then refreshes
   the token. A revoked grant fails that refresh with `invalid_grant` and
   pauses the provider.
6. Pass `randomFn` as the sixth argument of `applyUploadOutcome`.
7. In `scheduleUploadWake`, add `&& !authPaused.has(j.provider)` to the first
   filter.
8. In `runOAuthConnect`, after the settings write that stores the new
   tokens, add `authPaused.delete(<provider variable>)` and
   `uploadQueue.push(() => drainUploadJobs())`. If the function already
   queues a drain there, add only the `delete`.

Open `isProviderConnected` (near line 384). If it returns false when the
access token is an empty string, STOP. Sub-step 5 would then disconnect the
provider.

**Verify**: `bun run test src/background/cloud-upload.test.ts` → all pass.

### Step 6: Full gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

- Listed per step: one oauth test, three backoff tests, seven http tests,
  eight ledger tests, five drain tests.
- Patterns: the existing tests in each named file.
- Each new test must be seen failing before its source edit.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "body: await errText\(res\)" src/packages/cloud/drive.ts src/packages/cloud/dropbox.ts` returns no matches
- [ ] `rg -n "releaseClaim|recordTransient" src/packages/cloud/upload-job.ts` shows both definitions
- [ ] `rg -n "authPaused" src/background/cloud-upload.ts` shows the set, the selection filter, the wake filter, and the reconnect delete
- [ ] All tests in the test plan exist and pass
- [ ] `git status --short` shows only in-scope files as newly changed
- [ ] `plans/README.md` status row updated, or the status reported in the reply

## STOP conditions

Stop and report if:

- An excerpt in "Current state" does not match the live file.
- `isProviderConnected` depends on a non-empty access token.
- The rejection that `rt.refreshAccessToken` produces in the live runtime
  port is not an `Error` whose message contains the OAuth error code. Check
  with a test that runs `refreshAccessToken` through
  `ManagedRuntime.runPromise` as `defaultRuntimePort` does. If the message is
  wrapped or lost, STOP.
- An existing timing assertion fails after `makeCU` passes `random: () => 1`.
- A paused provider can cause an alarm loop: a test shows the alarm created
  while the only ready jobs belong to a paused provider.
- A verification fails twice after one reasonable fix.
- The fix appears to need a file outside the in-scope list.

## Maintenance notes

- The pause lives in memory. After a service-worker restart, the first ready
  job of a revoked provider makes one token request and pauses the provider
  again. No attempt is consumed.
- **Owner decision, not planned**: jobs that died from lost authorization
  before this plan landed stay `dead`. Reviving them on reconnect is possible
  but changes what Retry means.
- **Owner decision, not planned**: a paused provider keeps its cloud-only
  media in the "queued" history state until the user reconnects. ADR-0013
  says an unavailable path "fails visibly". This plan treats the status line
  as that visibility. If the owner wants a failed history entry instead, the
  pause must also write one.
- Network failures (`status: 0`) still count as ordinary failures. An offline
  browser can still kill jobs in about 75 seconds. Treating them as transient
  is a natural follow-up and was not part of the audit finding.
- Plan 037 adds `resume` to the job and a token parameter to
  `dispatchToProvider`. It runs after this plan.
- Reviewer: check that no path increments `attempts` for an `invalid_grant`
  refresh failure, and that `Retry-After` can only lengthen a wait.
