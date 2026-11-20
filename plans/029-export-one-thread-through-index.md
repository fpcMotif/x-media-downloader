# Plan 029: A single-thread export reads only that thread, not the whole archive

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/background/capture-db.ts src/background/capture-db.test.ts src/entrypoints/background.ts src/packages/capture`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/103

## Why this matters

The Archive panel and the popup each have a "JSON" and a "Markdown" button per
conversation. A click sends `ExportCaptureRequest` with a `conversationId`. The
service worker answers by loading every harvested tweet with `getAll()`, then
filtering that array down to one thread. The harvest can hold tens of thousands
of records, so exporting a 10-tweet thread copies the whole archive into worker
memory and builds two archive-sized Maps.

The store already has a `by_conversation` index and a `conversation(id)` method
that nothing in production calls. After this plan a single-thread export reads
the thread through that index, plus one keyed read per quoted tweet that sits
outside the thread.

Cost of one "JSON" or "Markdown" click, estimated from the code (not measured),
for an archive of N records, a thread of T tweets, and Q quoted tweets outside
the thread:

| | Records read from IndexedDB | Map entries built |
| --- | --- | --- |
| Before | N | N |
| After | T + Q | T + Q |

## Current state

Files and roles:

- `src/background/capture-db.ts` — the capture database. `CaptureStore` is the
  persistence seam (IndexedDB adapter by default, an in-memory fake in tests).
  `makeCaptureDb` wraps a store and serializes writes.
- `src/background/capture-db.test.ts` — vitest tests through an in-memory
  `fakeStore()`.
- `src/entrypoints/background.ts` — the service worker. The
  `ExportCaptureRequest` handler is near line 1930. Line numbers in this file
  are approximate. Locate the edit by the quoted code.
- `src/packages/capture/build-export.ts` — pure `composeCaptureExport`. Read
  only. This plan does not change it.

The database is IndexedDB `xmd-capture`, object store `tweets`, keyPath
`tweetId`, with two indexes (`src/background/capture-db.ts:68-70`, `:107-111`):

```ts
const DB_NAME = 'xmd-capture'
const STORE = 'tweets'
const VERSION = 1
```

```ts
      request.addEventListener('upgradeneeded', () => {
        const store = request.result.createObjectStore(STORE, { keyPath: 'tweetId' })
        store.createIndex('by_conversation', 'conversationId')
        store.createIndex('by_capturedAt', 'capturedAt')
      })
```

The seam and the factory (`src/background/capture-db.ts:23-65`):

```ts
export interface CaptureStore {
  upsert(records: ReadonlyArray<TweetRecord>, merge: Merge): Promise<void>
  allRecords(): Promise<TweetRecord[]>
  /** Stream every record through `step` (cursor-driven for IndexedDB) — an
   *  aggregate pass that never materializes the whole store in memory. */
  fold<A>(init: A, step: (acc: A, record: TweetRecord) => A): Promise<A>
  conversation(id: string): Promise<TweetRecord[]>
  count(): Promise<number>
  clear(): Promise<void>
}

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
        const byTweet = new Map<string, TweetRecord>()
        for (const record of records) {
          byTweet.set(record.tweetId, mergeRecord(byTweet.get(record.tweetId), record))
        }
        await store.upsert([...byTweet.values()], mergeRecord)
      }),
    allRecords: () => store.allRecords(),
    fold: (init, step) => store.fold(init, step),
    conversation: (id) => store.conversation(id),
    count: () => store.count(),
    clear: () => writes.run(() => store.clear()),
  }
}
```

Other plans (022, 030, 031, 032, 033) add members to these interfaces. If the
live interfaces have extra members, that is expected. Add this plan's members
beside them.

The typed keyed read and the existing index read
(`src/background/capture-db.ts:83-88`, `:160-164`):

```ts
function getTweetRecord(
  store: IDBObjectStore,
  key: IDBValidKey,
): IDBRequest<TweetRecord | undefined> {
  return store.get(key)
}
```

```ts
    async conversation(id) {
      const db = await openDb()
      const index = db.transaction(STORE, 'readonly').objectStore(STORE).index('by_conversation')
      return promisify(index.getAll(id))
    },
```

The handler (`src/entrypoints/background.ts` near 1930-1941):

```ts
  [
    'ExportCaptureRequest',
    handle<'ExportCaptureRequest'>(async (msg) => {
      const records = await captureDb.allRecords()
      const built = composeCaptureExport(records, msg.kind, msg.conversationId, Date.now())
      if (built === null) return { ok: false, filename: '', text: '' }
      console.info(
        `[XMD] capture export ${msg.kind} → ${built.filename} (${built.text.length} bytes)`,
      )
      return { ok: true, filename: built.filename, text: built.text }
    }),
  ],
