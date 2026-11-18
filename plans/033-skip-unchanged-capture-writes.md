# Plan 033: Re-seeing an unchanged tweet writes nothing and mirrors nothing

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/capture/store.ts src/packages/capture/tests/store.test.ts src/background/capture-db.ts src/background/capture-db.test.ts src/packages/sync/captures.ts src/packages/sync/tests/captures.test.ts src/background/capture-outbox.ts src/background/capture-outbox.test.ts src/entrypoints/background.ts`
> If any of these files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plans 022, 029, 030, 031, and 032
> also edit `capture-db.ts`, its test, and `background.ts`. Their changes are
> expected. The excerpts below show what must still be true.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none in logic. It edits `putRecords`, which plan 022 and plan 030 also edit, so run it after them or before them, never at the same time. It does not overlap `plans/019-coalesce-history-and-ledger-writes.md`, which covers other ledgers.
- **Category**: perf
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/107

## Why this matters

While Capture is on, the content script parses every X GraphQL response and
sends the tweets it finds to the service worker in batches of up to 64. It
does not remember what it already sent. Scrolling the home timeline, going back
to a thread, or a timeline refresh sends the same tweets again. The design
accepts this. The capture spec
(`docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md`, §7) says:

> No producer-side identity dedup … Re-sending the same tweet is a cheap no-op
> at the durable merge (§6.4)

It is not a no-op today. Each harvest stamps its records with a fresh
`capturedAt`. The merge rule lets an equal-rank record with a newer or equal
`capturedAt` win. So a re-sighting whose content is identical still wins, and:

1. The worker writes the full record to IndexedDB again.
2. The worker queues the record for the Convex mirror again. With the mirror
   on, that becomes a network mutation.
3. The mirror ledger is rebuilt once per record. `enqueue` filters and copies
   the whole ledger for each record. The ledger can hold 2000 events.

After this plan a re-sighting whose content is identical, apart from
`capturedAt`, keeps the stored record. Nothing is written and nothing is
queued. The ledger is rebuilt once per batch.

Cost of one batch of 64 re-seen, unchanged tweets with a ledger of L events,
estimated from the code (not measured):

| | IndexedDB puts | Mirror events queued | Ledger entries visited to enqueue | Ledger arrays built |
| --- | --- | --- | --- | --- |
| Before | 64 | 64 (when the mirror is on) | about 64 × L (up to 128,000) | 64 |
| After | 0 | 0 | 0 (the batch is empty) | 0 |

For a batch of 64 new tweets the puts and events stay at 64. The ledger work
drops from about 64 × L visits and 64 arrays to one pass and one array.

## Current state

Files and roles:

- `src/packages/capture/store.ts` — pure merge rule and summary selectors.
- `src/packages/capture/tests/store.test.ts` — their tests.
- `src/background/capture-db.ts` — the capture database (`CaptureStore` seam,
  `makeCaptureDb`, IndexedDB adapter).
- `src/background/capture-db.test.ts` — tests through an in-memory `fakeStore()`.
- `src/packages/sync/captures.ts` — pure reducers for the capture mirror ledger.
- `src/packages/sync/tests/captures.test.ts` — their tests.
- `src/background/capture-outbox.ts` — queues written records for the Convex
  mirror and drains them.
- `src/background/capture-outbox.test.ts` — its tests.
- `src/entrypoints/background.ts` — the `CaptureTweets` handler, near line 1908.
  Line numbers in this file are approximate.

The merge rule (`src/packages/capture/store.ts:25-32`). Do not change it:

```ts
export function mergeRecord(existing: TweetRecord | undefined, incoming: TweetRecord): TweetRecord {
  if (existing === undefined) return incoming
  if (incoming.sourceRank > existing.sourceRank) return incoming
  if (incoming.sourceRank === existing.sourceRank && incoming.capturedAt >= existing.capturedAt) {
    return incoming
  }
  return existing
}
```

(If the live body is formatted differently but has these four outcomes, that
is not a mismatch.) This rule is pinned by spec §6.4 and mirrored on the server
in `backend/convex/captures.ts:70-71`.

The write path (`src/background/capture-db.ts:15-16`, `:23-24`, `:34-37`,
`:50-58`, `:119-138`):

```ts
/** Per-record write policy: richer source wins (spec §6.4, {@link mergeRecord}). */
type Merge = (existing: TweetRecord | undefined, incoming: TweetRecord) => TweetRecord
```

```ts
export interface CaptureStore {
  upsert(records: ReadonlyArray<TweetRecord>, merge: Merge): Promise<void>
```

```ts
export interface CaptureDb {
  /** Persist a harvested batch, merging each record against the stored one.
   *  Empty batches are a no-op. Serialized against every other write. */
  putRecords(records: ReadonlyArray<TweetRecord>): Promise<void>
```

```ts
    putRecords: (records) =>
      writes.run(async () => {
        if (records.length === 0) return
        const byTweet = new Map<string, TweetRecord>()
        for (const record of records) {
          byTweet.set(record.tweetId, mergeRecord(byTweet.get(record.tweetId), record))
        }
        await store.upsert([...byTweet.values()], mergeRecord)
      }),
```

```ts
    upsert(records, merge) {
      return openDb().then(
        (db) =>
          new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite')
            const store = tx.objectStore(STORE)
            for (const incoming of records) {
              const get = getTweetRecord(store, incoming.tweetId)
              get.addEventListener('success', () => {
                const existing = get.result
                const winner = merge(existing, incoming)
                if (winner !== existing) store.put(winner)
              })
            }
            tx.addEventListener('complete', () => resolve())
            tx.addEventListener('error', () => reject(tx.error))
            tx.addEventListener('abort', () => reject(tx.error))
          }),
      )
    },
