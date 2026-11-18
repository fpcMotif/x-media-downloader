# Plan 026: Release posts whose files are saved but whose Release never finished

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/clear/worklist.ts src/packages/clear/tests/worklist.test.ts src/background/clear-session.ts src/background/clear-session.test.ts src/entrypoints/background.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/024-gate-release-on-server-reply.md, plans/025-click-each-post-once.md
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/100

## Why this matters

A "Release this page" sweep downloads each post's media and then un-bookmarks
or un-likes the post. The durable record of each post has four states:
`queued`, `downloaded`, `cleared`, `failed`. When the files land but the
click fails (X was slow, the tab closed, a rate limit), the post stays at
`downloaded`. The only way back is to press the sweep button again. That
second run sends the post through the download path again. With "prevent
duplicate downloads" on, every file is already saved, the download path
returns early, and the release is never attempted. The post is stuck. With
the setting off, every file is downloaded a second time just to reach the
click. After this plan a second sweep releases those posts directly, with no
new download.

## Hard design constraint

The extension never sends X's GraphQL requests itself and never replays
credentials. It only clicks X's own controls and observes X's own requests
through the MAIN-world tee. This plan reuses the existing click dispatch. It
adds no request.

## Vocabulary

- **Clear** (code noun) and **Release** (UI verb): the opt-in un-bookmark or
  un-like after a save.
- **Settle**: after a browser download reports complete, the worker waits a
  short window and re-reads the download through `chrome.downloads.search`. A
  download that is complete and on disk is settled. Settle is the only gate on
  the irreversible Clear.
- **Ledger**: the in-memory record, per post, of which media must land before
  a Clear may fire. It is lost when the service worker restarts.
- **Worklist**: the durable per (post, scope) sweep record in
  `chrome.storage.local`, key `clearWorklist`.
- **Scope**: `bookmark` or `like`.

`docs/state-machines.md` section 4.4 describes the worklist: states
`queued | downloaded | cleared | failed`, with `cleared` final. Its open
finding O18 says worklist entries can stay `queued` forever. This plan handles
`downloaded` only.

The safety argument of this plan rests on one fact: the state `downloaded` is
written in exactly one place, after Settle confirmed every media of the post
on this device.

## Current state

Files and roles:

- `src/packages/clear/worklist.ts` — pure worklist functions. Clean in git.
- `src/packages/clear/tests/worklist.test.ts` — its tests.
- `src/background/clear-session.ts` — the worker's Clear session: ledger,
  worklist writes, the release attempt. Has uncommitted changes.
- `src/background/clear-session.test.ts` — its tests. Helpers: `makeDeps`,
  `makeFakeClock`, `CLEAR_ON`, `fireSettleWindow`.
- `src/entrypoints/background.ts` — the service worker. `handleSweepEnqueue`
  is near lines 1623–1680. Has uncommitted changes; treat line numbers as
  approximate and locate edits by the quoted code.

The only write of `downloaded` (`src/background/clear-session.ts`, inside
`recordComplete`, near line 448):

```ts
          if (isTrulyComplete(next)) {
            setSweepState(tweetId, next.scopes, 'downloaded')
            return true
          }
```

A failed click leaves it there. `resolveClearAttempt` marks `cleared` only for
scopes that really flipped (near line 326):

```ts
    const flipped = flippedScopes(results)
    if (flipped.length > 0) setSweepState(attempt.tweetId, flipped, 'cleared')
```

A second sweep resets the state and returns the post for download
(`clear-session.ts`, `enqueueSweep`, near lines 557–575):

```ts
    await new Promise<void>((resolve) => {
      worklistQueue.push(async () => {
        let wl = decodeWorklist(await worklistStorage.get())
        const now = Date.now()
        for (const p of posts) {
          // (two comment lines, unchanged)
          if (isSweepCleared(wl, p.tweetId, scope)) {
            skippedIds.push(p.tweetId)
            continue
          }
          wl = enqueueSweepWorklist(wl, p.tweetId, scope, now)
          queuedPosts.push({ items: p.items })
        }
        await worklistStorage.set(capWorklist(wl, SWEEP_WORKLIST_MAX))
        resolve()
      })
    })
    return { queuedPosts, skipped: skippedIds.length, skippedIds }
```

