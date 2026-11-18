# Plan 019: Download history lives in memory with coalesced writes, and the durable ledgers stop re-reading storage

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> This plan has two parts. **Part A (history) is complete on its own.** You
> may stop after Part A, run the gates, and report Part B as not started.
> Do Part B only if Part A is green.
>
> **Drift check (run first)**:
> `git diff --stat 7456911 -- src/background/history-log.ts src/background/history-log.test.ts src/entrypoints/background.ts src/packages/kernel/durable-store.ts src/packages/kernel/tests/durable-store.test.ts src/background/cloud-upload.ts src/background/sync-outbox.ts src/background/capture-outbox.ts`
> `src/entrypoints/background.ts`, `src/background/cloud-upload.ts`, and
> `src/background/capture-outbox.ts` already show as changed, because the
> working tree had uncommitted edits when this plan was written. Those files
> were being edited while this plan was written, so their line numbers are
> approximate; find each place by the quoted text. Compare every "Current state" excerpt against the live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: `plans/018-cache-settings-and-skip-noop-writes.md` (must be DONE first; Part B relies on its "skip the write when the reducer returns its input" change in `runSerializedRmw`, and both plans edit `src/entrypoints/background.ts` and `src/packages/kernel/durable-store.ts`). This plan does not depend on 018's settings cache: it works with either `getSettings()` or `settingsCache.get()` at the call sites.
- **Category**: perf
- **Planned at**: commit `7456911`, 2026-11-16. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

The service worker keeps several lists in `chrome.storage.local`. For each
single change it reads the whole list from storage, decodes it through a
schema, changes one entry, and writes the whole list back.

- **Download history** (up to 500 records): one full read, decode, and rewrite
  per finished download and per batch start. A 50-item batch does about 51 of
  these cycles. Four other code paths decode the whole list again just to read
  it.
- **Upload ledger, sync outbox, capture outbox**: every step reads the list
  from storage before changing it. The service worker is the only code that
  writes these keys, so each of those reads returns exactly what the worker
  wrote last.

After this plan: history is decoded once per service-worker life and held in
memory; writes that arrive while a write is in flight are folded into one
write; and the three ledgers serve reads from memory. Every ledger write
stays immediate, so nothing about crash safety changes.

## Current state

### Part A — download history

Everything lives in `src/entrypoints/background.ts` at module scope. Find each
excerpt by its text.

The store and its two writers (near line 584):

```ts
// Durable local download history (opt-in `downloadHistoryEnabled`): the
// local-first twin of Convex `media_state`, fed from the SAME outcome points as
// the Sync Events above so the two never diverge. `local:` survives SW recycle.
const historyItem = storage.defineItem<JsonValue>('local:downloadHistory', { fallback: null })
const historyQueue = makeSerialQueue(queueError('history'))
// Serialized read-modify-write, like the outbox, so interleaved SW events can't
// lose an update. Gated by the toggle; orthogonal to Cloud Sync.
const recordHistory = (settings: Settings, actions: ReadonlyArray<HistoryAction>): void => {
  if (!settings.downloadHistoryEnabled || actions.length === 0) return
  historyQueue.push(() => persistHistory(settings, actions))
}

const persistHistory = async (
  settings: Settings,
  actions: ReadonlyArray<HistoryAction>,
): Promise<void> => {
  if (!settings.downloadHistoryEnabled || actions.length === 0) return
  let store = decodeStore(await historyItem.getValue())
  for (const a of actions) store = planHistory(store, settings, a)
  await historyItem.setValue(store)
}
```

An awaited write (near line 523):

```ts
const handleCloudHistoryNotice = async (notice: CloudHistoryNotice): Promise<void> => {
  const item = cloudGrabs.get(notice.mediaId)
  const settings = await getSettings()
  await historyQueue.run(() =>
    persistHistory(settings, [
      {
        kind: `cloud-${notice.kind}`,
        requestId: notice.mediaId,
        at: notice.at,
      },
    ]),
  )
```

(After plan 018, `getSettings()` on that line reads `settingsCache.get()`.
Leave whichever form is there.)

Three readers that each decode the whole store:

```ts
const cloudPostIdFromHistory = async (mediaId: string): Promise<string | undefined> =>
  decodeStore(await historyItem.getValue()).records.find((r) => r.requestId === mediaId)?.media
    .postId
```

```ts
  getBackfillRecords: async () =>
    decodeStore(await historyItem.getValue()).records.map((r) => ({
      requestId: r.requestId,
      filename: r.filename,
      media: { url: r.media.url, handle: r.media.author, ext: r.media.ext },
    })),
```

