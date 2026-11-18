# Plan 038: Keep one failed relay status call from stopping reconcile

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/background/remote-upload.ts src/background/remote-upload.test.ts src/background/cloud-upload.ts src/background/cloud-upload.test.ts`
> The command compares the working tree with the planning commit, so
> uncommitted changes show. All four files had uncommitted changes when this
> plan was written. Plans 017 and 018 also edit `remote-upload.ts`. If plan
> 017 is DONE, read the note in "Current state" before you start. Compare
> every excerpt with the live file. A mismatch is a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. Run after plan 017 if both are scheduled.
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17 (working tree had uncommitted changes)
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/112

## Why this matters

Reconcile asks the Convex relay for the state of every unfinished receipt.
Today it sends one query per receipt, one after another, with no error
handling. One rejected query stops the walk, so every later receipt keeps a
stale state. The caller `reconcileCloudOnlyHistory` awaits reconcile first
and then runs the local history sweep. When reconcile throws, the local sweep
never runs, so finished browser uploads never reach Download History. A
receipt that points at an old deployment with a rotated secret blocks
everything forever. After this plan each batch fails alone, the walk
continues, and the local sweep always runs.

## Current state

Files:

- `src/background/remote-upload.ts` — relay client. `reconcile` is at lines
  313-339.
- `src/background/remote-upload.test.ts` — tests. `memoryStore()`, a
  `settings` fixture, and `fetchImpl` stubs that return
  `Response.json({ status: 'success', value })`. The test near line 211
  ("reconciles offline completion once") is the pattern.
- `src/background/cloud-upload.ts` — `reconcileCloudOnlyHistory` near line
  804.
- `src/background/cloud-upload.test.ts` — harness `makeCU`, `fakeLedger`,
  `fakeRuntime`.

`src/background/remote-upload.ts:313-339`:

```ts
  const reconcile = () =>
    queue.run(async () => {
      const settings = await deps.getSettings()
      const rows = (await read()).filter((row) => row.historyOutcome !== 'completed')
      const reconcileNext = async (index: number): Promise<void> => {
        const row = rows[index]
        if (!row) return
        const statuses = Schema.decodeUnknownSync(Status)(
          await call(
            settings,
            'query',
            'relay:status',
            { deviceId: row.deviceId, mediaIds: [row.mediaId] },
            row.deploymentUrl,
            row.syncSecret,
          ),
        )
        const status = statuses[0]
        const kind = status?.status === 'uploading' ? 'queued' : status?.status
        if (status && kind && row.historyOutcome !== kind && row.historyOutcome !== 'completed') {
          await deps.onHistoryNotice({ mediaId: row.mediaId, kind, at: status.at })
          await patchReceipt(row.mediaId, { accepted: true, historyOutcome: kind })
        }
        await reconcileNext(index + 1)
      }
      await reconcileNext(0)
    })
```

`src/background/cloud-upload.ts`, `reconcileCloudOnlyHistory`:

```ts
  const reconcileCloudOnlyHistory = (): Promise<void> =>
    uploadQueue.run(async () => {
      await remote.reconcile()
      const settings = await getSettings()
      const ledger = await readLedger()
      const mediaIds = [
        ...new Set(
          ledger.filter((job) => job.cloudOnly && isTerminal(job)).map((job) => job.mediaId),
        ),
      ]
      await Promise.all(
        mediaIds.map((mediaId) => notifyCloudHistoryOnce(settings, ledger, mediaId)),
      )
    })
