# Plan 017: The Sync panel polls only while visible, and one relay reconcile costs one request per deployment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7456911 -- src/background/remote-upload.ts src/background/remote-upload.test.ts src/background/cloud-upload.ts src/entrypoints/options/panels/sync.tsx src/entrypoints/options/panels/visible-poll.ts src/entrypoints/options/panels/visible-poll.test.ts`
> `src/background/remote-upload.ts` and `src/background/cloud-upload.ts`
> already show as changed, because the working tree had uncommitted edits when
> this plan was written. Line numbers in `cloud-upload.ts` are approximate;
> find each place by the quoted text. For every
> in-scope file, compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none. Plan 018 also edits `src/background/remote-upload.ts` (a different function, `owns`). Run 017 and 018 one after the other, never in parallel.
- **Category**: perf
- **Planned at**: commit `7456911`, 2026-11-16. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

The options page's Sync panel asks the service worker for upload status every
2 seconds for as long as Cloud upload is on. It does this even when the
options tab is in the background. A Chrome MV3 service worker shuts down after
about 30 seconds without events; a message every 2 seconds means it never
shuts down, so its whole heap stays in memory.

Each status request also runs a "reconcile" against the Convex relay. The
reconcile sends one HTTPS query per unresolved receipt, one after another,
although the server endpoint accepts up to 100 ids per query. Reconciles run
on a serial queue, so if one pass takes longer than 2 seconds, new passes
pile up behind it without limit.

After this plan: the panel stops polling while hidden, a reconcile sends one
query per deployment (per 100 receipts), and a status-poll reconcile requested
while another status-poll reconcile is running joins the running one. A
reconcile triggered by a settings change never joins; it always runs fresh,
as it does today.

## Current state

Files:

- `src/entrypoints/options/panels/sync.tsx` — the options Sync panel (Preact).
  Contains the 2-second poll.
- `src/background/remote-upload.ts` — the relay client used by the service
  worker. Contains `reconcile`.
- `src/background/cloud-upload.ts` — calls `remote.reconcile()` from two
  places: `cloudUploadStatus` (every status request) and
  `reconcileCloudOnlyHistory` (after a settings change and on boot). This plan
  changes one line in the first and nothing in the second.
- `src/background/remote-upload.test.ts` — existing tests for the relay client.
- `backend/convex/relay.ts` — the server endpoint. NOT edited; shown for its limit.

The poll:

```ts
// src/entrypoints/options/panels/sync.tsx:157-172
  const uploadOn = settings.cloudUploadEnabled
  useEffect(() => {
    if (!uploadOn) {
      setCloudStatus(null)
      return
    }
    const poll = (): void => {
      void browser.runtime
        .sendMessage({ _tag: 'CloudStatusRequest' })
        .then((s) => setCloudStatus((s as CloudUploadStatus | null) ?? null))
        .catch(() => {})
    }
    poll()
    const handle = setInterval(poll, 2000)
    return () => clearInterval(handle)
  }, [uploadOn])
```

The status handler awaits a reconcile every time:

```ts
// src/background/cloud-upload.ts:767-774
  const cloudUploadStatus = async (): Promise<CloudUploadStatus> => {
    let relayError: string | null = null
    try {
      await remote.reconcile()
    } catch {
      relayError =
        'Accepted server status is unavailable. Check the original deployment, permission, and shared secret.'
    }
```

The settings-change path. `background.ts` runs it from its `watchSettings`
callback and once on boot. It must see the NEW settings, so it must never be
handed the result of a reconcile that started before the change:

```ts
// src/background/cloud-upload.ts:808-811
  const reconcileCloudOnlyHistory = (): Promise<void> =>
    uploadQueue.run(async () => {
      await remote.reconcile()
      const settings = await getSettings()
```

The port interface that both callers use:

```ts
// src/background/remote-upload.ts:48-59
export interface RemoteUploadPort {
  record(settings: Settings, items: ReadonlyArray<UploadCandidate>): Promise<ReadonlyArray<string>>
  owns(mediaId: string): Promise<boolean>
  summary(): Promise<UploadSummary>
  budget(day: string): Promise<{ bytes: number; count: number }>
  reconcile(): Promise<void>
  setup(): Promise<RelaySetup>
  probe(url: string): Promise<number | null>
  control(enabled: boolean, accepting: boolean, connected: boolean): Promise<void>
  disconnect(): Promise<void>
  retry(): Promise<void>
}
```