`enqueueSweepWorklist` is `enqueue` from the worklist package
(`src/packages/clear/worklist.ts:79-88`). It sets the state to `queued`:

```ts
  const key = keyFor(scope, tweetId)
  if (wl[key]?.state === 'cleared') return wl
  return { ...wl, [key]: { tweetId, scope, state: 'queued', at } }
```

The existing predicate to copy (`worklist.ts:73-74`):

```ts
export const isCleared = (wl: SweepWorklist, tweetId: string, scope: ClearScope): boolean =>
  wl[keyFor(scope, tweetId)]?.state === 'cleared'
```

The worker then sends every returned post to the download path
(`src/entrypoints/background.ts`, `handleSweepEnqueue`):

```ts
    const enqueued = await clearSession.enqueueSweep(scope, posts)
    queuedPosts = enqueued.queuedPosts
    skipped = enqueued.skipped
    skippedIds = enqueued.skippedIds
```

```ts
  if (items.length > 0)
    void Effect.runPromise(handleDownload(items, { scope }, undefined, originTabId)).catch(
```

`handleDownload` returns early when the admission gate leaves no requests
(near line 1391, the `requests.length === 0` branch). That return is before
the ledger is seeded (`seedClear: clearSession.seedLedger`, near line 1489).
With no ledger entry, no release is ever attempted.

The release attempt needs a ledger entry that is "truly complete"
(`clear-session.ts`, `prepareClearAttempt`, near lines 250–273):

```ts
    const entry = clearLedger.get(tweetId)
    if (entry === undefined) {
      trace('clear-not-attempted', { tweetId, detail: 'reason=no-entry' })
      return undefined
    }
    if (!isTrulyComplete(entry)) {
```

```ts
    if (!settings.clearOnSave) {
      trace('clear-not-attempted', { tweetId, detail: 'reason=clear-off' })
      return undefined
    }
```

How `seedLedger` builds an entry and records where to click (near lines
499–520). Copy these call shapes:

```ts
          rememberOrigin(tweetId, {
            ...(verdict.originTabId === undefined ? {} : { tabId: verdict.originTabId }),
            release,
          })
```

```ts
            : createEntry({
                tweetId,
                scopes: verdict.scopes,
                origin: verdict.origin,
                strategy: 'browser',
                expected: ids,
              })
```

A sweep's release pin has the shape `{ source: 'consented', scope }`, where
`scope` is `'bookmark'` or `'like'` (type `MembershipScope`).

The ledger reducer is imported in this file as `reduceLedger`. Its actions
include `{ type: 'Complete', mediaId }` and `{ type: 'Settle', mediaId }`
(both used in `recordComplete`). A new entry has every expected id in
progress. `Complete` then `Settle` for each id makes it truly complete.

`runClearAttempt(tweetId)` (near line 354) claims the scopes, dispatches the
click through the tab broadcaster, and resolves the result. Its only caller
today is the settle timer.

The session's public interface (`ClearSession`, near lines 113–145) lists
`seedLedger`, `recordComplete`, `recordFailure`, `setSweepState`,
`enqueueSweep`, `reset`, `releaseStillAuthorized`.

Errors from fire-and-forget promises in `background.ts` go through
`queueError(label)` (near line 462), which returns an
`(err: Error | string) => void` handler.

