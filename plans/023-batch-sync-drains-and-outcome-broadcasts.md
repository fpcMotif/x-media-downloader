# Plan 023: Sync events that arrive during a drain ride the same drain, and (optionally) outcome broadcasts share one tab query

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7456911 -- src/background/sync-outbox.ts src/background/sync-outbox.test.ts src/background/tab-broadcaster.ts src/background/tab-broadcaster.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S (Part A), S (Part B, optional)
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `7456911`, 2026-11-16

Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

**Part A.** With Cloud Sync on, every settled download calls `recordSync`.
Each call queues one task that appends its events and then drains. The append
sits inside the queued task, behind the previous task's network call. So a
drain can only ever see its own one or two events. Fifty downloads produce
fifty HTTPS calls and about 150 storage operations. The outbox already sends
up to 64 events per call; it never gets the chance.

After Part A the append happens at once on the storage queue, and at most one
drain is waiting at any time. Events that arrive while a network call is in
flight are picked up by the same drain loop. No timer is added, so no event
waits in memory.

**Part B (optional).** Every settled download also runs `tabs.query` and then
messages every X/Instagram/Threads tab. Part B lets outcomes that settle
within a short window share one `tabs.query`. The gain is small (`tabs.query`
is cheap). You may stop after Part A and mark the plan DONE with "Part B
skipped".

The original finding proposed one batched message per tab. That is NOT in
this plan: ADR-0014 fixes the wire message as one
`TransferOutcome { requestId, outcome, at }` per outcome. Changing the shape
needs the owner to rewrite that ADR first.

## Current state

Files:

- `src/background/sync-outbox.ts` — the Cloud Sync outbox shell.
- `src/background/sync-outbox.test.ts` — its tests, through injected fakes.
- `src/background/tab-broadcaster.ts` — tab messaging (Part B).
- `src/background/tab-broadcaster.test.ts` — its tests (Part B).
- `src/packages/kernel/serial-queue.ts` — `makeSerialQueue`. Read only.
- `src/packages/kernel/durable-store.ts` — `runSerializedRmw`. Read only.

The two queues, `src/background/sync-outbox.ts:147-151`:

```ts
  const outboxQueue = makeSerialQueue(deps.queueError('outbox'))
  const storeQueue = makeSerialQueue(deps.queueError('outboxStore'))

  const readOutbox = (): Promise<ReturnType<typeof decodeOutbox>> =>
    storeQueue.run(async () => decodeOutbox(await outbox.get()))
```

`outboxQueue` orders whole drains. `storeQueue` orders each storage
read-modify-write. They are separate chains.

The drain loop, `src/background/sync-outbox.ts:164-207` (shortened):

```ts
  const drainOutbox = async (settings: Settings): Promise<void> => {
    const port = connect(settings)
    // oxlint-disable no-await-in-loop -- FIFO: each batch depends on the previous outcome
    for (;;) {
      const state = await readOutbox()
      if (!isReady(state, now())) {
        await scheduleSyncWake(state)
        return
      }
      const batch = takeBatch(state)
      if (batch.length === 0) {
        await scheduleSyncWake(state)
        return
      }
      try {
        await port.mutation('sync:recordEvents', {
          events: batch,
          secret: settings.convexSyncSecret,
        })
        const sentIds = batch.map((e) => e.eventId)
        const next = await runSerializedRmw(storeQueue, outbox, decodeOutbox, (current) =>
          markDrained(current, sentIds),
        )
        // … status.set(ok)
      } catch (err) {
        // … markFailed, status.set(failed), scheduleSyncWake, return
      }
    }
    // oxlint-enable no-await-in-loop
  }
```

The loop re-reads the outbox after every successful call. Anything appended
while `port.mutation` was in flight is sent on the next pass of the same
loop. `markDrained` removes events by id, so a drain never removes an event
it did not send.

`clearOutbox`, `src/background/sync-outbox.ts:259-270`, is the one other
writer:

```ts
  const clearOutbox = (): void => {
    outboxQueue.push(async () => {
      await runSerializedRmw(
        storeQueue,
        outbox,
        (raw) => raw,
        () => null,
      )
      await status.set(null)
      await alarms.clear(SYNC_ALARM)
    })
  }
```

Its wipe runs inside an `outboxQueue` task, so it waits behind any drain that
is in flight. Today a `recordSync` called after `clearOutbox` also waits on
`outboxQueue`, so its append lands after the wipe and survives. An append
that skips `outboxQueue` would land BEFORE the queued wipe. If the in-flight
drain then fails or is in backoff, the wipe erases that event unsent.
Step A2 keeps the old ordering while a clear is queued.

The existing `oxlint-disable` / `oxlint-enable` pair above is pre-existing.
Leave it exactly as it is. Do not add another.

`recordSync`, `src/background/sync-outbox.ts:246-257`:

```ts
  /** Mirror state transitions when Cloud Sync is on. Fire-and-forget: downloads
   *  never block on — or fail because of — the cloud.
   *
   * @see ADR-0009
   */
  const recordSync = (settings: Settings, events: ReadonlyArray<SyncEvent>): void => {
    if (!isSyncConfigured(settings) || events.length === 0) return
    outboxQueue.push(async () => {
      await runSerializedRmw(storeQueue, outbox, decodeOutbox, (state) => append(state, events))
      await drainOutbox(settings)
    })
  }
```

Queue semantics, `src/packages/kernel/serial-queue.ts:50-61`:

```ts
    push(task) {
      tail = tail
        .then(task)
        .then(undefined, (reason) => observe(reason instanceof Error ? reason : String(reason)))
    },
    run(task) {
      const result = tail.then(task)
      tail = result.then(undefined, (reason) =>
        observe(reason instanceof Error ? reason : String(reason)),
      )
      return result
    },
```

`push` never starts the task synchronously (it chains on a promise). `run`
returns a promise that rejects with the task's error AND reports it to the
queue's `onError`. The caller must handle the returned promise.

`runSerializedRmw`, `src/packages/kernel/durable-store.ts:9-19`:

```ts
export const runSerializedRmw = <S extends JsonValue>(
  queue: SerialQueue,
  store: DurableStore,
  decode: (raw: JsonValue) => S,
  update: (state: S) => S | Promise<S>,
): Promise<S> =>
  queue.run(async () => {
    const next = await update(decode(await store.get()))
    await store.set(next)
    return next
  })
```

Existing tests for `recordSync`, `src/background/sync-outbox.test.ts:259-287`:

```ts
  it('appends and drains when configured', async () => {
    const outbox = fakeStore<JsonValue>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    makeSO({ outbox, connect: () => ({ mutation }) }).recordSync(configured(), [evt('e1')])
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    expect(decodeOutbox(outbox.value).pending).toHaveLength(0) // appended then drained
  })

  it('serializes interleaved recordSync calls so neither event is lost', async () => {
    const outbox = fakeStore<JsonValue>(null, { delay: true })
    // …
    so.recordSync(configured(), [evt('a')])
    so.recordSync(configured(), [evt('b')])
    // Deterministic flush: run() chains onto the same serial queue, so it resolves
    // only after both recordSync tasks (append + drain) have run — no timing race.
    await so.outboxQueue.run(async () => {})
    expect(sent).toContain('a')
    expect(sent).toContain('b')
  })
```

The test helpers `makeSO`, `fakeStore`, `configured`, `evt`, `okPort` are at
`src/background/sync-outbox.test.ts:26-99`. Use them.

ADR lines to stay consistent with:

- ADR-0020 (`docs/adr/0020-durable-drain-storage-and-sync-wake.md:22-24`):
  "Add a `sync-outbox-drain` browser alarm. Sync schedules it at the stored
  backoff deadline, clears it when no delayed work remains, and drains through
  its existing serial queue when the alarm fires." Part A keeps draining
  through `outboxQueue` and does not touch the alarm logic.