```

The relay `status` query accepts up to 100 `mediaIds` per call
(`backend/convex/relay.ts`). It returns one entry per job it finds, and each
entry carries its `mediaId`.

`cloudUploadStatus` in `cloud-upload.ts` calls `remote.reconcile()` inside a
`try` and shows the error message as `relayError`. Reconcile must therefore
still reject when something failed.

**If plan 017 is DONE**: it already batches the status query. Keep its
batching. Apply only the per-batch `try`, the summary error, and Step 3.

Binding decisions, ADR-0013:

- The receipt "preserves execution ownership". "Accepted server jobs never
  enter the browser uploader or disk queue".
- "Ordinary downloads use retained local receipt accounting".

Both lines mean that receipts must stay. This plan does not delete or prune
any receipt.

Repo rules (root `AGENTS.md`): no `oxlint-disable`, `eslint-disable`,
`@ts-ignore`, `@ts-expect-error`. A new `await` inside a loop would need a
forbidden suppression, so keep the recursive style of `reconcileNext`. No new
`as` casts. Name numeric constants.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Format check | `bun run fmt:check` | exit 0 |
| Focused tests | `bun run test <path>` | all pass |
| Full gate | `bun run check` | exit 0 |
| Build | `bun run build` | exit 0 |

If the format check fails, run `bunx oxfmt --write <files you changed>`.
Package manager is bun. Never use npm or npx.

## Scope

**In scope** (the only files you may modify):

- `src/background/remote-upload.ts`
- `src/background/remote-upload.test.ts`
- `src/background/cloud-upload.ts`
- `src/background/cloud-upload.test.ts`

**Out of scope** (do NOT touch):

- Pruning or deleting receipts. See "Maintenance notes".
- `owns()`, `budget()`, `summary()`, `submitBatch`, and `retry` in
  `remote-upload.ts`.
- How often reconcile runs. Plans 017 and 018 own the trigger rate.
- `backend/`. The `status` query already supports 100 ids.
- Every Markdown file except the `plans/README.md` status row.

## Git workflow

- Branch: `advisor/038-isolate-relay-reconcile-failures`.
- Conventional commits, for example
  `fix(relay): isolate reconcile failures per status batch`.
- The working tree has uncommitted changes that are not yours. Never revert
  them and never stash them. Before you start, run `git status --short` on
  each in-scope path. If a file already shows changes, make your edits but do
  not commit that file. Report it as edited and uncommitted. Stage only by
  explicit path.
- Do NOT push. Do NOT open a PR.

## Comment rule

A `doc-lock` hook can block edits that add or change comments or Markdown.
Write no new comments. Keep every existing comment as written. If the hook
rejects an edit, STOP and report the rejection text.

## Steps

### Step 1: Write the failing reconcile tests

In `src/background/remote-upload.test.ts`, modeled on the test near line 211:

1. "reconcile continues past a failing deployment". Seed two unfinished
   receipts with different `deploymentUrl` values. The `fetchImpl` stub
   rejects for the first URL and answers `completed` for the second. Call
   `reconcile()` and expect it to reject. Then assert that
   `onHistoryNotice` was called for the second receipt and that the stored
   second receipt has `historyOutcome: 'completed'`.
2. "reconcile batches status queries". Seed 150 unfinished receipts for one
   deployment and device. The stub counts `relay:status` requests and answers
   an empty list. Expect exactly 2 requests. Read the request body to check
   that the first carries 100 `mediaIds` and the second 50.
3. "reconcile writes the store once per batch". With the 150 receipts and a
   stub that answers `completed` for all, wrap `memoryStore()` to count
   `set` calls during reconcile. Expect 2.

**Verify**: `bun run test src/background/remote-upload.test.ts` → the three
new tests FAIL. Test 1 fails because the second receipt is untouched. Test 2
counts 150 requests.

### Step 2: Rewrite the reconcile walk

In `remote-upload.ts`, add `const STATUS_BATCH = 100` near the other
constants. Replace the body of `reconcile` with this shape:

```ts
  const reconcile = () =>
    queue.run(async () => {
      const settings = await deps.getSettings()
      const rows = (await read()).filter((row) => row.historyOutcome !== 'completed')
      const groups = Map.groupBy(rows, (row) => `${row.deploymentUrl}\n${row.deviceId}`)
      const batches = [...groups.values()].flatMap((group) =>
        Array.from({ length: Math.ceil(group.length / STATUS_BATCH) }, (_unused, index) =>
          group.slice(index * STATUS_BATCH, (index + 1) * STATUS_BATCH),
        ),
      )
      const failures: Array<string> = []
      const reconcileBatch = async (index: number): Promise<void> => {
        const batch = batches[index]
        const first = batch?.[0]
        if (!batch || !first) return
        try {
          const statuses = Schema.decodeUnknownSync(Status)(
            await call(
              settings,
              'query',
              'relay:status',
              { deviceId: first.deviceId, mediaIds: batch.map((row) => row.mediaId) },
              first.deploymentUrl,
              first.syncSecret,
            ),
          )
          await applyStatuses(batch, statuses)
        } catch (error) {
          failures.push(error instanceof Error ? error.message : String(error))
        }
        await reconcileBatch(index + 1)
      }
      await reconcileBatch(0)
      if (failures.length > 0)
        throw new Error(
          `Relay reconcile failed for ${failures.length} of ${batches.length} batches: ${failures[0]}`,
        )
    })
