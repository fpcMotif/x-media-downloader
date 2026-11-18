# Plan 027: Stop clicking when X answers 429, and resume after a back-off

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/clear src/packages/schema/index.ts src/entrypoints/overlay.content/handlers.ts src/entrypoints/overlay.content/handlers.test.ts src/entrypoints/overlay.content/index.tsx src/background/tab-broadcaster.ts src/background/tab-broadcaster.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plans 024 and 025 change several of
> these files; their changes are expected and are described below.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/024-gate-release-on-server-reply.md, plans/025-click-each-post-once.md
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/101

## Why this matters

X limits how many un-bookmark and un-like requests an account may send. When
the limit is hit, X answers HTTP 429. The extension sees that answer but does
nothing with it. The manual "Clear entire list" loop keeps clicking one post
every 350 ms, for up to 400 scroll steps. The automatic release keeps trying
other tabs and then the hidden permalink tab. Every click after the first 429
is wasted and may extend the limit. The manual loop also counts each 429 as a
"ghost row" strike, so real posts get skipped on later passes for the wrong
reason. After this plan one observed 429 pauses every release click in that
page for a back-off period, tells the worker to stop dispatching for the same
period, and is traced under its own reason.

## Hard design constraint

The extension never sends X's GraphQL requests itself and never replays
credentials. It only clicks X's own controls and observes X's own requests
through the MAIN-world tee. This plan only reads the status of replies the tee
already reports, and clicks less. It adds no request and no retry request.

## Vocabulary

- **Clear** (code noun) and **Release** (UI verb): the opt-in un-bookmark or
  un-like after a save.
- **Tee**: the MAIN-world script that copies X's own replies into DOM events.
- **Witness**: the in-page log of X's own `UnfavoriteTweet` and
  `DeleteBookmark` replies. The overlay fills it in `handleMutationResponse`.
- **Ghost row**: a stale row that never flips. The manual sweep counts
  consecutive failures per post and skips a post after `GHOST_NOFLIP_LIMIT = 2`.
- **Fan-out** and **permalink leg**: the worker asks each open X list tab to
  click, then falls back to a hidden tab on the post's own page.
- **Settle**: the worker's confirmation that the files landed. A release that
  fails after Settle leaves the post retryable.

## Current state

Files and roles:

- `src/entrypoints/overlay.content/index.tsx` — content script. Receives every
  observed mutation reply in `handleMutationResponse` (near lines 1878–1918).
- `src/packages/clear/tweet-clear.ts` — the automatic in-page clicker.
- `src/entrypoints/overlay.content/handlers.ts` — in-page message handlers,
  including the manual sweep loop `clearMountedForScope` and the automatic
  entry `handleClearTweet`.
- `src/packages/clear/list-clear.ts` — the "Clear entire list" scroll loop.
- `src/packages/schema/index.ts` — message schemas.
- `src/background/tab-broadcaster.ts` — worker dispatch.

Where every observed reply arrives (`index.tsx`, `handleMutationResponse`).
After plan 024 the record call reads:

```ts
      mutationWitness.record({ tweetId, op, status: detail.status, error, t, startedAt })
```

`detail.status` is the HTTP status of X's own reply, already validated with
`isNumber`. Nothing reads it for pacing.

The automatic click site (`src/packages/clear/tweet-clear.ts`, in
`clearScope`, near lines 438–445):

```ts
    /* v8 ignore stop */
    const { target, targetKind, disabled } = resolveClickTarget(ctrl)
    if (log) log(scope, '→ clicking', CLEAR_TESTID[scope].active)
    // (three comment lines, unchanged)
    const clickedAt = now()
    target.click()
```

The failure reason type (`tweet-clear.ts:165`):

```ts
    readonly reason: 'no-article' | 'no-control' | 'no-flip' | 'mutation-error'
```

`traceAttemptFail` accepts `click: null` and `attempts: 0` for failures that
did not click.

The manual loop. After plan 025, the body of the `for` loop in
`clearMountedForScope` (`handlers.ts`, near 587–626) ends with a
`clickAndJudge` function that clicks, waits `paceMs`, reads
`witness?.outcome(…)` once, and returns `recordClearVerdict({ … })`. The loop
starts:

```ts
  for (const article of document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const ctrl = clearControl(article, scope)
    if (ctrl === null) continue
```

A server error counts as a ghost strike (`handlers.ts`, `recordClearVerdict`):

```ts
  if (verdict === 'error') {
    ghosts?.set(tweetId, (ghosts.get(tweetId) ?? 0) + 1)
    trace(
      'clear-attempt-fail',
      `scope=${scope} reason=mutation-error attempts=1 elapsedMs=${paceMs} target=${targetKind} disabled=${disabled} testids=${actionTestids(article).join(',')} origin=manual`,
      tweetId,
    )
```

The whole-list loop keeps scrolling while passes return 0
(`src/packages/clear/list-clear.ts`): it runs up to `MAX_STEPS = 400` steps
and stops early only after `BOTTOM_STALLS = 3` steps with no click and no
scroll progress. `ListClearDeps` has `scroll`, `clock`, `path`,
`clearVisibleForPage` and `report`. `ListClearResult.reason` is
`'not-list-page' | 'scope-changed'`.

The automatic reply (`src/packages/schema/index.ts`, near line 460):

```ts
export const ClearTweetResponse = Schema.TaggedStruct('ClearTweetResponse', {
  mounted: Schema.Boolean,
  drainEligible: Schema.Boolean,
  results: Schema.Array(ClearResult),
  page: Schema.optional(ClearPageEvidence),
})
```

`handlers.ts` builds this reply in five object literals. Find them with
`rg -n "_tag: 'ClearTweetResponse'" src/entrypoints/overlay.content/handlers.ts`.

Worker side (`src/background/tab-broadcaster.ts`). `runFanOut` after plan 025:

```ts
        clearOrphanRecord(id)
        const attempted = res?.results.some((result) => !result.noop) === true
        const allSucceeded = res?.results.every((result) => result.ok) === true
        if (res?.mounted && attempted && allSucceeded) {
          answered.push(`${id}:mounted`)
          return { kind: 'mounted', results: res.results }
        }
        answered.push(`${id}:${answerToken(res)}`)
        if (res?.mounted === true) sawDiscardedMounted = true
        if (res?.mounted === true && attempted) break
```

`sendClearToTabs` defines `traceDispatch(outcome, fabricated, releaseTabId?)`
and then calls `runFanOut`:

```ts
    const fanOut = await runFanOut({
```

```ts
    if (fanOut.kind === 'mounted') {
      traceDispatch('mounted', false)
      return fanOut.results
    }
```

A failed dispatch returns `scopes.map((scope) => ({ scope, ok: false }))`.
The module already keeps one breaker variable, `backoffUntil`, for permalink
page errors. Do not reuse it: it must not block list tabs.

`probeReleaseTab` parses the permalink page's reply:

```ts
      if (res?.mounted === true) return { kind: 'mounted', results: res.results }
      return { kind: 'unmounted', page: res?.page }
```

The worker clock dep is `{ sleep, now }`. Tests use `instantClock`.

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

- `src/packages/clear/throttle.ts` (create)
- `src/packages/clear/tests/throttle.test.ts` (create)
- `src/packages/clear/tweet-clear.ts`
- `src/packages/clear/tests/tweet-clear.test.ts`
- `src/packages/clear/list-clear.ts`
- `src/packages/clear/tests/list-clear.test.ts`
- `src/packages/schema/index.ts`
- `src/entrypoints/overlay.content/handlers.ts`
- `src/entrypoints/overlay.content/handlers.test.ts`
- `src/entrypoints/overlay.content/index.tsx`
- `src/background/tab-broadcaster.ts`
- `src/background/tab-broadcaster.test.ts`
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/entrypoints/inject.content.ts` — the tee already reports the status.
  Do not read response headers in this plan.
- `src/packages/clear/mutation-witness.ts` — no API change is needed.
- `src/background/clear-session.ts` — a failed release already leaves the post
  retryable. No timer-driven retry is added here.
- `backoffUntil` and `releaseViaStatusTab` — the page-error breaker stays as
  it is. Plan 028 owns that function.
- Treating any status other than 429 as a rate limit. See Maintenance notes.

## Git workflow

- Branch: `advisor/027-pace-releases-and-back-off`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `fix(clear): …` here.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. Never revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists: those files already hold uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Add a tested back-off throttle

Create `src/packages/clear/tests/throttle.test.ts` with the tests in "Test
plan" items 1 to 5. Import from `'../throttle'`.

**Verify**: `bun run test src/packages/clear/tests/throttle.test.ts` → FAILS
(module not found).

Then create `src/packages/clear/throttle.ts`:

```ts
export const HTTP_TOO_MANY_REQUESTS = 429
export const RELEASE_THROTTLE_BASE_MS = 60_000
export const RELEASE_THROTTLE_MAX_MS = 900_000

