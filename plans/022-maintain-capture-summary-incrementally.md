# Plan 022: The capture summary is folded once per change, not once per popup open

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7456911 -- src/background/capture-db.ts src/background/capture-db.test.ts src/entrypoints/background.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `7456911`, 2026-11-16

Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

Every popup open sends `CaptureSummaryRequest`. The service worker answers by
walking a cursor over every harvested tweet in IndexedDB. The harvest can hold
tens of thousands of records, so the cost grows with the archive. The Options
capture panel sends the same request. Separately, every capture batch (about
every 750 ms while the user scrolls with capture on) calls
`captureDb.count()`, which walks the key range, only to print a log line.

After this plan the service worker keeps the last fold result in memory and
reuses it until a write changes the store. The per-batch `count()` is gone.

**Why a cached fold and not incremental counters.** A write is a merge, not an
insert. `mergeRecord` can replace a stored record with a richer one, which
changes a conversation's root text and handle without changing the tweet
count. Whether a record was new or replaced is only known inside the IndexedDB
transaction. Counters kept beside the store would drift on any missed case. A
cached fold is always equal to a fresh fold by construction.

## Current state

Files:

- `src/background/capture-db.ts` — `makeCaptureDb`, the serialized write
  queue, and the IndexedDB adapter.
- `src/background/capture-db.test.ts` — tests through an in-memory
  `CaptureStore` fake.
- `src/entrypoints/background.ts` — the message handlers that call the DB.
- `src/packages/capture/store.ts` — the pure fold (`emptyCaptureSummary`,
  `foldCaptureSummary`, `finishCaptureSummary`). Read only.

The DB factory, `src/background/capture-db.ts:34-61`:

```ts
export interface CaptureDb {
  /** Persist a harvested batch, merging each record against the stored one.
   *  Empty batches are a no-op. Serialized against every other write. */
  putRecords(records: ReadonlyArray<TweetRecord>): Promise<void>
  allRecords(): Promise<TweetRecord[]>
  /** Stream every record through `step` without loading the store whole. */
  fold<A>(init: A, step: (acc: A, record: TweetRecord) => A): Promise<A>
  conversation(id: string): Promise<TweetRecord[]>
  count(): Promise<number>
  clear(): Promise<void>
}

export function makeCaptureDb(deps: { store?: CaptureStore } = {}): CaptureDb {
  const store = deps.store ?? makeIndexedDbStore()
  const writes = makeSerialQueue()
  return {
    putRecords: (records) =>
      writes.run(async () => {
        if (records.length === 0) return
        await store.upsert(records, mergeRecord)
      }),
    allRecords: () => store.allRecords(),
    fold: (init, step) => store.fold(init, step),
    conversation: (id) => store.conversation(id),
    count: () => store.count(),
    clear: () => writes.run(() => store.clear()),
  }
}
```

`writes.run(task)` runs `task` after every earlier task on the same queue has
settled, and returns the task's result (`src/packages/kernel/serial-queue.ts:55-61`).

The pure fold, `src/packages/capture/store.ts:78-100`:

```ts
export type CaptureSummaryAcc = {
  tweets: number
  byConversation: Map<string, RecentConversation>
}

export const emptyCaptureSummary = (): CaptureSummaryAcc => ({
  tweets: 0,
  byConversation: new Map(),
})

export function foldCaptureSummary(acc: CaptureSummaryAcc, r: TweetRecord): CaptureSummaryAcc {
  acc.tweets += 1
  foldConversation(acc.byConversation, r)
  return acc
}

export function finishCaptureSummary(acc: CaptureSummaryAcc, n: number) {
  return {
    tweets: acc.tweets,
    conversations: acc.byConversation.size,
    recent: newestFirst(acc.byConversation, n),
  } satisfies CaptureSummaryReply
}
```

`finishCaptureSummary` does not mutate `acc` (`newestFirst` uses `toSorted`).
`foldCaptureSummary` DOES mutate `acc`. So a cached `acc` may be passed to
`finishCaptureSummary` any number of times, but must never be folded into
again.

