# Plan 032: "Export all (JSONL)" travels in chunks instead of one archive-sized message

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/background/capture-db.ts src/background/capture-db.test.ts src/entrypoints/background.ts src/packages/schema/index.ts src/packages/kernel/tests/sender-guard.test.ts src/packages/capture/build-export.ts src/packages/capture/build-export.test.ts src/components/capture-export.ts`
> This plan runs AFTER plans 029 and 031, so several of these files WILL show
> changes. Compare the "Current state" excerpts against the live code before
> proceeding; on a mismatch beyond what those plans describe, treat it as a
> STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/029-export-one-thread-through-index.md` (for `captureDb.byIds`) and `plans/031-search-whole-archive.md` (for `CaptureStore.page`) must both be DONE.
- **Category**: perf
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/106

## Why this matters

"Export all (JSONL)" in the popup and in Options → Archive asks the service
worker for the whole archive as one string. The worker loads every record with
`getAll()`, builds one JSON line per record, joins them into one string, and
sends that string back in one `runtime.sendMessage` reply. The page then copies
it into a Blob.

Estimated from the code (not measured), the archive exists about five times at
the peak: the record array, the array of lines, the joined string, the message
copy, and the page's copy. Three of those are in the service worker. Chrome
also caps the size of one extension message. The cap is believed to be 64 MiB.
This plan did not verify that number. Past the cap the export fails outright,
and the page shows "Nothing harvested yet".

After this plan the page asks for the export 500 records at a time and
assembles the file itself.

| | Worker peak | Largest single message | Page peak |
| --- | --- | --- | --- |
| Before | whole archive as records, lines, and one string | the whole export | the export string plus the Blob |
| After | 500 records and their lines | 500 lines | the export as chunk strings plus the Blob |

Records read are the same in both cases: N, plus the quoted tweets a chunk
refers to that are not in that chunk.

## Why the page does not open IndexedDB itself

An extension page could open `xmd-capture` directly and skip the worker. This
plan does not do that. Plan 022 and plan 030 cache summary counts in the worker
and both carry a STOP condition for a second `indexedDB.open` site. A single
open site also keeps the schema version in one place.

## Current state

Files and roles:

- `src/packages/capture/build-export.ts` — pure composer for the three export
  kinds. A root file of the capture package.
- `src/packages/capture/build-export.test.ts` — its tests.
- `src/packages/capture/lib/export.ts` — `toExportTweet`, `toJsonl`,
  `toTreeJson`, `toMarkdown`.
- `src/background/capture-db.ts` — the capture database.
- `src/entrypoints/background.ts` — the worker's message handlers. Line numbers
  are approximate.
- `src/packages/schema/index.ts` — message schemas and the `Message` union.
- `src/components/capture-export.ts` — the page-side export, used by the
  Archive panel and the popup.
- `src/components/capture-erase.test.ts` — the pattern for testing a page-side
  helper with an injected sender.

The composer (`src/packages/capture/build-export.ts:12-28`):

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
```

Its imports are:

```ts
import type { TweetRecord } from './record'
import { selectConversation } from './store'
import { buildTree } from './lib/tree'
import { toJsonl, toMarkdown, toTreeJson } from './lib/export'
```

The JSONL writer (`src/packages/capture/lib/export.ts:60-61`, `:66`, `:107-110`):

```ts
const indexById = (all: ReadonlyArray<TweetRecord>): Map<string, TweetRecord> =>
  new Map(all.map((r) => [r.tweetId, r]))