```

The adapter already skips the put when `merge` returns the stored object. This
plan makes `merge` return the stored object for an unchanged re-sighting, and
makes `upsert` report what it wrote.

The test fake's `upsert` (`src/background/capture-db.test.ts:29-39`):

```ts
    async upsert(
      records: ReadonlyArray<TweetRecord>,
      merge: (existing: TweetRecord | undefined, incoming: TweetRecord) => TweetRecord,
    ) {
      box.upsertCalls++
      for (const incoming of records) {
        const existing = rows.get(incoming.tweetId)
        const winner = merge(existing, incoming)
        if (winner !== existing) rows.set(incoming.tweetId, winner)
      }
    },
```

The handler (`src/entrypoints/background.ts`, near line 1908). Plan 022 removes
the `count()` and changes the log line. The two lines this plan cares about are
`putRecords` and `mirrorCaptures`:

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
```

The ledger reducers (`src/packages/sync/captures.ts:77-110`):

```ts
/** Append or replace the queued event for the same `tweetId` (newer wins), then cap. */
export function enqueue(
  ledger: CaptureLedger,
  event: SyncCaptureEvent,
  cap: number = DEFAULT_CAP,
): CaptureLedger {
  const without = ledger.filter((e) => e.tweetId !== event.tweetId)
  return capLedger([...without, event], cap)
}
```

```ts
/** Drop a drained event by `eventId`; same reference when it is absent or not yet due. */
export function claim(
  ledger: CaptureLedger,
  eventId: string,
  now: number,
  _leaseMs?: number,
): CaptureLedger {
  const next = ledger.filter((e) => !(e.eventId === eventId && e.at <= now))
  return next.length === ledger.length ? ledger : next
}

/** Bound the ledger at `cap`, dropping the oldest; same reference when nothing drops. */
export function capLedger(ledger: CaptureLedger, cap: number = DEFAULT_CAP): CaptureLedger {
  return ledger.length > cap ? ledger.slice(ledger.length - cap) : ledger
}
```

`DEFAULT_CAP` is 2000 and `DEFAULT_BATCH` is 64 in the same file. The ledger is
stored under the key `local:captureOutbox`.

The two call sites (`src/background/capture-outbox.ts:85-89`, `:107-113`):

```ts
      await runSerializedRmw(storeQueue, ledger, decodeLedger, (current) => {
        let next = current
        for (const e of batch) next = claim(next, e.eventId, at)
        return capLedger(next)
      })
```

```ts
        const at = now()
        await runSerializedRmw(storeQueue, ledger, decodeLedger, (current) => {
          let next = current
          for (const record of records)
            next = enqueue(next, captureEventFromRecord(record, settings.cloudDeviceId, at))
          return next
        })
```

