# Plan 041: Let the service worker sleep when only paused or purged downloads remain

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/background/transfer-correlation.ts src/background/transfer-correlation.test.ts src/packages/download/transfer-tracker.ts src/entrypoints/background.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. Run after any of plans 013, 018, 019, 022 that is in progress, because they also edit `src/entrypoints/background.ts`.
- **Category**: perf
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/115

## Why this matters

The service worker runs a watchdog while browser downloads are in flight. Every
6 seconds it asks `chrome.downloads.search` about each tracked download. The
watchdog stops only when the tracked set is empty. Two kinds of download never
leave that set: a download the user paused, and a download whose record was
erased from `chrome://downloads` before its final event arrived. With one such
download, the timer and its API calls repeat with no end. Extension API calls
reset the worker's idle timer, so the worker and its whole heap stay in memory.
After this plan the watchdog stops when no tracked download can still be
settled by a poll, and starts again when Chrome reports a change for a tracked
download. The size of the gain is an estimate from reading the code. It was not
measured.

## Current state

Files and roles:

- `src/background/transfer-correlation.ts` — owns the in-memory
  `downloadId → requestId` map and the `reconcile` poll. 111 lines.
- `src/background/transfer-correlation.test.ts` — its tests, with a `harness`
  helper.
- `src/packages/download/transfer-tracker.ts` — pure classifier
  `classifyTransfer` and the `ReconcileRow` type.
- `src/entrypoints/background.ts` — the service worker. It owns the watchdog
  timer. Line numbers in this file are approximate. Locate each edit by the
  quoted code.

The row type and classifier (`src/packages/download/transfer-tracker.ts:58-76`):

```ts
/** The fields of a `chrome.downloads.search` row this module reasons about. */
export interface ReconcileRow {
  readonly state?: string
  readonly exists?: boolean
}
```

```ts
export function classifyTransfer(row: ReconcileRow | undefined): ReconcileVerdict {
  if (row === undefined) return 'unknown'
  if (row.state === 'complete') return row.exists === false ? 'failed' : 'complete'
  if (row.state === 'interrupted') return 'failed'
  return 'in-progress'
}
```

A paused download has `state: 'in_progress'` and `paused: true` in Chrome's
`DownloadItem`. `classifyTransfer` returns `'in-progress'` for it. An erased
record gives no row, so the verdict is `'unknown'`.

The poll (`src/background/transfer-correlation.ts:13-16`, `:46-79`, `:95-109`):

```ts
export interface ReconcileSummary {
  /** Transfers `downloads.search` still reports as downloading. */
  readonly inProgress: number
}
```

```ts
  const requestByDownloadId = new Map<number, string>()
  const startedAtByDownloadId = new Map<number, number>()

  const release = (downloadId: number): void => {
    requestByDownloadId.delete(downloadId)
    startedAtByDownloadId.delete(downloadId)
  }

  const reconcileOne = async (downloadId: number, requestId: string): Promise<boolean> => {
    let row: ReconcileRow | undefined
    try {
      row = await ports.search(downloadId)
    } catch {
      return false
    }
    // A live onChanged may have settled it during the search.
    if (requestByDownloadId.get(downloadId) !== requestId) return false
    const verdict = classifyTransfer(row)
    const now = ports.now()
    if (verdict === 'complete') {
      ports.trace('reconcile-stuck-complete', {
        itemId: requestId,
        detail: `downloadId ${downloadId}`,
      })
      await ports.complete(requestId, downloadId, now)
    } else if (verdict === 'failed') {
      ports.trace('reconcile-stuck-failed', {
        itemId: requestId,
        detail: `downloadId ${downloadId}`,
      })
      await ports.fail(requestId, downloadId, now)
    }
    return verdict === 'in-progress'
  }
```

```ts
    reconcile: async ({ minAgeMs, only }) => {
      const now = ports.now()
      const wanted = only === undefined ? null : new Set(only)
      // Snapshot first: the settle ports release entries mid-loop.
      const due = [...requestByDownloadId.entries()].filter(
        ([downloadId, requestId]) =>
          (wanted === null || wanted.has(downloadId)) &&
          !ports.retryOwns(requestId) &&
          now - (startedAtByDownloadId.get(downloadId) ?? now) >= minAgeMs,
      )
      const stillDownloading = await Promise.all(
        due.map(([downloadId, requestId]) => reconcileOne(downloadId, requestId)),
      )
      return { inProgress: stillDownloading.filter(Boolean).length }
    },
```

