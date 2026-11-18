# Plan 030: The capture summary reads a page of the archive, not every record

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/background/capture-db.ts src/background/capture-db.test.ts src/entrypoints/background.ts src/packages/capture/store.ts src/packages/capture/tests/store.test.ts`
> This plan runs AFTER plan 022, so `capture-db.ts`, its test, and
> `background.ts` WILL show changes. Compare the "Current state" excerpts
> against the live code before proceeding; on a mismatch beyond what "State
> expected after plan 022" describes, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/022-maintain-capture-summary-incrementally.md` must be DONE. Run after `plans/029-export-one-thread-through-index.md` if both are pending, because both edit the same files.
- **Category**: perf
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/104

## Why this matters

Three surfaces ask the service worker for a capture summary: the popup on every
open (it shows 3 rows), the Options capture panel (it shows counts only), and
the Archive panel (up to 1000 rows). The worker answers each by walking a
cursor over every harvested tweet and copying each full record, including its
text, links, and media. It then keeps one entry with the root text for every
conversation and sorts all of them to keep the newest few.

Plan 022 caches that walk in worker memory until the next write. That removes
repeated walks between writes. It does not remove the first walk after a worker
start, or the walk after every write while the user scrolls with capture on.
It also keeps a Map with one entry per conversation alive for the worker's
life.

After this plan the summary never decodes every record. The counts come from
the store's own count and a key-only index walk. The newest rows come from a
reverse walk of the `by_capturedAt` index that stops as soon as it has seen
enough conversations.

Cost of one summary request, estimated from the code (not measured), for N
records in C conversations, asking for n rows:

| | Full records decoded | Kept in worker memory after the reply |
| --- | --- | --- |
| Before 022 | N on every request | nothing |
| After 022 | N on the first request after any write | one entry per conversation (C entries with root text) |
| After 030 | about n to a few times n, plus n root reads | two numbers |

The count of conversations costs C key-only cursor steps on the first request
after a write. A key-only step copies no record value.

## How this plan splits the work with plan 022

- Plan 022 adds `CaptureDb.summary()`, a cached full fold, and removes the
  per-batch `captureDb.count()` from the `CaptureTweets` handler. Its cache
  invalidation points (inside `putRecords` and `clear`, before the store call)
  are correct and this plan keeps them.
- This plan changes what is cached and how `recent` is produced. The cache
  holds two counts. `recent` is read from the indexes on each request.
- This plan does not redo anything 022 did. If 022 is not DONE, stop.

## Current state

Files and roles:

- `src/background/capture-db.ts` — the capture database: the `CaptureStore`
  seam, `makeCaptureDb`, and the IndexedDB adapter.
- `src/background/capture-db.test.ts` — tests through an in-memory `fakeStore()`.
- `src/entrypoints/background.ts` — the service worker. The
  `CaptureSummaryRequest` handler is near line 1920. Line numbers in this file
  are approximate. Locate edits by the quoted code.
- `src/packages/capture/store.ts` — pure summary types and the fold.
- `src/packages/capture/tests/store.test.ts` — tests for that file.

The database is IndexedDB `xmd-capture`, object store `tweets`, keyPath
`tweetId`, indexes `by_conversation` (on `conversationId`) and `by_capturedAt`
(on `capturedAt`). See `src/background/capture-db.ts:68-70` and `:107-111`:

```ts
        const store = request.result.createObjectStore(STORE, { keyPath: 'tweetId' })
        store.createIndex('by_conversation', 'conversationId')
        store.createIndex('by_capturedAt', 'capturedAt')
```

Typed helpers already in the adapter (`src/background/capture-db.ts:83-98`):

```ts
function getTweetRecord(
  store: IDBObjectStore,
  key: IDBValidKey,
): IDBRequest<TweetRecord | undefined> {
  return store.get(key)
}

/** `IDBCursorWithValue.value` is typed `any` by lib.dom; narrowed for the same
 *  reason as {@link getTweetRecord} — every row in this store is a `TweetRecord`. */
interface TweetCursor extends IDBCursorWithValue {
  readonly value: TweetRecord
}

function openTweetCursor(store: IDBObjectStore): IDBRequest<TweetCursor | null> {
  return store.openCursor()
}
```