export interface ReleaseThrottle {
  readonly blockedForMs: () => number
  readonly noteRateLimited: () => void
  readonly noteAnswered: () => void
}

export const makeReleaseThrottle = (opts: {
  readonly now: () => number
  readonly baseMs?: number
  readonly maxMs?: number
}): ReleaseThrottle => {
  const baseMs = opts.baseMs ?? RELEASE_THROTTLE_BASE_MS
  const maxMs = opts.maxMs ?? RELEASE_THROTTLE_MAX_MS
  let strikes = 0
  let blockedUntil = 0
  return {
    blockedForMs: () => Math.max(0, blockedUntil - opts.now()),
    noteRateLimited: () => {
      strikes += 1
      blockedUntil = opts.now() + Math.min(maxMs, baseMs * 2 ** (strikes - 1))
    },
    noteAnswered: () => {
      strikes = 0
    },
  }
}

export const noteReleaseReply = (throttle: ReleaseThrottle, status: number): void => {
  if (status === HTTP_TOO_MANY_REQUESTS) throttle.noteRateLimited()
  else throttle.noteAnswered()
}
```

`noteAnswered` resets the strike count. It does not end a back-off that is
already running.

**Verify**: `bun run test src/packages/clear/tests/throttle.test.ts` → all
pass.

### Step 2: Feed every observed reply into one page throttle

In `src/entrypoints/overlay.content/index.tsx`:

1. Import `makeReleaseThrottle` and `noteReleaseReply` from the clear
   package's new root file. Match the style of the `makeMutationWitness`
   import.
2. Directly below `const mutationWitness = makeMutationWitness()` add:

```ts
const releaseThrottle = makeReleaseThrottle({ now: Date.now })
```

3. In `handleMutationResponse`, on the line after the
   `mutationWitness.record({ … })` call, add:

```ts
      noteReleaseReply(releaseThrottle, detail.status)
```

   Match the surrounding indentation.
4. In the `makeTweetClearer({ … })` argument add `throttle: releaseThrottle,`
   below `witness: mutationWitness,`.
5. In the handler deps object (the one with `witness: mutationWitness`) add
   `throttle: releaseThrottle,`.

Typecheck fails until Steps 3 and 4 add the two `throttle` fields. That is
expected.

**Verify**: `rg -n "releaseThrottle" src/entrypoints/overlay.content/index.tsx`
→ 4 matches.

### Step 3: The automatic clicker refuses to click while blocked

Test first. In `src/packages/clear/tests/tweet-clear.test.ts` add tests 6 and
7 from "Test plan". Build the throttle with `makeReleaseThrottle` and a fake
`now`.

**Verify**: `bun run test src/packages/clear/tests/tweet-clear.test.ts` → the
new tests FAIL.

Then edit `src/packages/clear/tweet-clear.ts`:

1. Import the type: `import type { ReleaseThrottle } from './throttle'`.
2. In `TweetClearerDeps` add
   `readonly throttle?: ReleaseThrottle | undefined`, and read `throttle`
   where the other deps are destructured.
3. Add `'rate-limited'` to the `reason` union in `ClearAttemptFailRecord`.
4. In `clearScope`, directly after the `/* v8 ignore stop */` line quoted in
   "Current state" and before `const { target, targetKind, disabled } = …`,
   add:

```ts
    if (throttle !== undefined && throttle.blockedForMs() > 0) {
      traceAttemptFail({
        tweetId,
        scope,
        reason: 'rate-limited',
        attempts: 0,
        article: article.value,
        click: null,
        origin,
      })
      return false
    }
