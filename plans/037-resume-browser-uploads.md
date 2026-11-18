# Plan 037: Make browser uploads resumable and free of duplicate files

> **Executor instructions**: Follow this plan step by step. This plan has
> five parts (A to E). Each part leaves the code working and gets its own
> commit. Run every verification command and confirm the expected result
> before moving on. If anything in the "STOP conditions" section occurs, stop
> and report. Do not improvise. When done, update the status row for this
> plan in `plans/README.md`, unless a reviewer dispatched you and told you
> they maintain the index. If you stop after a completed part, report which
> parts are done.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/cloud/drive.ts src/packages/cloud/dropbox.ts src/packages/cloud/types.ts src/packages/cloud/upload-job.ts src/packages/cloud/lib/http.ts src/packages/cloud/lib/source.ts src/packages/cloud/lib/source-fetch.ts src/background/cloud-upload.ts`
> The command compares the working tree with the planning commit, so
> uncommitted changes show. `upload-job.ts` and `cloud-upload.ts` had
> uncommitted changes when this plan was written. Plans 035, 036, and 039 edit
> the same files and must land first. Compare every excerpt with the live
> file. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: plans/035-remember-uploaded-media.md,
  plans/036-time-out-background-fetches.md,
  plans/039-pause-on-auth-and-honor-retry-after.md
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17 (working tree had uncommitted changes)
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/111

## Why this matters

A browser upload keeps its provider session only in memory. The service
worker can stop at any time. When it does, the next attempt starts from byte
zero, and a 400 MB video may never finish. Worse, an upload can complete at
the provider while the worker dies before it records the success. The next
attempt then creates a second file. Drive has no name conflict rule, and the
Dropbox commit uses `autorename: true`, so both providers keep the duplicate.
The Drive loop also assumes that every 308 answer confirmed the whole chunk.
After this plan a retry first asks the provider what it already has, a
completed upload is recognized, and an interrupted one continues from the
confirmed offset.

## Provider facts (from official documentation, checked 2026-11-17)

Google Drive, <https://developers.google.com/workspace/drive/api/guides/manage-uploads>:

- "A `308 Resume Incomplete` response indicates that you must continue to
  upload the file." Process "the `Range` header of the response to determine
  which bytes the server has received."
- "If the response doesn't have a `Range` header, no bytes have been
  received."
- "To request the upload status, create an empty `PUT` request to the
  resumable session URI." Set `Content-Range` to `*/2000000` when the total
  is 2,000,000 bytes. The header value in practice is `bytes */2000000`.
- "A resumable session URI expires after one week."
- "A `404 Not Found` response indicates the upload session has expired and
  the upload must be restarted from the beginning."
- "Create chunks in multiples of 256 KB (256 x 1024 bytes) in size, except
  for the final chunk that completes the upload."
- Pre-generated IDs: "You can safely retry uploads with pre-generated IDs if
  there's an indeterminate server error or timeout." and "If the file action
  is successful, subsequent retries return a `409 Conflict` HTTP status code
  response and duplicate files aren't created."

Google Drive, <https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds>:

- `GET https://www.googleapis.com/drive/v3/files/generateIds` with query
  `count`. The response is `{ ids: string[], space, kind }`.

Google Drive, <https://developers.google.com/workspace/drive/api/reference/rest/v3/files>:

- `size`: "Output only. Size in bytes of blobs and Google Workspace editor
  files." The API returns it as a string.

Dropbox, <https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/upload-session-start>
and the `append_v2` and `finish` pages beside it:

- "An upload session can be used for a maximum of 7 days."
- `UploadSessionCursor.offset`: "Offset in bytes at which data should be
  appended. We use this to make sure upload data isn't lost or duplicated in
  the event of a network error."
- `incorrect_offset`: "This error may occur when a previous request was
  received and processed successfully but the client did not receive the
  response". It carries `correct_offset`, "The offset up to which data has
  been collected."
- `UploadSessionFinishError.path`: "Data has already been appended to the
  upload session. Please retry with empty data body and updated offset."
- `autorename` default is false: "If there's a conflict, as determined by
  `mode`, have the Dropbox server try to autorename the file".