No test builds its own `RemoteUploadPort` object
(`rg -n "RemoteUploadPort" src --glob '*.test.ts'` returns nothing), so adding
a method to the interface breaks no test double.

The reconcile, one query per receipt:

```ts
// src/background/remote-upload.ts:311-337
  const reconcile = () =>
    queue.run(async () => {
      const settings = await deps.getSettings()
      const rows = (await read()).filter((row) => row.historyOutcome !== 'completed')
      const reconcileNext = async (index: number): Promise<void> => {
        const row = rows[index]
        if (!row) return
        const statuses = Schema.decodeUnknownSync(Status)(
          await call(
            settings,
            'query',
            'relay:status',
            { deviceId: row.deviceId, mediaIds: [row.mediaId] },
            row.deploymentUrl,
            row.syncSecret,
          ),
        )
        const status = statuses[0]
        const kind = status?.status === 'uploading' ? 'queued' : status?.status
        if (status && kind && row.historyOutcome !== kind && row.historyOutcome !== 'completed') {
          await deps.onHistoryNotice({ mediaId: row.mediaId, kind, at: status.at })
          await patchReceipt(row.mediaId, { accepted: true, historyOutcome: kind })
        }
        await reconcileNext(index + 1)
      }
      await reconcileNext(0)
    })
```

Supporting definitions in the same file:

```ts
// src/background/remote-upload.ts:13-27 (fields only)
const Receipt = Schema.Struct({
  mediaId: Schema.String,
  deviceId: Schema.String,
  deploymentUrl: Schema.String,
  syncSecret: Schema.optional(Schema.String),
  ...
  accepted: Schema.Boolean,
  ...
  historyOutcome: Schema.optional(Schema.Literals(['queued', 'completed', 'failed'])),
})
```

```ts
// src/background/remote-upload.ts:36-42
const Status = Schema.Array(
  Schema.Struct({
    mediaId: Schema.String,
    status: Schema.Literals(['queued', 'uploading', 'completed', 'failed']),
    at: Schema.Number,
  }),
)
```

```ts
// src/background/remote-upload.ts:85
  const queue = makeSerialQueue(() => {})
```

The server accepts an array, caps it at 100, and returns only the rows it
found (so the reply can be shorter than the request and is not index-aligned):

```ts
// backend/convex/relay.ts:306-322
export const status = query({
  args: { secret: v.string(), deviceId: v.string(), mediaIds: v.array(v.string()) },
  returns: v.array(publicJob),
  handler: async (ctx, { secret, deviceId, mediaIds }) => {
    assertSecret(secret)
    if (mediaIds.length > 100) throw new Error('At most 100 status requests')
    ...
    return rows.flatMap((row) => (row ? [visible(row)] : []))
  },
})
```

The existing test harness (reuse it):

```ts
// src/background/remote-upload.test.ts:36-44
function memoryStore(): DurableStore {
  let value: unknown = null
  return {
    get: async () => value,
    set: async (next) => {
      value = next
    },
  }
}
```

A fetch double that records both the URL and the body of every request
(copy this shape for the new tests):

```ts
// src/background/remote-upload.test.ts:162-171
    const calls: { url: string; body: string }[] = []
    const store = memoryStore()
    const deps = {
      getSettings: async () => current,
      store,
      onHistoryNotice: () => {},
      fetchImpl: (async (url, init) => {
        const body = String(init?.body)
        calls.push({ url: String(url), body })
```

```ts
// src/background/remote-upload.test.ts:212-232 (shape of a reconcile test)
  it('reconciles offline completion after restart with the experiment disabled, once', async () => {
    const store = memoryStore()
    const notices: CloudHistoryNotice[] = []
    ...
    const deps = {
      getSettings: async () => current,
      store,
      onHistoryNotice: (notice: CloudHistoryNotice) => {
        notices.push(notice)
      },
      fetchImpl: (async (_url, init) =>
        Response.json({
          status: 'success',
          value: String(init?.body).includes('relay:status')
            ? [{ mediaId: 'm1', status: completed ? 'completed' : 'failed', at: 100 }]
            : { id: 'server-job', created: true },
        })) satisfies typeof fetch,
    }
    await makeRemoteUpload(deps).record(settings, [item])
    await makeRemoteUpload(deps).reconcile()
```

