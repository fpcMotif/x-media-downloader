# Plan 035: Remember uploaded media so pruning never causes a second upload

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/cloud/upload-job.ts src/packages/cloud/tests/upload-job.test.ts src/background/cloud-upload.ts src/background/cloud-upload.test.ts`
> The command compares the working tree with the planning commit, so
> uncommitted changes show. All four files had uncommitted changes when this
> plan was written, and the excerpts below were read from that working tree.
> Compare every excerpt with the live file before editing. A mismatch is a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none. Run before plan 037, which edits the same schema.
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17 (working tree had uncommitted changes)
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/109

## Why this matters

The browser upload ledger keeps at most 50 finished jobs. `capLedger` drops
older `succeeded` and `dead` rows. The ledger row is the only record that a
media item was uploaded. Once the row is gone, "Backfill" and a repeat
download enqueue the same media again, and the provider gets a duplicate file.
A dropped `dead` row loses a failure the user never retried. A second defect
sits beside it: `decodeLedger` returns an empty ledger when any single row
fails to decode, and the next write then replaces every pending job with
nothing. After this plan a compact key set remembers every uploaded media
item, `dead` rows are never pruned, and one bad row costs only that row.

## Current state

Files:

- `src/packages/cloud/upload-job.ts` — the pure UploadJob ledger and its
  transitions.
- `src/packages/cloud/tests/upload-job.test.ts` — its tests. `capLedger` tests
  are near lines 340-401. The `decodeLedger` test is at line 411.
- `src/background/cloud-upload.ts` — the service-worker upload module. It owns
  storage, the drain loop, and backfill.
- `src/background/cloud-upload.test.ts` — its tests. The harness is `makeCU`,
  `fakeLedger`, `fakeRuntime`, `fakeAlarms`, `fakeBadge`, `seedJobs(n)`,
  `connected()`. Backfill tests are near lines 846-904.

`src/packages/cloud/upload-job.ts:155-161`:

```ts
export function decodeLedger(raw: JsonValue): JobLedger {
  try {
    return Schema.decodeUnknownSync(LedgerSchema)(raw ?? [])
  } catch {
    return []
  }
}
```

`src/packages/cloud/upload-job.ts:233-251`:

```ts
export function capLedger(ledger: JobLedger, maxTerminal = 50): JobLedger {
  const unresolved = new Set(
    ledger
      .filter((job) => job.cloudOnly && job.historyOutcome !== 'completed')
      .map((job) => job.mediaId),
  )
  const removable = (job: UploadJob): boolean => isTerminal(job) && !unresolved.has(job.mediaId)
  const terminalCount = ledger.reduce((n, j) => (removable(j) ? n + 1 : n), 0)
  if (terminalCount <= maxTerminal) return ledger
  let toDrop = terminalCount - maxTerminal
  // Drop oldest terminal jobs first (insertion order); keep all live jobs.
  return ledger.filter((j) => {
    if (toDrop > 0 && removable(j)) {
      toDrop -= 1
      return false
    }
    return true
  })
}
```

`enqueue` (`upload-job.ts:180-216`) is a no-op only while the `succeeded` row
still exists:

```ts
    if (existing.status === 'succeeded' || existing.status === 'uploading') return ledger
```

`capLedger` call sites in `src/background/cloud-upload.ts`: lines 609, 624,
648 (inside `drainUploadJobs`) and 896 (inside `resumeOnBoot`). Line 648 caps
in the same write that records a success:

```ts
      await updateLedger((current) => {
        const applied = applyUploadOutcome(current, job.jobId, token!, tnow, outcome)
        settled = applied.settled
        settledLedger = capLedger(applied.ledger)
        return settledLedger
      })
```

Ledger storage (`cloud-upload.ts:376-380`):

```ts
  const storeQueue = makeSerialQueue(deps.queueError('uploadStore'))
  const readLedger = (): Promise<JobLedger> =>
    storeQueue.run(async () => decodeLedger(await store.get()))
  const updateLedger = (update: (ledger: JobLedger) => JobLedger | Promise<JobLedger>) =>
    runSerializedRmw(storeQueue, store, decodeLedger, update)
```

The live store is a wxt item (`cloud-upload.ts:237`):

```ts
  const item = storage.defineItem<JsonValue>('local:cloudUploadJobs', { fallback: null })