A paused or purged entry is never released, so `size()` never reaches 0.

The watchdog (`src/entrypoints/background.ts`, near lines 1079-1100):

```ts
const STUCK_RECONCILE_AFTER_MS = 12_000
const STUCK_RECONCILE_POLL_MS = 6_000
let stuckPollTimer: ReturnType<typeof setInterval> | null = null

const stopStuckPollIfIdle = (): void => {
  if (stuckPollTimer !== null && transferCorrelation.size() === 0) {
    clearInterval(stuckPollTimer)
    stuckPollTimer = null
  }
}

const reconcileStuckDownloads = async (): Promise<void> => {
  await transferCorrelation.reconcile({ minAgeMs: STUCK_RECONCILE_AFTER_MS })
  stopStuckPollIfIdle()
}

/** Arm the stuck-download watchdog while downloads are active (no-op if already armed).
 *  It self-stops once nothing is in flight, so it never keeps the worker awake idly. */
const ensureStuckPoll = (): void => {
  if (stuckPollTimer === null)
    stuckPollTimer = setInterval(() => void reconcileStuckDownloads(), STUCK_RECONCILE_POLL_MS)
}
```

The search port passes Chrome's whole row through, so `paused` is already
present at runtime (`src/entrypoints/background.ts`, near line 165):

```ts
  search: async (downloadId) => (await browser.downloads.search({ id: downloadId }))[0],
```

The change listener (`src/entrypoints/background.ts`, near lines 1704-1711):

```ts
const onDownloadChanged = async (delta: Browser.downloads.DownloadDelta): Promise<void> => {
  const id = transferCorrelation.requestFor(delta.id)
  // Process any tracked transfer even when the metrics accumulator is null (e.g.
  // just after a boot reconcile re-seeded the correlation): the durable outcome
  // and badge backlink must still fire; the byte-sample writes stay `live`-guarded.
  if (id === undefined) return
  const now = Date.now()
  await sampleBytes(delta.id, now)
```

Another caller of `reconcile` relies on `inProgress`. It must keep counting a
paused download as in progress (`src/entrypoints/background.ts`, near line 1731):

```ts
  const { inProgress } = await transferCorrelation.reconcile({ minAgeMs: 0 })
  const active = inProgress + retryQueue.ownedIds().size + startingRequests
```