Repo conventions that apply (from `AGENTS.md` and `src/packages/README.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Named constants, not magic numbers.
- Code outside a package imports only the package's root files.
  `bun run lint:boundaries` enforces this.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. The target
code below deliberately has no comments. You may not add a
`no-await-in-loop` suppression, so the sequential release below uses a
promise chain built with `reduce`.

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

- `src/packages/clear/worklist.ts`
- `src/packages/clear/tests/worklist.test.ts`
- `src/background/clear-session.ts`
- `src/background/clear-session.test.ts`
- `src/entrypoints/background.ts`
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/background/admission-gate.ts` and the saved-media index. The saved
  index includes saves made on other devices and cloud-only saves. Those must
  never authorize a Clear. Do not use it to decide a release.
- `handleDownload` in `background.ts`. Do not move the ledger seed above the
  early return.
- Posts stuck at `queued` or `failed`. See Maintenance notes.
- Any release at worker start-up or on a timer. This plan releases only when
  the user presses the sweep button again.
- `src/packages/schema/index.ts` — `SweepEnqueueResponse` keeps its shape.

## Git workflow

- Branch: `advisor/026-retry-stuck-releases`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `fix(clear): …` here.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. Never revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists: those files already hold uncommitted changes.
  At planning time that was `clear-session.ts`, `clear-session.test.ts` and
  `background.ts`.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Add the `isDownloaded` predicate

Test first. In `src/packages/clear/tests/worklist.test.ts` add test 1 from
"Test plan", next to the existing `isCleared` tests.

**Verify**: `bun run test src/packages/clear/tests/worklist.test.ts` → FAILS
(`isDownloaded` is not exported).

Then add to `src/packages/clear/worklist.ts`, directly below `isCleared`:

```ts
export const isDownloaded = (wl: SweepWorklist, tweetId: string, scope: ClearScope): boolean =>
  wl[keyFor(scope, tweetId)]?.state === 'downloaded'
```

**Verify**: `bun run test src/packages/clear/tests/worklist.test.ts` → all
pass.

### Step 2: Make `enqueueSweep` set settled posts aside

Test first. In `src/background/clear-session.test.ts` add tests 2 and 3 from
"Test plan". Model the storage stub on the existing test "resolves an
authorized Drain result through the claim and worklist" (near line 404), which
passes a `worklistStorage` with `get` and `set` over a local `stored`
variable.

**Verify**: `bun run test src/background/clear-session.test.ts` → the new
tests FAIL.

Then edit `src/background/clear-session.ts`:

1. Import `isDownloaded` from the worklist package, next to the import that
   brings in `isCleared` (it is aliased as `isSweepCleared`). Use the alias
   `isSweepDownloaded`.
2. In the `ClearSession` interface, add `settledIds: string[]` to the object
   type that `enqueueSweep` resolves to. Make the same change to the return
   type on the `enqueueSweep` implementation.
3. In the implementation, declare `const settledIds: string[] = []` next to
   `skippedIds`. Inside the `for (const p of posts)` loop, directly after the
   closing brace of the `if (isSweepCleared(…)) { … }` block, add:

```ts
          if (isSweepDownloaded(wl, p.tweetId, scope)) {
            settledIds.push(p.tweetId)
            continue
          }
```

4. Change the final return to
   `return { queuedPosts, skipped: skippedIds.length, skippedIds, settledIds }`.

A settled post keeps the state `downloaded`. It is not returned in
`queuedPosts`, so it is not downloaded again.

**Verify**: `bun run test src/background/clear-session.test.ts` → tests 2 and
3 pass. `bun run typecheck` → exit 0.

### Step 3: Add `releaseSettled` to the session

Test first. In `src/background/clear-session.test.ts` add tests 4 to 7 from
"Test plan".

**Verify**: `bun run test src/background/clear-session.test.ts` → the new
tests FAIL (`releaseSettled` does not exist).

Then edit `src/background/clear-session.ts`:

1. Near the other module constants, add:

```ts
const SETTLED_RETRY_MEDIA_ID = 'settled-retry'
```

2. Add to the `ClearSession` interface:

```ts
  readonly releaseSettled: (
    scope: MembershipScope,
    tweetIds: ReadonlyArray<string>,
    originTabId: number | undefined,
  ) => Promise<void>
```

   `MembershipScope` is already imported in this file (it types
   `resolveOriginScope`).
3. Inside `makeClearSession`, below `runClearAttempt`, add:

```ts
  const releaseSettled = async (
    scope: MembershipScope,
    tweetIds: ReadonlyArray<string>,
    originTabId: number | undefined,
  ): Promise<void> => {
    const seeded = await clearQueue.run(async () => {
      const ids: string[] = []
      for (const tweetId of tweetIds) {
        const existing = clearLedger.get(tweetId)
        if (existing !== undefined && !isFullyCleared(existing)) continue
        rememberOrigin(tweetId, {
          ...(originTabId === undefined ? {} : { tabId: originTabId }),
          release: { source: 'consented', scope },
        })
        const fresh = createEntry({
          tweetId,
          scopes: [scope],
          origin: 'sweep',
          strategy: 'browser',
          expected: [SETTLED_RETRY_MEDIA_ID],
        })
        const completed = reduceLedger(fresh, {
          type: 'Complete',
          mediaId: SETTLED_RETRY_MEDIA_ID,
        })
        clearLedger.set(
          tweetId,
          reduceLedger(completed, { type: 'Settle', mediaId: SETTLED_RETRY_MEDIA_ID }),
        )
        trace('clear-retry-settled', { tweetId, detail: `scope=${scope}` })
        ids.push(tweetId)
      }
      return ids
    })
    await seeded.reduce(
      (chain, tweetId) => chain.then(() => runClearAttempt(tweetId)),
      Promise.resolve(),
    )
  }
```

   If `createEntry` takes `scopes` or `expected` in a different shape than an
   array, pass the same shape that `seedLedger` passes. If `clearQueue.run`
   does not return the task's value, that is a STOP condition (it does at
   `runClearAttempt`: `const attempt = await clearQueue.run(…)`).