- `strict_conflict` default is false. Setting it "forces a conflict even when
  the target path refers to a file with identical contents."

Facts this plan could NOT confirm. Each has a fallback in the steps:

- Whether `files.generateIds` works under the OAuth scope this extension
  requests. Fallback: on any failure of that call, upload without a
  pre-generated ID, as today.
- Whether Dropbox returns the existing file, with no conflict, when
  `mode: 'add'` writes identical content to an existing path. The
  `strict_conflict` text implies it. Fallback: on a path conflict, commit
  once more with `autorename: true`, which is today's behavior.
- The status-probe header when the total size is unknown. This plan resumes
  only when the total size is known.

## Current state

Files:

- `src/packages/cloud/types.ts` — `UploadInput`, `UploadOutcome`.
- `src/packages/cloud/upload-job.ts` — the job schema and transitions.
- `src/packages/cloud/drive.ts` — Drive adapter. `multipart` and `resumable`.
- `src/packages/cloud/dropbox.ts` — Dropbox adapter. `simpleUpload` and
  `sessionUpload`.
- `src/packages/cloud/lib/http.ts` — `runUpload` template, `CloudHttpError`.
- `src/packages/cloud/lib/source.ts` — `parseSource`, reads the source
  response.
- `src/packages/cloud/lib/source-fetch.ts` — `SourceFetch`, the guarded
  fetch.
- `src/background/cloud-upload.ts` — `dispatchToProvider` and the drain.
- Tests: `src/packages/cloud/drive.test.ts`, `dropbox.test.ts`,
  `lib/http.test.ts`, `lib/source.test.ts`,
  `lib/upload-pipeline.e2e.test.ts`, `tests/upload-job.test.ts`,
  `src/background/cloud-upload.test.ts`.

`src/packages/cloud/types.ts:50-54`:

```ts
export interface UploadInput {
  /** twimg source URL — fetched only via the SSRF guard. */
  readonly url: string
  readonly target: UploadTarget
}
```

`src/background/cloud-upload.ts`, `dispatchToProvider`:

```ts
    const input: UploadInput = { url: job.url, target: job.target }
```

`src/packages/cloud/drive.ts:154-169` (session start, URL kept in memory):

```ts
        const init = yield* http.fetch(`${UPLOAD_BASE}?uploadType=resumable&fields=id`, {
          ...
          body: JSON.stringify({ name: meta.name, parents: [meta.parentId] }),
        })
        if (!init.ok) return yield* driveFail(init)
        const sessionUrl = init.headers.get('location')
```

`src/packages/cloud/drive.ts:185-200` (308 accepted without reading `Range`):

```ts
              const res = await doFetch(sessionUrl, reqInit)
              if (info.isLast) {
                ...
              } else if (res.status !== 308) {
                throw new CloudHttpError({
```

`src/packages/cloud/dropbox.ts:44`:

```ts
const commitInfo = (path: string) => ({ path, mode: 'add', autorename: true, mute: false })
```

`src/packages/cloud/dropbox.ts:124-125` (session state in local variables):

```ts
          let sessionId: string | null = null
          let cursorOffset = 0
```

`src/packages/cloud/upload-job.ts`, the lease guard every transition uses:

```ts
const onHeldLease = (
  ledger: JobLedger,
  jobId: string,
  token: number,
  fn: (job: UploadJob) => UploadJob,
): TransitionResult => {
```

`enqueue` revives a non-succeeded job with `...kept` and a fresh `url`.

Binding decisions:

- ADR-0013, written for the relay and adopted here for the browser path:
  "Drive identities allocated and persisted before creation", reconcile by
  stable identity, probe the session, and "trust only Drive-confirmed
  offsets".
- ADR-0013: "The local UploadJob ledger owns retries" and the Convex mirror
  is best-effort. Resume state is local. It must never reach the mirror.
- ADR-0017: `fetchPromise` serves the chunker sink. Orchestration stays
  Promise based. Keep `streamInChunks` unchanged (plan 015 finished it).
- ADR-0020: "Cloud Upload fencing and alarm logic stay unchanged." The new
  transition must go through `onHeldLease`.

