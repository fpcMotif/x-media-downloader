# Plan 031: Archive search covers every captured tweet, not the newest 1000 roots

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/background/capture-db.ts src/background/capture-db.test.ts src/entrypoints/background.ts src/packages/schema/index.ts src/packages/kernel/tests/sender-guard.test.ts src/components/capture-export.ts src/entrypoints/options/panels/archive.tsx src/entrypoints/options/panels/archive.test.ts`
> This plan runs AFTER plan 029, so `capture-db.ts`, its test, and
> `background.ts` WILL show changes. Compare the "Current state" excerpts
> against the live code before proceeding; on a mismatch beyond what plan 029
> describes, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: `plans/029-export-one-thread-through-index.md` must be DONE (this plan calls `captureDb.byIds`). Run after plans 022 and 030 if they are pending, because they edit the same files.
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/105

## Why this matters

The Options → Archive panel has a search box labelled "Search handles and
text". It filters a list the panel already holds: the newest 1000
conversations, each with only its root tweet's handle and text. So:

- A conversation older than the newest 1000 can never be found.
- A reply's text is never searched. A thread whose root says "thread 🧵" and
  whose replies hold the content does not match a word from the replies.
- A reply author's handle is never searched.

The panel tells the user that "Export all (JSONL) includes everything" but
gives no sign that search does not.

After this plan the service worker runs the search over every stored tweet and
returns the matching conversations. The panel sends the query after a short
pause in typing.

Cost of one search, estimated from the code (not measured), for N records in C
conversations:

| | Records read in the worker | Memory in the worker | What is searched |
| --- | --- | --- | --- |
| Before | 0 (the panel filters its own list) | none | root tweets of the newest 1000 conversations |
| After | N, in chunks of 1000, once per debounced query | one chunk plus one small entry per conversation (no text) | every stored tweet |

This plan fixes correctness first. It does not make search sublinear. See
"Maintenance notes" for the next step if N grows large.

## Current state

Files and roles:

- `src/background/capture-db.ts` — the capture database: the `CaptureStore`
  seam, `makeCaptureDb`, and the IndexedDB adapter.
- `src/background/capture-db.test.ts` — tests through an in-memory `fakeStore()`.
- `src/entrypoints/background.ts` — the service worker and its message
  handlers. Line numbers in this file are approximate.
- `src/packages/schema/index.ts` — the typed message schemas and the `Message`
  union.
- `src/packages/kernel/sender-guard.ts` — which message tags a content script
  may send.
- `src/packages/capture/` — the pure capture core. Root files such as
  `store.ts` and `build-export.ts` are importable from outside the package.
- `src/components/capture-export.ts` — page-side helpers that message the
  worker (`fetchCaptureSummary`, `runCaptureExport`).
- `src/entrypoints/options/panels/archive.tsx` — the Archive panel.
- `src/entrypoints/options/panels/archive.test.ts` — a source-text test of the
  panel.

The database is IndexedDB `xmd-capture`, object store `tweets`, keyPath
`tweetId` (a string). Records are `TweetRecord`
(`src/packages/capture/record.ts`). The fields this plan reads are `tweetId`,
`conversationId`, `author.handle`, `text`, and `capturedAt`. A root tweet is a
record whose `tweetId` equals its `conversationId`.

The panel's filter (`src/entrypoints/options/panels/archive.tsx:154-163`):

```tsx
  const loaded = summary?.recent ?? []
  const conversations = summary?.conversations ?? 0

  const needle = query.trim().toLowerCase()
  const matches =
    needle === ''
      ? loaded
      : loaded.filter((c) => `@${c.rootHandle} ${c.rootText}`.toLowerCase().includes(needle))
  const shown = matches.slice(0, visible)
  const remaining = matches.length - shown.length