```ts
// Seed once on SW startup from the durable history's completed tweetIds.
void (async () => {
  const { records } = decodeStore(await historyItem.getValue())
  const completed = records.filter((r) => r.status === 'completed')
  savedIndex.seed(completed.map((r) => r.media.postId))
  savedMediaIndex.seed(completed.map((r) => r.requestId)) // requestId === item.id
})()
```

The two message handlers (near line 1850):

```ts
  // Both of these go through `historyQueue`, like `recordHistory` — reading or
  // erasing outside it races the queued read-modify-write. A `recordHistory`
  // task that already read the store, then an erase, then that task's write:
  // the erased records come back. The read is queued for the weaker reason —
  // otherwise the popup can render a store that a queued write is about to
  // replace.
  [
    'HistoryRequest',
    () =>
      historyQueue.run(async () => ({
        records: decodeStore(await historyItem.getValue()).records,
      })),
  ],
  ['SavedStatusRequest', handle<'SavedStatusRequest'>((msg) => savedStatusCoordinator.handle(msg))],
  [
    'ClearHistoryRequest',
    () =>
      historyQueue.run(async () => {
        await historyItem.setValue(emptyStore)
        return { ok: true } as const
      }),
  ],
```

`recordHistory(settings, actions)` is also called from three places that must
keep working unchanged (search `recordHistory(`): two lines of the form
`recordHistory: (actions) => recordHistory(settings, actions),` and one
`recordHistory(settings, historyActions)`.

The relevant imports in `background.ts`:

```ts
import { makeSerialQueue } from '@/packages/kernel/serial-queue'
import { decodeStore, emptyStore } from '@/packages/history/store'
import { planHistory, type HistoryAction } from '@/packages/history/wiring'
```

The pure history functions (not edited):

```ts
// src/packages/history/store.ts:10-22
/** The durable local download history (newest-first), the local twin of `media_state`. */
export type DownloadStore = typeof DownloadStoreSchema.Type

export const emptyStore: DownloadStore = { records: [] }

/** Decode stored history; fall back to empty on a SchemaError (corrupt data). */
export function decodeStore(raw: JsonValue): DownloadStore {
  try {
    return Schema.decodeUnknownSync(DownloadStoreSchema)(raw)
  } catch {
    return emptyStore
  }
}
```

```ts
// src/packages/history/wiring.ts:6-16
export type HistoryAction =
  | { kind: 'queued'; item: MediaItem; filename: string; at: number }
  | { kind: 'cloud-completed'; requestId: string; at: number }
  | { kind: 'cloud-failed'; requestId: string; at: number }
  | { kind: 'cloud-queued'; requestId: string; at: number }
  | {
      kind: 'completed' | 'failed'
      requestId: string
      at: number
      bytes?: { received: number; total: number }
    }
```

```ts
// src/packages/history/wiring.ts:29-34
export function planHistory(
  store: DownloadStore,
  settings: Settings,
  action: HistoryAction,
): DownloadStore {
  if (!settings.downloadHistoryEnabled) return store
```

`planHistory` returns the SAME `store` reference when an action changes
nothing (see `applyTransition` in `store.ts`: `return changed ? { records } : store`).

Facts verified while writing this plan:

- Only `background.ts` reads or writes `local:downloadHistory`. The options
  page and popup use the `HistoryRequest` and `ClearHistoryRequest` messages.
  (`rg -n "downloadHistory'" src --glob '!*.test.ts'` shows one `defineItem`.)

### Part B — durable ledgers

The three live store factories. Each is used only when a test does not inject
its own store:

```ts
// src/background/cloud-upload.ts:235-239 (approximate)
/** The live UploadJob-ledger store: the durable `local:cloudUploadJobs` wxt item. */
const defaultLedgerStore = (): LedgerStore => {
  const item = storage.defineItem<JsonValue>('local:cloudUploadJobs', { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}
```

```ts
// src/background/sync-outbox.ts:96-99
const defaultOutboxStore = (): OutboxStorage => {
  const item = storage.defineItem<JsonValue>('local:syncOutbox', { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}
```

```ts
// src/background/capture-outbox.ts:136-139 (approximate)
function defaultLedger(): LedgerStorage {
  const item = storage.defineItem<JsonValue>('local:captureOutbox', { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}
```

How the upload ledger is read and written (every read hits storage today):

```ts
// src/background/cloud-upload.ts:377-380
  const readLedger = (): Promise<JobLedger> =>
    storeQueue.run(async () => decodeLedger(await store.get()))
  const updateLedger = (update: (ledger: JobLedger) => JobLedger | Promise<JobLedger>) =>
    runSerializedRmw(storeQueue, store, decodeLedger, update)
```

The claim that must stay durable before each upload starts (inside
`drainUploadJobs`; find it by `let afterClaim`):