The summary types and the fold (`src/packages/capture/store.ts:3-17`, `:42-69`,
`:94-100`):

```ts
export type RecentConversation = {
  conversationId: string
  rootHandle: string
  rootText: string
  count: number
  lastAt: number
}

/** The `CaptureSummaryRequest` reply: counts + the `n` newest threads. */
export type CaptureSummaryReply = {
  tweets: number
  conversations: number
  recent: RecentConversation[]
}
```

```ts
function foldConversation(byConversation: Map<string, RecentConversation>, r: TweetRecord): void {
  const existing = byConversation.get(r.conversationId)
  const isRoot = r.tweetId === r.conversationId
  if (existing === undefined) {
    byConversation.set(r.conversationId, {
      conversationId: r.conversationId,
      rootHandle: r.author.handle,
      rootText: r.text,
      count: 1,
      lastAt: r.capturedAt,
    })
    return
  }
  existing.count += 1
  existing.lastAt = Math.max(existing.lastAt, r.capturedAt)
  if (isRoot) {
    existing.rootHandle = r.author.handle
    existing.rootText = r.text
  }
}

/** Newest-first threads, capped at `n`. */
function newestFirst(byConversation: Map<string, RecentConversation>, n: number) {
  return [...byConversation.values()].toSorted((a, b) => b.lastAt - a.lastAt).slice(0, n)
}
```

```ts
export function finishCaptureSummary(acc: CaptureSummaryAcc, n: number) {
  return {
    tweets: acc.tweets,
    conversations: acc.byConversation.size,
    recent: newestFirst(acc.byConversation, n),
  } satisfies CaptureSummaryReply
}
```

So each row means: `count` is the number of stored tweets in the conversation,
`lastAt` is the largest `capturedAt` among them, and `rootHandle` / `rootText`
come from the root tweet (the record whose `tweetId` equals the
`conversationId`) when it is stored, otherwise from some other member.

The callers and their limits:

- `src/entrypoints/popup/App.tsx:1336` — `fetchCaptureSummary(3)`.
- `src/entrypoints/options/panels/capture.tsx:72` — `fetchCaptureSummary(0)`.
- `src/entrypoints/options/panels/archive.tsx:131` — `fetchCaptureSummary(1000)`.
- `src/entrypoints/background.ts` near line 1771: `const captureRecentLimit = 20`
  is the default when the message carries no limit.

### State expected after plan 022

Plan 022 specifies these shapes. Confirm each with `rg` before you start.

In `src/background/capture-db.ts`, `makeCaptureDb` holds
`let cachedSummary: CaptureSummaryAcc | undefined`, sets
`cachedSummary = undefined` inside the queued task of `putRecords` (after the
empty-batch return, before `store.upsert`) and inside `clear` (before
`store.clear()`), and has:

```ts
    summary: () =>
      writes.run(async () => {
        cachedSummary ??= await store.fold(emptyCaptureSummary(), foldCaptureSummary)
        return cachedSummary
      }),
```

The `CaptureDb` interface has `summary(): Promise<CaptureSummaryAcc>`.

In `src/entrypoints/background.ts`, the handler reads:

```ts
  [
    'CaptureSummaryRequest',
    handle<'CaptureSummaryRequest'>(async (msg) =>
      finishCaptureSummary(
        await captureDb.summary(),
        msg.limit ?? captureRecentLimit,
      ),
    ),
  ],
```

In `src/background/capture-db.test.ts` there is a `describe('summary', …)` with
six cases, and `fakeStore()` counts `foldCalls`.

Quick check: `rg -n "cachedSummary|summary\(" src/background/capture-db.ts src/entrypoints/background.ts`
must show the lines above. If it shows nothing, plan 022 has not landed.

### Two behaviour differences this plan introduces

