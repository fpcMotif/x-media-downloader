# Plan 025: Click each post's Release control once per attempt

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/background/tab-broadcaster.ts src/background/tab-broadcaster.test.ts src/packages/clear src/entrypoints/overlay.content/handlers.ts src/entrypoints/overlay.content/handlers.test.ts src/entrypoints/overlay.content/index.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plan 024 changes
> `src/packages/clear/tweet-clear.ts` and `index.tsx`; those changes are
> expected.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/024-gate-release-on-server-reply.md
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/99

## Why this matters

One release attempt can click the same post's control more than once. The
service worker asks each open X list tab in turn to release a post. When a tab
clicks and reports a failure, the worker asks the next tab, which clicks
again, and then opens a hidden permalink tab, which can click a third time.
Inside one page, two callers (the automatic release after a save, and the
manual "Clear this page" sweep) can also click the same control at the same
moment. Each extra click is one more request X counts against the account's
rate limit, and one more failure line that hides the real cause. After this
plan a failed click in one tab ends the tab fan-out, and one page never runs
two clicks for the same post and list at once.

## Hard design constraint

The extension never sends X's GraphQL requests itself and never replays
credentials. It only clicks X's own controls and observes X's own requests
through the MAIN-world tee. This plan only removes clicks. It adds no request.

## Vocabulary

- **Clear** (code noun) and **Release** (UI verb): the opt-in un-bookmark or
  un-like after a save.
- **Scope**: which list a click empties, `bookmark` or `like`.
- **Fan-out**: the worker sends a `ClearTweetRequest` message to each open X
  tab in order, until one tab that has the post mounted answers.
- **Permalink leg** (also "release tab"): when no list tab can do it, the
  worker loads the post's own page in one hidden tab and asks that page.
- **noop result**: a scope the page deliberately did not click. It is reported
  as `{ scope, ok: true, noop: true }`.
- **Witness**: the in-page log of X's own server replies (see plan 024).

`docs/state-machines.md` section 4.5 describes the tab dispatch as an "ordered
ownership protocol": the first mounted tab that performs the clear owns the
result.

## Current state

Files and roles:

- `src/background/tab-broadcaster.ts` — worker side. `runFanOut` (near lines
  856–889) and `sendClearToTabs` (near 939–1028). Has uncommitted changes.
- `src/background/tab-broadcaster.test.ts` — its tests. Fakes: a `TabsPort`
  object, `instantClock`, helpers `pinned()`, `clearResp`, `unmounted`.
- `src/packages/clear/` — pure Clear logic. Tests in `src/packages/clear/tests/`.
- `src/entrypoints/overlay.content/handlers.ts` — in-page message handlers.
  `clearMountedForScope` (583–626) is the manual sweep loop.
- `src/entrypoints/overlay.content/index.tsx` — wires `clearScope` and the
  handler deps.

The fan-out keeps going after a mounted tab clicked and failed
(`src/background/tab-broadcaster.ts`, `runFanOut`):

```ts
    for (const id of ids) {
      tried.push(id)
      try {
        const res = asClearTweetResponse(
          await tabs.sendTabMessage(id, {
            _tag: 'ClearTweetRequest',
            tweetId,
            scopes,
            allLists,
          }),
        )
        clearOrphanRecord(id)
        const attempted = res?.results.some((result) => !result.noop) === true
        const allSucceeded = res?.results.every((result) => result.ok) === true
        if (res?.mounted && attempted && allSucceeded) {
          answered.push(`${id}:mounted`)
          return { kind: 'mounted', results: res.results }
        }
        answered.push(`${id}:${answerToken(res)}`)
        if (res?.mounted === true) sawDiscardedMounted = true
      } catch (error) {
```

The loop ends with `return { kind: 'exhausted', sawDiscardedMounted }`. The
caller then runs the permalink leg for `bookmark` and `like` scopes
(`sendClearToTabs`):

```ts
    if (fanOut.kind === 'mounted') {
      traceDispatch('mounted', false)
      return fanOut.results
    }
```

Two existing tests fix behavior that must stay:

- "falls through a wrong-list mounted noop to the matching list tab": a tab
  whose results are all `noop` did not click, so the next tab is asked.
- "retries a mounted failed clear through the release tab instead of treating
  the attempt as terminal": after a mounted failure the permalink leg runs.

The manual sweep clicks with no coordination
(`src/entrypoints/overlay.content/handlers.ts:603-622`):

```ts
    const clickedAt = now()
    target.click()
    cleared++
    await new Promise((r) => setTimeout(r, paceMs))
    // (two comment lines, unchanged)
    if (tweetId === null) continue
    const verdict = witness?.outcome(tweetId, scope, clickedAt) ?? 'none'
    recordClearVerdict({
      document,
      article,
      tweetId,
      scope,
      verdict,
      paceMs,
      targetKind,
      disabled,
      ghosts,
      trace,
    })
```