```

The check sits after the "already released" branch on purpose. A post that
already left the list still reports success while the page is blocked.

**Verify**: `bun run test src/packages/clear/tests/tweet-clear.test.ts` → all
pass.

### Step 4: The manual sweep pauses and stops counting 429 as a ghost

Test first. In `src/entrypoints/overlay.content/handlers.test.ts` add tests 8
to 10 from "Test plan", next to the `clearMountedForScope — ghost-row skip`
describe block.

**Verify**: `bun run test src/entrypoints/overlay.content/handlers.test.ts` →
the new tests FAIL.

Then edit `src/entrypoints/overlay.content/handlers.ts`:

1. Import the `ReleaseThrottle` type next to the `MutationWitness` type
   import.
2. Add `readonly throttle?: ReleaseThrottle | undefined` to the handler deps
   interface (next to `witness`) and to `MountedScopeClear`. Destructure
   `throttle` in `clearMountedForScope`.
3. In `clearMountedForScope`, make this the first statement inside the `for`
   loop body, above `const ctrl = clearControl(article, scope)`:

```ts
    const waitMs = throttle?.blockedForMs() ?? 0
    if (waitMs > 0) {
      trace('clear-sweep-paused', `scope=${scope} waitMs=${waitMs} origin=manual`)
      break
    }
```

4. Add `readonly rateLimited: boolean` to `ClearVerdictRecord` and destructure
   it in `recordClearVerdict`. In the `verdict === 'error'` branch, change the
   ghost line to `if (!rateLimited) ghosts?.set(tweetId, (ghosts.get(tweetId) ?? 0) + 1)`
   and change `reason=mutation-error` in that branch's detail string to
   `reason=${rateLimited ? 'rate-limited' : 'mutation-error'}`.
5. In `clickAndJudge` (added by plan 025), pass
   `rateLimited: verdict === 'error' && (throttle?.blockedForMs() ?? 0) > 0,`
   in the `recordClearVerdict({ … })` argument.
6. In `handleClearVisible` and `handleClearWholeList`, add
   `throttle: deps.throttle,` to the `clearMountedForScope({ … })` argument.
7. Add this helper above `handleClearTweet`:

```ts
const retryAfterField = (
  throttle: ReleaseThrottle | undefined,
): { readonly retryAfterMs?: number } => {
  const waitMs = throttle?.blockedForMs() ?? 0
  return waitMs > 0 ? { retryAfterMs: waitMs } : {}
}
```

   Spread `...retryAfterField(deps.throttle),` into each of the five
   `ClearTweetResponse` object literals.

In `src/packages/schema/index.ts`, add one field to `ClearTweetResponse`,
below `page`:

```ts
  retryAfterMs: Schema.optional(Schema.Number),
```

**Verify**: `bun run test src/entrypoints/overlay.content/handlers.test.ts` →
all pass. `bun run typecheck` → exit 0.

### Step 5: The whole-list loop ends when the page is blocked

Test first. In `src/packages/clear/tests/list-clear.test.ts` add test 11 from
"Test plan", modelled on the existing scope-change abort test.

**Verify**: `bun run test src/packages/clear/tests/list-clear.test.ts` → the
new test FAILS.

Then edit `src/packages/clear/list-clear.ts`:

1. Add to `ListClearDeps`:
   `readonly blockedForMs?: (() => number) | undefined`.
2. Add `'rate-limited'` to the `ListClearResult.reason` union.
3. Next to `let scopeChanged = false` add `let rateLimited = false`.
4. Directly after the line `cleared += clearedThisStep` add:

```ts
        const waitMs = deps.blockedForMs?.() ?? 0
        if (waitMs > 0) {
          deps.report('clear-list-abort', `reason=rate-limited waitMs=${waitMs} cleared=${cleared}`)
          rateLimited = true
          break
        }
```

5. Change the final return to:

```ts
    if (scopeChanged) return { cleared, reason: 'scope-changed' }
    return rateLimited ? { cleared, reason: 'rate-limited' } : { cleared }