Both are visible only in edge cases. Both need the owner's acceptance, which is
recorded in "STOP conditions" and "Maintenance notes".

1. **Order among ties.** Today, conversations with the same `lastAt` appear in
   the order the fold first met them (ascending `tweetId` string order). After
   this plan they appear in the order of a reverse walk of `by_capturedAt`:
   descending `capturedAt`, then descending `tweetId`. Ties are common, because
   one harvest call stamps every record in a batch with the same `capturedAt`.
   At the cut-off, a different member of a tie group can make the list.
2. **Fallback text when the root is not stored.** Today the row shows the
   first member the fold met. After this plan it shows the newest captured
   member. The existing test name for this case is "falls back to any member",
   so any member satisfies the documented behaviour.

Facts about this repo's test setup:

- The IndexedDB adapter (`makeIndexedDbStore`) has no automated test. The repo
  has no `fake-indexeddb` dependency. Do not add one. This plan keeps the
  adapter thin and puts the row logic in pure functions that the test fake
  drives too.
- `vitest.config.ts` sets a 100% coverage threshold (statements, branches,
  functions, lines) on `src/packages/**`. Every branch of the new pure
  functions in `src/packages/capture/store.ts` needs a test.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- No `await` inside a `for` or `while` loop (`no-await-in-loop`). New code may
  not add a suppression comment for it.
- Code outside a package imports only that package's root files.
  `@/packages/capture/store` is a root file. `bun run lint:boundaries`
  enforces this.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. New exports
and interface members get no JSDoc block. Say so in your final report.

## Commands you will need

| Purpose       | Command                               | Expected on success |
|---------------|---------------------------------------|---------------------|
| Typecheck     | `bun run typecheck`                   | exit 0, no errors   |
| Lint          | `bun run lint`                        | exit 0              |
| Format check  | `bun run fmt:check`                   | exit 0              |
| Boundaries    | `bun run lint:boundaries`             | exit 0              |
| Focused tests | `bun run test <path/to/file.test.ts>` | all pass            |
| Coverage      | `bun run test:coverage`               | exit 0, thresholds met |
| Full gate     | `bun run check`                       | exit 0              |
| Build         | `bun run build`                       | exit 0              |

The package manager is bun. Never use npm or npx. If `bun run fmt:check` fails
only on files you edited, run `bunx oxfmt --write <those files>` and re-check.

## Scope

**In scope** (the only files you should modify):

- `src/packages/capture/store.ts`
- `src/packages/capture/tests/store.test.ts`
- `src/background/capture-db.ts`
- `src/background/capture-db.test.ts`
- `src/entrypoints/background.ts` (only the `CaptureSummaryRequest` handler and
  the import list it uses)
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/packages/schema/index.ts`, `src/components/capture-export.ts`, the popup,
  and the Options panels. The message and the reply shape do not change.
- The IndexedDB schema version and indexes. This plan adds no object store and
  no index.
- `foldCaptureSummary`, `emptyCaptureSummary`, `finishCaptureSummary`, and the
  `fold` members of `CaptureStore` and `CaptureDb`. They stay. Tests use them
  as the reference result. See Maintenance notes.
- The `CaptureTweets`, `ExportCaptureRequest`, and `ClearCaptureRequest`
  handlers.
- Persisting any summary to `chrome.storage`.

## Git workflow

- Branch: `advisor/030-summarize-captures-without-full-scan`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `perf(capture): …`.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. At planning time these in-scope
  files were already modified: `src/background/capture-db.ts`,
  `src/background/capture-db.test.ts`, `src/entrypoints/background.ts`. Never
  revert or stash them.
- Before editing, run `git status --short` and note which in-scope files are
  already modified.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Add the pure row helpers, test first

In `src/packages/capture/tests/store.test.ts`, add
`describe('recent rows from a newest-first walk', …)` with "Test plan" cases
1–4. Import `noteNewestRecord` and `completeRecentRow` from `'../store'`.

**Verify**: `bun run test src/packages/capture/tests/store.test.ts` → the new
tests FAIL (missing exports). Pre-existing tests pass.

Then add to `src/packages/capture/store.ts`, below `newestFirst`:

```ts
export function noteNewestRecord(
  rows: Map<string, RecentConversation>,
  r: TweetRecord,
): RecentConversation | undefined {
  if (rows.has(r.conversationId)) return undefined
  const row: RecentConversation = {
    conversationId: r.conversationId,
    rootHandle: r.author.handle,
    rootText: r.text,
    count: 0,
    lastAt: r.capturedAt,
  }
  rows.set(r.conversationId, row)
  return row
}

