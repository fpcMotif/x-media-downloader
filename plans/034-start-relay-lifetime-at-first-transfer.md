# Plan 034: Start the relay job lifetime at the first transfer, not at acceptance

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- backend/convex/relay.ts backend/convex/relayModel.ts backend/convex/relayWorker.ts backend/convex/relay.test.ts`
> The command compares the working tree with the planning commit, so
> uncommitted changes show. If any listed file changed, compare the "Current
> state" excerpts with the live code before you proceed. A mismatch is a STOP
> condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17 (working tree had uncommitted changes, none in the four in-scope files)
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/108

## Why this matters

The Convex relay accepts a Drive upload job and stamps `acceptedAt`. Every
lifetime check compares the current time with `acceptedAt`. The relay runs one
job at a time under one global lease, so a job can wait in the queue for longer
than its lifetime. Such a job fails with "Elapsed-time limit reached" before it
sends one byte. The same happens when the master switch is off for more than an
hour: every accepted job fails on the next claim. A batch of 200 large videos
loses most of its jobs this way. After this plan the clock starts when a job
first gets the lease, so queue wait and master-disable time cost nothing.

## Current state

Files:

- `backend/convex/relayModel.ts` — relay validators and limits. `relayFields`
  is the `relay_jobs` table shape.
- `backend/convex/relay.ts` — public and internal relay functions. `claim`
  grants the global lease. `retry` re-queues a failed job.
- `backend/convex/relayWorker.ts` — the action that moves bytes. `allowed()`
  runs before every outbound request.
- `backend/convex/relay.test.ts` — convex-test suite for the relay.

`backend/convex/relayModel.ts:41-59`:

```ts
export const relayFields = {
  ...relayInput,
  ...relayProgress,
  execution: v.literal('convex'),
  provider: v.literal('gdrive'),
  status: relayState,
  at: v.number(),
  acceptedAt: v.number(),
  epoch: v.number(),
  ...
  maxElapsedMs: v.number(),
  maxRetries: v.number(),
  folderId: v.string(),
}
```

`backend/convex/relay.ts:336` (inside `retry`):

```ts
    if (Date.now() - job.acceptedAt >= job.maxElapsedMs || job.failures >= job.maxRetries)
      return false
```

`backend/convex/relay.ts:352-375` (inside `claim`):

```ts
    if (!c.connected || c.epoch !== job.epoch || now - job.acceptedAt >= job.maxElapsedMs) {
      await ctx.db.patch(id, {
        status: 'failed',
        error:
          !c.connected || c.epoch !== job.epoch
            ? 'Backend Drive authorization revoked'
            : 'Elapsed-time limit reached',
        at: now,
      })
      return null
    }
    if (!c.enabled || process.env.RELAY_ENABLED !== 'true') {
      await ctx.scheduler.runAfter(60_000, wakeRef, { id })
      return null
    }
    const due = Math.max(c.leaseUntil, job.nextAt)
    if (due > now) {
      await ctx.scheduler.runAfter(due - now, wakeRef, { id })
      return null
    }
    const fence = c.fence + 1
    await ctx.db.patch(c._id, { active: id, fence, leaseUntil: now + LEASE_MS })
    await ctx.db.patch(id, { fence, leaseUntil: now + LEASE_MS, status: 'uploading', at: now })