Security note: a Drive session URL lets its holder write that one file. Treat
it like a token. Never log it, never put it in an error message, and never
send it to Convex.

Repo rules (root `AGENTS.md`): no `oxlint-disable`, `eslint-disable`,
`@ts-ignore`, `@ts-expect-error`. No new `as` casts. `unknown` is banned in
parameters and return types. Name numeric constants. Effect v4 is in use.
Read the `effect-v4` skill if it is available.

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
Package manager is bun. Never use npm or npx. No step calls a real provider.
All provider behavior is tested with stubbed `fetch`.

## Scope

**In scope** (the only files you may modify):

- `src/packages/cloud/types.ts`
- `src/packages/cloud/upload-job.ts`
- `src/packages/cloud/tests/upload-job.test.ts`
- `src/packages/cloud/drive.ts`
- `src/packages/cloud/drive.test.ts`
- `src/packages/cloud/dropbox.ts`
- `src/packages/cloud/dropbox.test.ts`
- `src/packages/cloud/lib/source.ts` and `lib/source.test.ts` (Part E only)
- `src/packages/cloud/lib/source-fetch.ts` (Part E only)
- `src/background/cloud-upload.ts`
- `src/background/cloud-upload.test.ts`

**Out of scope** (do NOT touch):

- `src/packages/cloud/lib/chunk.ts` and its test.
- `backend/` and `src/background/remote-upload.ts`. The relay has its own
  resume logic.
- The wire shape sent by `mirrorUploadJob`. See Step A4.
- `LEASE_MS` and lease renewal. See Maintenance notes.
- Content hashing. Plan 040 owns it.
- Every Markdown file except the `plans/README.md` status row.

## Git workflow

- Branch: `advisor/037-resume-browser-uploads`.
- One commit per part. Conventional commits, for example
  `fix(cloud): read the Drive 308 Range header`.
- The working tree may hold uncommitted changes that are not yours. Never
  revert them and never stash them. Before you start, run
  `git status --short` on each in-scope path. If a file already shows
  changes, make your edits but do not commit that file. Report it as edited
  and uncommitted. Stage only by explicit path.
- Do NOT push. Do NOT open a PR.

## Comment rule

A `doc-lock` hook can block edits that add or change comments or Markdown.
Write no new comments. Keep every existing comment as written. Report a
comment that became stale in your reply. If the hook rejects an edit, STOP
and report the rejection text.

## Part A: Carry resume state on the job

### Step A1: Schema and transition

Tests first, in `tests/upload-job.test.ts`:

1. `recordResume` with the held token stores the state on the job.
2. `recordResume` with a stale token returns `changed: false`.
3. A ledger row without `resume` still decodes (old rows).
4. `enqueue` on a `failed` job that has
   `resume: { fileId: 'f', sessionUrl: 'u', offset: 8 }` yields a pending job
   whose `resume` is `{ fileId: 'f' }`.
5. `retry` on a `dead` job removes `resume` entirely.
6. `recordSuccess` removes `resume`.

In `upload-job.ts`, add to `UploadJobSchema` after `bytes`:

```ts
  resume: Schema.optionalKey(
    Schema.Struct({
      fileId: Schema.optionalKey(Schema.String),
      sessionUrl: Schema.optionalKey(Schema.String),
      sessionId: Schema.optionalKey(Schema.String),
      offset: Schema.optionalKey(Schema.Number),
      total: Schema.optionalKey(Schema.Number),
    }),
  ),
```

Export `type ResumeState = NonNullable<UploadJob['resume']>`. Add:

```ts
export function recordResume(
  ledger: JobLedger,
  jobId: string,
  token: number,
  resume: ResumeState,
): TransitionResult {
  return onHeldLease(ledger, jobId, token, (job) => ({ ...job, resume }))
}
```

In `enqueue`, the revive branch must keep only the Drive file identity:
destructure `resume` out of `kept` and add
`...(existing.resume?.fileId !== undefined ? { resume: { fileId: existing.resume.fileId } } : {})`.
A revive brings a fresh source URL, so a byte offset from the old URL is not
trusted. In `retry` and in `recordSuccess`, build the new job without the
`resume` key (destructure it out).