```ts
// src/background/cloud-upload.ts:617-631 (approximate)
      let claimed = false
      let token: number | undefined
      let afterClaim: JobLedger = []
      await updateLedger((current) => {
        const c = claim(current, job.jobId, now)
        claimed = c.claimed
        token = c.token
        afterClaim = capLedger(c.ledger)
        return afterClaim
      })
      if (!claimed || token === undefined) {
        // `claim` itself retires a job whose crash count is exhausted.
        await publishMovedJob(settings, afterClaim, job)
        continue
      }
```

A second `claim` runs a few lines above it, in the "provider disconnected"
branch (find it by `let afterFailure`). It also goes through `updateLedger`.
This plan reads both and edits neither. Both rely on one property:
`updateLedger` resolves only after the new ledger is in `storage.local`.
Part B keeps that property (Step 6: the cache is assigned after the inner
write resolves).

The shared helper and interface, as they look AFTER plan 018:

```ts
// src/packages/kernel/durable-store.ts
export interface DurableStore {
  readonly get: () => Promise<JsonValue>
  readonly set: (value: JsonValue) => Promise<void>
}

export const runSerializedRmw = <S extends JsonValue>(
  queue: SerialQueue,
  store: DurableStore,
  decode: (raw: JsonValue) => S,
  update: (state: S) => S | Promise<S>,
): Promise<S> =>
  queue.run(async () => {
    const current = decode(await store.get())
    const next = await update(current)
    if (next !== current) await store.set(next)
    return next
  })
```

Facts verified while writing this plan:

- `local:cloudUploadJobs`, `local:syncOutbox`, and `local:captureOutbox` are
  each defined in exactly one file and written only through that file's store
  object. Nothing in `src/entrypoints/options`, `src/entrypoints/popup`, or
  `src/components` touches them.

### Decisions this plan must stay consistent with

- `docs/adr/0010-durable-local-download-history.md:42-43`: "The background
  does serialized read-modify-write like the Outbox; the popup reads it via a
  `HistoryRequest` message." Part A keeps one ordered writer in the background
  and keeps the message. It replaces "read from storage each time" with "read
  from storage once". It adds no delay timer: a change is written at once
  unless a write is already in flight, in which case it goes out in the very
  next write.
- `docs/adr/0005-state-persistence-split.md:15-16`: "single-writer: the
  background SW". Both parts depend on this. If any other context writes one
  of these keys, the in-memory copy would be wrong.
- `docs/adr/0020-durable-drain-storage-and-sync-wake.md:29-30`: "Cloud Upload
  fencing and alarm logic stay unchanged." Part B does not touch `claim`,
  `updateLedger`, the drain loop, or any alarm. Every write still reaches
  `storage.local` before `updateLedger` resolves.
- `docs/adr/0013-client-side-cloud-byte-upload.md:14`: "The durable browser
  UploadJob ledger owns retries and outcomes for browser-executed jobs."

### Repo conventions (from `AGENTS.md`)

- "Forbidden, without exception: `oxlint-disable` / `eslint-disable` /
  `@ts-ignore` / `@ts-expect-error`". The lint config flags `await` inside a
  loop; see Step 2 for how the flush loop avoids it.
- "Every `as` needs an uppercase `SAFETY:` comment". Add no new `as` casts.
  (The existing `{ ok: true } as const` in `ClearHistoryRequest` stays.)
- `unknown` is banned in parameters, returns, and type aliases. Use the domain
  type, or `JsonValue` from `@/packages/schema`. A `catch` binding is the one
  place a value arrives untyped: narrow it there with
  `error instanceof Error ? error : new Error(String(error))`.
- "Named constants, not magic numbers." "`async/await` over promise chains."
- Packages under `src/packages` are imported only through their root files
  (`bun run lint:boundaries`). `@/packages/history/store` and
  `@/packages/history/wiring` are root files and may be imported from
  `src/background/`.
- Effect code is Effect v4. v3 idioms such as `Effect.Service`, `catchAll`,
  and `decodeUnknownEither` do not exist. This plan needs no new Effect code.
- Tests are vitest with assertions inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. Step 3
names the one comment that leaves with its code (the six-line comment above
`'HistoryRequest'`). Every other comment stays as written, including the
two-line comment above `recordHistory`, because `recordHistory` stays.

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

The package manager is bun. Never use npm or npx.

## Scope

**In scope** (the only files you should modify):

Part A:

- `src/background/history-log.ts` (create)
- `src/background/history-log.test.ts` (create)
- `src/entrypoints/background.ts` — the history code shown above only

Part B:

- `src/packages/kernel/durable-store.ts` — add one exported function
- `src/packages/kernel/tests/durable-store.test.ts` — add tests
- `src/background/cloud-upload.ts` — `defaultLedgerStore` only
- `src/background/sync-outbox.ts` — `defaultOutboxStore` only
- `src/background/capture-outbox.ts` — `defaultLedger` only

Both parts:

- `plans/README.md` — this plan's row in the "Performance plans (012–023)"
  table only

**Out of scope** (do NOT touch, even though they look related):

- `src/packages/history/*` — the pure reducers stay as they are.
- `drainUploadJobs`, `claim`, `updateLedger`, `readLedger`, `capLedger`, and
  every alarm in `cloud-upload.ts`. Do not keep a decoded ledger in memory and
  do not batch ledger writes. That is a larger change to the fencing path and
  was deliberately left out.
- The drain loops in `sync-outbox.ts` and `capture-outbox.ts`.
- `local:convexDriveReceipts` in `src/background/remote-upload.ts`.
- `session:` keys (metrics, transfers, request meta).
- The message schema and the options History panel.

## Git workflow

- Branch: `advisor/019-coalesce-history-and-ledger-writes`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `perf(history): hold download history in memory and coalesce writes`
  for Part A and `perf(kernel): serve durable ledger reads from memory` for
  Part B. One commit per part.
- Do NOT push or open a PR.
- The working tree has unrelated uncommitted user changes, including edits
  inside `src/entrypoints/background.ts`, `src/background/cloud-upload.ts`,
  and `src/background/capture-outbox.ts`. Never revert or stash them.
- Staging rule: before you start, run `git status --short` and note which
  in-scope files already show as modified. Do NOT commit those files. Leave
  your edits in them unstaged and list them in your report. Commit only
  in-scope files that were clean (or new) when you started.

## Steps

### Step 1 (Part A): Write the failing tests for the history log

Create `src/background/history-log.test.ts`. The unit under test will be
`makeHistoryLog` from `./history-log` with this interface:

```ts
export interface HistoryStorage {
  readonly get: () => Promise<JsonValue>
  readonly set: (value: DownloadStore) => Promise<void>
}

export interface HistoryLog {
  readonly record: (settings: Settings, actions: ReadonlyArray<HistoryAction>) => void
  readonly apply: (settings: Settings, actions: ReadonlyArray<HistoryAction>) => Promise<void>
  readonly read: () => Promise<DownloadStore>
  readonly clear: () => Promise<void>
}

export function makeHistoryLog(deps: {
  readonly store: HistoryStorage
  readonly onError: (error: Error) => void
}): HistoryLog
```

Test fixtures:

- Settings: `{ ...Schema.decodeUnknownSync(Settings)({}), downloadHistoryEnabled: true }`
  with `Settings` from `@/packages/schema` and `Schema` from `effect`
  (pattern: `src/background/admission-gate.test.ts:8-12`).
- A media item (pattern: `src/background/remote-upload.test.ts:20-29`):
  `{ id, platform: 'x', postId: 'post', author: 'alice', type: 'photo', ext: 'jpg', index: 0, url: 'https://pbs.twimg.com/media/test.jpg' } satisfies MediaItem`.
- A queued action: `{ kind: 'queued', item, filename: 'a.jpg', at: 1 }`.
- A fake store with counters and a gate, so a test can hold a write open:

  ```ts
  function gatedStore(initial: JsonValue) {
    const writes: DownloadStore[] = []
    const pending: (() => void)[] = []
    let gets = 0
    let hold = false
    let failNextSet = false
    return {
      writes,
      get gets() { return gets },
      get pendingCount() { return pending.length },
      holdWrites: () => { hold = true },
      releaseWrite: () => pending.shift()?.(),
      failNextSet: () => { failNextSet = true },
      store: {
        get: async () => { gets += 1; return initial },
        set: (value: DownloadStore) =>
          new Promise<void>((resolve, reject) => {
            if (failNextSet) {
              failNextSet = false
              reject(new Error('set failed'))
              return
            }
            const commit = () => { writes.push(value); resolve() }
            if (hold) pending.push(commit)
            else commit()
          }),
      },
    }
  }
  ```

  A rejected `set` is not pushed to `writes`, so `writes` holds only values
  that reached storage.

Tests:

1. "loads storage once across many actions" — three awaited `apply` calls with
   different items → `gets` is 1, and `read()` returns 3 records.
2. "writes the folded state for an awaited apply" — after `await apply(...)`,
   the last entry of `writes` contains the record.
3. "folds actions that arrive during a write into one following write" —
   `holdWrites()`; call `record` with item 1 and wait one macrotask (so the
   first write starts and is held); call `record` four more times with items
   2–5; `releaseWrite()` and wait; `releaseWrite()` again and wait. Expect
   `writes.length` to be exactly 2, and `writes[1].records` to have 5 records.