`enqueue` and `claim` from this file are imported only by
`src/background/capture-outbox.ts` and `src/packages/sync/tests/captures.test.ts`.
`src/packages/cloud/upload-job.ts` has its own functions with the same names.
Those are a different module. Do not touch them.

Binding decisions. Read them before you start:

- ADR-0018 (`docs/adr/`): the capture mirror is gated by
  `captureMirrorEnabled`, default off. "Local capture never implies mirroring."
  This plan keeps that gate where it is, inside `mirrorCaptures`.
- ADR-0020: "Share one `DurableStore` interface and `runSerializedRmw`
  helper", "Cap each Capture mirror mutation at 64 records", "Capture gets no
  new backoff or wake policy", "Capture stays best-effort." This plan keeps
  `runSerializedRmw`, keeps the batch of 64, and adds no policy.
- Spec §6.1: `capturedAt` is the "clock passed in" at harvest. Spec §7 says a
  re-send is "a cheap no-op at the durable merge". This plan makes the store
  behave as §7 says.

### What "unchanged" means

Two records for the same tweet are unchanged when every field except
`capturedAt` is equal. `TweetRecord` (`src/packages/capture/record.ts`) has
these fields: `tweetId`, `conversationId`, `inReplyToTweetId?`,
`inReplyToHandle?`, `author { handle, name?, userId? }`, `text`, `rawText`,
`createdAt?`, `lang?`, `links[]`, `media[]`, `mentions[]`, `hashtags[]`,
`quotedTweetId?`, `retweetOf?`, `source`, `sourceRank`, `capturedAt`. It holds
no like or view counts, so a re-seen tweet is normally unchanged.

### Behaviour changes to know about

1. **`capturedAt` now means "when this content was first stored".** An
   unchanged re-sighting no longer moves it forward. The popup and Archive list
   sort conversations by their newest `capturedAt`. Re-opening an old thread
   with nothing new in it no longer moves the thread to the top. A new reply, a
   changed field, or a richer source still does.
2. **The mirror receives only records that were written.** Today every received
   record is offered to the mirror, written or not. After this plan, a tweet
   that was stored while the mirror was off is not mirrored when it is seen
   again unchanged. The same holds for an event that fell off the 2000-event
   ledger cap while offline. See "STOP conditions" and "Maintenance notes".

Facts about this repo's test setup:

- The IndexedDB adapter has no automated test. The repo has no
  `fake-indexeddb` dependency. Do not add one. The fake's `upsert` mirrors the
  adapter line for line. Keep the two in step.
- `vitest.config.ts` sets a 100% coverage threshold on `src/packages/**`. Every
  branch of the new functions in `store.ts` and `sync/captures.ts` needs a test.
- `fast-check` 4.10.2 is a dev dependency. Search for an existing property test
  to copy the import style: `rg -l "fast-check" src | head -3`.
- No `await` inside a `for` or `while` loop in new code. The drain loop in
  `capture-outbox.ts` has an existing suppression comment. Leave that comment
  and the loop as they are. This plan changes only the reducer call inside it.

Repo conventions that apply (from `AGENTS.md`):