**Verify**: `bun run test src/packages/cloud/tests/upload-job.test.ts` → all
pass. Tests 1, 2, 4, 5, 6 were red before the edit.

### Step A2: Pass state through `UploadInput`

In `types.ts`, extend `UploadInput`:

```ts
  readonly resume?: ResumeState
  readonly onResume?: (state: ResumeState) => Promise<void>
```

Declare `ResumeState` in `types.ts` as a plain interface with the same five
optional fields, and make `upload-job.ts` import nothing from it. The two
shapes are structurally equal. If `lint:boundaries` or a circular import
complains, keep the interface only in `types.ts`.

### Step A3: Wire the drain

In `cloud-upload.ts`, change `dispatchToProvider` to take the lease token and
build the input as:

```ts
    const input: UploadInput = {
      url: job.url,
      target: job.target,
      ...(job.resume !== undefined ? { resume: job.resume } : {}),
      onResume: async (state) => {
        await updateLedger((current) => recordResume(current, job.jobId, token, state).ledger)
      },
    }
```

Pass `token` from the drain's call site. The adapters do not use the new
fields yet.

### Step A4: Keep resume state out of the mirror

Run `rg -n "toWireUploadJob" src`. Open its definition. Confirm that it
builds the wire object field by field and does not spread the whole job. If
it spreads the job, STOP. Add a test beside its existing tests that a job
with `resume` produces a wire object without a `resume` key and without the
session URL string.

**Verify (Part A)**: `bun run check` → exit 0. Commit.

## Part B: Trust only Drive-confirmed offsets

Tests first, in `drive.test.ts`, modeled on the existing resumable test:

1. A non-final PUT answers 308 with `Range: bytes=0-4194303` for an 8 MiB
   chunk at offset 0. Expect one more PUT with
   `content-range: bytes 4194304-8388607/*` that carries the missing tail.
2. A non-final PUT at offset 8 MiB answers 308 with no `Range` header.
   Expect a failure outcome whose reason contains `session lost`.
3. A 308 with a full `Range` causes no extra PUT (existing behavior).
4. Four short `Range` answers in a row end in a failure outcome.

In `drive.ts`, add:

```ts
const MAX_TAIL_RESENDS = 3

const confirmedEnd = (res: Response): number => {
  const match = /^bytes=0-(\d+)$/.exec(res.headers.get('range') ?? '')
  return match === null ? 0 : Number(match[1]) + 1
}
```

In the non-final branch of the sink, after a 308:

- `confirmed = confirmedEnd(res)`, `expected = info.offset + chunk.length`.
- If `confirmed >= expected`, continue.
- If `confirmed < info.offset`, throw
  `new CloudHttpError({ provider: 'drive', status: 0, body: 'session lost confirmed bytes' })`.
- Otherwise resend `chunk.subarray(confirmed - info.offset)` with
  `content-range: bytes ${confirmed}-${expected - 1}/*`, and check the answer
  the same way. Stop after `MAX_TAIL_RESENDS` resends with the same
  `CloudHttpError` shape and body `'chunk never confirmed'`.

Write the resend as a small recursive async helper that takes the remaining
resend count. Do not add a loop with `await` inside. The repo forbids new
`no-await-in-loop` suppressions.

**Verify (Part B)**: `bun run test src/packages/cloud/drive.test.ts` → all
pass. `bun run check` → exit 0. Commit.

## Part C: Give each Drive file a stable identity

Tests first, in `drive.test.ts`:

1. First attempt, streamed: the adapter calls `generateIds`, then calls
   `onResume` with `{ fileId }` BEFORE the session start request, and the
   start request body contains `"id":"<that id>"`.
2. First attempt, buffered (multipart): same order, and the multipart
   metadata part contains the id.
3. Retry with `resume.fileId`, and `GET files/<id>?fields=id,size` answers
   200 with `size` equal to the source size: the outcome is `success` with
   `remoteId` equal to the id, and no upload request is sent.
4. Retry with `resume.fileId`, and the GET answers 404: the adapter uploads
   with the same id and does not call `generateIds`.