```

The panel's state and timers (`archive.tsx:121-137`):

```tsx
export function ArchivePanel() {
  const [summary, setSummary] = useState<CaptureSummary | null>(null)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [visible, setVisible] = useState(PAGE_SIZE)
  // One owned status-flash timer: a newer flash cancels the older timer before
  // rearming, and unmount cancels whatever is pending.
  const statusTimer = useOwnedTimer()
  const eraseStrip = useConfirmStrip()

  const refreshSummary = (): void => void fetchCaptureSummary(ARCHIVE_FETCH_LIMIT).then(setSummary)
  useEffect(refreshSummary, [])

  const flashStatus = (msg: string): void => {
    setStatusMsg(msg)
    statusTimer.arm(() => setStatusMsg(null), 5000)
  }
```

The search input (`archive.tsx:188-200`):

```tsx
          <Input
            type="search"
            aria-label="Search handles and text"
            placeholder="Search handles and text…"
            value={query}
            onInput={(e: Event) => {
              if (e.target instanceof HTMLInputElement) {
                setQuery(e.target.value)
                setVisible(PAGE_SIZE)
              }
            }}
            sx={styles.searchInput}
          />
```

`useOwnedTimer()` (`src/components/owned-timer.ts`) returns
`{ arm(fn, delayMs), cancel }`. `arm` cancels a pending timer first. Unmount
cancels it.

`src/entrypoints/options/panels/archive.test.ts` reads the panel's source text
and asserts that it contains these two exact strings. Keep both lines
unchanged:

- `const statusTimer = useOwnedTimer()`
- `statusTimer.arm(() => setStatusMsg(null), 5000)`

The page-side summary helper (`src/components/capture-export.ts:80-108`):

```ts
export interface CaptureSummary {
  readonly tweets: number
  readonly conversations: number
  readonly recent: ReadonlyArray<{
    readonly conversationId: string
    readonly rootHandle: string
    readonly rootText: string
    readonly count: number
    readonly lastAt: number
  }>
}

export const fetchCaptureSummary = (limit?: number): Promise<CaptureSummary | null> =>
  browser.runtime
    .sendMessage(
      limit === undefined
        ? { _tag: 'CaptureSummaryRequest' }
        : { _tag: 'CaptureSummaryRequest', limit },
    )
    .then((s: CaptureSummary | null) => {
      return s ?? null
    })
    .catch(() => null)
```

(The real `.then` body holds a comment. It is omitted here.)

A message schema and the union (`src/packages/schema/index.ts:560-563`,
`:684-688`):

```ts
export const CaptureSummaryRequest = Schema.TaggedStruct('CaptureSummaryRequest', {
  limit: Schema.optional(Schema.Number),
})
export type CaptureSummaryRequest = typeof CaptureSummaryRequest.Type
```

```ts
  CaptureTweets,
  CaptureSummaryRequest,
  ExportCaptureRequest,
  ClearCaptureRequest,
  ExportDiagnosticsRequest,
```

A handler entry in the `messageHandlers` Map in `background.ts` (near line
1921). After plans 022 and 030 the body differs. The entry shape is the same:

```ts
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

The sender guard: `CONTENT_SCRIPT_TAGS` in
`src/packages/kernel/sender-guard.ts:31-46` lists the tags a content script may
send. Every other tag is UI-only. Its test
(`src/packages/kernel/tests/sender-guard.test.ts:77-85`):

```ts
  it('forbids a content script from triggering export/clear/summary (UI-only)', () => {
    for (const tag of [
      'ExportCaptureRequest',
      'ClearCaptureRequest',
      'CaptureSummaryRequest',
    ] as const) {
      expect(isMessageAllowed(tag, cs, OWN)).toBe(false)
    }
  })
```

The next test, at line 87, has the same list for the options page.

The row type the reply reuses (`src/packages/capture/store.ts:3-9`):

```ts
export type RecentConversation = {
  conversationId: string
  rootHandle: string
  rootText: string
  count: number
  lastAt: number
}
```

The store seam after plan 029 has `byIds(ids: ReadonlyArray<string>): Promise<TweetRecord[]>`
on both `CaptureStore` and `CaptureDb`. It returns the stored records for the
ids that exist. `CaptureDb.byIds([])` returns `[]` without touching the store.

### Checklist for a new message tag

This repo needs five edits for a new UI-to-worker message. All five are steps
below.

1. A `Schema.TaggedStruct` and its type in `src/packages/schema/index.ts`.
2. The struct added to the `Message` union in the same file.
3. A decode test in `src/packages/schema/tests/capture-schema.test.ts`.
4. A handler entry in the `messageHandlers` Map in `background.ts`.
5. The tag added to both UI-only lists in `sender-guard.test.ts`. Do NOT add it
   to `CONTENT_SCRIPT_TAGS`. A page script on x.com must not be able to search
   the archive.

Facts about this repo's test setup:

- The IndexedDB adapter has no automated test. The repo has no
  `fake-indexeddb` dependency. Do not add one.
- `vitest.config.ts` sets a 100% coverage threshold on `src/packages/**`. Every
  branch of the new file `src/packages/capture/search.ts` needs a test.
- No `await` inside a `for` or `while` loop (`no-await-in-loop`). New code may
  not add a suppression. Use recursion. `reconcileNext` in
  `src/background/remote-upload.ts` (near line 317) is the pattern.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no new `as`
  except `as const` on a tuple in a test, which already exists.
- `unknown` is banned in parameters, returns, and type aliases.
- Code outside a package imports only that package's root files.
  `@/packages/capture/search` will be a root file. `bun run lint:boundaries`
  enforces this.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. New exports
get no JSDoc block. Say so in your final report.

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

- `src/packages/capture/search.ts` (create)
- `src/packages/capture/tests/search.test.ts` (create)
- `src/packages/schema/index.ts`
- `src/packages/schema/tests/capture-schema.test.ts`
- `src/packages/kernel/tests/sender-guard.test.ts`
- `src/background/capture-db.ts`
- `src/background/capture-db.test.ts`
- `src/entrypoints/background.ts` (one new handler entry, one constant, imports)
- `src/components/capture-export.ts`
- `src/entrypoints/options/panels/archive.tsx`
- `src/entrypoints/options/panels/archive.test.ts`
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/packages/kernel/sender-guard.ts`. The new tag stays UI-only by default.
- The IndexedDB schema version and indexes. A stored lowercase field or a
  full-text index needs a version bump and a backfill. Not in this plan.
- The popup. It has no search box.
- The summary request, the export request, and their handlers.
- The panel's styles, copy for the empty archive, export buttons, and erase
  flow.

## Git workflow

- Branch: `advisor/031-search-whole-archive`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `fix(capture): …`.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. At planning time these in-scope
  files were already modified: `src/background/capture-db.ts`,
  `src/background/capture-db.test.ts`, `src/entrypoints/background.ts`,
  `src/packages/schema/index.ts`, `src/entrypoints/options/panels/archive.tsx`.
  Never revert or stash them.
- Before editing, run `git status --short` and note which in-scope files are
  already modified.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Write the pure search core, test first

Create `src/packages/capture/tests/search.test.ts` with "Test plan" cases 1–9.
Use `src/packages/capture/tests/store.test.ts` as the pattern for imports and
for the record builder. Import from `'../search'`.

**Verify**: `bun run test src/packages/capture/tests/search.test.ts` → FAILS
(module not found).

Create `src/packages/capture/search.ts`:

```ts
import type { TweetRecord } from './record'
import type { RecentConversation } from './store'

export type CaptureSearchEntry = {
  conversationId: string
  count: number
  lastAt: number
  matched: boolean
  fallbackTweetId: string
}

export type CaptureSearchAcc = {
  needle: string
  byConversation: Map<string, CaptureSearchEntry>
}

export type CaptureSearchReply = {
  total: number
  matches: RecentConversation[]
}

export function startCaptureSearch(query: string): CaptureSearchAcc {
  return { needle: query.trim().toLowerCase(), byConversation: new Map() }
}

export function foldCaptureSearch(acc: CaptureSearchAcc, r: TweetRecord): CaptureSearchAcc {
  const hit = `@${r.author.handle} ${r.text}`.toLowerCase().includes(acc.needle)
  const entry = acc.byConversation.get(r.conversationId)
  if (entry === undefined) {
    acc.byConversation.set(r.conversationId, {
      conversationId: r.conversationId,
      count: 1,
      lastAt: r.capturedAt,
      matched: hit,
      fallbackTweetId: r.tweetId,
    })
    return acc
  }
  entry.count += 1
  entry.lastAt = Math.max(entry.lastAt, r.capturedAt)
  entry.matched ||= hit
  return acc
}

export function pickCaptureMatches(
  acc: CaptureSearchAcc,
  limit: number,
): { total: number; picked: CaptureSearchEntry[] } {
  const matched = [...acc.byConversation.values()].filter((e) => e.matched)
  return {
    total: matched.length,
    picked: matched.toSorted((a, b) => b.lastAt - a.lastAt).slice(0, limit),
  }
}

export function captureSearchRowIds(picked: ReadonlyArray<CaptureSearchEntry>): string[] {
  return [...new Set(picked.flatMap((e) => [e.conversationId, e.fallbackTweetId]))]
}

export function finishCaptureSearch(
  picked: ReadonlyArray<CaptureSearchEntry>,
  records: ReadonlyArray<TweetRecord>,
): RecentConversation[] {
  const byId = new Map(records.map((r) => [r.tweetId, r]))
  return picked.flatMap((e) => {
    const shown = byId.get(e.conversationId) ?? byId.get(e.fallbackTweetId)
    if (shown === undefined) return []
    return [
      {
        conversationId: e.conversationId,
        rootHandle: shown.author.handle,
        rootText: shown.text,
        count: e.count,
        lastAt: e.lastAt,
      },
    ]
  })
}
```

How it works:

- The haystack for one record is `` `@${handle} ${text}` `` in lower case. This
  is the same string the panel builds today, applied to every record instead of
  only the root.
- A conversation matches when any of its records matches.
- The accumulator holds one small entry per conversation. It holds no tweet
  text. Text for the rows shown is fetched afterwards by id.
- `fallbackTweetId` is the first record seen for the conversation. It supplies
  the row's handle and text when the root tweet is not stored. This is the same
  fallback the summary fold uses.
- `foldCaptureSearch` mutates and returns `acc`, the same way
  `foldCaptureSummary` does.

**Verify**: `bun run test src/packages/capture/tests/search.test.ts` → all pass.

### Step 2: Add the message schema

In `src/packages/schema/tests/capture-schema.test.ts`, add "Test plan" case 10.
Follow the existing test "decodes ExportCaptureRequest via its tagged shape and
the Message union" in that file.

**Verify**: `bun run test src/packages/schema/tests/capture-schema.test.ts` →
the new test FAILS (missing export).

In `src/packages/schema/index.ts`, add directly after the `CaptureSummaryRequest`
type line:

```ts
export const CaptureSearchRequest = Schema.TaggedStruct('CaptureSearchRequest', {
  query: Schema.String,
  limit: Schema.optional(Schema.Number),
})
export type CaptureSearchRequest = typeof CaptureSearchRequest.Type
```

In the `Message` union, add `CaptureSearchRequest,` on the line after
`CaptureSummaryRequest,`.

**Verify**: `bun run test src/packages/schema/tests/capture-schema.test.ts` →
all pass.

### Step 3: Pin the new tag as UI-only

In `src/packages/kernel/tests/sender-guard.test.ts`, add
`'CaptureSearchRequest',` to the tuple in the test "forbids a content script
from triggering export/clear/summary (UI-only)" and to the tuple in the test
that follows it for the options page.

This test passes without a source change, because tags are UI-only by default.
Prove it can fail: temporarily add `'CaptureSearchRequest'` to
`CONTENT_SCRIPT_TAGS` in `src/packages/kernel/sender-guard.ts`, run the test,
see the "forbids" test fail, then remove the line again.

**Verify**: `bun run test src/packages/kernel/tests/sender-guard.test.ts` → all
pass, and `git diff --stat -- src/packages/kernel/sender-guard.ts` → empty.

### Step 4: Add a paged read and a chunked scan to the capture database

In `src/background/capture-db.test.ts`:

1. Add a counter `pageCalls: 0` to `fakeStore()` and a `page` method:

```ts
    async page(after: string | undefined, limit: number) {
      box.pageCalls++
      return [...rows.values()]
        .toSorted((a, b) => (a.tweetId < b.tweetId ? -1 : 1))
        .filter((r) => after === undefined || r.tweetId > after)
        .slice(0, limit)
    },
```

   The fake returns rows in ascending `tweetId` string order, which is the order
   IndexedDB returns string keys.
2. Add `describe('scan', …)` with "Test plan" cases 11–14.

**Verify**: `bun run test src/background/capture-db.test.ts` → the `scan` cases
FAIL.

In `src/background/capture-db.ts`:

1. Add to the `CaptureStore` interface, after `conversation`:

```ts
  page(after: string | undefined, limit: number): Promise<TweetRecord[]>
```

2. Add to the `CaptureDb` interface, after `fold`:

```ts
  scan<A>(init: A, step: (acc: A, record: TweetRecord) => A, chunkSize?: number): Promise<A>
```

3. Add at module level, above `makeCaptureDb`:

```ts
const SCAN_CHUNK = 1000

function scanStore<A>(
  store: CaptureStore,
  init: A,
  step: (acc: A, record: TweetRecord) => A,
  chunkSize: number,
): Promise<A> {
  const scanFrom = async (acc: A, after: string | undefined): Promise<A> => {
    const chunk = await store.page(after, chunkSize)
    let folded = acc
    for (const record of chunk) folded = step(folded, record)
    const last = chunk.at(-1)
    if (last === undefined || chunk.length < chunkSize) return folded
    return scanFrom(folded, last.tweetId)
  }
  return scanFrom(init, undefined)
}
```

4. Add to the object returned by `makeCaptureDb`, after `fold`:

```ts
    scan: (init, step, chunkSize = SCAN_CHUNK) => scanStore(store, init, step, chunkSize),
```

5. Add to the object returned by `makeIndexedDbStore`, after `conversation`:

```ts
    async page(after, limit) {
      const db = await openDb()
      const range = after === undefined ? null : IDBKeyRange.lowerBound(after, true)
      return promisify(db.transaction(STORE, 'readonly').objectStore(STORE).getAll(range, limit))
    },
```

`IDBKeyRange.lowerBound(after, true)` means "keys strictly greater than
`after`". Each call is its own short read transaction, so a write can run
between two chunks.

`scan` differs from the existing `fold`: `fold` fires one IndexedDB event per
record through a cursor. `scan` fetches up to 1000 records per event. Do not
change or remove `fold`.

**Verify**: `bun run test src/background/capture-db.test.ts` → all pass.

### Step 5: Add the worker handler

In `src/entrypoints/background.ts`:

1. Add the import:

```ts
import {
  captureSearchRowIds,
  finishCaptureSearch,
  foldCaptureSearch,
  pickCaptureMatches,
  startCaptureSearch,
} from '@/packages/capture/search'
```

   Place it next to the other `@/packages/capture/…` imports.
2. Next to `const captureRecentLimit = 20`, add:

```ts
const captureSearchLimit = 200
```

3. In the `messageHandlers` Map, directly after the `CaptureSummaryRequest`
   entry, add:

```ts
  [
    'CaptureSearchRequest',
    handle<'CaptureSearchRequest'>(async (msg) => {
      const search = startCaptureSearch(msg.query)
      if (search.needle === '') return { total: 0, matches: [] }
      const { total, picked } = pickCaptureMatches(
        await captureDb.scan(search, foldCaptureSearch),
        msg.limit ?? captureSearchLimit,
      )
      const rows = await captureDb.byIds(captureSearchRowIds(picked))
      return { total, matches: finishCaptureSearch(picked, rows) }
    }),
  ],
```

**Verify**:
- `bun run typecheck` → exit 0. If it reports another exhaustive list of
  message tags that lacks `CaptureSearchRequest`, add the tag there in the same
  way `CaptureSummaryRequest` appears, and name that file in your report.
- `rg -n "'CaptureSearchRequest'" src/entrypoints/background.ts` → 2 matches.

### Step 6: Add the page-side helper

In `src/components/capture-export.ts`, add after `fetchCaptureSummary`:

```ts
export interface CaptureSearchResult {
  readonly total: number
  readonly matches: CaptureSummary['recent']
}

export const fetchCaptureSearch = (
  query: string,
  limit: number,
): Promise<CaptureSearchResult | null> =>
  browser.runtime
    .sendMessage({ _tag: 'CaptureSearchRequest', query, limit })
    .then((s: CaptureSearchResult | null) => s ?? null)
    .catch(() => null)
```

This mirrors `fetchCaptureSummary`. The reply of `sendMessage` is typed `any`,
so the parameter annotation is not a cast.

**Verify**: `bun run typecheck` → exit 0.

### Step 7: Make the panel ask the worker

In `src/entrypoints/options/panels/archive.test.ts`, add "Test plan" case 15.
Follow the existing test in that file, which reads the panel source and checks
for exact strings.

**Verify**: `bun run test src/entrypoints/options/panels/archive.test.ts` → the
new test FAILS. The existing test passes.

In `src/entrypoints/options/panels/archive.tsx`:

1. Change the hooks import to `import { useEffect, useRef, useState } from 'preact/hooks'`.
2. Add `fetchCaptureSearch` and `type CaptureSearchResult` to the existing
   import from `@/components/capture-export`.
3. Next to `PAGE_SIZE`, add `const SEARCH_DEBOUNCE_MS = 200`.
4. In `ArchivePanel`, after the `eraseStrip` line, add:

```tsx
  const [found, setFound] = useState<CaptureSearchResult | null>(null)
  const searchTimer = useOwnedTimer()
  const latestNeedle = useRef('')

  const searchArchive = (text: string): void => {
    const wanted = text.trim()
    latestNeedle.current = wanted
    setFound(null)
    if (wanted === '') {
      searchTimer.cancel()
      return
    }
    searchTimer.arm(() => {
      void fetchCaptureSearch(wanted, ARCHIVE_FETCH_LIMIT).then((result) => {
        if (latestNeedle.current === wanted) setFound(result ?? { total: 0, matches: [] })
      })
    }, SEARCH_DEBOUNCE_MS)
  }
```

5. Replace the `matches` computation with:

```tsx
  const needle = query.trim()
  const searching = needle !== '' && found === null
  const matches = needle === '' ? loaded : (found?.matches ?? [])
```

   Keep the `shown` and `remaining` lines as they are.
6. In the search input's `onInput`, add `searchArchive(e.target.value)` after
   `setVisible(PAGE_SIZE)`.
7. In `eraseArchive`, inside `if (outcome.ok)`, add `searchArchive('')` after
   `setQuery('')`.
8. Change the Refresh button's `onClick` to run both:
   `onClick={() => { refreshSummary(); searchArchive(query) }}`.
9. In the list's conditional rendering, add a branch before the "no matches"
   copy: when `searching` is true, render
   `<FieldDescription>Searching…</FieldDescription>`. The branch order becomes:
   summary is null → "Loading…"; `searching` → "Searching…"; `shown.length > 0`
   → the list; otherwise the existing empty and no-match copy.
10. Find the caption that starts "Showing the newest". It renders when the
    archive holds more conversations than were loaded. Keep it for an empty
    query. For a non-empty query, render instead, only when
    `found !== null && found.total > found.matches.length`:
    `Showing the newest {found.matches.length} of {found.total} matching conversations.`

Keep these two lines exactly as they are:
`const statusTimer = useOwnedTimer()` and
`statusTimer.arm(() => setStatusMsg(null), 5000)`.

Why `latestNeedle`: replies can arrive out of order. The guard drops a reply
for a query the user has already replaced.

**Verify**:
- `bun run test src/entrypoints/options/panels/archive.test.ts` → all pass.
- `rg -n "loaded.filter" src/entrypoints/options/panels/archive.tsx` → no matches.

### Step 8: Run the gate

**Verify**: `bun run check` → exit 0. `bun run test:coverage` → exit 0.
`bun run build` → exit 0.

## Test plan

`src/packages/capture/tests/search.test.ts`. The expectations come from the
requirement "search handles and text across the whole archive", not from the
implementation.

1. **`startCaptureSearch` trims and lowercases.** `startCaptureSearch('  FoO ').needle`
   is `'foo'`.
2. **A reply's text matches its conversation.** Root `1` with text `'thread'`,
   reply `2` in conversation `1` with text `'Rust borrow checker'`. Searching
   `'borrow'` yields one match with `conversationId` `'1'`.
3. **A reply author's handle matches.** A reply by handle `bob` in a
   conversation rooted by `alice`. Searching `'@bob'` yields that conversation.
4. **Case does not matter.** Searching `'RUST'` finds text `'rust'`.
5. **A conversation with no matching record is absent**, and `total` counts
   only matching conversations.
6. **Rows show the root tweet.** In case 2, the row's `rootHandle` and
   `rootText` are the root's, `count` is `2`, and `lastAt` is the larger
   `capturedAt`.
7. **Rows fall back to the first member when the root is not stored.** Only
   reply `2` of conversation `1` exists. The row shows the reply's handle and
   text.
8. **Newest first, capped.** Three matching conversations with `lastAt` 10, 30,
   20 and limit 2. `total` is `3`. `picked` conversation ids are the ones with
   30 and 20, in that order.
9. **A picked entry whose records are gone is dropped.**
   `finishCaptureSearch(picked, [])` returns `[]`. Also assert
   `captureSearchRowIds` returns each id once when the root is the fallback
   record.

For cases 2–8, build the result the way the worker does:
fold the records with `foldCaptureSearch` from `startCaptureSearch(query)`,
call `pickCaptureMatches`, then `finishCaptureSearch(picked, records)`.

`src/packages/schema/tests/capture-schema.test.ts`:

10. **`CaptureSearchRequest` decodes directly and through `Message`.**
    `{ _tag: 'CaptureSearchRequest', query: 'rust', limit: 5 }` decodes with
    both. `{ _tag: 'CaptureSearchRequest', query: 'rust' }` decodes with
    `limit` undefined. `{ _tag: 'CaptureSearchRequest' }` throws.

`src/background/capture-db.test.ts`, `describe('scan', …)`:

11. **Visits every record once.** Put 5 records. `db.scan(0, (n) => n + 1, 2)`
    resolves to `5`.
12. **Visits in ascending id order across chunks.** Collect ids with chunk size
    2. Expect the ids sorted ascending, each once.
13. **Stops on a short chunk.** With 5 records and chunk size 2,
    `store.pageCalls` is `3`. With 4 records and chunk size 2, it is `3` (the
    third call returns an empty chunk).
14. **An empty store yields the initial value** with one `page` call.

`src/entrypoints/options/panels/archive.test.ts`:

15. **The panel searches through the worker.** The panel source contains
    `fetchCaptureSearch(wanted, ARCHIVE_FETCH_LIMIT)` and
    `const searchTimer = useOwnedTimer()`, and does not contain
    `loaded.filter(`.

What is not covered by automated tests: the IndexedDB `page` adapter and the
panel's rendering. Check them in the browser.

Browser check (do it if you can load the extension; otherwise say in your final
report that it was not done):

1. `bun run build`, then load `.output/chrome-mv3` as an unpacked extension.
2. With Capture on, open an X thread that has replies. Note a distinctive word
   that appears only in a reply.
3. Options → Archive. Type that word. The thread appears after a short pause.
4. Clear the box. The full list returns.
5. Type a string that matches nothing. The existing "No conversations match"
   copy appears.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run test:coverage` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "CaptureSearchRequest" src/packages/schema/index.ts` returns 4 matches
- [ ] `rg -n "CaptureSearchRequest" src/packages/kernel/sender-guard.ts` returns no matches
- [ ] `rg -n "CaptureSearchRequest" src/packages/kernel/tests/sender-guard.test.ts` returns 2 matches
- [ ] `rg -n "loaded.filter" src/entrypoints/options/panels/archive.tsx` returns no matches
- [ ] `rg -n "statusTimer.arm\(\(\) => setStatusMsg\(null\), 5000\)" src/entrypoints/options/panels/archive.tsx` returns 1 match
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 029 is not DONE: `rg -n "byIds" src/background/capture-db.ts` returns
  nothing.
- A test or document states that Archive search is meant to cover root tweets
  only. Check `rg -n -i "search" docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md`.
  If it does, the wider search is a product change and the owner must agree.
- The new handler needs `CaptureSearchRequest` in `CONTENT_SCRIPT_TAGS` to
  work. It must not. The Options page is not a content script.
- `bun run test:coverage` fails on `src/packages/capture/search.ts` and the
  only way to pass is to delete a branch that a requirement needs.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Search reads every record once per query.** At tens of thousands of records
  this is tens of chunk reads. If it becomes slow, the next step is a stored
  lowercase search field or a token index. Both need an IndexedDB version bump
  and a backfill of existing rows, so they are a separate plan.
- **The reply is capped, with no resume cursor.** The worker returns the newest
  `limit` matching conversations and the full match count. The panel pages
  through that list locally, as it does today. The caption tells the user when
  matches were cut off.
- **Search now matches replies.** A conversation appears when any of its tweets
  matches. The row still shows the root tweet, so the matched word may not be
  visible in the row. If that confuses users, the alternative is to show the
  matching tweet's text in the row. That is a design decision for the owner.
- **A search is a snapshot taken chunk by chunk.** Tweets captured while a
  search runs may or may not be included. The next keystroke or Refresh
  corrects it.
- Plan 032 reuses `CaptureStore.page` for the chunked JSONL export.
- The IndexedDB `page` adapter has no automated test. A reviewer should check
  the exclusive lower bound, because an inclusive bound would repeat one record
  per chunk.
