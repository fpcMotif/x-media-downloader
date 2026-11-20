# Plan 013: Stop hover traces from waking the service worker and rewriting metrics

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7456911 -- src/entrypoints/overlay.content/index.tsx src/entrypoints/background.ts src/packages/overlay src/packages/kernel`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `7456911`, 2026-11-16. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

When the pointer rests on a photo or video, the content script shows a download
badge and sends a trace message to the extension's service worker: one for
`shown`, a second for `nudged` 2.2 s later, and `armed` for a Quick Grab hover.
Each message wakes the service worker (or keeps it from suspending), and the
handler then rewrites the whole metrics snapshot in `chrome.storage.session`.
Moving the mouse over a feed therefore produces a steady stream of worker
wake-ups and storage writes that carry no download information. The worker
keeps only the last 12 trace events, so these hover events also push real
evidence out of that ring. After this plan the three hover-only stages stay in
the page (dev console only), and the remaining trace events share one storage
write per 250 ms window.

## Current state

Files and roles:

- `src/entrypoints/overlay.content/index.tsx` — the content script.
  `traceDownloadUi` (lines 577–609) builds and sends trace events.
- `src/entrypoints/background.ts` — the service worker. The
  `DownloadTraceEvent` handler is at lines 1822–1839. `persistSnapshot` is at
  line 271. `recordTrace` is at 279–313. `background.ts` line numbers are
  approximate; locate each edit by the quoted code.
- `src/packages/overlay/` — pure overlay logic with tests in
  `src/packages/overlay/tests/`. Root files (`badge.ts`, `launcher.ts`,
  `quickgrab.ts`, `latest-frame.ts`) are the package's entry points.
- `src/packages/kernel/` — small shared primitives with tests in
  `src/packages/kernel/tests/` (for example `serial-queue.ts`, `backoff.ts`).

The sender (`src/entrypoints/overlay.content/index.tsx:577-609`):

```ts
const traceDownloadUi =
  (source: 'quickgrab' | 'badge') =>
  (
    stage: string,
    opts: {
      readonly item?: MediaItem
      readonly key?: string
      readonly elapsedMs?: number
      readonly detail?: string
    } = {},
  ): void => {
    // Dev-only: mirror the trace to the page console so "why didn't it grab" is
    // visible live in the x.com DevTools (e.g. `[XMD] quickgrab no-item-for-hover`).
    if (import.meta.env.DEV) {
      const tag = opts.item
        ? `${opts.item.type}#${opts.item.id}`
        : opts.key
          ? `key ${opts.key}`
          : ''
      console.debug(`[XMD] ${source} ${stage}`, tag, opts.detail ?? '')
    }
    postEvent({
      _tag: 'DownloadTraceEvent',
      source,
      stage,
      t: Date.now(),
      ...(opts.item
        ? { itemId: opts.item.id, tweetId: opts.item.postId, type: opts.item.type }
        : {}),
      ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}),
      ...((opts.detail ?? opts.key) ? { detail: opts.detail ?? `key ${opts.key}` } : {}),
    })
  }

const traceQuickGrab = traceDownloadUi('quickgrab')
const traceBadge = traceDownloadUi('badge')
```

`postEvent` is a `browser.runtime.sendMessage` (`index.tsx:381-386`).

The three hover-only call sites:

```ts
// src/entrypoints/overlay.content/index.tsx:1254
        traceQuickGrab('armed', { key })
// src/entrypoints/overlay.content/index.tsx:1373
        traceBadge('shown', next.key ? { key: next.key } : {})
// src/entrypoints/overlay.content/index.tsx:1379
          traceBadge('nudged', badge.key ? { key: badge.key } : {})
```

No code reads the stage names `shown`, `nudged`, or `armed` on the worker side.
A search of `src` finds them only at these three call sites (the other hits
are unrelated badge-phase and hotkey-action names).

The receiver (`src/entrypoints/background.ts:1822-1839`):

```ts
  [
    'DownloadTraceEvent',
    handle<'DownloadTraceEvent'>(async (msg, sender) => {
      recordTrace({
        source: msg.source,
        stage: msg.stage,
        t: msg.t,
        ...(msg.itemId !== undefined ? { itemId: msg.itemId } : {}),
        ...(msg.tweetId !== undefined ? { tweetId: msg.tweetId } : {}),
        ...(msg.type !== undefined ? { type: msg.type } : {}),
        ...(msg.elapsedMs !== undefined ? { elapsedMs: msg.elapsedMs } : {}),
        ...(msg.detail !== undefined ? { detail: msg.detail } : {}),
        ...(sender.tab?.id !== undefined ? { tabId: sender.tab.id } : {}),
      })
      await persistSnapshot(Date.now())
      return { ok: true }
    }),
  ],