5. Retry with `resume.fileId`, and the GET answers 200 with a different
   `size`: the adapter calls `onResume({})`, returns a failure outcome whose
   reason contains `size differs`, and sends no upload request.
6. `generateIds` answers 403: the upload proceeds with no `id` in the
   metadata and still succeeds.
7. The create request answers 409: the adapter performs the GET check from
   case 3 and returns success when the size matches.

Implementation in `drive.ts`:

- `generateId(accessToken)`: `GET ${FILES_BASE}/generateIds?count=1`. Return
  `ids[0]`, or `null` on any non-2xx answer or missing id.
- `existing(accessToken, fileId)`: `GET ${FILES_BASE}/${fileId}?fields=id,size`.
  Return `{ size: number } | null`. `null` on 404. Other non-2xx answers fail
  through `driveFail`. `size` arrives as a string. Convert with `Number`.
- In `upload`, before the sinks run: when `input.resume?.fileId` is set, call
  `existing`. Apply cases 3, 4, 5. Compare with the source size from
  `parseSource`. When the source size is unknown, treat any existing file as
  a match.
- When there is no `fileId`, call `generateId`. If it returns an id, await
  `input.onResume?.({ fileId })` before any create request.
- Add `id` to the JSON metadata of `multipart` and of the resumable start
  request when an id is known.
- On a 409 from either create request, run the `existing` check.

The source must be parsed before the pre-check can compare sizes. `runUpload`
owns source parsing. Add an optional third argument to `runUpload` in
`lib/http.ts`: `before?: (source: { size: number | null }) => Effect.Effect<UploadOutcome | null, CloudHttpError | FetchError, R>`.
When it returns an outcome, `runUpload` returns that outcome and cancels the
source body with `s.body.cancel()`. Add `lib/http.ts` and `lib/http.test.ts`
to your edits for this part and cover the short-circuit with one test.

**Verify (Part C)**: `bun run test src/packages/cloud` → all pass.
`bun run check` → exit 0. Commit.

## Part D: Stop Dropbox duplicates

Tests first, in `dropbox.test.ts`:

1. The `dropbox-api-arg` of `files/upload` has `"autorename":false`.
2. `files/upload` answers 409 with a body that contains `path/conflict`: the
   adapter sends one more `files/upload` with `"autorename":true` and returns
   its result.
3. `upload_session/append_v2` answers 409 with body
   `{"error":{".tag":"incorrect_offset","correct_offset":N}}` where N equals
   the offset after this chunk: the adapter continues with the next chunk and
   the upload succeeds.
4. The same error with a different N ends in a failure outcome.
5. `upload_session/finish` answers 409 with `path/conflict`: the adapter
   sends one more `finish` with an empty body, the cursor offset advanced by
   the final chunk length, and `"autorename":true`.

Implementation in `dropbox.ts`:

- `commitInfo(path, autorename = false)`.
- A helper `isPathConflict(body: string): boolean` that tests for
  `path/conflict`.
- A helper `correctOffset(body: string): number | null` that parses the JSON
  body inside a `try` and returns `error.correct_offset` when `.tag` is
  `incorrect_offset`. Decode with a small `Schema.Struct`, not with a cast.
- Apply the five behaviors above. Each conflict retry happens once.

**Verify (Part D)**: `bun run test src/packages/cloud/dropbox.test.ts` → all
pass. `bun run check` → exit 0. Commit.

## Part E: Continue from the confirmed offset

This part has the highest risk. Start it only after Parts A to D are
committed. If the owner asked for Parts A to D only, stop here and report.

Resume applies only when all of these hold: the source size is known,
`input.resume.total` equals that size, and the stored session answers the
probe. In every other case the adapter starts from byte zero with a new
session, as today.

### Step E1: Ranged source fetch

- `SourceFetch.fetch` gets an optional second parameter
  `fromByte?: number`. When set, it calls
  `guardedFetch(url, { headers: { range: \`bytes=${fromByte}-\` } }, fetchImpl)`.
- `parseSource` accepts `fromByte`. With `fromByte` set it requires status
  206 and a `content-range` header that starts with `bytes ${fromByte}-`. Any
  other answer makes the caller fall back to a full fetch from zero. Test
  both paths in `lib/source.test.ts`.