A test for a timer-driven helper with injected fakes, to model the new helper
test on: `src/entrypoints/overlay.content/saved-status-lifecycle.test.ts`
(it injects a fake `clock` with `after(ms, run)` returning a cancel function).

Repo conventions that apply (from `AGENTS.md`):

- "Forbidden, without exception: `oxlint-disable` / `eslint-disable` /
  `@ts-ignore` / `@ts-expect-error`". The lint config flags `await` inside a
  loop. The existing code avoids it with a small recursive helper
  (`reconcileNext(index + 1)` above). Use the same recursive pattern for any
  sequential awaits. Do not add a disable comment.
- "Every `as` needs an uppercase `SAFETY:` comment". Do not add new `as` casts.
- `unknown` is banned in parameters, returns, and type aliases. Use the domain
  type.
- "Named constants, not magic numbers."
- "`async/await` over promise chains."
- "`satisfies` over a widening annotation: `const X = {...} satisfies T`, not
  `const X: T = {...}`."
- "Function components only. Hooks at the top level, never conditionally, with
  complete dependency arrays."
- Effect code is Effect v4. v3 idioms such as `Effect.Service`, `catchAll`,
  and `decodeUnknownEither` do not exist. This plan needs no new Effect code.
- Tests are vitest with assertions inside `it()`.

ADR constraint (`docs/adr/0013-client-side-cloud-byte-upload.md:57`):
"Saved requires confirmed Drive completion, not durable queue acceptance."
The reconcile is what turns a receipt into a confirmed completion. This plan
changes how many requests it sends, not what it decides per receipt.