export function completeRecentRow(
  row: RecentConversation,
  count: number,
  root: TweetRecord | undefined,
): void {
  row.count = count
  if (root === undefined) return
  row.rootHandle = root.author.handle
  row.rootText = root.text
}
```

`noteNewestRecord` is called with records in newest-first order. The first
record seen for a conversation carries that conversation's largest
`capturedAt`, so it sets `lastAt`. It returns the new row, or `undefined` when
the conversation already has one. `completeRecentRow` fills in the member count
and, when the root tweet is stored, its handle and text. Both mutate the row,
the same way `foldConversation` mutates its Map entries.

**Verify**: `bun run test src/packages/capture/tests/store.test.ts` → all pass.

### Step 2: Extend the test fake and rewrite the `summary` tests

In `src/background/capture-db.test.ts`:

1. Extend the import from `@/packages/capture/store` to bring in
   `completeRecentRow`, `noteNewestRecord`, `emptyCaptureSummary`,
   `foldCaptureSummary`, `finishCaptureSummary`, and the type
   `RecentConversation`. Keep whatever plan 022 already imports.
2. In `fakeStore()`, add counters `countCalls: 0`, `conversationCountCalls: 0`,
   and `recentCalls: 0` next to the existing counters, and widen the return
   type annotation. Increment `countCalls` at the top of the fake's `count`.
3. Add two methods to the fake. They walk the rows in the same order the
   IndexedDB index does (descending `capturedAt`, then descending `tweetId`)
   and use the same pure helpers as the real adapter:

```ts
    async conversationCount() {
      box.conversationCountCalls++
      return new Set([...rows.values()].map((r) => r.conversationId)).size
    },
    async recentConversations(limit: number) {
      box.recentCalls++
      const newestFirstRecords = [...rows.values()].toSorted(
        (a, b) => b.capturedAt - a.capturedAt || (a.tweetId < b.tweetId ? 1 : -1),
      )
      const picked = new Map<string, RecentConversation>()
      for (const r of newestFirstRecords) {
        if (picked.size >= limit) break
        const row = noteNewestRecord(picked, r)
        if (row === undefined) continue
        const members = [...rows.values()].filter((m) => m.conversationId === row.conversationId)
        completeRecentRow(row, members.length, rows.get(row.conversationId))
      }
      return [...picked.values()]
    },
```

4. Replace the six cases in `describe('summary', …)` with "Test plan" cases
   5–11. The old cases call `db.summary()` with no argument and pass the result
   to `finishCaptureSummary`. That signature is going away.

**Verify**: `bun run test src/background/capture-db.test.ts` → the `summary`
cases FAIL (type errors or wrong shape). Other tests pass.

### Step 3: Add the two reads to the store seam and the IndexedDB adapter

In `src/background/capture-db.ts`:

1. Extend the import from `@/packages/capture/store` with `completeRecentRow`,
   `noteNewestRecord`, and the types `CaptureSummaryReply` and
   `RecentConversation`.
2. Add to the `CaptureStore` interface, after `count`:

```ts
  conversationCount(): Promise<number>
  recentConversations(limit: number): Promise<RecentConversation[]>