- ADR-0014 (`docs/adr/0014-transfer-tracker-outcome-backlink.md:43-45`):
  "**A backlink message** (`TransferOutcome { requestId, outcome, at }`,
  schema/index.ts): broadcast fire-and-forget to every open X tab on a
  terminal browser outcome." Part B keeps this exact message, one per
  outcome, to every tab.

`tab-broadcaster.ts` and its test hold uncommitted edits, so their line
numbers are approximate. Locate each edit by the quoted code.

Part B code, `src/background/tab-broadcaster.ts` near lines 483-501:

```ts
  const broadcastToXTabs = async (message: Message): Promise<void> => {
    const ids = await queryXTabs()
    await Promise.all(ids.map((id) => tabs.sendTabMessage(id, message).catch(() => {})))
  }

  const reportTransferOutcome = (
    requestId: string,
    outcome: 'complete' | 'failed',
    at: number,
  ): void => {
    if (requestId.endsWith('.json')) return
    // `.catch` so a tabs.query failure during SW teardown is a silent no-op (the
    // same degraded outcome as no tab receiving it), never an unhandled rejection.
    void broadcastToXTabs({ _tag: 'TransferOutcome', requestId, outcome, at }).catch(() => {})
  }
```

The clock seam is declared at `tab-broadcaster.ts` near lines 112-114 and
resolved near lines 512-515, AFTER `reportTransferOutcome`:

```ts
  const clock = deps.clock ?? {
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
```

Part B tests today, `src/background/tab-broadcaster.test.ts` near lines
1279-1299:

```ts
describe('reportTransferOutcome', () => {
  it('fans the terminal outcome out to every open X tab', async () => {
    const tabs = fakeTabs([1, 2])
    makeTabBroadcaster(tabs).reportTransferOutcome('req-1', 'complete', 1234)
    await tick() // fire-and-forget
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2])
    // …
  })
```

Repo conventions that apply (from `AGENTS.md`):

- No new `oxlint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. Prefer narrowing.
- `unknown` is banned in parameters, returns and type aliases.
- Named constants, not magic numbers.
- Always handle a returned promise. `async/await` over promise chains where an
  async function exists.
- Tests are vitest with assertions inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Format check | `bun run fmt:check` | exit 0 |
| Boundaries | `bun run lint:boundaries` | exit 0 |
| Focused tests | `bun run test <path/to/file.test.ts>` | all pass |
| Full gate | `bun run check` | exit 0 |
| Build | `bun run build` | exit 0 |

Package manager is bun. Never use npm or npx.

## Scope

**In scope** (the only files you should modify):

- `src/background/sync-outbox.ts` (only `recordSync`, two new local
  variables, and the counter lines in `clearOutbox` shown in Step A2)
- `src/background/sync-outbox.test.ts`
- `plans/README.md` (only this plan's status row in the
  "Performance plans (012–023)" table)
- Part B only: `src/background/tab-broadcaster.ts`,
  `src/background/tab-broadcaster.test.ts`

**Out of scope** (do NOT touch):

- `drainOutbox`, `scheduleSyncWake`, `runSyncConnectionTest`, and the alarm
  logic. In `clearOutbox`, only the counter lines from Step A2 change; its
  three existing statements stay as they are.
- `src/packages/sync/outbox.ts` — the pure reducer and its batch size of 64.
- `src/packages/schema/index.ts` — no new message shape. `TransferOutcome`
  stays as is (ADR-0014).
- `src/entrypoints/overlay.content/handlers.ts` — the content side does not
  change.
- `src/entrypoints/background.ts` — call sites of `recordSync` and
  `reportTransferOutcome` do not change.
- `broadcastToXTabs` itself and its other caller (`SavedStatusUpdate`).

## Git workflow

- Branch: `advisor/023-batch-sync-drains-and-outcome-broadcasts`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `perf(sync): …` for Part A and `perf(background): …` for Part B. One
  commit per part.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes, and some sit inside this
  plan's in-scope files. At planning time
  `src/background/tab-broadcaster.ts` and
  `src/background/tab-broadcaster.test.ts` (Part B) already had uncommitted
  edits. Never revert or stash them.
- Before editing, run the drift-check command from the top of this plan and
  note which in-scope files already show uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Leave
  this plan's edits unstaged in that file and name the file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage them by
  path.

## Steps

### Part A

#### Step A1: Write the failing tests

In `src/background/sync-outbox.test.ts`, inside
`describe('recordSync — gating', …)`, add:

1. **A same-tick burst is one network call.**

```ts
  it('sends a same-tick burst of recordSync calls in one mutation', async () => {
    const outbox = fakeStore<JsonValue>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, connect: () => ({ mutation }) })
    for (const id of ['a', 'b', 'c', 'd', 'e']) so.recordSync(configured(), [evt(id)])
    await so.outboxQueue.run(async () => {})
    expect(mutation).toHaveBeenCalledTimes(1)
    const [, args] = mutation.mock.calls[0]!
    expect(args.events).toHaveLength(5)
    expect(decodeOutbox(outbox.value).pending).toHaveLength(0)
  })