Secrets: receipts carry a `syncSecret` field. Never log it and never put a
real value in a test. The existing tests use the literal placeholder
`'test-secret'`; reuse that placeholder only.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Format check | `bun run fmt:check` | exit 0 |
| Boundaries | `bun run lint:boundaries` | exit 0 |
| Focused tests | `bun run test src/background/remote-upload.test.ts` and `bun run test src/entrypoints/options/panels/visible-poll.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |
| Build | `bun run build` | exit 0 |

The package manager is bun. Never use npm or npx.

## Scope

**In scope** (the only files you should modify):

- `src/background/remote-upload.ts` — the body of `reconcile`; one new
  module-level constant (`RELAY_STATUS_BATCH`); one new variable and one new
  function inside `makeRemoteUpload` (`sharedReconcile`, `reconcileShared`);
  one new method on the `RemoteUploadPort` interface and on the returned object
- `src/background/remote-upload.test.ts` — add tests
- `src/background/cloud-upload.ts` — ONE line inside `cloudUploadStatus`
  (`remote.reconcile()` → `remote.reconcileShared()`)
- `src/entrypoints/options/panels/visible-poll.ts` (create)
- `src/entrypoints/options/panels/visible-poll.test.ts` (create)
- `src/entrypoints/options/panels/sync.tsx` — the one poll effect, one import,
  and one new module-level constant
- `plans/README.md` — this plan's row in the "Performance plans (012–023)"
  table only

**Out of scope** (do NOT touch, even though they look related):

- `reconcileCloudOnlyHistory` in `src/background/cloud-upload.ts`. It keeps
  calling `remote.reconcile()`, which keeps its current meaning: always queue
  a fresh run.
- A rate limit on `cloudUploadStatus`. A time-based limit would show stale
  status right after the user clicks Retry.
- `backend/` — the server endpoint already accepts batches. No backend change.
- `retry`, `record`, `submitBatch`, `budget`, `owns`, and `patchReceipt` in
  `remote-upload.ts`.
- The popup's metrics poll (`src/entrypoints/popup/App.tsx`). Another plan
  owns it.
- The message schema (`src/packages/schema/index.ts`).

## Git workflow

- Branch: `advisor/017-throttle-sync-panel-status-poll`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `perf(relay): batch status reconcile per deployment` and
  `perf(options): pause the sync status poll while hidden`.
- Do NOT push or open a PR.
- The working tree has unrelated uncommitted user changes, including edits to
  `src/background/remote-upload.ts` and `src/background/cloud-upload.ts`
  themselves. Never revert or stash them.
- Staging rule: before you start, run `git status --short` and note which
  in-scope files already show as modified. Do NOT commit those files. Leave
  your edits in them unstaged and list them in your report. Commit only
  in-scope files that were clean (or new) when you started.

## Steps

### Step 1: Add failing tests for batched and shared reconcile

In `src/background/remote-upload.test.ts`, add a new `describe('relay status
reconcile', ...)` block after the existing one. Reuse the file's `settings`
constant and `memoryStore()`.

Seed receipts by writing the store directly, so the test does not depend on
the submit path. A seeded receipt looks like this (all required fields):

```ts
const receipt = (mediaId: string) => ({
  mediaId,
  deviceId: 'device',
  deploymentUrl: 'https://test.convex.cloud',
  syncSecret: 'test-secret',
  sourceUrl: `https://pbs.twimg.com/media/${mediaId}.jpg`,
  path: `twitter/${mediaId}.jpg`,
  contentType: 'image/jpeg',
  accepted: true,
})
```

Test A — "sends one relay:status query for all receipts on one deployment":

1. `const store = memoryStore(); await store.set([receipt('m1'), receipt('m2'), receipt('m3')])`.
2. `fetchImpl` records each request's URL and body into
   `calls: { url: string; body: string }[]` (the double shown in "Current
   state", `remote-upload.test.ts:162-171`) and replies
   `Response.json({ status: 'success', value: [{ mediaId: 'm1', status: 'completed', at: 100 }, { mediaId: 'm3', status: 'failed', at: 101 }] })`
   (note: `m2` is absent from the reply on purpose).
3. Collect notices through `onHistoryNotice`.
4. `await makeRemoteUpload(deps).reconcile()`.
5. Expect: exactly 1 recorded body contains `relay:status`.
6. Expect: that body contains `m1`, `m2`, and `m3`.
7. Expect: `notices` equals
   `[{ mediaId: 'm1', kind: 'completed', at: 100 }, { mediaId: 'm3', kind: 'failed', at: 101 }]`.

Test B — "splits more than 100 receipts into queries of at most 100":

1. Seed 101 receipts `m0` … `m100`.
2. `fetchImpl` replies with an empty `value: []`.
3. `await reconcile()`.
4. Expect: exactly 2 bodies contain `relay:status`.

Test C — "queries each deployment separately":

1. Seed `receipt('m1')` and a second receipt with
   `deploymentUrl: 'https://other.convex.cloud'`.
2. `await reconcile()`, with the same URL-and-body recording double as test A.
3. Expect: 2 `relay:status` requests, one whose recorded `url` starts with
   each origin.

Test D — "a status-poll reconcile joins a running status-poll reconcile":

1. Seed one receipt. `fetchImpl` replies with `value: []`.
2. `const remote = makeRemoteUpload(deps)`.
3. `await Promise.all([remote.reconcileShared(), remote.reconcileShared()])`.
4. Expect: exactly 1 body contains `relay:status`.

Test E — "a settings-change reconcile never joins: it runs fresh, with the
new settings, even when the running one fails":

1. Seed one receipt (`receipt('m1')`, deployment `https://test.convex.cloud`).
2. `getSettings` returns the file's `settings` on its first call and
   `{ ...settings, convexSyncSecret: 'rotated-secret' }` on every later call
   (count the calls in a local variable). `'rotated-secret'` is a placeholder,
   like the file's `'test-secret'`.
3. `fetchImpl` records `url` and `body`; its FIRST call throws
   `new Error('network down')`; later calls reply with `value: []`.
4. `const remote = makeRemoteUpload(deps)`.
5. `const polled = remote.reconcileShared()` then, without awaiting,
   `const afterSettingsChange = remote.reconcile()`.
6. `await expect(polled).rejects.toThrow()`.
7. `await afterSettingsChange` (it must resolve).
8. Expect: exactly 2 recorded bodies contain `relay:status`.
9. Expect: the second of them contains `rotated-secret`.

Tests D and E call `reconcileShared`, which does not exist yet.