### Step E2: Drive

- After the session start, call
  `onResume({ fileId, sessionUrl, offset: 0, total })`. After each confirmed
  chunk, call `onResume` with the new confirmed offset.
- On a retry with `resume.sessionUrl`: send an empty `PUT` to the session URL
  with `content-range: bytes */${total}`. Status 200 or 201 means complete:
  return success. Status 308 gives the confirmed offset through
  `confirmedEnd`. Status 404 means the session expired: start a new session
  with the same `fileId`.
- Fetch the source from the confirmed offset. Add the confirmed offset to
  every `info.offset` the chunker reports.
- The confirmed offset must be a multiple of 256 KiB. If it is not, start a
  new session.

### Step E3: Dropbox

- After `upload_session/start` and after each append, call
  `onResume({ sessionId, offset, total })`.
- On a retry with `resume.sessionId`: fetch the source from `resume.offset`
  and append at that offset. An `incorrect_offset` answer on the first append
  gives the true offset. Refetch the source from there once. A `not_found`
  answer means the session expired: start a new session from zero.

Tests for E2 and E3 go in `drive.test.ts` and `dropbox.test.ts`. Each
behavior above gets one test with a stubbed `fetch`. Add one end-to-end case
to `lib/upload-pipeline.e2e.test.ts`: attempt one fails after two chunks,
attempt two resumes, and the provider stub received every byte exactly once.

**Verify (Part E)**: `bun run check` → exit 0. `bun run build` → exit 0.
Commit.

## Test plan

- Listed per part above. Patterns: the existing tests in `drive.test.ts`,
  `dropbox.test.ts`, `tests/upload-job.test.ts`, and
  `lib/upload-pipeline.e2e.test.ts`.
- Every new test must be seen failing before its source edit.
- No test may call a real provider.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "autorename: true" src/packages/cloud/dropbox.ts` returns no matches
- [ ] `rg -n "generateIds" src/packages/cloud/drive.ts` returns at least one match
- [ ] `rg -n "sessionUrl" src/packages/sync src/background/remote-upload.ts` returns no matches
- [ ] A test proves the mirror wire object carries no `resume`
- [ ] Every test listed in Parts A to D exists and passes (and Part E, if executed)
- [ ] `git status --short` shows only in-scope files as newly changed
- [ ] `plans/README.md` status row updated, or the status reported in the reply

## STOP conditions

Stop and report if:

- Plans 035, 036, or 039 are not marked DONE in `plans/README.md`.
- An excerpt in "Current state" does not match the live file.
- `toWireUploadJob` spreads the whole job into the wire object.
- A session URL or session id would appear in a log line, an error reason, or
  a Convex payload.
- `streamInChunks` would need a change.
- A step needs a provider fact that the "Provider facts" section does not
  state. Do not guess provider behavior.
- A source host answers a ranged request with 200 in a test fixture taken
  from real traffic. Report it. The fallback to a full fetch must then be the
  only path.
- A verification fails twice after one reasonable fix.
- The fix appears to need a file outside the in-scope list.

## Maintenance notes

- The job lease is 300 s and is not renewed while a long upload runs. A
  second drain can reclaim a job whose first attempt is still sending. With
  this plan the second attempt probes the provider first, which limits the
  damage. Lease renewal on each `onResume` call is a natural follow-up. It
  touches fencing, which ADR-0020 freezes, so it needs an owner decision.
- `onResume` writes the ledger once per 8 MiB chunk. Plan 019 coalesces
  ledger writes. If 019 lands, check that a resume write is not delayed past
  the next chunk.
- Unconfirmed provider facts are listed above with their fallbacks. A
  maintainer with a test account should confirm them and then remove the
  fallbacks that are never taken.
- A Drive file whose stored size differs from the source is left in place.
  The extension never deletes user files.
- Plan 040 adds hash and size checks on the success path. It reuses the
  `fields` list and the Dropbox commit helper from this plan.
- Reviewer: check the order "persist the id, then create" in Part C, and
  check that no code path trusts an offset that the provider did not return.