```

```ts
export function toExportTweet(r: TweetRecord, byId: Map<string, TweetRecord>): ExportTweet {
```

```ts
export function toJsonl(records: ReadonlyArray<TweetRecord>): string {
  const byId = indexById(records)
  return records.map((r) => JSON.stringify(toExportTweet(r, byId))).join('\n')
}
```

`toExportTweet` looks up exactly one other record: the one whose id is
`r.quotedTweetId`. It uses that record's `author.handle` and `text`. Nothing
else crosses records. So a chunk needs only its own records plus the tweets
they quote.

The worker handler (`src/entrypoints/background.ts`, near line 1931, shape at
planning time; plan 029 changes its first line):

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

`allRecords()` is `getAll()` on the object store. It returns records in
ascending `tweetId` key order. A chunked walk in ascending key order therefore
produces the same line order.

The page side (`src/components/capture-export.ts:27-78`, comments omitted):

```ts
export async function runCaptureExport(
  kind: CaptureExportKind,
  conversationId?: string,
): Promise<ExportOutcome> {
  console.info(`[XMD] capture-export click kind=${kind} conv=${conversationId ?? '-'}`)

  let res: ExportResponse | null = null
  try {
    res = await browser.runtime.sendMessage({
      _tag: 'ExportCaptureRequest',
      kind,
      conversationId,
    })
  } catch (err) {
    console.error('[XMD] capture-export sendMessage threw', err)
    return { ok: false, detail: 'Could not reach the extension worker.' }
  }

  console.info('[XMD] capture-export response', {
    ok: res?.ok,
    filename: res?.filename,
    bytes: res?.text?.length ?? 0,
  })
  if (!res?.ok || !isNonEmptyString(res.text)) {
    return { ok: false, detail: 'Nothing harvested yet — turn on Capture and browse X.' }
  }

  const filename = res.filename ?? 'xharvest.jsonl'
  const url = URL.createObjectURL(new Blob([res.text], { type: 'application/octet-stream' }))

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  console.info(`[XMD] capture-export <a download> fired → ${filename} (${res.text.length} bytes)`)
  return { ok: true, detail: `Exported ${filename} — check your Downloads folder.` }
}
```

Between `const url` and `const a` there is a five-line comment about the
synthetic `<a download>` click. Callers: `archive.tsx` (`doExport`) and
`src/entrypoints/popup/capture-quick-actions.tsx:213` (`runCaptureExport('jsonl')`).

State expected from earlier plans. Confirm with `rg` before you start:

- Plan 029: `CaptureDb.byIds(ids: ReadonlyArray<string>): Promise<TweetRecord[]>`.
  It returns the stored records among the ids, and `[]` for an empty list.
- Plan 031: `CaptureStore.page(after: string | undefined, limit: number): Promise<TweetRecord[]>`.
  It returns up to `limit` records with `tweetId` strictly greater than
  `after`, in ascending key order. The test fake in
  `src/background/capture-db.test.ts` has `page` and a `pageCalls` counter.
  Plan 031 does not expose `page` on `CaptureDb`. This plan does.

### Checklist for a new message tag

1. A `Schema.TaggedStruct` and its type in `src/packages/schema/index.ts`.
2. The struct added to the `Message` union in the same file.
3. A decode test in `src/packages/schema/tests/capture-schema.test.ts`.
4. A handler entry in the `messageHandlers` Map in `background.ts`.
5. The tag added to both UI-only lists in
   `src/packages/kernel/tests/sender-guard.test.ts` (the tests at lines 77 and
   87). Do NOT add it to `CONTENT_SCRIPT_TAGS` in
   `src/packages/kernel/sender-guard.ts`. A page script on x.com must not be
   able to read the archive.

Facts about this repo's test setup:

- The IndexedDB adapter has no automated test. The repo has no
  `fake-indexeddb` dependency. Do not add one.
- `vitest.config.ts` sets a 100% coverage threshold on `src/packages/**`. Every
  branch of the new functions in `build-export.ts` needs a test.
- No `await` inside a `for` or `while` loop (`no-await-in-loop`). New code may
  not add a suppression. Use recursion.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Code outside a package imports only that package's root files.
  `@/packages/capture/build-export` is a root file.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Step 5 moves one existing comment together with the code it
describes. Move it byte for byte. Do not edit any Markdown file except this
plan's status row in `plans/README.md`. New exports get no JSDoc block. Say so
in your final report.

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

- `src/packages/capture/build-export.ts`
- `src/packages/capture/build-export.test.ts`
- `src/packages/schema/index.ts`
- `src/packages/schema/tests/capture-schema.test.ts`
- `src/packages/kernel/tests/sender-guard.test.ts`
- `src/background/capture-db.ts`
- `src/background/capture-db.test.ts`
- `src/entrypoints/background.ts` (one new handler entry, one constant, imports)
- `src/components/capture-export.ts`
- `src/components/capture-export.test.ts` (create)
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/packages/capture/lib/export.ts`. `toJsonl` and `toExportTweet` stay as
  they are. The tests use `toJsonl` as the reference output.
- The `ExportCaptureRequest` schema and handler. Tree and Markdown exports keep
  using them. The `'jsonl'` literal stays in the schema. See Maintenance notes.
- `src/packages/kernel/sender-guard.ts`.
- The Archive panel and the popup. They call `runCaptureExport('jsonl')` and
  need no change.
- Opening IndexedDB from a page.
- A streamed download through the File System Access API. It opens a Save
  dialog, which closes the popup.

## Git workflow

- Branch: `advisor/032-stream-jsonl-export-in-page`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `perf(capture): …`.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. At planning time these in-scope
  files were already modified: `src/background/capture-db.ts`,
  `src/background/capture-db.test.ts`, `src/entrypoints/background.ts`,
  `src/packages/schema/index.ts`. Never revert or stash them.
- Before editing, run `git status --short` and note which in-scope files are
  already modified.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Add the pure chunk composer, test first

In `src/packages/capture/build-export.test.ts`, add
`describe('chunked jsonl export', …)` with "Test plan" cases 1–5. Import
`composeJsonlChunk`, `jsonlExportFilename`, and `quotedIdsOutside` from
`'./build-export'`, and `toJsonl` from `'./lib/export'` if the file does not
import it yet.

**Verify**: `bun run test src/packages/capture/build-export.test.ts` → the new
tests FAIL (missing exports).

In `src/packages/capture/build-export.ts`:

1. Change the lib import to
   `import { toExportTweet, toJsonl, toMarkdown, toTreeJson } from './lib/export'`.
2. Add below the imports:

```ts
export function jsonlExportFilename(nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '')
  return `xharvest-${day}.jsonl`
}

export function quotedIdsOutside(chunk: ReadonlyArray<TweetRecord>): string[] {
  const inChunk = new Set(chunk.map((r) => r.tweetId))
  const quoted = chunk.flatMap((r) => (r.quotedTweetId === undefined ? [] : [r.quotedTweetId]))
  return [...new Set(quoted)].filter((id) => !inChunk.has(id))
}

export function composeJsonlChunk(
  chunk: ReadonlyArray<TweetRecord>,
  quoted: ReadonlyArray<TweetRecord>,
): string {
  const byId = new Map([...quoted, ...chunk].map((r) => [r.tweetId, r]))
  return chunk.map((r) => JSON.stringify(toExportTweet(r, byId))).join('\n')
}
```

3. In `composeCaptureExport`, replace the two lines of the `jsonl` branch with:

```ts
    return { filename: jsonlExportFilename(nowMs), text: toJsonl(records) }
```

**Verify**: `bun run test src/packages/capture/build-export.test.ts` → all pass,
including the existing test "jsonl: stamps the filename from nowMs and matches
toJsonl(records)".

### Step 2: Add the message schema and pin it UI-only

1. In `src/packages/schema/tests/capture-schema.test.ts`, add "Test plan" case
   6. Follow the existing `ExportCaptureRequest` decode test in that file.
2. Run it and see it FAIL.
3. In `src/packages/schema/index.ts`, add directly after the
   `ExportCaptureRequest` type line:

```ts
export const ExportCaptureChunkRequest = Schema.TaggedStruct('ExportCaptureChunkRequest', {
  after: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Number),
})
export type ExportCaptureChunkRequest = typeof ExportCaptureChunkRequest.Type
```

4. In the `Message` union, add `ExportCaptureChunkRequest,` on the line after
   `ExportCaptureRequest,`.
5. In `src/packages/kernel/tests/sender-guard.test.ts`, add
   `'ExportCaptureChunkRequest',` to the tuples in the tests at lines 77 and 87.
   Prove the "forbids" test can fail: temporarily add the tag to
   `CONTENT_SCRIPT_TAGS` in `src/packages/kernel/sender-guard.ts`, see the test
   fail, then remove it.

**Verify**:
- `bun run test src/packages/schema/tests/capture-schema.test.ts src/packages/kernel/tests/sender-guard.test.ts` → all pass.
- `git diff --stat -- src/packages/kernel/sender-guard.ts` → empty.

### Step 3: Expose `page` on the capture database

In `src/background/capture-db.test.ts`, add "Test plan" case 7 in a
`describe('page', …)`.

**Verify**: it FAILS (`db.page is not a function`, or a type error).

In `src/background/capture-db.ts`:

1. Add to the `CaptureDb` interface, after `scan`:

```ts
  page(after: string | undefined, limit: number): Promise<TweetRecord[]>
```

2. Add to the object returned by `makeCaptureDb`, after `scan`:

```ts
    page: (after, limit) => store.page(after, limit),
```

**Verify**: `bun run test src/background/capture-db.test.ts` → all pass.

### Step 4: Add the worker handler

In `src/entrypoints/background.ts`:

1. Extend the import from `@/packages/capture/build-export` to
   `composeCaptureExport, composeJsonlChunk, jsonlExportFilename, quotedIdsOutside`.
2. Next to `const captureRecentLimit = 20`, add:

```ts
const captureExportChunk = 500
```

3. In the `messageHandlers` Map, directly after the `ExportCaptureRequest`
   entry, add:

```ts
  [
    'ExportCaptureChunkRequest',
    handle<'ExportCaptureChunkRequest'>(async (msg) => {
      const limit = msg.limit ?? captureExportChunk
      const chunk = await captureDb.page(msg.after, limit)
      const quoted = await captureDb.byIds(quotedIdsOutside(chunk))
      const last = chunk.at(-1)
      return {
        lines: composeJsonlChunk(chunk, quoted),
        next: last !== undefined && chunk.length === limit ? last.tweetId : null,
        filename: jsonlExportFilename(Date.now()),
      }
    }),
  ],
```

The reply means: `lines` is this chunk's JSON lines joined with `\n`, with no
trailing newline. `next` is the `after` value for the next request, or `null`
when this was the last chunk.

**Verify**:
- `bun run typecheck` → exit 0. If it reports another exhaustive list of
  message tags that lacks the new tag, add it there the way
  `ExportCaptureRequest` appears, and name that file in your report.
- `rg -n "'ExportCaptureChunkRequest'" src/entrypoints/background.ts` → 2 matches.

### Step 5: Assemble the file in the page

Create `src/components/capture-export.test.ts` with "Test plan" cases 8–12. Use
`src/components/capture-erase.test.ts` as the pattern: the function under test
takes its sender as a parameter and the test passes a plain async function.

**Verify**: `bun run test src/components/capture-export.test.ts` → FAILS
(missing export).

In `src/components/capture-export.ts`:

1. Add below `isNonEmptyString`:

```ts
interface ExportChunkResponse {
  readonly lines?: string
  readonly next?: string | null
  readonly filename?: string
}

export type RequestExportChunk = (after: string | undefined) => Promise<ExportChunkResponse | null>

export type JsonlCollection =
  | { readonly kind: 'ready'; readonly filename: string; readonly chunks: ReadonlyArray<string> }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unreachable' }

export function collectJsonlExport(requestChunk: RequestExportChunk): Promise<JsonlCollection> {
  const chunks: string[] = []
  const collectFrom = async (after: string | undefined): Promise<JsonlCollection> => {
    const res = await requestChunk(after).catch(() => null)
    if (res === null || typeof res.lines !== 'string') return { kind: 'unreachable' }
    if (res.lines !== '') chunks.push(res.lines)
    if (typeof res.next === 'string') return collectFrom(res.next)
    if (chunks.length === 0) return { kind: 'empty' }
    return { kind: 'ready', filename: res.filename ?? 'xharvest.jsonl', chunks }
  }
  return collectFrom(undefined)
}

const requestChunkFromWorker: RequestExportChunk = (after) =>
  browser.runtime.sendMessage(
    after === undefined
      ? { _tag: 'ExportCaptureChunkRequest' }
      : { _tag: 'ExportCaptureChunkRequest', after },
  )
```

2. Extract the download tail of `runCaptureExport` into one function that both
   paths use. Add it above `runCaptureExport`:

```ts
function saveExport(filename: string, parts: BlobPart[], bytes: number): ExportOutcome {
  const url = URL.createObjectURL(new Blob(parts, { type: 'application/octet-stream' }))

  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  console.info(`[XMD] capture-export <a download> fired → ${filename} (${bytes} bytes)`)
  return { ok: true, detail: `Exported ${filename} — check your Downloads folder.` }
}
```

   Move the existing five-line comment about the synthetic `<a download>` click
   with this code, unchanged, to the same position (between the `const url`
   line and the `const a` line).
3. In `runCaptureExport`, replace everything from `const filename = …` to the
   end of the function with:

```ts
  return saveExport(res.filename ?? 'xharvest.jsonl', [res.text], res.text.length)
```

4. At the top of `runCaptureExport`, directly after the first `console.info`
   line, add:

```ts
  if (kind === 'jsonl') return runJsonlExport(requestChunkFromWorker)
```

5. Add below `runCaptureExport`:

```ts
export async function runJsonlExport(requestChunk: RequestExportChunk): Promise<ExportOutcome> {
  const collected = await collectJsonlExport(requestChunk)
  if (collected.kind === 'unreachable') {
    return { ok: false, detail: 'Could not reach the extension worker.' }
  }
  if (collected.kind === 'empty') {
    return { ok: false, detail: 'Nothing harvested yet — turn on Capture and browse X.' }
  }
  const parts = collected.chunks.flatMap((chunk, i) => (i === 0 ? [chunk] : ['\n', chunk]))
  const bytes = collected.chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  return saveExport(collected.filename, parts, bytes)
}
```

   If lint rejects `reduce`, compute `bytes` with a `for…of` loop instead.

The two failure messages are the existing ones, copied exactly.

The recursion in `collectFrom` awaits between calls, so it does not grow the
call stack.

**Verify**:
- `bun run test src/components/capture-export.test.ts` → all pass.
- `bun run typecheck` → exit 0.

### Step 6: Run the gate

**Verify**: `bun run check` → exit 0. `bun run test:coverage` → exit 0.
`bun run build` → exit 0.

## Test plan

`src/packages/capture/build-export.test.ts`, `describe('chunked jsonl export', …)`.
The reference output is `toJsonl(all)`, which this plan does not edit.

1. **Chunks joined by a newline equal the whole export.** Build 5 records with
   ids `'1'`–`'5'`, where `'5'` quotes `'1'` and `'2'` quotes `'9'` (not
   stored). Split them into chunks of 2 in id order. For each chunk compute
   `composeJsonlChunk(chunk, all.filter((r) => quotedIdsOutside(chunk).includes(r.tweetId)))`.
   Expect the chunk texts joined with `'\n'` to equal `toJsonl(all)`.
2. **A quote outside the chunk carries its text.** For the chunk holding `'5'`,
   parse its line and expect `quote.text` to equal record `'1'`'s text.
3. **`quotedIdsOutside` lists each outside id once and skips ids inside the
   chunk.** Chunk `[a quotes b, b, c quotes z, d quotes z]` yields `['z']`.
4. **An empty chunk composes to an empty string.**
   `composeJsonlChunk([], [])` is `''`, and `quotedIdsOutside([])` is `[]`.
5. **`jsonlExportFilename` stamps the UTC day.** For the `nowMs` the existing
   jsonl test uses, expect `'xharvest-20260705.jsonl'`.

`src/packages/schema/tests/capture-schema.test.ts`:

6. **`ExportCaptureChunkRequest` decodes directly and through `Message`.**
   `{ _tag: 'ExportCaptureChunkRequest' }` decodes with `after` and `limit`
   undefined. `{ _tag: 'ExportCaptureChunkRequest', after: '12', limit: 100 }`
   decodes with both set. `{ _tag: 'ExportCaptureChunkRequest', after: 12 }`
   throws.

`src/background/capture-db.test.ts`, `describe('page', …)`:

7. **`page` walks the store in id order without repeats.** Put records `'1'`,
   `'2'`, `'3'`. `db.page(undefined, 2)` has ids `['1','2']`. `db.page('2', 2)`
   has ids `['3']`. `db.page('3', 2)` is `[]`.

`src/components/capture-export.test.ts`, with a fake `requestChunk`:

8. **Chunks are collected in order until `next` is null.** A fake that answers
   `{ lines: 'a', next: '1', filename: 'f.jsonl' }` then
   `{ lines: 'b', next: null, filename: 'f.jsonl' }` yields
   `{ kind: 'ready', filename: 'f.jsonl', chunks: ['a', 'b'] }`. Also assert the
   fake was called with `undefined` and then `'1'`.
9. **An empty archive is reported as empty.** `{ lines: '', next: null }`
   yields `{ kind: 'empty' }`.
10. **A missing reply is reported as unreachable.** A fake that resolves `null`
    on the second call yields `{ kind: 'unreachable' }`.
11. **A throwing sender is reported as unreachable.**
12. **A reply without a filename falls back to `xharvest.jsonl`.**

What is not covered by automated tests: the IndexedDB `page` adapter (added by
plan 031), the Blob assembly, and the download click. Check them in the browser.

Browser check (do it if you can load the extension; otherwise say in your final
report that it was not done):

1. Before this change, with some captures stored, run "Export all (JSONL)" and
   keep the file.
2. `bun run build`, reload the extension, and export again without browsing X
   in between.
3. The two files are byte-identical: `cmp old.jsonl new.jsonl` prints nothing.
4. The file has one line per stored tweet: `wc -l` plus one equals the tweet
   count shown in Options → Archive.
5. Run the export from the popup as well. The popup stays open and the file
   lands in Downloads.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run test:coverage` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "ExportCaptureChunkRequest" src/packages/schema/index.ts` returns 4 matches
- [ ] `rg -n "ExportCaptureChunkRequest" src/packages/kernel/sender-guard.ts` returns no matches
- [ ] `rg -n "ExportCaptureChunkRequest" src/packages/kernel/tests/sender-guard.test.ts` returns 2 matches
- [ ] `rg -n "kind === 'jsonl'\) return runJsonlExport" src/components/capture-export.ts` returns 1 match
- [ ] `rg -n "indexedDB" src/components src/entrypoints/options src/entrypoints/popup` returns no matches
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 029 or plan 031 is not DONE:
  `rg -n "byIds|page\(" src/background/capture-db.ts` lacks either name.
- Test case 1 fails. The chunked output must equal `toJsonl(all)` byte for
  byte. A difference means `toExportTweet` reads another record besides the
  quoted one, and the chunk context in this plan is incomplete.
- A test asserts that the JSONL export is sent as `ExportCaptureRequest`
  (`rg -n "jsonl" src --glob "*.test.*"`). Report it. Do not change that test
  without the owner.
- The `doc-lock` hook rejects the comment move in Step 5 or any other edit.
  Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **The export is no longer one snapshot.** Each chunk is its own read. Tweets
  captured during an export are included when their id sorts after the current
  position and left out otherwise. A tweet updated during the export appears in
  its old or new form, never twice. For a quiet archive the file is
  byte-identical to the old export.
- **The page still holds the whole export once** as chunk strings before the
  Blob is built. A truly streamed download needs the File System Access API and
  a Save dialog. That would close the popup, so it was left out.
- After this plan, no UI code sends `ExportCaptureRequest` with kind `'jsonl'`.
  The worker branch and the schema literal still exist. Removing them also
  removes the last production caller of `captureDb.allRecords()`. That is a
  contract change for the owner to schedule. Until then the old path still
  works for any other caller.
- The comment at the top of `src/components/capture-export.ts` says the worker
  answers `{ ok, filename, text }`. That stays true for tree and Markdown. It
  does not describe the chunked JSONL path. This plan may not edit comments.
  Report it for a docs pass.
- Chunk size 500 is a guess. Larger chunks mean fewer messages and more worker
  memory per message. The request's `limit` field lets a caller choose.
- The Chrome message size cap quoted in "Why this matters" is unverified. The
  chunked path stays far below any plausible cap, so the exact number does not
  affect this plan.