```

If `Map.groupBy` is not available to the type checker, build the map with
`rows.reduce` into a `Map<string, Array<Receipt>>`.

Receipts in one group share a deployment and device. They may differ in
`syncSecret` only if the secret was rotated. Using the first row's secret is
acceptable: a wrong secret fails that batch only.

Add `applyStatuses` above `reconcile`. It must:

1. Index `statuses` by `mediaId`.
2. For each row in the batch, compute `kind` with the same rule as today:
   `status.status === 'uploading' ? 'queued' : status.status`.
3. Collect the rows where `status` exists, `kind` is set, and
   `row.historyOutcome !== kind`.
4. Call `deps.onHistoryNotice({ mediaId, kind, at: status.at })` for each
   collected row. Use `Promise.all`.
5. Write all receipt changes in ONE store write. Open `patchReceipt` and
   reuse its read-modify-write helper with a function that patches every
   collected `mediaId` to `{ accepted: true, historyOutcome: kind }`. If
   `patchReceipt` can only patch one row and has no shared helper, add a
   sibling `patchReceipts(patches: ReadonlyMap<string, Partial<Receipt>>)`
   built the same way.

Notices go out before the store write, as today. A crash between the two
repeats the notice on the next reconcile. That is the current behavior.

**Verify**: `bun run test src/background/remote-upload.test.ts` → all pass.
`bun run typecheck` and `bun run lint` → exit 0.

### Step 3: Always run the local sweep

Test first, in `src/background/cloud-upload.test.ts`:

- Name: "runs the local history sweep when relay reconcile fails".
- Arrange: a ledger with one terminal cloud-only job whose history notice was
  not sent yet. Find an existing cloud-only history test with
  `rg -n "cloudOnly" src/background/cloud-upload.test.ts` and copy its
  arrangement. Make the relay reconcile reject. If `makeCU` has no seam for
  the remote port, make the `fetchImpl` stub reject for the relay URL and
  seed one unfinished receipt.
- Act: call `reconcileCloudOnlyHistory()` and expect it to reject.
- Assert: the history notice for the local job was still sent.

**Verify**: the test FAILS before the source edit.

Then change `reconcileCloudOnlyHistory` to:

```ts
  const reconcileCloudOnlyHistory = (): Promise<void> =>
    uploadQueue.run(async () => {
      const relayFailure = await remote.reconcile().then(
        () => null,
        (error: Error) => error,
      )
      const settings = await getSettings()
      const ledger = await readLedger()
      const mediaIds = [
        ...new Set(
          ledger.filter((job) => job.cloudOnly && isTerminal(job)).map((job) => job.mediaId),
        ),
      ]
      await Promise.all(
        mediaIds.map((mediaId) => notifyCloudHistoryOnce(settings, ledger, mediaId)),
      )
      if (relayFailure !== null) throw relayFailure
    })
```

**Verify**: `bun run test src/background/cloud-upload.test.ts` → all pass.

### Step 4: Full gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

- `remote-upload.test.ts`: three tests from Step 1. Pattern: the test near
  line 211.
- `cloud-upload.test.ts`: one test from Step 3.
- Each new test must be seen failing before its source edit.
- The existing test "reconciles offline completion once" must still pass
  unchanged. It guards the notice-once rule.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "mediaIds: \[row.mediaId\]" src/background/remote-upload.ts` returns no matches
- [ ] The four new tests exist and pass
- [ ] `rg -n "oxlint-disable" src/background/remote-upload.ts` shows no new line compared with `git diff`
- [ ] `git status --short` shows only in-scope files as newly changed
- [ ] `plans/README.md` status row updated, or the status reported in the reply

## STOP conditions

Stop and report if:

- An excerpt in "Current state" does not match the live file and plan 017 is
  not the cause.
- The relay `status` query in `backend/convex/relay.ts` no longer accepts 100
  `mediaIds`, or its entries carry no `mediaId`.
- A single store write for a batch is not possible without changing `owns()`
  or `budget()`.
- Any step would remove a receipt from the store.
- A verification fails twice after one reasonable fix.
- The fix appears to need a file outside the in-scope list.

## Maintenance notes

- **Owner decision, not planned**: the audit proposed pruning completed
  receipts so the store stops growing. Receipts are how `owns()` keeps
  relay-owned media out of the browser uploader, and how `budget()` counts
  the day's bytes. ADR-0013 states both rules. Pruning needs an ADR change
  first, for example a compact ownership set that outlives the receipt.
- Reconcile still runs on every settings change and on every status read.
  Plans 017 and 018 reduce that rate. With batching, each run now costs one
  request per 100 receipts instead of one per receipt.
- A receipt for a deployment that no longer exists fails its batch on every
  run. The error is now visible as `relayError` and no longer blocks other
  receipts. Giving the user a way to drop such a receipt is a product
  decision.
- Reviewer: check that reconcile still rejects when any batch failed, and
  that the store write happens after the notices.