**Verify**: `bun run test src/background/remote-upload.test.ts` → tests A and
B FAIL (A sees 3 requests, B sees 101). Tests D and E FAIL because
`reconcileShared` is not a function. Test C passes already. All pre-existing
tests still pass.

### Step 2: Batch the reconcile per deployment

In `src/background/remote-upload.ts`:

1. Add a module-level constant near the top-level schema constants:
   `const RELAY_STATUS_BATCH = 100`.
2. Replace the body of `reconcile`'s queued task with this logic:
   - Read settings and the unresolved rows exactly as today
     (`row.historyOutcome !== 'completed'`).
   - Group the rows by the triple `deploymentUrl`, `deviceId`, `syncSecret`.
     Use a `Map<string, Receipt[]>` keyed by
     `` `${row.deploymentUrl}\n${row.deviceId}\n${row.syncSecret ?? ''}` ``.
   - Split each group into chunks of at most `RELAY_STATUS_BATCH` rows.
   - For each chunk, send ONE call:
     `call(settings, 'query', 'relay:status', { deviceId, mediaIds }, deploymentUrl, syncSecret)`
     where `deviceId`, `deploymentUrl`, and `syncSecret` come from the chunk's
     first row and `mediaIds` is every row's `mediaId`.
   - Decode the reply with `Schema.decodeUnknownSync(Status)` as today.
   - For each returned status, look up its row by `mediaId` inside the chunk
     (the reply is not index-aligned and may omit rows). Apply the exact
     per-row rule that exists today:

     ```ts
     const kind = status.status === 'uploading' ? 'queued' : status.status
     if (row.historyOutcome !== kind && row.historyOutcome !== 'completed') {
       await deps.onHistoryNotice({ mediaId: row.mediaId, kind, at: status.at })
       await patchReceipt(row.mediaId, { accepted: true, historyOutcome: kind })
     }
     ```

   - Keep every await sequential: chunks one after another, and statuses
     inside a chunk one after another. Use recursive helpers in the style of
     the existing `reconcileNext(index + 1)`. Do not use `await` inside a
     `for` loop and do not add a lint-disable comment.
   - Ignore a returned status whose `mediaId` is not in the chunk.

Keep the function inside `queue.run(...)` so it stays serialized with
`record` and `retry`.

**Verify**: `bun run test src/background/remote-upload.test.ts` → tests A, B,
and C pass. Tests D and E still fail. All pre-existing tests pass.

### Step 3: Add a joining entry point for the status poll

There are two kinds of caller, and they need different behaviour:

- The status poll only wants "a recent reconcile". If one is running, it can
  wait for that one.
- The settings-change path (`reconcileCloudOnlyHistory`) needs a reconcile
  that starts AFTER the change. It must never be handed a run that read the
  old settings.

So `reconcile()` keeps its current meaning (always queue a fresh run), and a
second method, `reconcileShared()`, is added for the poll.

In `src/background/remote-upload.ts`:

1. Add `reconcileShared(): Promise<void>` to the `RemoteUploadPort` interface,
   on the line after `reconcile(): Promise<void>`.
2. Leave `reconcile` (the batched function from Step 2) as it is. Do not make
   it join anything.
3. Inside `makeRemoteUpload`, next to `const queue = ...`, add
   `let sharedReconcile: Promise<void> | null = null`.
4. Below `reconcile`, add:

   ```ts
   const reconcileShared = (): Promise<void> => {
     if (sharedReconcile !== null) return sharedReconcile
     const pass = (async () => {
       try {
         await reconcile()
       } finally {
         sharedReconcile = null
       }
     })()
     sharedReconcile = pass
     return pass
   }
   ```

   A shared run joins only another shared run. It never joins, and is never
   joined by, a plain `reconcile()`.
5. Add `reconcileShared,` to the returned object, after `reconcile,`.

In `src/background/cloud-upload.ts`, inside `cloudUploadStatus` only, change
`await remote.reconcile()` to `await remote.reconcileShared()`. Do not change
the `remote.reconcile()` call inside `reconcileCloudOnlyHistory`.