```

Row-tolerant decoding already exists in this repo. See
`src/packages/clear/worklist.ts:38`:

```ts
const decodeEntry = Schema.decodeUnknownOption(SweepEntry)
```

Binding decisions:

- ADR-0013: "The local UploadJob ledger owns retries." and "the local ledger
  remains authoritative". The new key set is local state beside the ledger.
  It is never mirrored to Convex.
- ADR-0020: "Promise orchestration stays outside Effect. Cloud Upload fencing
  and alarm logic stay unchanged." Do not change `claim`, leases, or alarms.

Repo rules (root `AGENTS.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, `@ts-expect-error`.
- No new `as` casts. `unknown` is banned in parameters and return types.
- Name numeric constants.
- Modules import each other by file path, for example
  `@/packages/cloud/upload-job`. Run `bun run lint:boundaries` to check.
- This repo uses Effect v4. If a skill named `effect-v4` is available, read it
  before writing Schema code. Copy the Schema calls shown in this plan.

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

- `src/packages/cloud/uploaded-set.ts` (create)
- `src/packages/cloud/tests/uploaded-set.test.ts` (create)
- `src/packages/cloud/upload-job.ts`
- `src/packages/cloud/tests/upload-job.test.ts`
- `src/background/cloud-upload.ts`
- `src/background/cloud-upload.test.ts`

**Out of scope** (do NOT touch):

- `src/background/remote-upload.ts` and the Convex relay receipts. ADR-0013
  keeps relay-owned media out of the browser uploader.
- `src/packages/sync/captures.ts`. It has its own unrelated `capLedger`.
- Cloud-only jobs. `capLedger` already keeps unresolved cloud-only media. The
  new skip rule does not apply to a cloud-only enqueue. See Maintenance notes.
- `claim`, leases, backoff, and alarms.
- Every Markdown file except the `plans/README.md` status row.

## Git workflow

- Branch: `advisor/035-remember-uploaded-media`.
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
Write no new comments. Keep every existing comment as written, even where this
plan changes the code under it. Report a comment that became stale in your
reply. If the hook rejects an edit, STOP and report the rejection text.

## Steps

### Step 1: Decode the ledger row by row

Test first. In `src/packages/cloud/tests/upload-job.test.ts`, next to the
existing `decodeLedger` test, add:

```ts
  it('decodeLedger keeps valid rows when one row is corrupt', () => {
    const l = enqueue(enqueue([], spec('m1'), 0), spec('m2'), 0)
    const raw = JSON.parse(JSON.stringify(l))
    raw.splice(1, 0, { jobId: 42 })
    expect(decodeLedger(raw)).toEqual(l)
  })
```

**Verify**: `bun run test src/packages/cloud/tests/upload-job.test.ts` → the
new test FAILS with an empty array.

Then replace `decodeLedger` in `upload-job.ts`:

```ts
const decodeJob = Schema.decodeUnknownOption(UploadJobSchema)

export function decodeLedger(raw: JsonValue): JobLedger {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((row) => {
    const job = decodeJob(row)
    return Option.isSome(job) ? [job.value] : []
  })
}
```

Add `Option` to the file's `effect` import. Run
`rg -n "LedgerSchema" src/packages/cloud/upload-job.ts`. If the constant has
no remaining use, delete its declaration.

**Verify**: the same test command → all pass. `bun run typecheck` → exit 0.

### Step 2: Add the uploaded key set module

Create `src/packages/cloud/tests/uploaded-set.test.ts` first, modeled on the
top of `upload-job.test.ts`. Cases:

1. `decodeUploadedKeys(null)` and `decodeUploadedKeys('x')` return `[]`.
2. `decodeUploadedKeys(['a', 'b'])` returns `['a', 'b']`.
3. `rememberUploaded(['a'], ['a'])` returns the same array reference.
4. `rememberUploaded(['a'], ['b', 'b', 'a'])` returns `['a', 'b']`.
5. `rememberUploaded(['a', 'b'], ['c'], 2)` returns `['b', 'c']`.

Then create `src/packages/cloud/uploaded-set.ts`. Copy the `JsonValue` import
line from `upload-job.ts`.

```ts
import { Option, Schema } from 'effect'

export const UPLOADED_KEYS_CAP = 20_000

const decodeKeys = Schema.decodeUnknownOption(Schema.Array(Schema.String))

export function decodeUploadedKeys(raw: JsonValue): ReadonlyArray<string> {
  return Option.getOrElse(decodeKeys(raw ?? []), () => [])
}

export function rememberUploaded(
  keys: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
  cap: number = UPLOADED_KEYS_CAP,
): ReadonlyArray<string> {
  const known = new Set(keys)
  const fresh = [...new Set(added)].filter((key) => !known.has(key))
  if (fresh.length === 0) return keys
  const next = [...keys, ...fresh]
  return next.length > cap ? next.slice(next.length - cap) : next
}
```