```

3. Add a typed cursor opener below `openTweetCursor`:

```ts
function openNewestCursor(index: IDBIndex): IDBRequest<TweetCursor | null> {
  return index.openCursor(null, 'prev')
}
```

4. Add to the object returned by `makeIndexedDbStore`, after `count`:

```ts
    async conversationCount() {
      const db = await openDb()
      const request = db
        .transaction(STORE, 'readonly')
        .objectStore(STORE)
        .index('by_conversation')
        .openKeyCursor(null, 'nextunique')
      let total = 0
      return new Promise<number>((resolve, reject) => {
        request.addEventListener('success', () => {
          const cursor = request.result
          if (cursor === null) {
            resolve(total)
            return
          }
          total += 1
          cursor.continue()
        })
        request.addEventListener('error', () => reject(request.error))
      })
    },
    async recentConversations(limit) {
      const db = await openDb()
      return new Promise<RecentConversation[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly')
        const store = tx.objectStore(STORE)
        const byConversation = store.index('by_conversation')
        const rows = new Map<string, RecentConversation>()
        const completeFromIndexes = (row: RecentConversation): void => {
          const count = byConversation.count(row.conversationId)
          const root = getTweetRecord(store, row.conversationId)
          root.addEventListener('success', () => {
            completeRecentRow(row, count.result, root.result)
          })
        }
        const newest = openNewestCursor(store.index('by_capturedAt'))
        newest.addEventListener('success', () => {
          const cursor = newest.result
          if (cursor === null) return
          const row = noteNewestRecord(rows, cursor.value)
          if (row !== undefined) completeFromIndexes(row)
          if (rows.size < limit) cursor.continue()
        })
        tx.addEventListener('complete', () => resolve([...rows.values()]))
        tx.addEventListener('error', () => reject(tx.error))
        tx.addEventListener('abort', () => reject(tx.error))
      })
    },
```

Load-bearing details:

- `openKeyCursor(null, 'nextunique')` visits each distinct `conversationId`
  once and copies no record value.
- In `completeFromIndexes`, the `count` request is issued before the `get`
  request. Requests in one transaction finish in the order they were issued, so
  `count.result` is ready when the `get` succeeds. Do not swap the two lines.
- The cursor stops as soon as `rows.size` reaches `limit`: it simply does not
  call `continue()`. The transaction then completes once the pending `count`
  and `get` requests finish, and `resolve` runs.
- `recentConversations` is never called with a limit below 1 by `makeCaptureDb`
  (Step 4 guards it).

**Verify**: `bun run typecheck` → the only errors, if any, are in
`makeCaptureDb.summary` and the handler, which Step 4 and Step 5 fix.

### Step 4: Change `makeCaptureDb.summary` to read from the indexes

In `src/background/capture-db.ts`:

1. Change the `CaptureDb` interface member to:

```ts
  summary(limit: number): Promise<CaptureSummaryReply>
```

2. In `makeCaptureDb`, replace the declaration
   `let cachedSummary: CaptureSummaryAcc | undefined` with:

```ts
  let cachedCounts: { tweets: number; conversations: number } | undefined
```

3. Replace both `cachedSummary = undefined` assignments (in `putRecords` and in
   `clear`) with `cachedCounts = undefined`. Keep them exactly where they are.
4. Replace the `summary` member with:

```ts
    summary: (limit) =>
      writes.run(async () => {
        cachedCounts ??= {
          tweets: await store.count(),
          conversations: await store.conversationCount(),
        }
        const recent = limit > 0 ? await store.recentConversations(limit) : []
        return { ...cachedCounts, recent }
      }),
```

5. Remove `emptyCaptureSummary`, `foldCaptureSummary`, and the type
   `CaptureSummaryAcc` from this file's import if nothing else in the file uses
   them. Check with
   `rg -n "emptyCaptureSummary|foldCaptureSummary|CaptureSummaryAcc" src/background/capture-db.ts`.

`summary` stays on the `writes` queue, as plan 022 put it. That keeps a summary
requested during a write ordered after that write.

**Verify**: `bun run test src/background/capture-db.test.ts` → all pass.

### Step 5: Simplify the handler

In `src/entrypoints/background.ts`, change the `CaptureSummaryRequest` handler
body to:

```ts
    handle<'CaptureSummaryRequest'>(async (msg) =>
      captureDb.summary(msg.limit ?? captureRecentLimit),
    ),