4. "does not write when the actions change nothing" — `apply` a
   `{ kind: 'completed', requestId: 'unknown-id', at: 1 }` action on an empty
   store → `writes.length` is 0.
5. "does nothing when history is disabled" — settings with
   `downloadHistoryEnabled: false`; `await apply(...)` → `gets` is 0 and
   `writes.length` is 0.
6. "read returns state that is not yet written" — `holdWrites()`; `record`
   one item; wait one macrotask; `await read()` returns 1 record while
   `writes.length` is still 0.
7. "clear empties memory and storage, and a held write cannot bring records
   back" — `holdWrites()`; `record` one item; `await tick()` (the first write
   is now held, so `pendingCount` is 1); `const cleared = log.clear()` (do
   not await yet); `await tick()`; `releaseWrite()`; `await tick()` (the
   record write lands and the clear write is now held, so `pendingCount` is
   1 again); `releaseWrite()`; `await cleared`. Expect `writes.length` to be
   exactly 2, `writes[0].records` to have 1 record, `writes[1]` to equal
   `{ records: [] }`, `pendingCount` to be 0, and `await read()` to return 0
   records.
8. "reports a failed write and retries on the next action" — use
   `gatedStore(null)` without `holdWrites()`; `onError` is `vi.fn()`. Call
   `failNextSet()`; `record` item 1; `await tick()`. Expect `onError` to have
   been called exactly 1 time and `writes.length` to be 0. Then
   `await apply(settings, [queued item 2])`. Expect `writes.length` to be 1
   and `writes[0].records` to have 2 records.
9. "clear replaces undecodable stored data with one write" —
   `gatedStore('not-a-store')` (a string does not decode, so the log starts
   from `emptyStore`); `await clear()`. Expect `writes.length` to be exactly
   1 and `writes[0]` to equal `{ records: [] }`.
10. "clear on an already-empty history still writes once" —
    `gatedStore({ records: [] })`; `await clear()` → `writes.length` is 1.

Wait for a macrotask with
`const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))`
(the same helper as `src/packages/kernel/tests/durable-store.test.ts:6`).

**Verify**: `bun run test src/background/history-log.test.ts` → FAILS because
`./history-log` does not exist. That is the red state.

### Step 2 (Part A): Implement the history log

Create `src/background/history-log.ts`.

Rules for the implementation:

- State: `current: DownloadStore | null` (decoded, in memory),
  `persisted: DownloadStore | null` (the last value known to be in storage),
  `loading: Promise<DownloadStore> | null`, `flushing: Promise<void> | null`.
- `load()`: if `current` is set, return it. Otherwise share one pending read:
  `decodeStore(await deps.store.get())`. When it resolves, set
  `current ??= loaded` and, if `persisted` is still `null`, set
  `persisted = loaded`. Clear `loading` when it settles.
- `flush()`: if `flushing` is set, return it. Otherwise start one pass that
  repeats "take `snapshot = current`, `await deps.store.set(snapshot)`, then
  `persisted = snapshot`" until `current === persisted`. Clear `flushing` in
  a `finally`. Write the repetition as a small recursive async helper
  (`writeUntilCurrent`), not as `await` inside a `while` loop, because the
  linter flags `await` in loops and disable comments are forbidden. The
  helper's first statement is the guard
  `if (current === null || current === persisted) return`. After that guard
  TypeScript knows `current` is a `DownloadStore`, so no non-null assertion
  (`!`) and no cast is needed. Copy `current` into a `const snapshot` right
  after the guard and use only `snapshot` across the `await`.
- `apply(settings, actions)`: return at once if
  `!settings.downloadHistoryEnabled || actions.length === 0`. Otherwise
  `await load()`, then fold synchronously:
  `let next = current; for (const action of actions) next = planHistory(next, settings, action); current = next`
  (start from `current`, not from the value `load()` returned, so actions that
  ran while you were waiting are kept). Then `await flush()`.
- `record(settings, actions)`: call `apply` without awaiting; route a
  rejection to `deps.onError` after narrowing the caught value to `Error`.
  Use an async IIFE with `try`/`catch`, not a promise chain.
- `read()`: `await load()` and return `current`.
- `clear()` must always write the empty store exactly once, even when memory
  is already empty. Reason: `decodeStore` returns the shared `emptyStore`
  constant for undecodable stored data, so `current === persisted` can be
  true while storage still holds the bad bytes. Today's code always writes
  on clear, and this plan keeps that. Implementation: `await load()`, set
  `current = emptyStore`, set `persisted = null`, then `await flush()`.
  Setting `persisted = null` makes the guard in `writeUntilCurrent` fail, so
  one write goes out. If a flush is already running, its helper sees
  `current !== persisted` after its own write and writes the empty store
  next. Tests 7, 9, and 10 pin this.