```

The message (`src/packages/schema/index.ts:566-569`). It does not change:

```ts
export const ExportCaptureRequest = Schema.TaggedStruct('ExportCaptureRequest', {
  kind: Schema.Literals(['jsonl', 'tree', 'markdown']),
  conversationId: Schema.optional(Schema.String),
})
```

The pure composer (`src/packages/capture/build-export.ts:12-28`):

```ts
export function composeCaptureExport(
  records: ReadonlyArray<TweetRecord>,
  kind: 'jsonl' | 'tree' | 'markdown',
  conversationId: string | undefined,
  nowMs: number,
): { filename: string; text: string } | null {
  if (kind === 'jsonl') {
    const day = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '')
    return { filename: `xharvest-${day}.jsonl`, text: toJsonl(records) }
  }
  if (conversationId === undefined) return null
  const [tree] = buildTree(selectConversation(records, conversationId))
  if (tree === undefined) return null
  if (kind === 'tree')
    return { filename: `thread-${conversationId}.json`, text: toTreeJson(tree, records) }
  return { filename: `thread-${conversationId}.md`, text: toMarkdown(tree, records) }
}
```

Why the composer needs no change. For `tree` and `markdown` it uses `records`
in two ways only. `selectConversation(records, conversationId)` keeps the
records whose `conversationId` matches. `toTreeJson` and `toMarkdown` build a
`tweetId → record` Map from `records` and read it only to resolve each thread
tweet's `quotedTweetId` (`src/packages/capture/lib/export.ts:66-75`):

```ts
export function toExportTweet(r: TweetRecord, byId: Map<string, TweetRecord>): ExportTweet {
  let quote: ExportQuote | null = null
  if (r.quotedTweetId !== undefined) {
    const q = byId.get(r.quotedTweetId)
    quote = {
      id: r.quotedTweetId,
      url: permalink(q?.author.handle ?? '', r.quotedTweetId),
      text: q?.text ?? null,
    }
  }
```

So passing "the thread's records plus the records its tweets quote" produces
the same output as passing the whole archive.

The relevant `TweetRecord` fields (`src/packages/capture/record.ts:51-70`):
`tweetId: string`, `conversationId: string`, `quotedTweetId?: string`.

The test fake (`src/background/capture-db.test.ts:24-59`) implements
`CaptureStore` over a `Map<string, TweetRecord>` named `rows` and counts
`upsertCalls`. Its record builder is `mk(tweetId, opts)`, which defaults
`conversationId` to `tweetId`.

Facts about this repo's test setup:

- The IndexedDB adapter (`makeIndexedDbStore`) has no automated test. The repo
  has no `fake-indexeddb` dependency. Do not add one. New adapter code is
  checked by typecheck, by review against the method beside it, and by the
  browser check in "Test plan".
- `vitest.config.ts` sets a 100% coverage threshold on `src/packages/**`. This
  plan adds no code there. `src/background/**` is outside that gate.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- `for...of` over `.forEach()`. No spread inside a loop accumulator.
- No `await` inside a `for` or `while` loop. The lint rule `no-await-in-loop`
  is on, and the existing loops that break it carry a suppression comment that
  new code may not add.
- Code outside a package imports only that package's root files.
  `@/packages/capture/build-export`, `@/packages/capture/store`, and
  `@/packages/capture/record` are root files. `bun run lint:boundaries`
  enforces this.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. The new
interface members therefore get no JSDoc block. Say so in your final report so
the owner can add one.

## Commands you will need

| Purpose       | Command                               | Expected on success |
|---------------|---------------------------------------|---------------------|
| Typecheck     | `bun run typecheck`                   | exit 0, no errors   |
| Lint          | `bun run lint`                        | exit 0              |
| Format check  | `bun run fmt:check`                   | exit 0              |
| Boundaries    | `bun run lint:boundaries`             | exit 0              |
| Focused tests | `bun run test <path/to/file.test.ts>` | all pass            |
| Full gate     | `bun run check`                       | exit 0              |
| Build         | `bun run build`                       | exit 0              |

The package manager is bun. Never use npm or npx. If `bun run fmt:check` fails
only on files you edited, run `bunx oxfmt --write <those files>` and re-check.

## Scope

**In scope** (the only files you should modify):

- `src/background/capture-db.ts`
- `src/background/capture-db.test.ts`
- `src/entrypoints/background.ts` (only the `ExportCaptureRequest` handler)
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/packages/capture/build-export.ts` and `src/packages/capture/lib/export.ts`
  — the composer and the export shape stay unchanged.
- `src/packages/schema/index.ts` — the message does not change.
- `src/components/capture-export.ts`, the Archive panel, and the popup — the
  reply shape does not change.
- The `jsonl` branch. It still calls `captureDb.allRecords()` after this plan.
  Plan 032 replaces it.
- The IndexedDB schema version and indexes.

## Git workflow

- Branch: `advisor/029-export-one-thread-through-index`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `perf(capture): …`.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. At planning time these in-scope
  files were already modified: `src/background/capture-db.ts`,
  `src/background/capture-db.test.ts`, `src/entrypoints/background.ts`. Never
  revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Write the failing tests

In `src/background/capture-db.test.ts`:

1. Add `import { composeCaptureExport } from '@/packages/capture/build-export'`.
2. In `fakeStore()`, add two counters next to `upsertCalls`:
   `allRecordsCalls: 0` and `byIdsCalls: 0`. Widen the return type annotation to
   include both. Increment `allRecordsCalls` at the top of the fake's
   `allRecords`.
3. Add a `byIds` method to the fake:

```ts
    async byIds(ids: ReadonlyArray<string>) {
      box.byIdsCalls++
      return ids.flatMap((id) => {
        const row = rows.get(id)
        return row === undefined ? [] : [row]
      })
    },
```

4. Add `describe('threadWithQuotes', …)` with the cases in "Test plan".

**Verify**: `bun run test src/background/capture-db.test.ts` → the new tests
FAIL (`db.threadWithQuotes is not a function`, or a type error). The
pre-existing tests still pass.

### Step 2: Add `byIds` to the store seam and the IndexedDB adapter

In `src/background/capture-db.ts`:

1. Add to the `CaptureStore` interface, after `conversation`:

```ts
  byIds(ids: ReadonlyArray<string>): Promise<TweetRecord[]>
```

2. Add to the object returned by `makeIndexedDbStore`, after `conversation`:

```ts
    async byIds(ids) {
      const db = await openDb()
      return new Promise<TweetRecord[]>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly')
        const store = tx.objectStore(STORE)
        const found: TweetRecord[] = []
        for (const id of ids) {
          const get = getTweetRecord(store, id)
          get.addEventListener('success', () => {
            if (get.result !== undefined) found.push(get.result)
          })
        }
        tx.addEventListener('complete', () => resolve(found))
        tx.addEventListener('error', () => reject(tx.error))
        tx.addEventListener('abort', () => reject(tx.error))
      })
    },
```

This mirrors the `upsert` method above it: one transaction, one keyed `get` per
id, resolve on `complete`.

**Verify**: `bun run typecheck` → the only errors, if any, are about
`threadWithQuotes` or `byIds` in the test file.

### Step 3: Add `byIds` and `threadWithQuotes` to `makeCaptureDb`

In `src/background/capture-db.ts`:

1. Add to the `CaptureDb` interface, after `conversation`:

```ts
  byIds(ids: ReadonlyArray<string>): Promise<TweetRecord[]>
  threadWithQuotes(conversationId: string): Promise<TweetRecord[]>
```

2. Add to the object returned by `makeCaptureDb`, after `conversation`:

```ts
    byIds: async (ids) => (ids.length === 0 ? [] : store.byIds(ids)),
    threadWithQuotes: async (conversationId) => {
      const thread = await store.conversation(conversationId)
      const inThread = new Set(thread.map((r) => r.tweetId))
      const quotedIds = new Set<string>()
      for (const r of thread) {
        if (r.quotedTweetId !== undefined && !inThread.has(r.quotedTweetId)) {
          quotedIds.add(r.quotedTweetId)
        }
      }
      if (quotedIds.size === 0) return thread
      const quoted = await store.byIds([...quotedIds])
      return [...thread, ...quoted]
    },
```

The two empty-list guards matter. They keep an empty id list away from the
IndexedDB adapter, so no transaction is opened when there is nothing to read.

**Verify**: `bun run test src/background/capture-db.test.ts` → all pass,
including the new cases.

### Step 4: Use it in the handler

In `src/entrypoints/background.ts`, in the `ExportCaptureRequest` handler,
replace the line

```ts
      const records = await captureDb.allRecords()
```

with

```ts
      const records =
        msg.kind === 'jsonl' || msg.conversationId === undefined
          ? await captureDb.allRecords()
          : await captureDb.threadWithQuotes(msg.conversationId)
```

Change nothing else in the handler. A `tree` or `markdown` request with no
`conversationId` still reaches `composeCaptureExport`, which returns `null` for
it, exactly as today.

**Verify**:
- `rg -n "captureDb\.threadWithQuotes\(" src/entrypoints/background.ts` → 1 match.
- `rg -n "captureDb\.allRecords\(\)" src/entrypoints/background.ts` → 1 match.
- `bun run typecheck` → exit 0.

### Step 5: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

New cases in `src/background/capture-db.test.ts`, in a new
`describe('threadWithQuotes', …)`. Use the existing `mk` builder and
`fakeStore()`. Model the layout on the existing `describe('makeCaptureDb', …)`
block in the same file.

Shared fixture for cases 1–3. Put these records with `db.putRecords`:

- `mk('10', { conversationId: '10', text: 'root' })`
- `mk('11', { conversationId: '10', inReplyToTweetId: '10', quotedTweetId: '90', text: 'reply quoting outside' })`
- `mk('12', { conversationId: '10', inReplyToTweetId: '10', quotedTweetId: '10', text: 'reply quoting the root' })`
- `mk('13', { conversationId: '10', inReplyToTweetId: '10', quotedTweetId: '404', text: 'quote never captured' })`
- `mk('90', { conversationId: '90', author: { handle: 'bob' }, text: 'quoted elsewhere' })`
- `mk('50', { conversationId: '50', text: 'unrelated thread' })`

1. **Returns the thread plus outside quotes only.**
   `(await db.threadWithQuotes('10')).map((r) => r.tweetId).toSorted()` equals
   `['10', '11', '12', '13', '90']`. Record `'50'` is absent. The uncaptured
   quote `'404'` adds nothing.
2. **Same export text as the whole-archive path.** For both `'tree'` and
   `'markdown'`:
   `composeCaptureExport(await db.threadWithQuotes('10'), kind, '10', 0)`
   deep-equals `composeCaptureExport(await db.allRecords(), kind, '10', 0)`.
   This encodes the requirement: the export must not change. The expected value
   comes from the existing whole-archive path, which this plan does not edit.
   Also assert the `tree` text contains `'quoted elsewhere'`, so the test cannot
   pass with quotes silently dropped on both sides.
3. **Does not read the whole store.** After the `putRecords`, read
   `store.allRecordsCalls`, call `db.threadWithQuotes('10')`, and expect
   `store.allRecordsCalls` unchanged and `store.byIdsCalls` to be `1`.
4. **A thread with no outside quotes skips the keyed read.** Put
   `[mk('1'), mk('2', { conversationId: '1' })]`. Call
   `db.threadWithQuotes('1')`. Expect 2 records and `store.byIdsCalls` to be `0`.
5. **An unknown conversation returns an empty list.**
   `await db.threadWithQuotes('nope')` equals `[]`.
6. **`byIds([])` never reaches the store.** `await db.byIds([])` equals `[]`
   and `store.byIdsCalls` is `0`.

There is no unit-test harness for the IndexedDB adapter or for `background.ts`
wiring. Step 2's adapter code and Step 4 are verified by typecheck, lint, the
`rg` checks, and the browser check below.

Browser check (do it if you can load the extension; otherwise say in your final
report that it was not done):

1. `bun run build`, then load `.output/chrome-mv3` as an unpacked extension.
2. With Capture on, open any X thread so at least one conversation is stored.
3. Options → Archive → click "JSON" on a row. A `thread-<id>.json` file
   downloads and contains that thread's tweets.

Verification: `bun run test src/background/capture-db.test.ts` → all pass,
including 6 new tests.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] The 6 new tests exist and pass
- [ ] `rg -n "captureDb\.threadWithQuotes\(" src/entrypoints/background.ts` returns 1 match
- [ ] `rg -c "byIds" src/background/capture-db.ts` prints 5 or more
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `ExportCaptureRequest` handler or `makeCaptureDb` does not match the
  excerpts, beyond extra interface members added by plans 022, 030, 031, 032,
  or 033.
- `composeCaptureExport`, `toTreeJson`, or `toMarkdown` reads `records` for
  anything other than the thread filter and the `quotedTweetId` lookup. Check
  with `rg -n "byId\.get|indexById|selectConversation" src/packages/capture`.
  A third use means "thread plus quotes" is no longer enough.
- Test case 2 fails after Step 3. That means the two paths produce different
  text. Do not edit the composer to make it pass.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The export of one thread now resolves quotes one level deep, which is what
  the export shape needs today (`ExportQuote` carries only id, url, and text).
  If the export ever inlines a quoted tweet's own quote, `threadWithQuotes`
  must follow the chain.
- `byIds` is reused by plan 031 (search rows) and plan 032 (JSONL chunks). Keep
  its contract: unknown ids are skipped, order is not guaranteed.
- The IndexedDB adapter has no automated test in this repo. A reviewer should
  read Step 2's `byIds` against the `upsert` method beside it. Adding
  `fake-indexeddb` as a dev dependency would let all adapter code be tested. It
  is an owner decision and is not part of this plan.
- Deferred: the `jsonl` branch still loads the whole store. Plan 032 covers it.