```

Then remove `finishCaptureSummary` from the import from
`@/packages/capture/store` if nothing else in the file uses it. Check with
`rg -n "finishCaptureSummary|emptyCaptureSummary|foldCaptureSummary" src/entrypoints/background.ts`.
If that leaves the import empty, delete the whole import statement.

Leave every comment in this region as it is.

**Verify**:
- `rg -n "captureDb\.summary\(" src/entrypoints/background.ts` → 1 match.
- `rg -n "captureDb\.fold\(" src/entrypoints/background.ts` → no matches.
- `bun run typecheck` → exit 0.

### Step 6: Run the gate

**Verify**: `bun run check` → exit 0. `bun run test:coverage` → exit 0.
`bun run build` → exit 0.

## Test plan

`src/packages/capture/tests/store.test.ts`, new
`describe('recent rows from a newest-first walk', …)`. Use the file's existing
`make({...})` record builder.

1. **First sighting creates the row.** With an empty Map, call
   `noteNewestRecord(rows, make({ tweetId: '2', conversationId: '1', capturedAt: 40 }))`.
   The returned row equals
   `{ conversationId: '1', rootHandle: <that record's handle>, rootText: <its text>, count: 0, lastAt: 40 }`
   and `rows.get('1')` is that same object.
2. **A later, older record of the same conversation adds nothing.** After case
   1, calling it with `make({ tweetId: '1', conversationId: '1', capturedAt: 10 })`
   returns `undefined`, and `rows.get('1')?.lastAt` is still `40`.
3. **`completeRecentRow` sets the count and the root's handle and text.** Give
   it a row, `3`, and a root record with a different handle and text. Expect
   `count` `3`, and the handle and text of the root.
4. **`completeRecentRow` keeps the fallback when the root is not stored.** Give
   it a row, `2`, and `undefined`. Expect `count` `2` and the handle and text
   unchanged.

`src/background/capture-db.test.ts`, `describe('summary', …)`. Use `mk` and
`fakeStore()`.

5. **Matches the full fold when no two conversations tie.** Put records in
   three conversations with distinct `capturedAt` values, including one
   conversation with a reply and its root, and one whose root is absent. Expect
   `await db.summary(5)` to deep-equal
   `finishCaptureSummary(await db.fold(emptyCaptureSummary(), foldCaptureSummary), 5)`
   for `tweets`, `conversations`, and for each `recent` row's `conversationId`,
   `count`, and `lastAt`, in the same order. The fold is the pre-existing
   reference, which this plan does not edit. For the conversation whose root is
   stored, also compare `rootHandle` and `rootText`.
6. **The cut-off keeps the newest conversations.** With the fixture of case 5,
   `(await db.summary(2)).recent.map((r) => r.conversationId)` equals the two
   conversations with the largest `lastAt`, newest first.
7. **A limit of 0 returns counts only and skips the recent walk.**
   `await db.summary(0)` has `recent` equal to `[]`, the right `tweets` and
   `conversations`, and `store.recentCalls` is `0`.
8. **Counts are read once while nothing changes.** Put two records. Call
   `db.summary(3)` twice. Expect `store.conversationCountCalls` to be `1`.
9. **A write invalidates the counts.** Put `[mk('1')]`, call `db.summary(3)`,
   put `[mk('2')]`, call `db.summary(3)`. Expect the second reply's `tweets` to
   be `2` and `store.conversationCountCalls` to be `2`.
10. **`clear` invalidates the counts.** Put `[mk('1')]`, call `db.summary(3)`,
    call `db.clear()`, call `db.summary(3)`. Expect `tweets` `0`,
    `conversations` `0`, and `recent` `[]`.
11. **A summary requested during a write sees that write.** Call
    `const put = db.putRecords([mk('1')])` and, without awaiting,
    `const sum = db.summary(3)`. Await both. Expect `tweets` to be `1`.

What these tests cover and what they do not:

- Cases 1–4 test the row logic that the IndexedDB adapter uses.
- Cases 5–11 test `makeCaptureDb` (caching, ordering on the write queue, the
  limit guard) and the row logic driven in index order by the fake.
- No test runs the IndexedDB adapter code in Step 3. That is checked by
  typecheck, by review, and by the browser check below.

Browser check (do it if you can load the extension; otherwise say in your final
report that it was not done):

1. `bun run build`, then load `.output/chrome-mv3` as an unpacked extension.
2. With Capture on, open two different X threads.
3. Open the popup. The capture section lists the most recently opened thread
   first, with a plausible tweet count for each row.
4. Options → Archive. The header shows the same tweet and conversation counts
   as Options → Capture.

Verification:
`bun run test src/packages/capture/tests/store.test.ts src/background/capture-db.test.ts`
→ all pass, with 4 new pure tests and 7 `summary` tests.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run test:coverage` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "cachedSummary" src/background/capture-db.ts` returns no matches
- [ ] `rg -n "cachedCounts" src/background/capture-db.ts` returns at least 4 matches
- [ ] `rg -n "captureDb\.fold\(" src/entrypoints/background.ts` returns no matches
- [ ] `rg -n "openKeyCursor\(null, 'nextunique'\)" src/background/capture-db.ts` returns 1 match
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 022 is not DONE: `rg -n "cachedSummary" src/background/capture-db.ts`
  returns nothing, or the `CaptureSummaryRequest` handler still calls
  `captureDb.fold(`.
- **Owner question, tie order.** Any existing test asserts the order of
  `recent` rows among conversations that share the same `lastAt`, or asserts
  which member of such a tie group survives the cut-off. Search the summary
  consumers' tests:
  `rg -n "lastAt" src/entrypoints/popup src/entrypoints/options src/components`.
  If one does, the tie order is a requirement and the owner must choose a rule
  first. Do not change that test.
- A test asserts which member's text is shown when the root tweet is not
  stored, beyond "some member".
- A second writer to the capture database exists outside
  `src/background/capture-db.ts`
  (`rg -n "xmd-capture|indexedDB\.open" src`). The in-memory count cache is
  only correct while the service worker is the sole writer.
- Test case 5 fails on `count`, `lastAt`, or the order of conversations with
  distinct `lastAt`. That means the index path and the fold disagree on
  something other than the two documented differences.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Tie order is an accepted change, pending the owner.** Conversations with
  the same `lastAt` now sort by descending `tweetId` within the tie. If the
  owner wants the old order, or a different rule such as "most tweets first",
  the place to add a secondary key is the cursor walk: read past the cut-off
  until `capturedAt` changes, then sort the tie group. That costs extra reads
  only at the boundary.
- **Fallback text.** When the root tweet is not stored, the row shows the
  newest captured member instead of the first one by id.
- Worst case for the reverse walk: the newest records all belong to one long
  thread. The walk then reads that thread's records before it finds a second
  conversation. The cost is bounded by the archive size and is still one
  record at a time.
- The conversation count is C key-only cursor steps after each write. If that
  shows up in a profile, the next step is a small `conversations` object store
  kept up to date inside the `upsert` transaction. That needs an IndexedDB
  version bump and a backfill, so it was left out.
- After this plan, `fold`, `emptyCaptureSummary`, `foldCaptureSummary`, and
  `finishCaptureSummary` have no production caller. Tests use them as the
  reference result. Removing them, together with their tests, is an owner
  decision: the capture spec (§8) names the summary selectors as part of the
  pure core.
- The comment above the `CaptureSummaryRequest` handler describes a cursor
  fold. It is stale after this plan. This plan may not edit comments. Report
  it so the owner can reword it in a docs pass.
- Plan 031 (search) and plan 032 (chunked export) add more reads to the same
  seam. Any new write path must still clear `cachedCounts` before the store
  call.
- The IndexedDB adapter has no automated test. A reviewer should read Step 3
  line by line, in particular the request order in `completeFromIndexes` and
  the cursor stop condition.