An existing test pins that a purged record is not settled and stays registered
(`src/background/transfer-correlation.test.ts:88-102`, "leaves a purged record,
a retry-owned id, and an unlisted id alone"). This plan keeps that behaviour.
A purged entry stays in the map. It only stops counting as a reason to poll.

Design constraints:

- `GLOSSARY.md`, Clock Port entry: "The one scheduled-work holdout still on a
  raw timer is the stuck-download watchdog's `setInterval` in
  `entrypoints/background.ts` — kept inline by decision (round-7 review: no
  duplication, defense-in-depth exists; extraction judged uniformity polish)."
  Keep the `setInterval` inline in `background.ts`. Do not move the watchdog
  into a module, and do not switch it to `chrome.alarms`.
- `docs/adr/0014-transfer-tracker-outcome-backlink.md`: "missing row →
  `unknown`, never a fabricated outcome". Do not settle, fail, or release a
  purged entry.

Repo conventions that apply (from `AGENTS.md` and `src/packages/README.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Named constants, not magic numbers.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. The target
code below deliberately has no comments.

## Commands you will need

| Purpose       | Command                                 | Expected on success |
|---------------|-----------------------------------------|---------------------|
| Typecheck     | `bun run typecheck`                     | exit 0, no errors   |
| Lint          | `bun run lint`                          | exit 0              |
| Format check  | `bun run fmt:check`                     | exit 0              |
| Boundaries    | `bun run lint:boundaries`               | exit 0              |
| Focused tests | `bun run test <path/to/file.test.ts>`   | all pass            |
| Full gate     | `bun run check`                         | exit 0              |
| Build         | `bun run build`                         | exit 0              |

The package manager is bun. Never use npm or npx. If `bun run fmt:check` fails
only on files you edited, run `bunx oxfmt --write <those files>` and re-check.

## Scope

**In scope** (the only files you should modify):

- `src/packages/download/transfer-tracker.ts` (one optional field on `ReconcileRow`)
- `src/background/transfer-correlation.ts`
- `src/background/transfer-correlation.test.ts`
- `src/entrypoints/background.ts`
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `classifyTransfer` and `reconcile` in `transfer-tracker.ts`. The verdicts do
  not change. Boot reconcile depends on them.
- `reconcileTransfersOnBoot` and `planBootReconcile`. Boot reconcile already
  handles purged records.
- `STUCK_RECONCILE_AFTER_MS` and `STUCK_RECONCILE_POLL_MS`.
- `clearDownloadMonitor`. It must keep refusing a reset while a paused
  download exists.
- `inFlight`, `transfersState`, and `requestMetaById` cleanup for purged
  entries. See "Maintenance notes".

## Git workflow

- Branch: `advisor/041-let-worker-sleep-with-stalled-downloads`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `perf(background): …` here.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes, and some are in this plan's
  in-scope files. Never revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists: those files already hold uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Write the failing tests

In `src/background/transfer-correlation.test.ts`, add the four tests listed in
"Test plan" inside the existing `describe('transfer correlation', …)` block.
Use the existing `harness()` helper. Rows are set with `h.rows.set(id, row)`.
A purged record is an id with no row. The tests read `summary.pollable`.

**Verify**: `bun run test src/background/transfer-correlation.test.ts` → the
four new tests FAIL (`pollable` is `undefined`, and `paused` is not a known
property of `ReconcileRow`). The existing tests pass.

### Step 2: Let the row carry `paused`

In `src/packages/download/transfer-tracker.ts`, add one field to `ReconcileRow`:

```ts
export interface ReconcileRow {
  readonly state?: string
  readonly exists?: boolean
  readonly paused?: boolean
}
```

Do not change `classifyTransfer`.

**Verify**: `bun run typecheck` → exit 0.

### Step 3: Report how many transfers a poll can still settle

In `src/background/transfer-correlation.ts`:

1. Add a module-level constant above `makeTransferCorrelation`:

```ts
const QUIET_AFTER_PURGED_ROUNDS = 3
```

2. Add `pollable` to `ReconcileSummary`. Keep the existing `inProgress` field
   and its comment as they are:

```ts
  readonly pollable: number
```

3. Inside `makeTransferCorrelation`, next to the two existing maps, add:

```ts
  const pausedDownloadIds = new Set<number>()
  const purgedRoundsByDownloadId = new Map<number, number>()

  const forgetQuiet = (downloadId: number): void => {
    pausedDownloadIds.delete(downloadId)
    purgedRoundsByDownloadId.delete(downloadId)
  }

  const isQuiet = (downloadId: number): boolean =>
    pausedDownloadIds.has(downloadId) ||
    (purgedRoundsByDownloadId.get(downloadId) ?? 0) >= QUIET_AFTER_PURGED_ROUNDS
```

4. Call `forgetQuiet(downloadId)` in `release`, after the two existing
   `delete` calls. In `register`, call `forgetQuiet(downloadId)` after the two
   existing `set` calls. In `clear`, add `pausedDownloadIds.clear()` and
   `purgedRoundsByDownloadId.clear()`.

5. In `reconcileOne`, directly after the line
   `if (requestByDownloadId.get(downloadId) !== requestId) return false` and
   before `const verdict = classifyTransfer(row)`, add:

```ts
    if (row === undefined) {
      purgedRoundsByDownloadId.set(
        downloadId,
        (purgedRoundsByDownloadId.get(downloadId) ?? 0) + 1,
      )
    } else {
      purgedRoundsByDownloadId.delete(downloadId)
    }
    if (row?.paused === true && row.state !== 'complete' && row.state !== 'interrupted') {
      pausedDownloadIds.add(downloadId)
    } else {
      pausedDownloadIds.delete(downloadId)
    }
```

   A search that throws returns earlier, so it changes neither record. That is
   intended: a thrown search is transient.

6. In `reconcile`, replace the final `return` with:

```ts
      const pollable = [...requestByDownloadId.keys()].filter(
        (downloadId) => !isQuiet(downloadId),
      ).length
      return { inProgress: stillDownloading.filter(Boolean).length, pollable }
```

   An entry that was not due this round (too young, retry-owned, or outside
   `only`) has no quiet record, so it counts as pollable. A settled entry was
   released by the settle port, so it is no longer in the map.

**Verify**: `bun run test src/background/transfer-correlation.test.ts` → all
pass, including the four new tests.

### Step 4: Stop the watchdog when nothing is pollable, and re-arm on a change

In `src/entrypoints/background.ts`:

1. Replace the body of `reconcileStuckDownloads` so it reads:

```ts
const reconcileStuckDownloads = async (): Promise<void> => {
  const { pollable } = await transferCorrelation.reconcile({
    minAgeMs: STUCK_RECONCILE_AFTER_MS,
  })
  if (pollable === 0 && stuckPollTimer !== null) {
    clearInterval(stuckPollTimer)
    stuckPollTimer = null
  }
}
```

   An empty map gives `pollable === 0`, so this covers the old
   `stopStuckPollIfIdle()` call. Leave `stopStuckPollIfIdle` and its other
   callers unchanged.

2. In `onDownloadChanged`, directly after the line `if (id === undefined) return`,
   add:

```ts
  ensureStuckPoll()
```

   Chrome sends a change event when a paused download resumes. The event
   re-arms the watchdog. If the download is still paused on the next poll, the
   watchdog stops again after one round.

Do not change the comment above `ensureStuckPoll`. It stays true.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -c "ensureStuckPoll\(\)" src/entrypoints/background.ts` → one more match
than before this step (count it before you edit).
`rg -n "pollable" src/entrypoints/background.ts` → 2 matches.

### Step 5: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

All in `src/background/transfer-correlation.test.ts`, modelled on the existing
test "leaves a purged record, a retry-owned id, and an unlisted id alone".

1. **A paused download is not pollable but still counts as in progress.**
   Register id 1. Set its row to `{ state: 'in_progress', paused: true }`.
   `reconcile({ minAgeMs: 0 })` returns `inProgress: 1` and `pollable: 0`.
   `size()` is 1 and nothing settled.
2. **A resumed download is pollable again.** Continue from test 1. Set the row
   to `{ state: 'in_progress', paused: false }`. The next `reconcile` returns
   `pollable: 1`.
3. **A purged record stops being pollable after three rounds.** Register id 1
   with no row. The first and second `reconcile({ minAgeMs: 0 })` return
   `pollable: 1`. The third returns `pollable: 0`. `size()` stays 1 and nothing
   settled. The number three comes from the requirement that one missed search
   must not end polling.
4. **A download that is still too young is pollable.** Register id 1 at
   `h.clock.now`. `reconcile({ minAgeMs: STUCK_AFTER_MS })` returns
   `pollable: 1` without calling search.

There is no unit-test harness for the `background.ts` wiring. Step 4 is
verified by typecheck, lint, and the `rg` checks.

Verification: `bun run test src/background/transfer-correlation.test.ts` → all
pass, 4 new tests.

Optional check in a real browser (the operator runs this, not the executor):
start a large download through the extension and pause it in
`chrome://downloads`. Open `chrome://serviceworker-internals`. Before this
plan the worker stays RUNNING for minutes. After it, the worker should stop
within about a minute of the pause. Resume the download and confirm that it
still records a completed outcome in the popup.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] The 4 new tests exist and pass
- [ ] `rg -n "QUIET_AFTER_PURGED_ROUNDS" src/background/transfer-correlation.ts` returns 2 matches
- [ ] `rg -n "setInterval" src/entrypoints/background.ts` still shows the watchdog timer inline in `ensureStuckPoll`
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `reconcileOne`, `reconcile`, or the watchdog block does not match the
  excerpts.
- `rg -n "ReconcileSummary" src` shows a test fake or another module that
  builds a `ReconcileSummary` object literal. It would need the new field.
- An existing test in `transfer-correlation.test.ts` fails after Step 3.
- You find that the fix seems to need releasing or failing a purged entry.
  ADR-0014 forbids a fabricated outcome.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- A purged entry stays in the correlation map until the worker restarts. Its
  request id also stays in `inFlight`, as it does today. Boot reconcile drops
  it on the next worker start. The worker can now reach that restart, because
  the watchdog no longer holds it awake.
- A paused download that the user cancels fires a change event. The listener
  re-arms the watchdog and handles the interrupt as before.
- If the worker sleeps while a download is paused, the in-memory map is lost.
  `reconcileTransfersOnBoot` re-seeds it from `session:transfers` and re-arms
  the watchdog. That path already existed.
- Deferred: three smaller leaks from the same audit are not planned anywhere.
  `cloudGrabs` entries in `background.ts` are deleted only on `completed`. The
  `misses` map in `src/packages/sync/saved-index.ts` is never pruned by its
  TTL. `orphanRecords` in `src/background/tab-broadcaster.ts` is never pruned
  when tabs close. Each one is small and lives only as long as the worker.
  This plan shortens that life.
- Reviewer: check that `inProgress` is unchanged for a paused download, so the
  monitor reset in `clearDownloadMonitor` still refuses.