```

`backend/convex/relayWorker.ts:182-184`:

```ts
    const allowed = async () => {
      if (deadline.aborted || Date.now() - job.acceptedAt >= job.maxElapsedMs)
        throw new RelayFailure('Elapsed-time limit reached', true)
```

The elapsed check in `claim` runs before the disabled check. That order is why
a disabled relay fails waiting jobs.

No test in `relay.test.ts` asserts the elapsed limit today.

Binding decision, ADR-0013 (`docs/adr/0013-client-side-cloud-byte-upload.md`):

> Default limits are 512 MiB per source, one hour of total job lifetime, and
> three failures. Job lifetime is not an action timeout. Provider pause closes
> admission but drains accepted jobs. Master disable suspends requests at a
> safe boundary

"Drains accepted jobs" and "suspends" both require that waiting does not kill
a job. The ADR does not say when the hour begins. This plan starts it at the
first lease grant and keeps the one hour default and the three failure cap.

Convex rules that apply (from `backend/convex/_generated/ai/guidelines.md`,
read that file first as `backend/AGENTS.md` requires):

- Every function keeps its `args` validators. Do not remove or loosen one.
- A field added to a table that already holds rows must be `v.optional(...)`.
- `Date.now()` is allowed in mutations and actions. Do not add it to a query.
- `ctx.db.patch` merges shallowly. Patching one field leaves the rest.
- Tests use `convexTest(schema, modules)` with
  `import.meta.glob('./**/*.ts')`, as `relay.test.ts` already does.

Repo rules that apply (root `AGENTS.md`):

- No `@ts-ignore`, `@ts-expect-error`, `oxlint-disable`, or `eslint-disable`.
- No new `as` casts.
- Name numeric constants. Test code may use inline arithmetic for time.

**Hard boundary: never deploy.** Do not run `convex deploy`. Do not run
`convex dev` against any real deployment. Do not call any Convex MCP tool. All
verification in this plan runs in convex-test on the local machine.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Install backend deps | `bun install --cwd backend --frozen-lockfile` | exit 0, `git status --short backend` shows no new changes |
| Backend typecheck | `bun run --cwd backend typecheck` | exit 0 |
| Relay tests | `bun run --cwd backend test convex/relay.test.ts` | all pass |
| All backend tests | `bun run --cwd backend test` | all pass |
| Format check | `bun run fmt:check` | exit 0 |

At planning time the relay tests could not run. The error was
`Cannot find dependency '@edge-runtime/vm'` because backend dependencies were
not installed. The baseline is therefore unverified. Step 1 establishes it.

Package manager is bun. Never use npm or npx.

## Scope

**In scope** (the only files you may modify):

- `backend/convex/relayModel.ts`
- `backend/convex/relay.ts`
- `backend/convex/relayWorker.ts`
- `backend/convex/relay.test.ts`

**Out of scope** (do NOT touch):

- `backend/convex/_generated/**` — generated code.
- `backend/convex/schema.ts` — it spreads `relayFields`, so the new field
  arrives without an edit.
- `publicJob` and `visible()` — the extension decodes that shape. Do not add
  `startedAt` to it.
- `docs/adr/0013-client-side-cloud-byte-upload.md` and every other Markdown
  file except the `plans/README.md` status row.
- Any change that makes `retry` restart the lifetime, or that subtracts
  mid-transfer suspension time. Both are separate owner decisions.
- The extension under `src/`.

## Git workflow

- Branch: `advisor/034-start-relay-lifetime-at-first-transfer`.
- Commit style is conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`. Use
  `fix(relay): start job lifetime at first lease grant`.
- The working tree has uncommitted changes that are not yours. Never revert
  them and never stash them. Stage by explicit path. `backend/package.json`
  had uncommitted changes at planning time. Do not stage it.
- Do NOT push. Do NOT open a PR.

## Comment rule

A `doc-lock` hook can block edits that add or change comments or Markdown.
Write no new comments. Keep every existing comment as written. If the hook
rejects an edit, STOP and report the rejection text. If it rejects the
`plans/README.md` row edit, report the new status in your reply instead.

## Steps

### Step 1: Establish the baseline

Run the install command, then the backend typecheck, then the relay tests.

**Verify**: all three exit 0. Record the number of passing relay tests. If the
install changes any tracked file, or typecheck or tests fail before you have
edited anything, STOP.

### Step 2: Write the failing tests

Append three tests to `backend/convex/relay.test.ts`. Model them on the
existing test "caps failed attempts and ignores duplicate completion delivery"
(lines 155-189). Reuse the file's `claim`, `checkpoint`, `submit`, `status`,
`control`, `secret`, `input`, and `progress` bindings.

```ts
const TWO_HOURS_MS = 2 * 60 * 60 * 1000

it('does not count queue wait against the job lifetime', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const accepted = await t.mutation(submit, input)
  vi.setSystemTime(Date.now() + TWO_HOURS_MS)
  const owner = await t.mutation(claim, { id: accepted.id })
  expect(owner).not.toBeNull()
  expect(owner?.status).toBe('uploading')
})

it('keeps an accepted job alive while the relay is disabled', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const accepted = await t.mutation(submit, input)
  await t.mutation(control, { secret, enabled: false, accepting: true, connected: true })
  vi.setSystemTime(Date.now() + TWO_HOURS_MS)
  expect(await t.mutation(claim, { id: accepted.id })).toBeNull()
  expect(await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })).toEqual([
    expect.objectContaining({ status: 'queued' }),
  ])
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  expect(await t.mutation(claim, { id: accepted.id })).not.toBeNull()
})

it('fails a job once its lifetime since the first claim has elapsed', async () => {
  const t = convexTest(schema, modules)
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const accepted = await t.mutation(submit, input)
  const owner = await t.mutation(claim, { id: accepted.id })
  await t.mutation(checkpoint, {
    id: accepted.id,
    fence: owner?.fence,
    progress,
    release: true,
    completed: false,
    error: 'Transient provider failure',
  })
  vi.setSystemTime(Date.now() + TWO_HOURS_MS)
  expect(await t.mutation(claim, { id: accepted.id })).toBeNull()
  expect(await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })).toEqual([
    expect.objectContaining({ status: 'failed', error: 'Elapsed-time limit reached', failures: 1 }),
  ])
})
```

**Verify**: `bun run --cwd backend test convex/relay.test.ts` → the first two
new tests FAIL (claim returns null, status is `failed`). The third passes
today and is a regression guard. If the first two pass before any source edit,
STOP: the finding no longer holds.

### Step 3: Add the field and the helper

In `backend/convex/relayModel.ts`, add one line to `relayFields` directly
after `acceptedAt: v.number(),`:

```ts
  startedAt: v.optional(v.number()),
```

Add this exported function after `limits()`:

```ts
export function lifetimeExpired(
  job: { startedAt?: number; maxElapsedMs: number },
  now: number,
): boolean {
  return job.startedAt !== undefined && now - job.startedAt >= job.maxElapsedMs
}
```

Existing rows have no `startedAt`. For them the lifetime has not started. A
row that is mid-transfer during the rollout gets `startedAt` at its next
claim. `maxRetries` still bounds it. No migration is needed.

**Verify**: `bun run --cwd backend typecheck` → exit 0.

### Step 4: Use the helper at the three check sites

1. `backend/convex/relay.ts`: add `lifetimeExpired` to the existing import
   from `./relayModel`.
2. In `claim`, replace `now - job.acceptedAt >= job.maxElapsedMs` with
   `lifetimeExpired(job, now)`.
3. In `claim`, change the lease patch on the job to:

   ```ts
   await ctx.db.patch(id, {
     fence,
     leaseUntil: now + LEASE_MS,
     status: 'uploading',
     at: now,
     startedAt: job.startedAt ?? now,
   })
   ```

4. In `retry`, replace `Date.now() - job.acceptedAt >= job.maxElapsedMs` with
   `lifetimeExpired(job, Date.now())`.
5. `backend/convex/relayWorker.ts`: import `lifetimeExpired` from
   `./relayModel` and replace
   `Date.now() - job.acceptedAt >= job.maxElapsedMs` in `allowed()` with
   `lifetimeExpired(job, Date.now())`.

Do not change `acceptedAt` writes or reads anywhere else. `visible()` still
returns `acceptedAt`.

**Verify**:
- `bun run --cwd backend typecheck` → exit 0.
- `bun run --cwd backend test convex/relay.test.ts` → all pass, including the
  three new tests.
- `rg -n "acceptedAt >= " backend/convex` → no matches.

### Step 5: Full backend gate

**Verify**: `bun run --cwd backend test` → all pass. `bun run fmt:check` → exit
0. If format fails, run `bunx oxfmt --write` on the files you changed and
rerun.

## Test plan

- Three new tests in `backend/convex/relay.test.ts` as written in Step 2.
- Tests 1 and 2 must be seen failing in Step 2 and passing in Step 4.
- Test 3 guards the limit that remains. To confirm it can fail, temporarily
  change `lifetimeExpired` to return `false`, see test 3 fail, then restore.

## Done criteria

- [ ] `bun run --cwd backend typecheck` exits 0
- [ ] `bun run --cwd backend test` exits 0 and the three new tests pass
- [ ] `rg -n "acceptedAt >= " backend/convex` returns no matches
- [ ] `rg -n "lifetimeExpired" backend/convex` shows one definition and three uses
- [ ] `git status --short` shows only the four in-scope files as newly changed
- [ ] No deploy command was run
- [ ] `plans/README.md` status row updated, or the status reported in the reply

## STOP conditions

Stop and report if:

- You have no written confirmation from the repository owner that the relay
  lifetime starts at the first lease grant. ADR-0013 says "one hour of total
  job lifetime" and does not say when the hour begins. Report that this
  decision is pending and change nothing.
- Backend install, typecheck, or tests fail before your first edit.
- An excerpt in "Current state" does not match the live file.
- The worker's `job` value has no `startedAt` property at the type level. That
  means `claim` no longer returns `relayDoc`.
- The fix appears to need a change to `schema.ts`, `publicJob`, or any file
  under `src/`.
- A verification fails twice after one reasonable fix.
- Any step would require a deploy to verify.

## Maintenance notes

- A job that never gets the lease now waits without limit. The extension shows
  it as queued. If the owner wants a queue-wait limit, add a separate, larger
  limit. Do not reuse `maxElapsedMs`. This is an owner decision.
- `retry` does not restart the lifetime. A job that failed on the lifetime
  limit stays failed, and the user must submit it again. Changing that is an
  owner decision.
- Time spent suspended in the middle of a transfer still counts. Changing that
  needs an accumulated-active-time field and an owner decision.
- After the owner confirms the rule, ADR-0013 should say that the hour starts
  at the first lease grant. That edit is docs work and is not part of this
  plan.
- Reviewer: check that the elapsed check in `claim` still runs before the
  disabled check, and that no query calls `Date.now()`.