A key is the job's `idempotencyKey`, which is `${mediaId}:${provider}`.
20,000 keys take about 1 MB in `chrome.storage.local`.

**Verify**: `bun run test src/packages/cloud/tests/uploaded-set.test.ts` → 5
pass. `bun run typecheck` → exit 0.

### Step 3: Make `capLedger` keep `dead` rows and unremembered successes

Tests first, in the `capLedger` block of `upload-job.test.ts`:

1. Sixty `dead` rows with `maxTerminal` 5 → all sixty stay.
2. Sixty `succeeded` rows, empty `remembered` → all sixty stay.
3. Sixty `succeeded` rows, all keys in `remembered`, `maxTerminal` 5 → five
   stay, and they are the newest five.
4. Sixty `skipped` rows with `maxTerminal` 5 → five stay.

Build rows with the helpers the file already uses (`spec`, `claimFirst`,
`recordSuccess`, `recordFailure`, `recordSourceGone`).

**Verify**: tests 1 and 2 FAIL before the source edit.

Change `capLedger` in `upload-job.ts`. Export the default as a constant:

```ts
export const MAX_TERMINAL_JOBS = 50
const NOTHING_REMEMBERED: ReadonlySet<string> = new Set()

export function capLedger(
  ledger: JobLedger,
  maxTerminal: number = MAX_TERMINAL_JOBS,
  remembered: ReadonlySet<string> = NOTHING_REMEMBERED,
): JobLedger {
```

Replace the `removable` line with:

```ts
  const prunable = (job: UploadJob): boolean =>
    job.status === 'skipped' ||
    (job.status === 'succeeded' && remembered.has(job.idempotencyKey))
  const removable = (job: UploadJob): boolean => prunable(job) && !unresolved.has(job.mediaId)
```

Leave the rest of the function as it is.

Existing `capLedger` tests assumed that every terminal row is removable.
Update each one that now fails: pass a `remembered` set that holds the keys
of its `succeeded` rows, and expect `dead` rows to stay. These tests encode
the old requirement, so changing their expectations is correct. Do not delete
a test.

**Verify**: `bun run test src/packages/cloud/tests/upload-job.test.ts` → all
pass.

### Step 4: Store and load the key set in the service worker

In `src/background/cloud-upload.ts`:

1. Find the ledger storage seam type near line 62 (its doc comment starts
   "Durable UploadJob-ledger storage seam"). Add an optional dependency
   `readonly uploaded?:` of that same seam type to `CloudUploadDeps`, next to
   the `ledger` field.
2. Next to the live ledger store near line 237, add a second live store with
   the same shape that uses
   `storage.defineItem<JsonValue>('local:cloudUploadedKeys', { fallback: null })`.
3. Inside `makeCloudUpload`, after `updateLedger`, add:

```ts
  const uploadedStore = deps.uploaded ?? liveUploadedStore()
  let uploadedKeys: ReadonlySet<string> | null = null
  const loadUploaded = async (): Promise<ReadonlySet<string>> => {
    if (uploadedKeys === null)
      uploadedKeys = new Set(
        await storeQueue.run(async () => decodeUploadedKeys(await uploadedStore.get())),
      )
    return uploadedKeys
  }
  const rememberKeys = async (keys: ReadonlyArray<string>): Promise<void> => {
    if (keys.length === 0) return
    const next = await runSerializedRmw(storeQueue, uploadedStore, decodeUploadedKeys, (current) =>
      rememberUploaded(current, keys),
    )
    uploadedKeys = new Set(next)
  }
  const capJobs = (ledger: JobLedger): JobLedger =>
    capLedger(ledger, MAX_TERMINAL_JOBS, uploadedKeys ?? new Set())
```

   Use the name of your live store function in place of `liveUploadedStore`.
   Check what `runSerializedRmw` returns in
   `src/packages/kernel/durable-store.ts`. If it does not return the written
   value, set the cache with a second read through `loadUploaded` after
   resetting `uploadedKeys = null`. If `runSerializedRmw` does not accept a
   `ReadonlyArray<string>` value type, STOP.

4. Replace all four `capLedger(` calls in this file with `capJobs(`.
5. Add `await loadUploaded()` as the first statement of `drainUploadJobs`,
   after the `cloudUploadEnabled` check.
6. In `drainUploadJobs`, directly after the settle `updateLedger` call that
   contains `applyUploadOutcome`, add:

```ts
      if (settled !== undefined && settled.status === 'succeeded')
        await rememberKeys([settled.idempotencyKey])
```

7. Replace the body of `resumeOnBoot`'s queued task with:

```ts
      await loadUploaded()
      const ledger = await readLedger()
      await rememberKeys(
        ledger.filter((job) => job.status === 'succeeded').map((job) => job.idempotencyKey),
      )
      await updateLedger((current) => capJobs(current))
      await drainUploadJobs()
```

   This sweep covers a crash between the success write and `rememberKeys`.

In `cloud-upload.test.ts`, add an in-memory `fakeUploaded()` store modeled on
`fakeLedger`, and pass it through `makeCU`.

**Verify**: `bun run typecheck` → exit 0.
`bun run test src/background/cloud-upload.test.ts` → all existing tests pass.

### Step 5: Skip remembered media at enqueue

Test first, in `cloud-upload.test.ts`, modeled on the backfill tests near
lines 846-904:

- Name: "backfill does not re-queue media whose succeeded rows were pruned".
- Arrange: a connected provider, 60 history records, and a runtime whose
  upload always succeeds. Run backfill and drain to completion.
- Assert: the uploader was called 60 times. The ledger holds at most 50
  `succeeded` rows.
- Act: run backfill again and drain.
- Assert: the second reply has `queued: 0`, and the uploader call count is
  still 60.

**Verify**: the test FAILS before the source edit. The uploader is called
more than 60 times.

Then, in `backfillCloudUploads`, add `const uploaded = await loadUploaded()`
before the `updateLedger` call, and skip remembered keys in the inner loop:

```ts
            for (const p of providers) {
              if (uploaded.has(idempotencyKeyFor(r.requestId, p))) continue
              next = enqueue(
```

Run `rg -n "enqueue\(" src/background/cloud-upload.ts`. For every other call
that enqueues a job whose spec has no `cloudOnly: true`, add the same skip.
Do not skip when the spec is cloud-only: the history verdict needs the row.

Import `idempotencyKeyFor` and `MAX_TERMINAL_JOBS` from
`@/packages/cloud/upload-job` if they are not imported yet.

**Verify**: `bun run test src/background/cloud-upload.test.ts` → all pass,
including the new test.

### Step 6: Full gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

- `uploaded-set.test.ts`: five cases from Step 2.
- `upload-job.test.ts`: one decode case from Step 1 and four cap cases from
  Step 3. Pattern: the existing `capLedger` tests in the same file.
- `cloud-upload.test.ts`: the pruned-backfill case from Step 5. Add one more:
  "boot sweep remembers succeeded rows". Seed a ledger with one `succeeded`
  row and an empty key store, call `resumeOnBoot`, flush, and assert that the
  key store now holds that row's `idempotencyKey`.
- Each new test must be seen failing before its source edit.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "capLedger\(" src/background/cloud-upload.ts` returns no matches
- [ ] `rg -n "decodeUnknownSync\(LedgerSchema\)" src` returns no matches
- [ ] `rg -n "cloudUploadedKeys" src` shows exactly one storage definition
- [ ] The new tests named in the test plan exist and pass
- [ ] `git status --short` shows only in-scope files as newly changed
- [ ] `plans/README.md` status row updated, or the status reported in the reply

## STOP conditions

Stop and report if:

- An excerpt in "Current state" does not match the live file.
- `runSerializedRmw` cannot store a `ReadonlyArray<string>` without a cast.
- A cloud-only code path would need the skip rule to pass a test.
- An existing test fails for a reason other than the two requirement changes
  in Step 3 (unremembered successes stay, `dead` rows stay).
- A verification fails twice after one reasonable fix.
- The fix appears to need a file outside the in-scope list.

## Maintenance notes

- **Owner decision, not planned**: the key set never forgets a media item
  until 20,000 newer keys push it out. If the user deletes a file in Drive or
  reconnects a different account, the extension will not upload that media
  again. Clearing a provider's keys on disconnect would fix that. It needs an
  owner decision because it changes what "already uploaded" means.
- `dead` rows now stay until the user clicks Retry. Each row is about 0.5 KB.
  A user who never retries accumulates them. Watch the ledger size if plan
  019 (ledger read cache) is not yet in place.
- Cloud-only enqueues ignore the key set. A repeat cloud-only save of pruned
  media can still upload twice. Fixing it needs a history verdict that reads
  the key set. That is a separate plan.
- `skipped` rows (source gone) stay prunable. Backfill may fetch such a
  source once more and skip it again.
- Plan 037 adds a `resume` field to `UploadJobSchema`. Run 035 first, then
  rerun 037's drift check.
- Plans 019 and 036 also edit `src/background/cloud-upload.ts`. Run them one
  at a time.
- Reviewer: check that `rememberKeys` runs before any later `capJobs` call
  can drop the row, and that the key store is never sent to Convex.