4. Add `releaseSettled` to the object that `makeClearSession` returns.

What this does:

- A post that a live download already owns (a ledger entry that is not fully
  cleared) is skipped. The download's own Settle will release it.
- The entry has origin `sweep`, so only the swept scope can be clicked.
- `runClearAttempt` re-checks the "Clear after download" setting, claims the
  scope, dispatches the click, and writes `cleared` on a real flip. On failure
  the worklist stays `downloaded`, and the next sweep retries.
- Posts run one at a time.

**Verify**: `bun run test src/background/clear-session.test.ts` → all pass.

### Step 4: Call it from the sweep handler

In `src/entrypoints/background.ts`, in `handleSweepEnqueue`:

1. Next to `let skippedIds: string[] = []` add
   `let settledIds: string[] = []`.
2. In the `try` block, after `skippedIds = enqueued.skippedIds`, add
   `settledIds = enqueued.settledIds`.
3. Directly above the line `if (items.length > 0)` add:

```ts
  if (settledIds.length > 0 && (scope === 'bookmark' || scope === 'like')) {
    traceBackground('clear-sweep-settled', {
      detail: `scope=${scope} settled=${settledIds.length} ids=${settledIds.join(',')}`,
    })
    void clearSession
      .releaseSettled(scope, settledIds, originTabId)
      .catch(queueError('release-settled'))
  }
```