`background.ts` line numbers in this plan are approximate, because that file
is being edited. Locate each edit by the quoted code.

The handlers, `src/entrypoints/background.ts` near lines 1904-1925:

```ts
  [
    'CaptureTweets',
    handle<'CaptureTweets'>(async (msg) => {
      await captureDb.putRecords(msg.records)
      const total = await captureDb.count()
      console.info(`[XMD] capture received ${msg.records.length} record(s); store total=${total}`)
      captureOutbox.mirrorCaptures(msg.records)
      return { stored: msg.records.length }
    }),
  ],
  // Streams the store through a cursor fold — the harvest can be tens of
  // thousands of records, and `getAll()` materialized every one of them in SW
  // memory on each popup open just to compute three aggregates.
  [
    'CaptureSummaryRequest',
    handle<'CaptureSummaryRequest'>(async (msg) =>
      finishCaptureSummary(
        await captureDb.fold(emptyCaptureSummary(), foldCaptureSummary),
        msg.limit ?? captureRecentLimit,
      ),
    ),
  ],
```

The clear handler, `src/entrypoints/background.ts` near lines 1938-1945
(stays as is):

```ts
  [
    'ClearCaptureRequest',
    async () => {
      const cleared = await captureDb.count()
      await captureDb.clear()
      return { cleared }
    },
  ],
```

`captureDb` is created once per service-worker life at
`src/entrypoints/background.ts` near line 717: `const captureDb = makeCaptureDb()`. The
only writers are `putRecords` and `clear`.

The test fake, `src/background/capture-db.test.ts:24-59`, implements
`CaptureStore` over a `Map` and already counts `upsertCalls`. Its `fold`:

```ts
    async fold<A>(init: A, step: (acc: A, record: TweetRecord) => A) {
      let acc = init
      for (const r of rows.values()) acc = step(acc, r)
      return acc
    },
```

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. Prefer narrowing.
- `unknown` is banned in parameters, returns and type aliases.
- Packages under `src/packages` are imported only through their root entry
  files. `@/packages/capture/store` is a root file and is already imported by
  `capture-db.ts`. `bun run lint:boundaries` enforces this.
- Tests are vitest with assertions inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. This means
the new `summary` method gets no JSDoc block; say so in your final report so
the owner can add one.

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

- `src/background/capture-db.ts`
- `src/background/capture-db.test.ts`
- `src/entrypoints/background.ts` (only the `CaptureTweets` and
  `CaptureSummaryRequest` handlers and the import list they use)
- `plans/README.md` (only this plan's status row in the
  "Performance plans (012–023)" table)

**Out of scope** (do NOT touch):

- `src/packages/capture/store.ts` — the fold functions stay unchanged.
- The IndexedDB adapter (`makeIndexedDbStore`) and its schema version.
- `ClearCaptureRequest` — its one `count()` runs only on an explicit user
  clear and produces the reply value.
- `ExportCaptureRequest` — export memory use is a separate finding.
- `src/entrypoints/popup/*` and `src/components/capture-export.ts` — the
  message shape and reply do not change.
- Persisting the summary to `chrome.storage` — see Maintenance notes.

## Git workflow

- Branch: `advisor/022-maintain-capture-summary-incrementally`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `perf(capture): …`.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes, and some sit inside this
  plan's in-scope files. At planning time `src/entrypoints/background.ts`
  had about 180 uncommitted changed lines and was still being edited. Never
  revert or stash them.
- Before editing, run the drift-check command from the top of this plan and
  note which in-scope files already show uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Leave
  this plan's edits unstaged in that file and name the file in your final
  message. Expect this for `src/entrypoints/background.ts`.
- Commit only in-scope files that were clean before you started. Stage them by
  path.

## Steps

### Step 1: Write the failing tests

In `src/background/capture-db.test.ts`:

1. Add a `foldCalls` counter to `fakeStore`, next to `upsertCalls`. Widen the
   return type annotation to include `foldCalls: number`. Increment it at the
   top of the fake's `fold`.