```

   The flush is `await so.outboxQueue.run(async () => {})`. It resolves only
   after every drain queued before it has finished, and each drain's first
   read waits on `storeQueue` behind the five appends. Do not gate this test
   on "the outbox is empty": the outbox starts as `null`, so that check
   passes before anything has run.

   Expected value source: the requirement "N events recorded before a drain
   starts are sent in one call" (N = 5 is below the batch size of 64). On the
   current code this test fails with 5 calls.

2. **Events recorded during an in-flight call join the next pass.**

```ts
  it('sends events recorded during an in-flight call in one follow-up mutation', async () => {
    const outbox = fakeStore<JsonValue>(null)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const mutation = vi.fn<ConvexPort['mutation']>(async () => {
      calls += 1
      if (calls === 1) await gate
      return {}
    })
    const so = makeSO({ outbox, connect: () => ({ mutation }) })
    so.recordSync(configured(), [evt('e1')])
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    for (const id of ['e2', 'e3', 'e4']) so.recordSync(configured(), [evt(id)])
    release()
    await so.outboxQueue.run(async () => {})
    expect(mutation).toHaveBeenCalledTimes(2)
    const [, args] = mutation.mock.calls[1]!
    expect(args.events).toHaveLength(3)
  })
```

   The `vi.waitFor` here gates on the network-call count, which is a real
   signal. On the current code this test fails with 4 calls.

3. **A failed append is reported, not thrown.** `fakeStore` cannot reject, so
   wrap it:

```ts
  it('reports a failed append through the queue observer', async () => {
    const base = fakeStore<JsonValue>(null)
    let failNextSet = true
    const outbox = {
      get: () => base.get(),
      set: async (value: JsonValue) => {
        if (failNextSet) {
          failNextSet = false
          throw new Error('storage write failed')
        }
        await base.set(value)
      },
    }
    const onError = vi.fn<(err: Error) => void>()
    const so = makeSO({ outbox, queueError: () => onError })
    so.recordSync(configured(), [evt('e1')])
    await so.outboxQueue.run(async () => {})
    await tick()
    expect(onError).toHaveBeenCalled()
  })