Imports: `decodeStore`, `emptyStore`, `type DownloadStore` from
`@/packages/history/store`; `planHistory`, `type HistoryAction` from
`@/packages/history/wiring`; `type JsonValue`, `type Settings` from
`@/packages/schema`.

**Verify**: `bun run test src/background/history-log.test.ts` → 10 passed.
**Verify**: `bun run lint` → exit 0 (no `no-await-in-loop` finding).

### Step 3 (Part A): Wire the history log into the service worker

In `src/entrypoints/background.ts`:

1. Add `import { makeHistoryLog } from '../background/history-log'` next to
   the other `'../background/...'` imports.
2. Replace the single line
   `const historyQueue = makeSerialQueue(queueError('history'))` with:

   ```ts
   const historyLog = makeHistoryLog({
     store: {
       get: () => historyItem.getValue(),
       set: (value) => historyItem.setValue(value),
     },
     onError: queueError('history'),
   })
   ```

   Do not touch the two-line comment directly under that line
   (`// Serialized read-modify-write, like the outbox, …` /
   `// lose an update. Gated by the toggle; …`). It sits on `recordHistory`,
   which stays, so the comment rule keeps it. Its wording will be slightly
   out of date; Maintenance notes lists it for the owner. Also keep the
   three-line comment above `const historyItem` and `const historyItem`
   itself.
3. Replace the body of `recordHistory` so it only delegates, and delete
   `persistHistory` entirely. Leave the comment above `recordHistory` as it
   is:

   ```ts
   const recordHistory = (settings: Settings, actions: ReadonlyArray<HistoryAction>): void => {
     historyLog.record(settings, actions)
   }
   ```

4. In `handleCloudHistoryNotice`, replace
   `await historyQueue.run(() => persistHistory(settings, [ ... ]))` with
   `await historyLog.apply(settings, [ ... ])`, keeping the same action array.
5. `cloudPostIdFromHistory`: replace
   `decodeStore(await historyItem.getValue()).records` with
   `(await historyLog.read()).records`.
6. `getBackfillRecords`: same replacement.
7. The "Seed once on SW startup" block: replace
   `const { records } = decodeStore(await historyItem.getValue())` with
   `const { records } = await historyLog.read()`.
8. `HistoryRequest` handler: replace the handler with
   `async () => ({ records: (await historyLog.read()).records }),`.
9. `ClearHistoryRequest` handler: replace the handler with:

   ```ts
       async () => {
         await historyLog.clear()
         return { ok: true } as const
       },
   ```

10. Delete the six-line comment above `'HistoryRequest'` that starts
    `// Both of these go through \`historyQueue\``. It describes the two
    `historyQueue.run(...)` wrappers you removed in items 8 and 9. This is
    the only comment this plan deletes. Add no replacement comment. Do not
    touch the comment near line 198 that mentions the "`decodeStore`
    pattern".
11. Remove imports that are now unused in `background.ts`: `decodeStore` and
    `emptyStore` from `@/packages/history/store`, and `planHistory` from
    `@/packages/history/wiring` (keep `type HistoryAction`). Keep
    `makeSerialQueue`; other queues still use it. Let `bun run lint` and
    `bun run typecheck` tell you if any of these is still used elsewhere in
    the file; if one is, keep that import.

**Verify**: `rg -n "historyQueue|persistHistory|historyItem\.(getValue|setValue)" src/entrypoints/background.ts`
→ exactly 2 matches, both inside the `makeHistoryLog({ store: ... })` block.
**Verify**: `bun run typecheck` → exit 0.
**Verify**: `bun run lint` → exit 0.

### Step 4 (Part A): Gates for Part A

**Verify**: `bun run check` → exit 0.
**Verify**: `bun run build` → exit 0.

Commit Part A now. If you were told to do Part A only, or if anything in
Part B hits a STOP condition, stop here and report "Part A done, Part B not
started".

### Step 5 (Part B): Failing tests for the cached store

In `src/packages/kernel/tests/durable-store.test.ts`, add a
`describe('makeCachedDurableStore', ...)` block. The unit under test will be
exported from `../durable-store`:

```ts
export const makeCachedDurableStore = (inner: DurableStore): DurableStore
```

Use an inner store with `gets` and `sets` counters and an option to make
`set` reject.

1. "reads the inner store once" — three `get()` calls → inner `get` called 1
   time, each returning the initial value.
2. "shares one inner read between concurrent first gets" —
   `await Promise.all([cached.get(), cached.get()])` → inner `get` called 1 time.