Do not change the `SweepEnqueueResponse` that the function returns.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -n "releaseSettled" src/entrypoints/background.ts` → 1 match.

### Step 5: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

`src/packages/clear/tests/worklist.test.ts`:

1. **`isDownloaded`** is `true` only for an entry in state `downloaded` for
   that exact scope. It is `false` for `queued`, `cleared`, `failed`, a
   missing entry, and the other scope.

`src/background/clear-session.test.ts` (model on the test near line 404;
`stored` starts as
`{ 'bookmark:T': { tweetId: 'T', scope: 'bookmark', state: 'downloaded', at: 1 } }`):

2. **A settled post is set aside, not re-queued.**
   `enqueueSweep('bookmark', [{ tweetId: 'T', items: ['m0'] }])` resolves with
   `settledIds: ['T']`, `queuedPosts: []`, `skipped: 0`. The stored entry is
   still `downloaded`. Fails before the change (the state becomes `queued`).
3. **Other states are unchanged.** A post with no entry is returned in
   `queuedPosts` and stored as `queued`. A `cleared` post is in `skippedIds`.
4. **`releaseSettled` dispatches the click with the swept scope pinned.** With
   settings `CLEAR_ON` and a `dispatchClear` mock that resolves
   `[{ scope: 'bookmark', ok: true }]`, call
   `releaseSettled('bookmark', ['T'], 7)`. `dispatchClear` was called once
   with `'T'`, `['bookmark']`, the settings' all-lists value, `7`, and
   `{ source: 'consented', scope: 'bookmark' }`. Then
   `isCleared(decodeWorklist(stored), 'T', 'bookmark')` becomes `true` (use
   `vi.waitFor`, as the model test does).
5. **A failed click leaves the post retryable.** `dispatchClear` resolves
   `[{ scope: 'bookmark', ok: false }]`. The stored state stays `downloaded`.
6. **"Clear after download" off blocks it.** With `clearOnSave: false`,
   `dispatchClear` is not called.
7. **A post with a live download is left alone.** Seed a ledger entry for `T`
   with `seedLedger` (as the model test does) and do not complete it. Then
   `releaseSettled('bookmark', ['T'], 7)` does not call `dispatchClear`.

`background.ts` has no unit-test harness for `handleSweepEnqueue`. Step 4 is
verified by typecheck, lint and the `rg` check.

Verification: `bun run test src/packages/clear/tests/worklist.test.ts src/background/clear-session.test.ts`
→ all pass, 7 new tests.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `bun run lint:boundaries` exits 0
- [ ] The 7 new tests exist and pass
- [ ] `rg -n "settledIds" src/background/clear-session.ts` returns at least 4 matches
- [ ] `rg -n "savedMediaIndex|queryConvexMedia" src/background/clear-session.ts` returns no matches
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `rg -n "'downloaded'" src --glob '!**/*.test.ts'` shows any write of the
  state `downloaded` other than the one in `recordComplete` quoted above. The
  safety argument of this plan needs that single writer.
- `enqueueSweep`, `prepareClearAttempt` or `handleSweepEnqueue` does not match
  the excerpts.
- `createEntry` followed by `Complete` and `Settle` does not make
  `isTrulyComplete` true in test 4.
- The fix appears to need the saved-media index, a change to
  `handleDownload`, or a new message type.
- You find you need a suppression comment or an `as` cast.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Why `downloaded` is trusted: it is written only after Settle confirmed every
  media of the post on this device. It is not refreshed later. If the user
  deleted the file afterwards, a retry still releases the post. Settle has
  always been a point-in-time check, so this plan does not weaken it. An owner
  who wants an age limit can compare the entry's `at` field with the current
  time; that is a product decision and is not made here.
- Owner decision needed, not made here: posts stuck at `queued`. They arise
  when the service worker restarts between the download and the 1.5 s settle
  window, because the ledger is in memory (state-machines finding O18). There
  is no durable proof the file landed, so this plan does not release them. The
  next sweep sends them through the download path as before.
- Owner decision needed, not made here: releasing `downloaded` posts
  automatically at worker start-up. It would act without a fresh user action.
- The sweep reply still reports `queued` and `skipped` only. A settled post is
  in neither count. If the popup should show "retrying N", that needs a schema
  field.
- `prepareClearAttempt` checks `settings.clearOnSave` for every release,
  including sweeps. A comment in `handleSweepEnqueue` says the sweep is
  independent of that toggle. The code and the comment disagree. This plan
  follows the code. Report the disagreement to the owner.
- Plans 018 and 019 also edit `src/entrypoints/background.ts`. Run one at a
  time and rerun the next plan's drift check.
- A reviewer should check that no path can reach `releaseSettled` with an id
  whose worklist state was not `downloaded`.