```

   Vitest fails a run on an unhandled rejection, so this test also proves the
   rejected append is handled. It passes on the current code too; it guards
   Step A2.

4. **A `recordSync` made after `clearOutbox` survives the clear.**

```ts
  it('keeps an event recorded after clearOutbox while a drain is in flight', async () => {
    const outbox = fakeStore<JsonValue>(null)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const sent: string[] = []
    const mutation = vi.fn<ConvexPort['mutation']>(async (_name, args) => {
      calls += 1
      if (calls === 1) {
        await gate
        throw new Error('offline')
      }
      const { events } = args
      if (Array.isArray(events))
        for (const e of events) if (isJsonObject(e) && hasRequestId(e)) sent.push(e.requestId)
      return {}
    })
    const so = makeSO({ outbox, connect: () => ({ mutation }) })
    so.recordSync(configured(), [evt('before')])
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    so.clearOutbox()
    so.recordSync(configured(), [evt('after')])
    release()
    await so.outboxQueue.run(async () => {})
    expect(sent).toContain('after')
  })
```

   The first call must FAIL. A failed drain stops, the queued clear then
   wipes the outbox, and only an append that lands after the wipe is sent.
   This passes on the current code. It fails on a version of Step A2 that
   appends directly while a clear is queued (the event is wiped and never
   sent). It is the guard for the ordering rule in Step A2.

If `args.events` does not typecheck in tests 1 and 2, narrow it the way the
existing test `'serializes interleaved recordSync calls so neither event is
lost'` does (`Array.isArray(events)`), not with `as`.

**Verify**: `bun run test src/background/sync-outbox.test.ts` → tests 1 and 2
FAIL with the call counts above; tests 3 and 4 and every pre-existing test
pass. This red state is required before Step A2.

#### Step A2: Append at once and keep at most one drain waiting

In `src/background/sync-outbox.ts`, inside `makeSyncOutbox`, replace the body
of `recordSync` (keep its JSDoc block untouched) with this shape:

```ts
  let drainQueued = false
  let clearsQueued = 0

  const recordSync = (settings: Settings, events: ReadonlyArray<SyncEvent>): void => {
    if (!isSyncConfigured(settings) || events.length === 0) return
    if (clearsQueued > 0) {
      outboxQueue.push(async () => {
        await runSerializedRmw(storeQueue, outbox, decodeOutbox, (state) => append(state, events))
        await drainOutbox(settings)
      })
      return
    }
    void runSerializedRmw(storeQueue, outbox, decodeOutbox, (state) =>
      append(state, events),
    ).catch(() => {})
    if (drainQueued) return
    drainQueued = true
    outboxQueue.push(async () => {
      drainQueued = false
      await drainOutbox(settings)
    })
  }
```

And change `clearOutbox` to count itself while it waits. Its three existing
statements stay in the same order, now inside a `try`:

```ts
  const clearOutbox = (): void => {
    clearsQueued += 1
    outboxQueue.push(async () => {
      try {
        await runSerializedRmw(
          storeQueue,
          outbox,
          (raw) => raw,
          () => null,
        )
        await status.set(null)
        await alarms.clear(SYNC_ALARM)
      } finally {
        clearsQueued -= 1
      }
    })
  }
```

Why each line is there:

- While a clear is queued (`clearsQueued > 0`), `recordSync` takes the old
  path: append and drain inside one `outboxQueue` task. That task runs after
  the queued wipe, so the event survives, exactly as today. Test 4 pins this.
  The `finally` returns the counter even if the wipe fails.

- The append goes straight onto `storeQueue`. It no longer waits behind a
  drain's network call. A failure is already reported once by `storeQueue`'s
  own `onError` (`deps.queueError('outboxStore')`), because `run` reports
  before it rejects. The `.catch(() => {})` only stops the second, unhandled
  copy of the same rejection. If the lint gate rejects an empty catch body,
  STOP and report; do not silence the rule.
- `drainQueued` is cleared at the START of the drain task. An event recorded
  after that point queues a fresh drain. An event recorded before it is
  already on `storeQueue` ahead of the drain's first `readOutbox()`, so that
  drain sees it.
- `outboxQueue.push` never runs the task synchronously, so a same-tick burst
  sets the flag once and queues one drain.

Place `let drainQueued = false` and `let clearsQueued = 0` directly above the JSDoc block of
`recordSync`.