2. Add `import { finishCaptureSummary } from '@/packages/capture/store'`.
3. Add a new `describe('summary', …)` with these cases. `mk` is the existing
   record builder in that file.

   a. **Reuses the fold while nothing changes.** Put `[mk('1'), mk('2')]`.
      Call `db.summary()` twice. Expect `store.foldCalls` to be `1`. Expect
      `finishCaptureSummary(await db.summary(), 5).tweets` to be `2`.

   b. **A write invalidates it.** Put `[mk('1')]`, call `db.summary()`, put
      `[mk('2')]`, call `db.summary()` again. Expect `store.foldCalls` to be
      `2` and the second summary's `tweets` to be `2`.

   c. **A merge that replaces a record is reflected.** Put
      `[mk('1', { text: 'thin' })]`, call `db.summary()`. Put
      `[mk('1', { text: 'rich', source: 'tweetDetail', sourceRank: 2 })]`.
      Call `db.summary()`. Expect `tweets` to be `1` and
      `finishCaptureSummary(acc, 5).recent[0]?.rootText` to be `'rich'`.
      (Check the allowed `source` values in `src/packages/capture/record.ts`
      before writing this case; the existing test
      `'merges on write — a richer tweetDetail replaces a stored timeline record'`
      at line 81 shows a valid richer record.)

   d. **`clear` invalidates it.** Put `[mk('1')]`, call `db.summary()`, call
      `db.clear()`, call `db.summary()`. Expect `tweets` to be `0` and
      `conversations` (via `finishCaptureSummary`) to be `0`.

   e. **An empty batch does not invalidate it.** Put `[mk('1')]`, call
      `db.summary()`, call `db.putRecords([])`, call `db.summary()`. Expect
      `store.foldCalls` to be `1`.

   f. **A summary requested during a write sees that write.** Call
      `const put = db.putRecords([mk('1')])` and, without awaiting,
      `const sum = db.summary()`. Await both. Expect the summary's `tweets` to
      be `1`.

**Verify**: `bun run test src/background/capture-db.test.ts` → the new tests
FAIL (`db.summary is not a function`, or a type error). The pre-existing
tests still pass. This red state is required before Step 2.

### Step 2: Add the cached summary to `makeCaptureDb`

In `src/background/capture-db.ts`:

1. Extend the existing import from `@/packages/capture/store` to also import
   `emptyCaptureSummary`, `foldCaptureSummary`, and the type
   `CaptureSummaryAcc`.
2. Add to the `CaptureDb` interface:

```ts
  summary(): Promise<CaptureSummaryAcc>
```

3. Change `makeCaptureDb` to this shape:

```ts
export function makeCaptureDb(deps: { store?: CaptureStore } = {}): CaptureDb {
  const store = deps.store ?? makeIndexedDbStore()
  const writes = makeSerialQueue()
  let cachedSummary: CaptureSummaryAcc | undefined
  return {
    putRecords: (records) =>
      writes.run(async () => {
        if (records.length === 0) return
        cachedSummary = undefined
        await store.upsert(records, mergeRecord)
      }),
    allRecords: () => store.allRecords(),
    fold: (init, step) => store.fold(init, step),
    conversation: (id) => store.conversation(id),
    count: () => store.count(),
    clear: () =>
      writes.run(async () => {
        cachedSummary = undefined
        await store.clear()
      }),
    summary: () =>
      writes.run(async () => {
        cachedSummary ??= await store.fold(emptyCaptureSummary(), foldCaptureSummary)
        return cachedSummary
      }),
  }
}
```

Load-bearing details:

- `summary` runs on the `writes` queue. That is what makes case (f) pass and
  what stops a fold that started before a write from being cached after it.
- The cache is cleared BEFORE the store call, inside the queued task. If the
  write fails, the cache is already empty, so the next summary re-reads.
- Keep the existing JSDoc blocks on the interface untouched. Add none.

**Verify**: `bun run test src/background/capture-db.test.ts` → all pass,
including the six new cases.