```

In `handlers.ts`, in the `makeListClear({ … })` argument inside
`handleClearWholeList`, add
`blockedForMs: () => deps.throttle?.blockedForMs() ?? 0,`.

The reply `ClearWholeListResponse` carries `reason`. Run
`rg -n "ClearWholeListResponse" src/packages/schema/index.ts` and add
`'rate-limited'` to its `reason` literals. If the popup switches over that
reason exhaustively and typecheck fails there, that is a STOP condition.

**Verify**: `bun run test src/packages/clear/tests/list-clear.test.ts` → all
pass. `bun run typecheck` → exit 0.

### Step 6: The worker stops dispatching while a page reports a limit

Test first. In `src/background/tab-broadcaster.test.ts` add tests 12 to 14
from "Test plan".

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → the new
tests FAIL.

Then edit `src/background/tab-broadcaster.ts`:

1. Next to the declaration of `backoffUntil` add `let rateLimitedUntil = 0`.
2. Add `| { readonly kind: 'rate-limited' }` to the `FanOutOutcome` type.
3. Read `asClearTweetResponse` (near line 458). If it returns the reply object
   itself after its checks, do nothing. If it builds a new object field by
   field, copy `retryAfterMs` through when it is a number.
4. In `runFanOut`, directly after the closing brace of the
   `if (res?.mounted && attempted && allSucceeded) { … }` block, add:

```ts
        if (res?.retryAfterMs !== undefined && res.retryAfterMs > 0) {
          rateLimitedUntil = Math.max(rateLimitedUntil, clock.now() + res.retryAfterMs)
          answered.push(`${id}:rate-limited`)
          return { kind: 'rate-limited' }
        }
```

5. In `probeReleaseTab`, directly above
   `if (res?.mounted === true) return { kind: 'mounted', results: res.results }`,
   add:

```ts
      if (res?.retryAfterMs !== undefined && res.retryAfterMs > 0)
        rateLimitedUntil = Math.max(rateLimitedUntil, clock.now() + res.retryAfterMs)