- No new `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- An unused destructured name starts with `_`. See
  `const { cloudOnly: _previousMode, ...kept } = existing` in
  `src/packages/cloud/upload-job.ts:185`.
- Code outside a package imports only that package's root files.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add or edit code comments. A pre-edit hook (`doc-lock`)
blocks that. A comment may be deleted only together with the code it describes.
Step 4 deletes `enqueue` and `claim` with their one-line doc comments. Do not
edit any Markdown file except this plan's status row in `plans/README.md`. New
exports get no JSDoc block. Say so in your final report.

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
- `src/packages/sync/captures.ts`
- `src/packages/sync/tests/captures.test.ts`
- `src/background/capture-outbox.ts`
- `src/background/capture-outbox.test.ts` (only if a test there breaks on the
  reducer rename)
- `src/entrypoints/background.ts` (only the `CaptureTweets` handler)
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `mergeRecord`. It is pinned by the spec, by tests, and by the server copy.
- `backend/convex/captures.ts`. The server keeps its own merge.
- `src/entrypoints/overlay.content/index.tsx`. Remembering sent tweets in the
  content script is a different design. The spec rejects it in §7.
- `src/packages/cloud/upload-job.ts` and `src/background/cloud-upload.ts`.
  Their `enqueue` and `claim` are other functions.
- Keeping the decoded ledger in worker memory between writes. ADR-0020 keeps
  every ledger change inside `runSerializedRmw`, which reads the stored value
  each time.
- The gate inside `mirrorCaptures` and the drain loop's structure.

## Git workflow

- Branch: `advisor/033-skip-unchanged-capture-writes`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `perf(capture): …`.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. At planning time these in-scope
  files were already modified: `src/background/capture-db.ts`,
  `src/background/capture-db.test.ts`, `src/background/capture-outbox.ts`,
  `src/background/capture-outbox.test.ts`, `src/entrypoints/background.ts`.
  Never revert or stash them.
- Before editing, run `git status --short` and note which in-scope files are
  already modified.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Add the "unchanged" rule to the pure core, test first

In `src/packages/capture/tests/store.test.ts`, add
`describe('mergeUnlessUnchanged', …)` with "Test plan" cases 1–6. Import
`mergeUnlessUnchanged` and `sameCapturedContent` from `'../store'`.

**Verify**: `bun run test src/packages/capture/tests/store.test.ts` → the new
tests FAIL (missing exports). Existing tests pass.

Add to `src/packages/capture/store.ts`, directly below `mergeRecord`:

```ts
export function sameCapturedContent(a: TweetRecord, b: TweetRecord): boolean {
  const { capturedAt: _aCapturedAt, ...aContent } = a
  const { capturedAt: _bCapturedAt, ...bContent } = b
  return JSON.stringify(aContent) === JSON.stringify(bContent)
}

export function mergeUnlessUnchanged(
  existing: TweetRecord | undefined,
  incoming: TweetRecord,
): TweetRecord {
  const winner = mergeRecord(existing, incoming)
  if (existing === undefined || winner === existing) return winner
  return sameCapturedContent(existing, incoming) ? existing : winner
}
```

How it works:

- `mergeRecord` still decides who wins. Only when the incoming record wins does
  the new check run.
- When the incoming record wins but differs from the stored one only in
  `capturedAt`, the stored object is returned. The store adapter treats "the
  stored object came back" as "write nothing".
- `JSON.stringify` compares field by field in key order. If two equal records
  ever list their keys in a different order, the result is `false` and the
  record is written. That costs one write. It never loses data.

**Verify**: `bun run test src/packages/capture/tests/store.test.ts` → all pass.

### Step 2: Make `upsert` and `putRecords` report what was written

In `src/background/capture-db.test.ts`:

1. Change the fake's `upsert` to collect and return the winners it stored:

```ts
      box.upsertCalls++
      const written: TweetRecord[] = []
      for (const incoming of records) {
        const existing = rows.get(incoming.tweetId)
        const winner = merge(existing, incoming)
        if (winner !== existing) {
          rows.set(incoming.tweetId, winner)
          written.push(winner)
        }
      }
      return written