3. "writes through and then serves the written value" —
   `await cached.set(['a'])` → inner `set` called 1 time with `['a']`;
   `await cached.get()` returns `['a']`; inner `get` called 0 times.
4. "returns the same reference it was given" — `const value = ['a']`;
   `await cached.set(value)`; `expect(await cached.get()).toBe(value)`.
5. "keeps the previous value when the inner write fails" — after a successful
   `get()` returning `['old']`, make inner `set` reject;
   `await expect(cached.set(['new'])).rejects.toThrow()`; `await cached.get()`
   returns `['old']`.
6. "a slow first read does not overwrite a newer write" — inner `get`
   resolves only when released; start `cached.get()`, then
   `await cached.set(['new'])`, then release the read; both the pending
   `get()` and a later `get()` resolve to `['new']`.

**Verify**: `bun run test src/packages/kernel/tests/durable-store.test.ts`
→ the six new tests FAIL (the export does not exist); earlier tests pass.

### Step 6 (Part B): Implement the cached store

In `src/packages/kernel/durable-store.ts`, add `makeCachedDurableStore` below
`runSerializedRmw`. Rules:

- Track `loaded: boolean`, `value: JsonValue`, and
  `loading: Promise<JsonValue> | null`.
- `get()`: if `loaded`, return `value`. Otherwise share one pending
  `inner.get()`. When it resolves, if `loaded` is still false, store the
  result and set `loaded = true`. Return `value` (the newest one). Clear
  `loading` when it settles.
- `set(next)`: `await inner.set(next)`, THEN set `value = next` and
  `loaded = true`. If `inner.set` rejects, change nothing and let the
  rejection propagate.
- Do not copy or clone values.

**Verify**: `bun run test src/packages/kernel/tests/durable-store.test.ts` → all pass.

### Step 7 (Part B): Use the cached store in the three live factories

1. `src/background/cloud-upload.ts`, in `defaultLedgerStore`: wrap the
   returned object:
   `return makeCachedDurableStore({ get: () => item.getValue(), set: (value) => item.setValue(value) })`.
   Add `makeCachedDurableStore` to the existing import from
   `@/packages/kernel/durable-store`.
2. `src/background/sync-outbox.ts`, in `defaultOutboxStore`: the same change
   and import.
3. `src/background/capture-outbox.ts`, in `defaultLedger`: the same change
   and import.

Change nothing else in those files. Do not wrap stores that tests inject
(`deps.store`, `deps.ledger`, `deps.outbox`).

**Verify**: `rg -c "makeCachedDurableStore" src/background/cloud-upload.ts src/background/sync-outbox.ts src/background/capture-outbox.ts`
→ each file prints `2` (one import, one call).
**Verify**: `bun run test src/background/cloud-upload.test.ts`,
`bun run test src/background/sync-outbox.test.ts`, and
`bun run test src/background/capture-outbox.test.ts` → all pass.

### Step 8 (Part B): Gates

**Verify**: `bun run lint` → exit 0.
**Verify**: `bun run fmt:check` → exit 0.
**Verify**: `bun run lint:boundaries` → exit 0.
**Verify**: `bun run check` → exit 0.
**Verify**: `bun run build` → exit 0.

## Test plan

- `src/background/history-log.test.ts` (new, 10 tests, Step 1). Key
  expectations and where they come from:
  - Test 1 (`gets` is 1): requirement "history is decoded once per worker life".
  - Test 3 (exactly 2 writes for 5 actions): requirement "writes that arrive
    during a write are folded into one". Under the old code the same sequence
    costs 5 reads and 5 writes.
  - Test 7: the erase race described in the comment this plan deletes
    ("the erased records come back") must stay impossible.
  - Test 8: a failed write is reported and the data is not lost from memory.
  - Tests 9 and 10: today's `ClearHistoryRequest` always writes the empty
    store, which also replaces corrupt stored data. That must stay true.
- `src/packages/kernel/tests/durable-store.test.ts` (6 new tests, Step 5).
  Test 5 encodes "memory never runs ahead of storage"; that is what keeps the
  upload claim durable.
- Existing suites that must stay green without edits:
  `src/background/cloud-upload.test.ts`, `src/background/sync-outbox.test.ts`,
  `src/background/capture-outbox.test.ts`, `src/packages/history/tests/*`.
- Patterns: `src/packages/kernel/tests/durable-store.test.ts` (store fakes),
  `src/background/capture-outbox.test.ts:42-58` (`fakeLedger`).
- Verification: `bun run check` exits 0.

## Done criteria

Part A — ALL must hold:

- [ ] `bun run test src/background/history-log.test.ts` exits 0 with 10 tests
- [ ] `rg -c "Serialized read-modify-write, like the outbox" src/entrypoints/background.ts` prints `1` (the comment on `recordHistory` is still there)
- [ ] `rg -n "historyQueue|persistHistory" src/entrypoints/background.ts` returns no matches
- [ ] `rg -n "decodeStore\(await historyItem" src/entrypoints/background.ts` returns no matches
- [ ] `bun run check` exits 0 and `bun run build` exits 0

Part B — ALL must hold (or Part B is reported as not started):

- [ ] `bun run test src/packages/kernel/tests/durable-store.test.ts` exits 0, including 6 `makeCachedDurableStore` tests
- [ ] `rg -c "makeCachedDurableStore" src/background/cloud-upload.ts src/background/sync-outbox.ts src/background/capture-outbox.ts` prints `2` for each file
- [ ] `git diff -- src/background/cloud-upload.ts` shows your changes only in the import line and `defaultLedgerStore`
- [ ] `bun run check` exits 0 and `bun run build` exits 0

Both parts:

- [ ] `rg -n "oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error" src/background/history-log.ts src/background/history-log.test.ts` returns no matches
- [ ] `git status --short` shows no newly modified files outside the in-scope list and `plans/README.md`
- [ ] `plans/README.md` status row for 019 updated (say which parts are done)

## STOP conditions

Stop and report back (do not improvise) if:

- Plan 018 is not DONE (`runSerializedRmw` still calls `store.set`
  unconditionally). Part B would still be correct, but the plans share files
  and must run in order.
- Any file outside `src/entrypoints/background.ts` reads or writes
  `local:downloadHistory`, or any file other than its owner writes
  `local:cloudUploadJobs`, `local:syncOutbox`, or `local:captureOutbox`.
  Check with
  `rg -n "downloadHistory'|cloudUploadJobs'|syncOutbox'|captureOutbox'" src --glob '!*.test.ts'`.
  The single-writer assumption would be false and the in-memory copies wrong.
- `historyItem.setValue(value)` does not type-check with a `DownloadStore`
  argument inside the `makeHistoryLog({ store })` block. Do not add a cast;
  report the error text.
- A test in `cloud-upload.test.ts`, `sync-outbox.test.ts`, or
  `capture-outbox.test.ts` fails after Step 7. Those tests inject their own
  stores, so a failure means a factory change leaked into shared code.
- You find you need to change `drainUploadJobs`, `claim`, `updateLedger`, or
  an alarm to finish a step. That is out of scope by design.
- The flush logic cannot be written without `await` in a loop or a lint
  disable comment.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- New code that needs download history must go through `historyLog`
  (`read`, `record`, `apply`, `clear`). Reading `historyItem` directly would
  miss changes that are in memory but not yet written.
- If a second context ever needs to write history or a ledger key directly
  (for example an options-page "import history" feature), the in-memory copies
  become stale. Route such writes through a message to the service worker
  instead.
- Durability of history: a change is in memory first and written in the
  current or the very next storage write. If the worker is killed in between,
  that change is lost. The old code had the same exposure while its write was
  in flight. No timer-based delay was added on purpose; do not add one without
  revisiting ADR-0010.
- Part B deliberately keeps the schema decode on every ledger read. It removes
  the storage round-trip only. The remaining cost (decode per read, one full
  write per job step during a large backfill) needs the decoded ledger held in
  memory inside `cloud-upload.ts`, next to the claim and lease logic. That is a
  separate, riskier change and should get its own plan and review.
- The capture outbox still does two full writes per capture batch (enqueue,
  then claim). Folding them into one needs a change to its drain loop.
- Known stale text this plan leaves behind on purpose, because the comment
  and Markdown rules forbid the executor from editing it. The owner should
  update these in a docs change:
  - `src/entrypoints/background.ts`, the two-line comment above
    `recordHistory` ("Serialized read-modify-write, like the outbox, …").
    After this plan the function delegates to `historyLog`, which holds the
    store in memory and coalesces writes.
  - `src/entrypoints/background.ts` near line 198, the comment that refers to
    the "`decodeStore` pattern". `background.ts` no longer imports
    `decodeStore`; the function now lives behind `history-log.ts`.
  - `docs/adr/0010-durable-local-download-history.md:42`, "The background
    does serialized read-modify-write like the Outbox". History is now read
    once and then kept in memory by one ordered writer.
- A reviewer should check: (1) `history-log.ts` folds from `current`, not from
  a stale local; (2) `makeCachedDurableStore.set` assigns the cache only after
  the inner write resolves; (3) the diff to `cloud-upload.ts`,
  `sync-outbox.ts`, and `capture-outbox.ts` is confined to the factory
  functions and one import each.