**Verify**: `bun run test src/background/sync-outbox.test.ts` → all pass,
including the four new tests and both pre-existing `recordSync` tests.

#### Step A3: Gate

**Verify**: `bun run check` → exit 0.

You may stop here. If you stop, set the README status to
`DONE (Part A; Part B skipped)`.

### Part B (optional)

#### Step B1: Write the failing test

In `src/background/tab-broadcaster.test.ts`, inside
`describe('reportTransferOutcome', …)`, add a test that uses an injected
clock whose `sleep` you control:

```ts
  it('shares one tab query across outcomes that settle within the coalesce window', async () => {
    const tabs = fakeTabs([1, 2])
    let wake!: () => void
    const clock = {
      sleep: () => new Promise<void>((resolve) => { wake = resolve }),
      now: () => 0,
    }
    const tb = makeTabBroadcaster(tabs, { clock })
    tb.reportTransferOutcome('req-1', 'complete', 1)
    tb.reportTransferOutcome('req-2', 'failed', 2)
    tb.reportTransferOutcome('req-3', 'complete', 3)
    wake()
    await tick()
    expect(tabs.queryXTabs).toHaveBeenCalledTimes(1)
    expect(tabs.sent).toHaveLength(6)
  })
```

Check how `fakeTabs` exposes its query spy before writing the assertion (read
the helper near the top of the test file) and adapt the spy name. The
expectation comes from the requirement: 3 outcomes × 2 tabs = 6
`TransferOutcome` messages (ADR-0014 keeps one message per outcome per tab),
with 1 tab query instead of 3.

Update the two existing tests in that `describe` so they pass a clock whose
`sleep` resolves immediately:
`{ sleep: async () => {}, now: () => 0 }`.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → the new
test FAILS (3 queries); the rest pass.

#### Step B2: Coalesce the tab query

In `src/background/tab-broadcaster.ts`:

1. Add a module-level constant near the other timing constants:

```ts
const OUTCOME_COALESCE_MS = 150
```

2. Move the `const clock = deps.clock ?? {…}` statement (near lines 512-515) up so
   it sits before `broadcastToXTabs`. Move the statement only. The comment
   block above its old position (ending "…one settled download at a time.")
   describes the Release-tab section, not the clock; leave that comment where
   it is.

3. Replace the body of `reportTransferOutcome` (keep its JSDoc block) with:

```ts
  let queuedOutcomes: TransferOutcome[] = []

  const flushOutcomes = async (): Promise<void> => {
    await clock.sleep(OUTCOME_COALESCE_MS)
    const outcomes = queuedOutcomes
    queuedOutcomes = []
    const ids = await queryXTabs()
    await Promise.all(
      ids.flatMap((id) =>
        outcomes.map((message) => tabs.sendTabMessage(id, message).catch(() => {})),
      ),
    )
  }

  const reportTransferOutcome = (
    requestId: string,
    outcome: 'complete' | 'failed',
    at: number,
  ): void => {
    if (requestId.endsWith('.json')) return
    queuedOutcomes.push({ _tag: 'TransferOutcome', requestId, outcome, at })
    if (queuedOutcomes.length > 1) return
    // `.catch` so a tabs.query failure during SW teardown is a silent no-op (the
    // same degraded outcome as no tab receiving it), never an unhandled rejection.
    void flushOutcomes().catch(() => {})
  }
```

   `TransferOutcome` is the type exported from `@/packages/schema`. Import it
   as a type if the file does not already. The two-line `.catch` comment is
   the existing one; it stays attached to its `.catch`.

   The first outcome in an empty buffer starts the flush. Later outcomes join
   the buffer until the flush takes it.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → all pass.

#### Step B3: Gate

**Verify**: `bun run check` → exit 0. Then `bun run build` → exit 0.

## Test plan

- Part A: four new tests in `src/background/sync-outbox.test.ts` (Step A1).
  Tests 1 and 2 fail before Step A2 (5 calls and 4 calls) and pass after
  (1 call and 2 calls). Tests 3 and 4 pass before and after; they guard the
  error path and the ordering against `clearOutbox`.