**Verify**: `bun run test src/background/remote-upload.test.ts` → all tests
pass, including A–E and the pre-existing
"reconciles offline completion after restart with the experiment disabled, once".
**Verify**: `rg -n "remote\.reconcile(Shared)?\(\)" src/background/cloud-upload.ts`
→ exactly 2 matches: `remote.reconcileShared()` inside `cloudUploadStatus` and
`remote.reconcile()` inside `reconcileCloudOnlyHistory`.
**Verify**: `bun run test src/background/cloud-upload.test.ts` → all pass.

### Step 4: Add the visibility-gated poll helper with tests

Create `src/entrypoints/options/panels/visible-poll.ts`. It must have no
Preact or `browser` imports, so it is testable with fakes.

Target shape:

```ts
export interface VisibilitySource {
  readonly isVisible: () => boolean
  readonly onChange: (listener: () => void) => () => void
}

export interface PollClock {
  readonly every: (intervalMs: number, run: () => void) => () => void
}

export interface VisiblePollDeps {
  readonly poll: () => void
  readonly intervalMs: number
  readonly visibility: VisibilitySource
  readonly clock: PollClock
}

export function startVisiblePoll(deps: VisiblePollDeps): () => void

export const documentVisibility = {
  isVisible: () => document.visibilityState === 'visible',
  onChange: (listener) => {
    document.addEventListener('visibilitychange', listener)
    return () => document.removeEventListener('visibilitychange', listener)
  },
} satisfies VisibilitySource

export const intervalClock = {
  every: (intervalMs, run) => {
    const handle = setInterval(run, intervalMs)
    return () => clearInterval(handle)
  },
} satisfies PollClock
```

Use `satisfies`, not a `: VisibilitySource` / `: PollClock` annotation (repo
rule quoted in "Current state").

Behaviour of `startVisiblePoll`:

- On start, if visible: call `poll()` once and start the interval.
- On start, if hidden: do nothing yet.
- On a visibility change to visible, when no interval is running: call
  `poll()` once and start the interval.
- On a visibility change to hidden: stop the interval.
- A visibility change that does not change the state does nothing (never two
  intervals at once).
- The returned function stops the interval and removes the visibility
  listener. After it runs, later visibility changes do nothing.

Create `src/entrypoints/options/panels/visible-poll.test.ts` with a fake
visibility source (a mutable `visible` flag plus a `fire()` that calls every
registered listener) and a fake clock (records started and stopped intervals,
exposes `tick()` to run the live interval callback). Model the fakes on
`src/entrypoints/overlay.content/saved-status-lifecycle.test.ts`. Tests:

1. "polls once and starts the interval when visible at start" — 1 poll, 1 live interval.
2. "does not poll while hidden at start" — 0 polls, 0 live intervals.
3. "stops the interval when the page becomes hidden" — after `fire()` with
   `visible = false`: 0 live intervals, and `tick()` causes no further poll.
4. "polls immediately and restarts when the page becomes visible again" —
   poll count rises by exactly 1 on the change, and 1 interval is live.
5. "never runs two intervals" — two `fire()` calls while visible leave exactly
   1 live interval.
6. "dispose stops polling and ignores later visibility changes".

**Verify**: `bun run test src/entrypoints/options/panels/visible-poll.test.ts`
→ 6 passed.

### Step 5: Use the helper in the Sync panel

In `src/entrypoints/options/panels/sync.tsx`:

1. Add a module-level constant `const CLOUD_STATUS_POLL_MS = 2000` below the
   imports.
2. Import `documentVisibility`, `intervalClock`, and `startVisiblePoll` from
   `./visible-poll`.
3. In the effect shown in "Current state", replace the last three lines
   (`poll()`, `const handle = setInterval(poll, 2000)`, and the cleanup return)
   with:

   ```ts
       return startVisiblePoll({
         poll,
         intervalMs: CLOUD_STATUS_POLL_MS,
         visibility: documentVisibility,
         clock: intervalClock,
       })
   ```

   Keep the `if (!uploadOn)` early return, the `poll` function body, and the
   `[uploadOn]` dependency array exactly as they are.

**Verify**: `rg -n "setInterval" src/entrypoints/options/panels/sync.tsx` → no matches.
**Verify**: `bun run typecheck` → exit 0.

### Step 6: Run the gates

**Verify**: `bun run lint` → exit 0.
**Verify**: `bun run fmt:check` → exit 0.
**Verify**: `bun run check` → exit 0.
**Verify**: `bun run build` → exit 0.