`recordClearVerdict` (511–561) returns `void`. It has four exits: witness
`'error'` (failed), witness `'ok'` (released), DOM `flipConfirmed` (released),
and no flip (failed).

The automatic path calls `deps.clearScope(tweetId, scope, origin)` once per
scope (`handlers.ts`, `clearMountedTweet`, near 954–981). The dep is declared
at `handlers.ts:141`:

```ts
  readonly clearScope: (tweetId: string, scope: ClearScope, origin: ClearOrigin) => Promise<boolean>
```

`index.tsx` builds it once (near line 168) with
`const { clearScope } = makeTweetClearer({ … })` and passes `clearScope` into
the handler deps (near line 2280), next to `witness: mutationWitness`.

Nothing stops two `ClearTweetRequest` messages, or one of them and the manual
sweep, from clicking the same post and scope in the same page at the same
time.

Repo conventions that apply (from `AGENTS.md` and `src/packages/README.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Named constants, not magic numbers.
- Code outside a package imports only the package's root files. A new root
  file is a new entry point. `bun run lint:boundaries` enforces this.
- Tests are vitest. Assertions live inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. The target
code below deliberately has no comments. You may not add a
`no-await-in-loop` suppression; edits inside an existing suppressed region
are fine.

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

- `src/background/tab-broadcaster.ts`
- `src/background/tab-broadcaster.test.ts`
- `src/packages/clear/click-guard.ts` (create)
- `src/packages/clear/tests/click-guard.test.ts` (create)
- `src/entrypoints/overlay.content/handlers.ts`
- `src/entrypoints/overlay.content/handlers.test.ts`
- `src/entrypoints/overlay.content/index.tsx`
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/packages/clear/tweet-clear.ts` — the guard wraps `clearScope` from
  outside. Plan 024 owns that file's logic.
- `src/packages/schema/index.ts` — no message shape changes.
- `releaseViaStatusTab` and its poll loop — plan 028 owns it.
- `src/background/clear-session.ts` — the ledger's claim latch already stops
  two worker dispatches for one post. Do not change it.
- Detecting a re-add (`FavoriteTweet` or `CreateBookmark` after a click). See
  Maintenance notes.

## Git workflow

- Branch: `advisor/025-click-each-post-once`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `fix(clear): …` here.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. Never revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists: those files already hold uncommitted changes.
  At planning time that was `tab-broadcaster.ts`, `tab-broadcaster.test.ts`
  and `overlay.content/index.tsx`.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: End the fan-out after a tab clicked and failed

Test first. In `src/background/tab-broadcaster.test.ts` add the tests in "Test
plan" items 1 and 2. Model them on the existing test "retries a mounted failed
clear through the release tab instead of treating the attempt as terminal".
Use the same fake `TabsPort`, `instantClock`, `pinned()` and `clearResp`
helpers.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → test 1
FAILS (the second tab receives a `ClearTweetRequest`).

Then edit `runFanOut` in `src/background/tab-broadcaster.ts`. Replace these
two lines:

```ts
        answered.push(`${id}:${answerToken(res)}`)
        if (res?.mounted === true) sawDiscardedMounted = true
```

with:

```ts
        answered.push(`${id}:${answerToken(res)}`)
        if (res?.mounted === true) sawDiscardedMounted = true
        if (res?.mounted === true && attempted) break
```

The `break` leaves the `for` loop. The function then reaches its existing
final `return { kind: 'exhausted', sawDiscardedMounted }`, so the caller runs
the permalink leg exactly as it does today. A tab whose results are all noop
has `attempted === false` and does not break.

Why the permalink leg is still safe after a click: it loads the post's own
page fresh. A scope the first tab already released reads as "not a member"
there, and the page reports it released without clicking.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → all pass,
including the two existing tests named in "Current state".

### Step 2: Add a tested per-page click guard

Create `src/packages/clear/tests/click-guard.test.ts` with the tests in "Test
plan" items 3 to 7. Import from `'../click-guard'`, the way
`src/packages/clear/tests/mutation-witness.test.ts` imports from
`'../mutation-witness'`.

**Verify**: `bun run test src/packages/clear/tests/click-guard.test.ts` →
FAILS (module not found).

Then create `src/packages/clear/click-guard.ts`:

```ts
export const RECENT_RELEASE_MEMO_MS = 15_000

export interface ClickGuard {
  readonly run: (
    tweetId: string,
    scope: string,
    click: () => Promise<boolean>,
  ) => Promise<boolean>
}

export const makeClickGuard = (opts: {
  readonly now: () => number
  readonly memoMs?: number
}): ClickGuard => {
  const memoMs = opts.memoMs ?? RECENT_RELEASE_MEMO_MS
  const inFlight = new Map<string, Promise<boolean>>()
  const releasedAt = new Map<string, number>()

  const forgetExpired = (now: number): void => {
    for (const [key, at] of releasedAt) {
      if (now - at >= memoMs) releasedAt.delete(key)
    }
  }

  const run = (tweetId: string, scope: string, click: () => Promise<boolean>): Promise<boolean> => {
    const key = `${scope}:${tweetId}`
    const running = inFlight.get(key)
    if (running !== undefined) return running
    forgetExpired(opts.now())
    if (releasedAt.has(key)) return Promise.resolve(true)
    const attempt = click()
      .then((released) => {
        if (released) releasedAt.set(key, opts.now())
        return released
      })
      .finally(() => {
        inFlight.delete(key)
      })
    inFlight.set(key, attempt)
    return attempt
  }

  return { run }
}
```

Rules this encodes:

- While a click for a post and scope is running, a second caller gets the same
  promise. `click` runs once.
- For `memoMs` after a released verdict, a new caller gets `true` and `click`
  does not run. This covers a stale row that X has not removed yet.
- A failed verdict is not remembered. The next caller clicks again.

**Verify**: `bun run test src/packages/clear/tests/click-guard.test.ts` → all
pass.

### Step 3: Route the automatic path through the guard

In `src/entrypoints/overlay.content/index.tsx`:

1. Import `makeClickGuard` from the clear package. Match the path style of the
   existing `makeMutationWitness` import.
2. Directly below the `const { clearScope } = makeTweetClearer({ … })`
   statement add:

```ts
const clickGuard = makeClickGuard({ now: Date.now })

const guardedClearScope: typeof clearScope = (tweetId, scope, origin) =>
  clickGuard.run(tweetId, scope, () => clearScope(tweetId, scope, origin))
```

3. Run `rg -n "\bclearScope\b" src/entrypoints/overlay.content/index.tsx`.
   Every use other than the destructuring and the two lines you just added
   must become `guardedClearScope`. In an object literal written with the
   shorthand `clearScope,` write `clearScope: guardedClearScope,`.
4. In the handler deps object (the one that holds `witness: mutationWitness`,
   near line 2280) add `clickGuard,`.

In `src/entrypoints/overlay.content/handlers.ts`, in the deps interface that
declares `clearScope` (line 141) and `witness` (line 155), add:

```ts
  readonly clickGuard?: ClickGuard | undefined
```

and import the `ClickGuard` type next to the existing `MutationWitness` type
import.

**Verify**: `bun run typecheck` → exit 0.
`rg -n "\bclearScope\b" src/entrypoints/overlay.content/index.tsx` → every hit
is the destructuring, the `typeof clearScope`, the inner call inside
`clickGuard.run`, or a `clearScope: guardedClearScope` property.

### Step 4: Route the manual sweep through the guard

Test first. In `src/entrypoints/overlay.content/handlers.test.ts` add the
tests in "Test plan" items 8 and 9, next to the existing
`clearMountedForScope — ghost-row skip` describe block (near line 1589). Reuse
its DOM builders.

**Verify**: `bun run test src/entrypoints/overlay.content/handlers.test.ts` →
the new tests FAIL.

Then edit `src/entrypoints/overlay.content/handlers.ts`:

1. Change `recordClearVerdict` to return `boolean`. Its four exits become, in
   order: `return false` (witness error), `return true` (witness ok),
   `return true` (DOM flip), and `return false` after the final
   `clear-attempt-fail` trace. Change nothing else in it.
2. In `MountedScopeClear` add
   `readonly clickGuard?: ClickGuard | undefined`, and destructure
   `clickGuard` in `clearMountedForScope`.
3. In `clearMountedForScope`, replace the block from
   `const clickedAt = now()` to the end of the `recordClearVerdict({ … })`
   call. Keep the two-line comment that sits above
   `if (tweetId === null) continue` attached to the same condition. The new
   shape:

```ts
    const clickAndJudge = async (): Promise<boolean> => {
      const clickedAt = now()
      target.click()
      cleared++
      await new Promise((r) => setTimeout(r, paceMs))
      // (the two existing comment lines stay here, unchanged)
      if (tweetId === null) return false
      const verdict = witness?.outcome(tweetId, scope, clickedAt) ?? 'none'
      return recordClearVerdict({
        document,
        article,
        tweetId,
        scope,
        verdict,
        paceMs,
        targetKind,
        disabled,
        ghosts,
        trace,
      })
    }
    if (clickGuard === undefined || tweetId === null) await clickAndJudge()
    else await clickGuard.run(tweetId, scope, clickAndJudge)
```

   This code stays inside the existing `// oxlint-disable no-await-in-loop`
   region of the loop. `cleared` still counts only clicks this loop made.
4. In `handleClearVisible` and in `handleClearWholeList`, add
   `clickGuard: deps.clickGuard,` to the `clearMountedForScope({ … })`
   argument, next to `witness: deps.witness,`.

**Verify**: `bun run test src/entrypoints/overlay.content/handlers.test.ts` →
all pass. `bun run lint` → exit 0.

### Step 5: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

`src/background/tab-broadcaster.test.ts`:

1. **A mounted tab that clicked and failed ends the fan-out.** Two list tabs.
   Tab 1 answers `mounted: true` with `[{ scope: 'bookmark', ok: false }]`.
   Tab 2 would answer mounted and ok. Assert that no `ClearTweetRequest` was
   sent to tab 2, and that the release tab was navigated once. Fails before
   the change.
2. **A partly failed mounted answer also ends the fan-out.** Tab 1 answers
   `[{ scope: 'bookmark', ok: true }, { scope: 'like', ok: false }]`. Assert
   the same two facts.

`src/packages/clear/tests/click-guard.test.ts` (model on
`src/packages/clear/tests/mutation-witness.test.ts`; use a fake `now`):

3. **Two callers at once share one click.** Call `run('1', 'bookmark', click)`
   twice before the first resolves. `click` was called once. Both promises
   resolve to the same value.
4. **A released verdict is remembered for `memoMs`.** After a `true` result, a
   new `run` inside the window resolves `true` and does not call `click`.
5. **The memo expires.** Advance the fake clock by `memoMs`. `click` runs.
6. **A failed verdict is not remembered.** After `false`, the next `run` calls
   `click` again.
7. **Scopes and posts are independent.** A running `bookmark` click for post
   `1` does not block `like` for post `1` or `bookmark` for post `2`.

`src/entrypoints/overlay.content/handlers.test.ts`:

8. **The manual sweep does not click a post that another caller is
   clicking.** Build a real guard with `makeClickGuard`. Start
   `guard.run(id, 'bookmark', pending)` with a promise you control. Run
   `clearMountedForScope` with that guard on a document holding that post.
   Assert the control's `click` spy was not called and the function returned
   `0`. Resolve the pending promise so the test can finish.
9. **Without a guard the sweep is unchanged.** The same document with no
   `clickGuard` clicks once and returns `1`.

Verification: `bun run test src/background/tab-broadcaster.test.ts src/packages/clear/tests/click-guard.test.ts src/entrypoints/overlay.content/handlers.test.ts`
→ all pass, 9 new tests.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `bun run lint:boundaries` exits 0
- [ ] The 9 new tests exist and pass
- [ ] `rg -n "res\?\.mounted === true && attempted\) break" src/background/tab-broadcaster.ts` returns 1 match
- [ ] `rg -n "clickGuard" src/entrypoints/overlay.content/handlers.ts` returns at least 5 matches
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `runFanOut` or `clearMountedForScope` does not match the excerpts.
- Either existing test named in "Current state" fails after Step 1.
- `rg -n "\bclearScope\b" src/entrypoints/overlay.content` shows a caller in a
  file other than `index.tsx` and `handlers.ts` that builds its own clearer.
  The guard would then not cover it.
- `recordClearVerdict` has more or fewer than four exits.
- You find you need a suppression comment or an `as` cast.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- The guard is per page. It does not coordinate two tabs. Step 1 is the
  cross-tab rule: after one tab clicked, no other list tab is asked.
- "Attempted" means the page returned a result that is not a noop. It does not
  prove a click happened: a missing control also returns `ok: false`. Ending
  the fan-out in that case is accepted. Another tab would hit the same missing
  control, and the permalink leg still runs.
- Trade-off of the 15 s memo: if the user re-adds the bookmark or like by hand
  and the same post is released again inside 15 s, the page reports "released"
  without clicking. `RECENT_RELEASE_MEMO_MS` is a named, injectable constant
  for that reason.
- Unknown live behavior, not decided here: whether a second click on a stale
  row re-adds the post or just sends a second remove request. The code looks
  for the active "remove" control before clicking, so a row that already
  flipped is not clicked. Do not build logic on either answer without a
  captured session. A follow-up could watch the witness for `FavoriteTweet` or
  `CreateBookmark` after a click.
- Plans 027 and 028 edit the same regions (`runFanOut`,
  `clearMountedForScope`). Run them after this plan and rerun their drift
  checks. Plans 016 and 021 edit `overlay.content/index.tsx`; run one at a
  time.
- A reviewer should check that the guard wraps every `clearScope` use in
  `index.tsx`, including the one handed to the scroll drain wiring.