- Part B: one new test and two adjusted tests in
  `src/background/tab-broadcaster.test.ts`. The new test fails before Step B2
  (3 queries) and passes after (1 query, 6 messages).
- Patterns: the existing `describe('recordSync — gating', …)` block and the
  existing `describe('reportTransferOutcome', …)` block.
- Verification: `bun run test src/background/sync-outbox.test.ts src/background/tab-broadcaster.test.ts`
  → all pass.

## Done criteria

ALL must hold:

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] The test `'sends a same-tick burst of recordSync calls in one mutation'` exists and passes
- [ ] `rg -n "drainQueued" src/background/sync-outbox.ts` returns 4 matches
- [ ] `rg -n "clearsQueued" src/background/sync-outbox.ts` returns 4 matches
- [ ] The test `'keeps an event recorded after clearOutbox while a drain is in flight'` exists and passes
- [ ] `rg -c "oxlint-disable" src/background/sync-outbox.ts` returns the same count as before this plan (1)
- [ ] `git diff --stat 7456911 -- src/packages/schema/index.ts src/entrypoints/overlay.content/handlers.ts` shows no change made by this plan
- [ ] If Part B was done: the coalesce test exists and passes, and `rg -n "OUTCOME_COALESCE_MS" src/background/tab-broadcaster.ts` returns 2 matches
- [ ] `plans/README.md` status row updated (say whether Part B was done)

## STOP conditions

Stop and report back (do not improvise) if:

- The code in "Current state" does not match the live files.
- `drainOutbox` no longer re-reads the outbox on every loop pass (for example
  it now reads once and drains a fixed list). Part A relies on the re-read.
- `outboxQueue` and `storeQueue` are no longer two separate queues. Appending
  on the same queue as the drain would bring back one call per event.
- The pre-existing test `'serializes interleaved recordSync calls so neither
  event is lost'` fails after Step A2. That means an event can be lost; do
  not weaken the test.
- The lint gate rejects the empty `.catch(() => {})` on the append. Report
  it. Do not disable the rule or rename anything to dodge it.
- Part B: any test that depends on a `TransferOutcome` reaching a tab within
  the same tick cannot be fixed by injecting an instant clock.
- Part B: you find yourself changing `src/packages/schema/index.ts` or
  `handlers.ts`. That is the batched-message design, which ADR-0014 does not
  allow without the owner.
- The `doc-lock` hook blocks an edit. Report the blocked line.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `clearOutbox` is the only writer whose order against `recordSync` matters.
  While a clear is queued, `recordSync` falls back to the old append-and-drain
  task so the event lands after the wipe. Any new writer that runs its
  storage write inside an `outboxQueue` task needs the same treatment.
- Part A changes when an append can fail visibly. Before, a failed append was
  reported under the `outbox` label. Now it is reported under `outboxStore`.
  The drain still runs and simply finds nothing new.
- The drain uses the `settings` captured by the call that queued it. That was
  already true. If settings change between two calls in one burst, the queued
  drain uses the earlier value; the next drain uses the new one.
- A burst larger than 64 events still takes more than one call. That is the
  reducer's batch size (ADR-0020 caps Capture mirror mutations at 64 for the
  same reason).
- Part B delays each badge correction by up to `OUTCOME_COALESCE_MS`. If the
  service worker is stopped inside that window, the buffered outcomes are not
  broadcast. The durable ledger and reconcile from ADR-0014 still record
  them; only the live badge correction is skipped, which is the same
  degraded result as a dead tab today.
- Deferred, needs the owner: one batched `TransferOutcomes` message per tab.
  It cuts messages from outcomes × tabs to one per tab per window, but it
  changes the ADR-0014 wire message and needs a content-side handler.
- Reviewer: check that `drainQueued = false` is the first statement of the
  queued task, before any `await`.