## Test plan

- `src/background/remote-upload.test.ts`, new block "relay status reconcile":
  tests A (one query for three receipts; fails before with 3 queries),
  B (101 receipts → 2 queries; fails before with 101), C (two deployments → 2
  queries), D (two concurrent status-poll reconciles → 1 query), E (a
  settings-change reconcile issued while a status-poll reconcile is running
  and failing still runs, and uses the new settings). The expectations come
  from the requirement "one status request per deployment per 100 receipts",
  the server's documented 100-id limit, and the requirement "a settings change
  is never answered by a reconcile that read the old settings".
- `src/entrypoints/options/panels/visible-poll.test.ts`: the six tests in
  Step 4. Test 3 encodes the requirement "no status message is sent while the
  options tab is hidden".
- Patterns: `src/background/remote-upload.test.ts:212-240` for relay tests;
  `src/entrypoints/overlay.content/saved-status-lifecycle.test.ts` for fakes.
- Verification: both focused test commands pass; `bun run check` exits 0.

## Done criteria

ALL must hold:

- [ ] `bun run test src/background/remote-upload.test.ts` exits 0, including tests A–E
- [ ] `rg -n "remote\.reconcile\(\)" src/background/cloud-upload.ts` returns exactly 1 match, inside `reconcileCloudOnlyHistory`
- [ ] `rg -n "remote\.reconcileShared\(\)" src/background/cloud-upload.ts` returns exactly 1 match, inside `cloudUploadStatus`
- [ ] `bun run test src/entrypoints/options/panels/visible-poll.test.ts` exits 0 with 6 tests
- [ ] `rg -n "mediaIds: \[row.mediaId\]" src/background/remote-upload.ts` returns no matches
- [ ] `rg -n "setInterval" src/entrypoints/options/panels/sync.tsx` returns no matches
- [ ] `rg -n "oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error" src/entrypoints/options/panels/visible-poll.ts src/entrypoints/options/panels/visible-poll.test.ts` returns no matches
- [ ] `bun run check` exits 0 and `bun run build` exits 0
- [ ] `git status --short` shows no newly modified files outside the in-scope list and `plans/README.md`
- [ ] `plans/README.md` status row for 017 updated

## STOP conditions

Stop and report back (do not improvise) if:

- `reconcile` in `src/background/remote-upload.ts` does not match the excerpt
  (for example it already batches, or `relay:status` is called elsewhere).
- `backend/convex/relay.ts` no longer accepts a `mediaIds` array for `status`,
  or its limit is below 100. Do not change the backend; report instead.
- The pre-existing test "reconciles offline completion after restart with the
  experiment disabled, once" fails after Step 2 or Step 3. That test pins the
  per-receipt decision rule; a failure means the rule changed, not just the
  request count.
- Satisfying the lint requires `await` in a loop and you cannot express it
  with a recursive helper. Do not add a disable comment.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Deliberately left out: rate-limiting the reconcile on status reads (for
  example at most once every 30 seconds). It would show stale status right
  after the user clicks Retry. If the 2-second poll still proves costly while
  the panel is visible, the better follow-up is for the service worker to
  write upload status to `storage.session` and for the panel to watch that
  key instead of polling.
- Two entry points exist on purpose. `reconcileShared()` is for callers that
  only need a recent result (the status poll): a caller that arrives mid-pass
  gets the result of a pass that may have read receipts and settings slightly
  earlier, and the next poll runs a fresh pass. `reconcile()` is for callers
  that need a pass that started after their call (the settings-change sweep
  in `reconcileCloudOnlyHistory`). A new caller must pick deliberately; when
  unsure, use `reconcile()`.
- `patchReceipt` still reads and rewrites all receipts once per CHANGED
  receipt. That is unchanged and only runs when a status actually changes.
- If the server limit in `backend/convex/relay.ts` changes,
  `RELAY_STATUS_BATCH` must follow it.
- A reviewer should check that the per-receipt rule in Step 2 is byte-for-byte
  the old rule, and that grouping includes `syncSecret` (receipts from an older
  deployment keep their own credentials; see the existing test "uses original
  deployment credentials for status and budget after settings change").