### Step 3: Use it in the handlers and drop the per-batch count

In `src/entrypoints/background.ts`:

1. `CaptureSummaryRequest` handler: replace
   `await captureDb.fold(emptyCaptureSummary(), foldCaptureSummary),` with
   `await captureDb.summary(),`. Keep `finishCaptureSummary(…, msg.limit ?? captureRecentLimit)`.
2. Remove `emptyCaptureSummary` and `foldCaptureSummary` from the import at
   `background.ts` near lines 130-134 (the import from
   `@/packages/capture/store`) if nothing else in the file uses them. Check with
   `rg -n "emptyCaptureSummary|foldCaptureSummary" src/entrypoints/background.ts`.
   Keep `finishCaptureSummary`.
3. `CaptureTweets` handler: delete the line
   `const total = await captureDb.count()` and change the log line to:

```ts
      console.info(`[XMD] capture received ${msg.records.length} record(s)`)
```

Leave every comment in this region as it is, including the three-line comment
above `'CaptureSummaryRequest'`.

**Verify**:
- `rg -n "captureDb\.count\(\)" src/entrypoints/background.ts` → exactly 1
  match (the `ClearCaptureRequest` handler).
- `rg -n "captureDb\.fold\(" src/entrypoints/background.ts` → no matches.
- `bun run typecheck` → exit 0.

### Step 4: Full gate

**Verify**: `bun run check` → exit 0. Then `bun run build` → exit 0.

## Test plan

- New tests: the six `summary` cases in Step 1, in
  `src/background/capture-db.test.ts`. Case (a) encodes the requirement
  "two summary requests with no write between them cost one store pass".
  Cases (b)–(f) encode "a cached summary always equals a fresh fold".
- Pattern: the existing `describe('makeCaptureDb', …)` block in the same file
  and its `fakeStore`.
- Verification: `bun run test src/background/capture-db.test.ts` → all pass,
  including 6 new tests. They fail before Step 2.

## Done criteria

ALL must hold:

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "captureDb\.fold\(" src/entrypoints/background.ts` returns no matches
- [ ] `rg -n "captureDb\.count\(\)" src/entrypoints/background.ts` returns exactly 1 match
- [ ] `rg -n "summary\(\)" src/background/capture-db.test.ts` returns matches and the file's tests pass
- [ ] `git status --short` shows no file changed by this plan outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code in "Current state" does not match the live files.
- `rg -n "xmd-capture|indexedDB\.open" src` shows a second writer to the
  capture database outside `src/background/capture-db.ts`. The in-memory cache
  is only correct while the service worker is the sole writer.
- More than one `makeCaptureDb()` instance is created in non-test code. Each
  instance would hold its own cache.
- `finishCaptureSummary` in `src/packages/capture/store.ts` has changed so
  that it mutates its `acc` argument. A cached `acc` would then be corrupted
  by reuse.
- An extension page (popup or options) now writes to the capture database
  directly instead of through a message to the service worker.
- The `doc-lock` hook blocks an edit. Report the blocked line.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The cache lives in service-worker memory. A cold worker pays one full fold
  on the first summary request. While the user scrolls with capture on, writes
  arrive about every 750 ms, so a popup opened during scrolling still pays a
  fold. This plan removes the repeated folds between writes, not the first
  one.
- Persisting the summary to `chrome.storage` would remove the cold-start fold
  too. It was left out because the persisted copy could disagree with
  IndexedDB after a crash between the two writes. If someone adds it, the
  persisted value must be treated as a hint and verified.
- Any new write path into the capture store must go through `makeCaptureDb`
  and clear `cachedSummary`. Reviewer: check that both writers clear the cache
  before the store call.
- The `summary()` reply holds a `Map` owned by the cache. Callers must not
  mutate it. Today the only caller passes it straight to
  `finishCaptureSummary`.
- The comment above the `CaptureSummaryRequest` handler still describes a
  cursor fold. That is true on a cache miss. The owner may want to reword it
  in a docs pass.