```

2. Add `describe('putRecords reports written records', …)` with "Test plan"
   cases 7–11.

**Verify**: `bun run test src/background/capture-db.test.ts` → the new cases
FAIL. Typecheck errors in this file are expected until the next edits.

In `src/background/capture-db.ts`:

1. Change the import to
   `import { mergeRecord, mergeUnlessUnchanged } from '@/packages/capture/store'`.
   Keep any other names later plans added to this import.
2. In `CaptureStore`, change the `upsert` return type to
   `Promise<TweetRecord[]>`.
3. In `CaptureDb`, change the `putRecords` return type to
   `Promise<TweetRecord[]>`. Leave its doc comment as it is.
4. In `makeCaptureDb.putRecords`, change two lines:
   - `if (records.length === 0) return` becomes `if (records.length === 0) return []`
   - `await store.upsert([...byTweet.values()], mergeRecord)` becomes
     `return store.upsert([...byTweet.values()], mergeUnlessUnchanged)`

   Keep the `byTweet` loop with `mergeRecord`. Keep any cache-invalidation line
   that plan 022 or plan 030 added, in its place.
5. In the IndexedDB adapter's `upsert`:
   - `new Promise<void>(` becomes `new Promise<TweetRecord[]>(`
   - add `const written: TweetRecord[] = []` after the `const store = …` line
   - replace `if (winner !== existing) store.put(winner)` with:

```ts
                if (winner !== existing) {
                  store.put(winner)
                  written.push(winner)
                }
```

   - `tx.addEventListener('complete', () => resolve())` becomes
     `tx.addEventListener('complete', () => resolve(written))`

**Verify**: `bun run test src/background/capture-db.test.ts` → all pass.

### Step 3: Mirror only what was written

In `src/entrypoints/background.ts`, in the `CaptureTweets` handler:

- `await captureDb.putRecords(msg.records)` becomes
  `const written = await captureDb.putRecords(msg.records)`
- `captureOutbox.mirrorCaptures(msg.records)` becomes
  `captureOutbox.mirrorCaptures(written)`

Leave `return { stored: msg.records.length }` and the log line as they are. The
reply keeps meaning "records received". Leave the comment above the handler as
it is.

`mirrorCaptures` already returns early for an empty list.

**Verify**:
- `rg -n "mirrorCaptures\(written\)" src/entrypoints/background.ts` → 1 match.
- `rg -n "mirrorCaptures\(msg\.records\)" src/entrypoints/background.ts` → no matches.
- `bun run typecheck` → exit 0.

### Step 4: Rebuild the mirror ledger once per batch

In `src/packages/sync/tests/captures.test.ts`:

1. Before deleting anything, copy the bodies of the current `enqueue` and
   `claim` into the test file as local reference functions named
   `referenceEnqueue` and `referenceClaim`. They are the oracle: the old,
   tested behaviour.
2. Replace `describe('enqueue', …)` with `describe('enqueueAll', …)` and the
   `claim` cases in `describe('readyJobs / claim', …)` with `claimAll` cases,
   per "Test plan" cases 12–19. Keep the `readyJobs` case.
3. Update the import from `'../captures'`: remove `enqueue` and `claim`, add
   `enqueueAll` and `claimAll`.

**Verify**: `bun run test src/packages/sync/tests/captures.test.ts` → FAILS
(missing exports).

In `src/packages/sync/captures.ts`, delete `enqueue` and `claim` together with
their one-line doc comments, and add in their places:

```ts
export function enqueueAll(
  ledger: CaptureLedger,
  events: ReadonlyArray<SyncCaptureEvent>,
  cap: number = DEFAULT_CAP,
): CaptureLedger {
  if (events.length === 0) return ledger
  const latest = new Map<string, SyncCaptureEvent>()
  for (const event of events) {
    latest.delete(event.tweetId)
    latest.set(event.tweetId, event)
  }
  const kept = ledger.filter((e) => !latest.has(e.tweetId))
  return capLedger([...kept, ...latest.values()], cap)
}
```

```ts
export function claimAll(
  ledger: CaptureLedger,
  eventIds: ReadonlyArray<string>,
  now: number,
): CaptureLedger {
  const drained = new Set(eventIds)
  const next = ledger.filter((e) => !(drained.has(e.eventId) && e.at <= now))
  return next.length === ledger.length ? ledger : next
}
```

Load-bearing detail: `latest.delete` before `latest.set` moves a repeated
`tweetId` to the end of the Map. That reproduces the order the one-at-a-time
`enqueue` gave: an event sits where its last occurrence was appended.

**Verify**: `bun run test src/packages/sync/tests/captures.test.ts` → all pass.

In `src/background/capture-outbox.ts`:

1. In the import from `@/packages/sync/captures`, replace `enqueue` with
   `enqueueAll` and `claim` with `claimAll`.
2. Replace the drain's ledger update with:

```ts
      await runSerializedRmw(storeQueue, ledger, decodeLedger, (current) =>
        capLedger(
          claimAll(
            current,
            batch.map((e) => e.eventId),
            at,
          ),
        ),
      )
```

3. Replace the enqueue update in `mirrorCaptures` with:

```ts
        await runSerializedRmw(storeQueue, ledger, decodeLedger, (current) =>
          enqueueAll(
            current,
            records.map((record) => captureEventFromRecord(record, settings.cloudDeviceId, at)),
          ),
        )
```

Leave every comment in this file as it is, including the two `oxlint-disable` /
`oxlint-enable` lines around the drain loop.

**Verify**:
- `bun run test src/background/capture-outbox.test.ts` → all pass, with no
  expectation changed. If a test imports `enqueue` or `claim`, switch it to the
  new name and keep its expectation.
- `rg -n "\benqueue\(|\bclaim\(" src/background/capture-outbox.ts src/packages/sync/captures.ts` → no matches.

### Step 5: Run the gate

**Verify**: `bun run check` → exit 0. `bun run test:coverage` → exit 0.
`bun run build` → exit 0.

## Test plan

`src/packages/capture/tests/store.test.ts`, `describe('mergeUnlessUnchanged', …)`.
Use the file's record builder. The expectations come from spec §6.4 and §7.

1. **First sighting is stored.** `mergeUnlessUnchanged(undefined, a)` is `a`.
2. **An unchanged re-sighting keeps the stored object.** `b` equals `a` except
   `capturedAt` is larger. The result is `a` (use `toBe`, identity).
3. **A changed field wins as before.** `b` has a later `capturedAt` and a
   different `text`. The result is `b`.
4. **A richer source wins as before.** `a` has `sourceRank` 1, `b` has
   `sourceRank` 2 and `source` `'tweetDetail'`. The result is `b`.
5. **A thinner source loses as before.** `a` rank 2, `b` rank 1. The result is
   `a`.
6. **`sameCapturedContent` ignores only `capturedAt`.** True for two records
   that differ only in `capturedAt`. False when `links` differs by one entry.
   False when one record has `inReplyToTweetId` and the other does not.

Also add one property test with `fast-check`: for any two records `a` and `b`
with the same `tweetId`, `mergeUnlessUnchanged(a, b)` deep-equals
`mergeRecord(a, b)` in every field except `capturedAt`. This pins that the new
rule never changes stored content.

`src/background/capture-db.test.ts`, `describe('putRecords reports written records', …)`:

7. **New records are reported.** `await db.putRecords([mk('1'), mk('2')])`
   returns two records with ids `'1'` and `'2'`.
8. **An unchanged re-sighting writes nothing and reports nothing.** Put
   `[mk('1', { capturedAt: 1000 })]`, then
   `[mk('1', { capturedAt: 5000 })]`. The second call returns `[]`, and the
   stored record's `capturedAt` is still `1000`.
9. **A changed re-sighting is written and reported.** Put
   `[mk('1', { text: 'a', capturedAt: 1000 })]`, then
   `[mk('1', { text: 'b', capturedAt: 5000 })]`. The second call returns one
   record with text `'b'` and `capturedAt` `5000`.
10. **A thinner re-sighting reports nothing.** Stored rank 2, incoming rank 1.
    Returns `[]`.
11. **An empty batch returns `[]`** and `store.upsertCalls` stays `0`.

`src/packages/sync/tests/captures.test.ts`. Build events with the file's
existing helpers.

12. **`enqueueAll` appends new events in order.**
13. **`enqueueAll` replaces a queued event for the same `tweetId`** and moves
    it to the end.
14. **`enqueueAll` with duplicate `tweetId`s in one batch keeps the last one.**
15. **`enqueueAll` caps the ledger, dropping the oldest.**
16. **`enqueueAll(ledger, [])` returns the same reference.**
17. **Property: `enqueueAll` equals folding `referenceEnqueue`.** With
    `fast-check`, for any ledger of up to 8 events, any batch of up to 8 events
    drawn from a small set of tweet ids, and any cap from 1 to 6:
    `enqueueAll(ledger, events, cap)` deep-equals
    `events.reduce((l, e) => referenceEnqueue(l, e, cap), capLedger(ledger, cap))`.
    The ledger is capped first because a stored ledger is always within its
    cap.
18. **`claimAll` removes due events by id and keeps events that are not yet
    due.** Also assert it deep-equals folding `referenceClaim` over the ids.
19. **`claimAll` returns the same reference when nothing matches**, including
    for an empty id list.

Existing tests that must stay green without changed expectations:
`src/background/capture-outbox.test.ts` (the ADR-0018 gate cases and the drain
cases) and every `mergeRecord` test in `store.test.ts`.

Browser check (do it if you can load the extension; otherwise say in your final
report that it was not done):

1. `bun run build`, then load `.output/chrome-mv3` as an unpacked extension.
2. With Capture on, open an X thread. Open the service worker console.
3. Reload the thread. The worker still logs the received batch. Options →
   Archive shows the same tweet count as before the reload.
4. In DevTools → Application → IndexedDB → `xmd-capture` → `tweets`, pick one
   tweet of the thread. Its `capturedAt` is the same before and after the
   reload.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run test:coverage` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "mergeUnlessUnchanged" src/background/capture-db.ts` returns 2 matches
- [ ] `rg -n "mirrorCaptures\(written\)" src/entrypoints/background.ts` returns 1 match
- [ ] `rg -n "export function (enqueue|claim)\(" src/packages/sync/captures.ts` returns no matches
- [ ] `rg -n "export function (enqueueAll|claimAll)\(" src/packages/sync/captures.ts` returns 2 matches
- [ ] `git diff -- src/packages/capture/store.ts | rg "^-.*mergeRecord|^-.*sourceRank|^-.*capturedAt >="` returns no matches (the merge rule is untouched)
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- **Owner question, mirror backfill.** Any spec, ADR, or test says that turning
  the mirror on later will, over time, mirror tweets that were captured before.
  Search:
  `rg -n -i "backfill|re-mirror|remirror" docs/adr docs/superpowers/specs src/background/capture-outbox.test.ts`.
  At planning time the capture spec had no such promise. If one exists, this
  plan would break it. The owner must choose between this plan as written and
  a variant that still offers unchanged records to the mirror.
- A test asserts that re-putting an identical record advances the stored
  `capturedAt`, or that it moves a conversation up the recent list. That would
  make the old behaviour a requirement.
- A test in `capture-outbox.test.ts` needs a changed expectation, not only a
  renamed import.
- Property test 17 fails. Then `enqueueAll` is not equivalent to the old
  one-at-a-time reducer. Report the counterexample that fast-check prints.
- `enqueue` or `claim` from `src/packages/sync/captures.ts` is imported by a
  file other than `capture-outbox.ts` and the captures test
  (`rg -n "sync/captures" src`).
- The live `mergeRecord` has outcomes other than the four in "Current state".
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- **Mirror backfill is an open owner decision.** After this plan the mirror
  gets a tweet when its stored record changes. A tweet stored while the mirror
  was off, or dropped from the 2000-event ledger while offline, is not mirrored
  by seeing it again unchanged. If the owner wants a backfill, the clean form
  is an explicit action that walks the store and enqueues in batches of 64. It
  should not ride on re-sightings.
- **`capturedAt` is first-stored time for unchanged content.** The Archive and
  popup lists order by it. If the owner wants "last seen" ordering back, add a
  separate `lastSeenAt` that is updated without rewriting the record. Do not
  loosen `sameCapturedContent`.
- The server copy of the merge rule (`backend/convex/captures.ts`) is
  unchanged. It still lets an equal-rank event with a newer `at` win. With this
  plan the client sends fewer such events.
- The comment in `src/entrypoints/overlay.content/index.tsx` near line 1705 and
  spec §7 call a re-send "a cheap no-op at the durable merge". After this plan
  that statement is true. No doc edit is needed.
- The comment above the `CaptureTweets` handler says the handler offers the
  batch to the mirror. After this plan it offers the written part of the
  batch. This plan may not edit comments. Report it for a docs pass.
- `putRecords` still opens a read-write transaction and reads each record to
  compare it. Only the put and the mirror are skipped.
- Plan 022 and plan 030 clear a summary cache on every `putRecords`. After this
  plan they could skip that when nothing was written. That is a follow-up, not
  part of this plan.
- If a future `TweetRecord` field changes on every sighting (a view count, for
  example), every re-sighting becomes a write again. Exclude such a field in
  `sameCapturedContent` the way `capturedAt` is excluded, and decide whether it
  should reach the mirror.