```

The snapshot write and the ring (`src/entrypoints/background.ts:156`, `:265-271`, `:279-280`):

```ts
const MAX_TRACE_EVENTS = 12
```

```ts
const withTraceEvents = (snap: MetricsSnapshot): MetricsSnapshot =>
  traceEvents.length === 0 ? snap : { ...snap, events: traceEvents }

const currentSnapshot = (now: number): MetricsSnapshot =>
  withTraceEvents(live ? snapshot(live, now) : ZERO_SNAPSHOT)

const persistSnapshot = (now: number): Promise<void> => metricsItem.setValue(currentSnapshot(now))
```

```ts
function recordTrace(event: DownloadTraceEntry): void {
  traceEvents = [...traceEvents, event].slice(-MAX_TRACE_EVENTS)
```

The reset path that clears the ring (`src/entrypoints/background.ts:1752-1754`):

```ts
  traceEvents = []
  live = null
  await metricsItem.setValue(null)
```

The same file already buffers a different stream with a trailing timer. Use it
as the pattern for a timer that starts once and does not re-arm
(`src/entrypoints/background.ts:402-406`):

```ts
  if (releaseDiagnosticsFlushTimer !== undefined) return
  releaseDiagnosticsFlushTimer = setTimeout(() => {
    releaseDiagnosticsFlushTimer = undefined
    void flushReleaseDiagnostics()
  }, RELEASE_DIAGNOSTICS_FLUSH_MS)
```

Errors from fire-and-forget promises in this file go through `queueError`
(`src/entrypoints/background.ts:462-469`), which takes a label and returns an
`(err: Error | string) => void` handler. The existing use is
`.catch(queueError('release-diagnostics'))` at line 392.

Design constraint, quoted from `docs/adr/0008-monitoring-metrics-model.md`:
"the background SW persists the latest `MetricsSnapshot` to `storage.session`
(ADR-0005) and answers a `MetricsRequest` message with it". The snapshot must
still be persisted after trace events. This plan only delays that write by at
most 250 ms and merges writes that fall in the same window.

Repo conventions that apply (from `AGENTS.md` and `src/packages/README.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Named constants, not magic numbers.
- Code outside a package imports only the package's root files. A new root
  file is a new entry point. Tests in `tests/` import through root files.
  `bun run lint:boundaries` enforces this.
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

**In scope** (the only files you should modify or create):

- `src/packages/overlay/trace-policy.ts` (create)
- `src/packages/overlay/tests/trace-policy.test.ts` (create)
- `src/packages/kernel/trailing-flush.ts` (create)
- `src/packages/kernel/tests/trailing-flush.test.ts` (create)
- `src/entrypoints/overlay.content/index.tsx`
- `src/entrypoints/background.ts`
- `plans/README.md` (only this plan's status row, in the "Performance plans (012–023)" table)

**Out of scope** (do NOT touch, even though they look related):

- `src/packages/schema/index.ts` — the `DownloadTraceEvent` message shape does
  not change. Do not add a batched message type.
- `reportClear` (`index.tsx:239-250`), `handleTeeDrop` (`index.tsx:1934-1948`),
  and `handlers.ts` — they send other trace events that must keep flowing.
- The other `persistSnapshot` callers (`background.ts:896`, `:1394`, `:1591`,
  `:1716`, and the ports in `src/background/`). Download-progress snapshots
  must stay immediate.
- `recordTrace`, `MAX_TRACE_EVENTS`, and the release-diagnostics buffer.
- The `media-no-key`, `no-item-for-hover`, `grab-target-stale`,
  `badge-target-stale`, `whole-post-fallback`, and `recovery-retryable` stages.
  They report failures and stay production-visible.

## Git workflow

- Branch: `advisor/013-batch-hover-trace-events`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `perf(overlay): …` and `perf(background): …` here.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes, and some are in this plan's
  in-scope files (`src/entrypoints/background.ts` had about 180 changed lines
  at planning time and was still being edited). Never revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists: those files already hold uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Add the page-only stage policy, test first

Create `src/packages/overlay/tests/trace-policy.test.ts` with the tests in
"Test plan" items 1–2. Import from `'../trace-policy'`, the same way
`src/packages/overlay/tests/badge.test.ts` imports from `'../badge'`.

**Verify**: `bun run test src/packages/overlay/tests/trace-policy.test.ts` →
FAILS (module not found).

Then create `src/packages/overlay/trace-policy.ts`:

```ts
const PAGE_ONLY_TRACE_STAGES: ReadonlySet<string> = new Set(['shown', 'nudged', 'armed'])

export const isPageOnlyTraceStage = (stage: string): boolean => PAGE_ONLY_TRACE_STAGES.has(stage)
```

**Verify**: `bun run test src/packages/overlay/tests/trace-policy.test.ts` →
all pass.

### Step 2: Keep page-only stages out of the message channel

In `src/entrypoints/overlay.content/index.tsx`:

1. Import `isPageOnlyTraceStage` from the overlay package's new root file. Match
   the path style the file already uses for other `packages/overlay` imports
   (find it with `rg -n "packages/overlay" src/entrypoints/overlay.content/index.tsx`).
2. In `traceDownloadUi`, between the closing brace of the `if (import.meta.env.DEV) { … }`
   block and the `postEvent({` call, add exactly one statement:

```ts
    if (isPageOnlyTraceStage(stage)) return
```

Do not change the three call sites. Do not change the existing comment.

**Verify**: `bun run typecheck` → exit 0.
`rg -n "isPageOnlyTraceStage" src/entrypoints/overlay.content/index.tsx` → 2
matches (the import and the guard).

### Step 3: Add a tested trailing-flush primitive

Create `src/packages/kernel/tests/trailing-flush.test.ts` with the tests in
"Test plan" items 3–5. Use vitest fake timers (`vi.useFakeTimers()` in
`beforeEach`, `vi.useRealTimers()` in `afterEach`); an existing fake-timer
example is `src/packages/download/tests/retry-queue.test.ts`.

**Verify**: `bun run test src/packages/kernel/tests/trailing-flush.test.ts` →
FAILS (module not found).

Then create `src/packages/kernel/trailing-flush.ts`:

```ts
export interface TrailingFlush {
  readonly request: () => void
  readonly cancel: () => void
}

export const makeTrailingFlush = (flush: () => void, delayMs: number): TrailingFlush => {
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    request: () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        flush()
      }, delayMs)
    },
    cancel: () => {
      clearTimeout(timer)
      timer = undefined
    },
  }
}
```

The timer starts on the first `request` and is not pushed back by later
requests. This bounds the delay to `delayMs`.

**Verify**: `bun run test src/packages/kernel/tests/trailing-flush.test.ts` →
all pass.

### Step 4: Coalesce the trace handler's snapshot write

In `src/entrypoints/background.ts`:

1. Import `makeTrailingFlush` from `@/packages/kernel/trailing-flush`. Match the
   style of the file's other `@/packages/kernel/...` imports.
2. Directly below the `persistSnapshot` definition (line 271), add:

```ts
const TRACE_SNAPSHOT_FLUSH_MS = 250

const traceSnapshotFlush = makeTrailingFlush(() => {
  void persistSnapshot(Date.now()).catch(queueError('trace-snapshot'))
}, TRACE_SNAPSHOT_FLUSH_MS)
```

   `queueError` is declared later in the file. That is fine: it is only read
   when the timer fires.
3. In the `DownloadTraceEvent` handler (the `await` is at line 1836), replace
   `await persistSnapshot(Date.now())` with `traceSnapshotFlush.request()`.
   Keep `return { ok: true }`. Keep the handler `async`: the `handle` helper
   requires a function that returns `Promise<JsonValue>`, and no require-await
   lint rule is enabled, so an `async` function with no `await` is accepted.
4. In the reset path, directly above `traceEvents = []` (line 1752), add
   `traceSnapshotFlush.cancel()`. A pending flush must not re-create the
   snapshot after a reset sets it to `null`.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -c "await persistSnapshot\(Date.now\(\)\)" src/entrypoints/background.ts`
→ prints `1` (it prints `2` before this step; the handler's `await` is the one
removed). `rg -c "persistSnapshot\(Date.now\(\)\)" src/entrypoints/background.ts`
→ prints `3` (also `3` before: the handler's call is gone and the one inside
`traceSnapshotFlush` is new).

### Step 5: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

`src/packages/overlay/tests/trace-policy.test.ts` (model on
`src/packages/overlay/tests/badge.test.ts`):

1. **Hover-only stages stay in the page.** `isPageOnlyTraceStage('shown')`,
   `('nudged')`, and `('armed')` are each `true`. Fails before the change
   (module missing).
2. **Failure and outcome stages still reach the worker.**
   `isPageOnlyTraceStage` is `false` for each of `'media-no-key'`,
   `'no-item-for-hover'`, `'grab-target-stale'`, `'badge-target-stale'`,
   `'whole-post-fallback'`, `'recovery-retryable'`, and `'tee-drop'`.

`src/packages/kernel/tests/trailing-flush.test.ts` (model on
`src/packages/kernel/tests/serial-queue.test.ts` for layout):

3. **Many requests in one window flush once.** Call `request()` 5 times, advance
   fake time by the delay, expect the `flush` spy called exactly 1 time. Fails
   before the change (module missing).
4. **The window does not slide.** Call `request()`, advance by 200 ms of a
   250 ms delay, call `request()` again, advance by 50 ms. Expect exactly 1
   flush. Then call `request()` and advance by 250 ms. Expect 2 flushes total.
5. **`cancel` drops a pending flush.** Call `request()`, then `cancel()`,
   advance by the delay. Expect 0 flushes. A later `request()` still flushes.

There is no unit-test harness for `overlay.content/index.tsx` or
`background.ts` wiring. Steps 2 and 4 are verified by typecheck, lint, and the
`rg` checks.

Verification: `bun run test src/packages/overlay/tests/trace-policy.test.ts src/packages/kernel/tests/trailing-flush.test.ts`
→ all pass, 5 new tests.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `bun run lint:boundaries` exits 0
- [ ] The 5 new tests exist and pass
- [ ] `rg -n "isPageOnlyTraceStage" src/entrypoints/overlay.content/index.tsx` returns 2 matches
- [ ] `rg -n "traceSnapshotFlush" src/entrypoints/background.ts` returns 3 matches (definition, `request`, `cancel`)
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `traceDownloadUi` or the `DownloadTraceEvent` handler does not match the
  excerpts.
- `rg -n "trace(Badge|QuickGrab)\('(shown|nudged|armed)'" src` returns anything
  other than these three lines in `src/entrypoints/overlay.content/index.tsx`:
  `traceQuickGrab('armed', …)` (near line 1254), `traceBadge('shown', …)` (near
  1373), and `traceBadge('nudged', …)` (near 1379).
- `rg -n "'shown'|'nudged'|'armed'" src/entrypoints/background.ts src/background`
  returns any match. A worker-side reader means the stages are not hover-only.
- A test or fixture asserts that `shown`, `nudged`, or `armed` reaches the
  background.
- Removing the `await` in the handler causes a lint or type error that you can
  only clear with a suppression comment or an `as` cast.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Trade-off: `shown`, `nudged`, and `armed` no longer appear in the worker
  console, the 12-event ring, or the popup snapshot in production builds. They
  still print to the page console in dev builds. The Quick Grab outcome events
  that follow `armed` still carry `elapsedMs`, so hover-to-grab timing is kept.
- A trace event's snapshot write can now land up to 250 ms after the event.
  The service worker stays alive well beyond that after a message, so the
  timer fires. If the worker is killed inside the window, at most 250 ms of
  ring updates are lost; the ring is in-memory and best-effort already.
- If a new high-frequency hover stage is added, add it to
  `PAGE_ONLY_TRACE_STAGES` and to test 1.
- Deferred: `media-no-key` on Quick Grab (`index.tsx:1286`) is not de-duplicated
  per element the way the badge variant is (`index.tsx:1360`). It only fires
  while the grab modifier is held, so it was left alone.
- Deferred: batching several trace events into one message. It needs a schema
  change and was not needed once the hover stages stopped sending.