```

6. In `sendClearToTabs`, directly above `const fanOut = await runFanOut({`,
   add:

```ts
    if (clock.now() < rateLimitedUntil) {
      traceDispatch('rate-limited', true)
      return scopes.map((scope) => ({ scope, ok: false }))
    }
```

   Directly after the `if (fanOut.kind === 'mounted') { … }` block add:

```ts
    if (fanOut.kind === 'rate-limited') {
      traceDispatch('rate-limited', true)
      return scopes.map((scope) => ({ scope, ok: false }))
    }
```

A dispatch that ends this way reports every scope as failed. The session
keeps the post retryable (plan 026 retries it on the next sweep).

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → all pass.

### Step 7: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

`src/packages/clear/tests/throttle.test.ts` (fake `now`):

1. **Open at start.** `blockedForMs()` is `0`.
2. **One 429 blocks for the base period.** After `noteRateLimited()`,
   `blockedForMs()` is `60_000`. After advancing 60 000 ms it is `0`.
3. **Repeated 429s double the period up to the cap.** Second strike 120 000,
   third 240 000, and a tenth strike is `900_000`.
4. **A normal reply resets the strike count but not a running block.** After
   one strike, `noteAnswered()` leaves `blockedForMs()` above 0. The next
   strike blocks for 60 000 again, not 120 000.
5. **`noteReleaseReply`.** Status 429 blocks. Status 200 and status 500 do
   not.

`src/packages/clear/tests/tweet-clear.test.ts`:

6. **Blocked: no click.** A bookmarked post, a throttle with one strike.
   `clearScope` resolves `false`. The control's click spy was not called. The
   trace has one `clear-attempt-fail` with `reason=rate-limited attempts=0`.
   `sleeps` is empty.
7. **Not blocked: unchanged.** The same test with a fresh throttle clicks as
   before.

`src/entrypoints/overlay.content/handlers.test.ts`:

8. **The manual sweep stops at the first blocked check.** Three clearable
   posts and a throttle with one strike. `clearMountedForScope` returns `0`,
   no control was clicked, and the trace has one `clear-sweep-paused`.
9. **A 429 is not a ghost strike.** One post. The witness returns `'error'`
   and the throttle gets a strike during the pace wait (call
   `noteRateLimited()` from the witness fake). The `ghosts` map has no entry
   for the post, and the trace detail contains `reason=rate-limited`.
10. **Another server error still is.** Same test without the strike. The
    ghost count is 1 and the detail contains `reason=mutation-error`.

`src/packages/clear/tests/list-clear.test.ts`:

11. **The list loop ends when blocked.** `blockedForMs` returns `0` on the
    first step and `30_000` on the second. `run()` resolves with
    `reason: 'rate-limited'`, `clearVisibleForPage` was called twice, and the
    scroll returned to the start position.

`src/background/tab-broadcaster.test.ts` (model on the existing mounted
failure tests; one broadcaster instance per test):

12. **A reply with `retryAfterMs` ends the dispatch.** Tab 1 answers
    `{ …clearResp([{ scope: 'bookmark', ok: false }]), retryAfterMs: 60_000 }`.
    The result is all `ok: false`. Tab 2 received nothing. The release tab was
    not navigated. The `clear-dispatch` line contains `outcome=rate-limited`.
13. **The next dispatch inside the window sends nothing.** A second
    `sendClearToTabs` on the same broadcaster sends no `ClearTweetRequest`.
14. **A reply without `retryAfterMs` is unchanged.** The existing mounted
    success path still returns `mounted`.

Verification: `bun run test src/packages/clear/tests src/entrypoints/overlay.content/handlers.test.ts src/background/tab-broadcaster.test.ts`
→ all pass, 14 new tests.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `bun run lint:boundaries` exits 0
- [ ] The 14 new tests exist and pass
- [ ] `rg -n "noteReleaseReply\(releaseThrottle" src/entrypoints/overlay.content/index.tsx` returns 1 match
- [ ] `rg -n "rateLimitedUntil" src/background/tab-broadcaster.ts` returns at least 5 matches
- [ ] `rg -c "retryAfterField\(deps.throttle\)" src/entrypoints/overlay.content/handlers.ts` prints `5`
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `clearMountedForScope` has no `clickAndJudge` function. Plan 025 has not
  landed.
- `handleMutationResponse` does not record with a validated numeric
  `detail.status`.
- `rg -c "_tag: 'ClearTweetResponse'" src/entrypoints/overlay.content/handlers.ts`
  does not print `5`.
- Adding `'rate-limited'` to a reason union breaks an exhaustive switch
  outside the in-scope files.
- Any step appears to need a request to X, a resend, or a response header
  read in the tee.
- You find you need a suppression comment or an `as` cast.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Unknown live behavior, not decided here: the length of X's rate-limit
  window for these two mutations, and whether X also signals a limit inside a
  200 reply (an `errors` array with a rate-limit code). Only HTTP 429 is
  treated as a limit. `RELEASE_THROTTLE_BASE_MS` and
  `RELEASE_THROTTLE_MAX_MS` are named, injectable guesses. Tune them from
  captured `clear-mutation` lines, not from memory.
- The throttle is per page and counts every observed release reply in that
  page, including a click the user made by hand. The worker's
  `rateLimitedUntil` is what stops other tabs.
- No automatic resume. After the back-off, the next user action or the next
  settled download releases again. Posts that failed meanwhile stay at
  `downloaded` and are retried by plan 026 on the next sweep. A timer-driven
  resume is an owner decision.
- The manual loop reads the witness once, 350 ms after the click. A 429 that
  arrives later still blocks the next loop step through the throttle, but that
  one post is traced as `no-flip` and gets one ghost strike. Accepted.
- Deferred: reading X's `x-rate-limit-reset` response header in the tee would
  give the exact resume time. It is observation only, so the design constraint
  allows it. It needs a tee change and a live check that the header exists.
- Plan 028 edits `probeReleaseTab` and `runFanOut` too. Run it after this plan
  and rerun its drift check.
- A reviewer should check that `backoffUntil` is untouched and that no code
  path clicks while `blockedForMs()` is above zero.
