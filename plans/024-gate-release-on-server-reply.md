# Plan 024: Let X's own server reply decide a Release, not the optimistic DOM flip

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/clear/tweet-clear.ts src/packages/clear/mutation-witness.ts src/packages/clear/tests src/entrypoints/inject.content.ts src/entrypoints/overlay.content/index.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none. Plans 025, 026, 027 and 028 depend on this plan.
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/98

## Why this matters

"Release" is the feature that un-bookmarks or un-likes a post after its media
is saved. The extension clicks X's own button and then decides whether the
post really left the list. Today the decision is taken from the page: X flips
the button optimistically, before its server answers, and the code accepts
that flip at once. When the server later rejects the request (rate limit,
error), X rolls the button back, but the extension has already recorded the
post as released and will never retry it. The post stays in the list forever.

A second fault makes the server evidence itself unreliable. The reply log
stamps each reply with the time it was received. A reply to an older request
that arrives after a new click is then counted as the answer to the new click.

After this plan a DOM flip is only tentative while a server reply can still
arrive, the server reply decides when there is one, and a reply is matched to
a click by the time its request started.

## Hard design constraint

The extension never sends X's GraphQL requests itself and never replays
credentials. It only clicks X's own controls and observes X's own requests
through the MAIN-world tee. Nothing in this plan may add a `fetch` or XHR to
X, read a token or cookie, or resend a request. The tee only reads.

## Vocabulary

- **Clear** is the code noun and **Release** is the UI verb for the same
  thing: the opt-in un-bookmark or un-like after a save.
- **Tee**: `src/entrypoints/inject.content.ts`. It runs in the page's MAIN
  world, wraps `fetch` and `XMLHttpRequest`, and copies the responses of
  tracked requests into DOM events. It never changes a request.
- **Witness**: `src/packages/clear/mutation-witness.ts`. A bounded in-page log
  of X's own `UnfavoriteTweet` and `DeleteBookmark` replies that the tee saw.
  `outcome(tweetId, scope, sinceT)` returns `'ok'`, `'error'` or `'none'`.
- **Flip**: the post's active control (un-bookmark or un-like) is gone from
  the DOM, or the row detached.

`docs/research/2026-09-03-release-root-cause.md` sets the intended precedence:
(1) server mutation ok means cleared with `arm=mutation`, (2) server error
means failed with `reason=mutation-error`, (3) no server evidence means the
DOM flip is the fallback. `docs/state-machines.md` section 4.6 states the
witness invariant: "only a reply newer than the click counts".

## Current state

Files and roles:

- `src/packages/clear/tweet-clear.ts` — the in-page clicker. `clearScope`
  clicks and then polls. Clean in git at planning time.
- `src/packages/clear/mutation-witness.ts` — the witness. Clean in git.
- `src/packages/clear/tests/tweet-clear.test.ts` and
  `src/packages/clear/tests/mutation-witness.test.ts` — their tests.
- `src/entrypoints/inject.content.ts` — the tee. Clean in git. It has no test
  file.
- `src/entrypoints/overlay.content/index.tsx` — the content script. It listens
  for the tee's event and records into the witness. It had uncommitted changes
  at planning time.

The bug (`src/packages/clear/tweet-clear.ts:262-313`). The witness is read
first on each tick. When it says `'none'` and the DOM has flipped, the function
returns `true` at once:

```ts
  async function pollDomFlip(input: ClearFlipPollRecord): Promise<boolean | null> {
    const { article, tweetId, scope, origin, clickedAt, targetKind, disabled } = input
    // oxlint-disable no-await-in-loop -- sequential poll with a fixed cap
    for (let i = 1; i <= FLIP_POLL_ATTEMPTS; i++) {
      await clock.sleep(FLIP_POLL_INTERVAL_MS)
      if (witness) {
        const verdict = witness.outcome(tweetId, scope, clickedAt)
        if (verdict === 'error') {
          traceAttemptFail({
            tweetId,
            scope,
            reason: 'mutation-error',
            attempts: i,
            article,
            click: { target: targetKind, disabled },
            origin,
          })
          return false
        }
        if (verdict === 'ok') {
          traceFlip({
            article,
            tweetId,
            scope,
            attempt: i,
            target: targetKind,
            disabled,
            origin,
            armOverride: 'mutation',
          })
          if (onFlip) onFlip(tweetId, scope, origin)
          return true
        }
      }
      if (!flipConfirmed(article, scope)) continue
      if (log) log(scope, `→ flip confirmed after ${i * FLIP_POLL_INTERVAL_MS}ms`)
      const { arm, reresolved } = classifyFlip(document, article, tweetId, scope)
      traceFlip({ article, tweetId, scope, attempt: i, target: targetKind, disabled, origin })
      // (six comment lines here, unchanged by this plan)
      if (arm === 'detached' && (reresolved === 'member' || reresolved === 'ambiguous'))
        return false
      if (onFlip) onFlip(tweetId, scope, origin)
      return true
    }
    // oxlint-enable no-await-in-loop
    return null
  }
```

Constants (`tweet-clear.ts:56-66`): `FLIP_POLL_INTERVAL_MS = 200`,
`FLIP_POLL_ATTEMPTS = 6`, `EXTRA_WITNESS_POLL_INTERVAL_MS = 250`,
`EXTRA_WITNESS_POLL_ATTEMPTS = 4`.

The trace helpers already accept overrides (`tweet-clear.ts:162-174`, `208-240`):

```ts
  interface ClearFlipRecord {
    readonly article: Element
    readonly tweetId: string
    readonly scope: MembershipScope
    readonly attempt: number
    readonly target: 'button' | 'testid-node'
    readonly disabled: boolean
    readonly origin: ClearOrigin
    readonly armOverride?: 'mutation' | undefined
    readonly elapsedMsOverride?: number | undefined
  }
```

```ts
    const detail = `scope=${scope} arm=${arm} attempt=${attempt} elapsedMs=${elapsedMs} target=${target} disabled=${disabled} reresolved=${reresolved} origin=${origin}`
    trace('clear-flip', detail, tweetId)
```

`traceAttemptFail` takes `{ tweetId, scope, reason, attempts, article, click, origin, elapsedMsOverride? }`.

The click site (`tweet-clear.ts:444-455`):

```ts
    const clickedAt = now()
    target.click()
    const primary = await pollDomFlip({
```

The witness (`src/packages/clear/mutation-witness.ts:18-24`, `70-88`):

```ts
export interface MutationWitnessEvent {
  readonly tweetId: string
  readonly op: ReleaseMutationOp
  readonly status: number
  readonly error: boolean
  readonly t: number
}
```

```ts
  function record(ev: MutationWitnessEvent): void {
    const key = `${ev.tweetId}:${ev.op}`
    events.delete(key)
    events.set(key, ev)
    if (events.size > capacity) {
      const oldest = events.keys().next().value
      if (oldest !== undefined) events.delete(oldest)
    }
  }

  function outcome(
    tweetId: string,
    scope: MembershipScope,
    sinceT: number,
  ): 'ok' | 'error' | 'none' {
    const ev = events.get(`${tweetId}:${CONFIRMING_OP[scope]}`)
    if (ev === undefined || ev.t < sinceT) return 'none'
    return ev.status === 200 && !ev.error ? 'ok' : 'error'
  }
```

`t` is the time the overlay received the reply
(`src/entrypoints/overlay.content/index.tsx`, inside `handleMutationResponse`,
near line 1905: `const t = Date.now()` then
`mutationWitness.record({ tweetId, op, status: detail.status, error, t })`).

The tee emits no request start time (`src/entrypoints/inject.content.ts:105-115`):

```ts
    const emitMutation = (
      path: string,
      status: number,
      body: string,
      requestBody: string | null,
    ): void => {
      if (import.meta.env.DEV) console.debug(`[XMD] tee mutation · path=${path} · status=${status}`)
      document.dispatchEvent(
        new CustomEvent('xmd:mutation-response', { detail: { path, status, body, requestBody } }),
      )
    }
```

The tee's fetch wrapper (`inject.content.ts:197-198`, `222-236`):

```ts
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const promise = origFetch(input, init)
```

```ts
        if (isMutationUrl(reqUrl)) {
          const requestBody = isStringInitBody(init?.body) ? init.body : null
          void promise
            .then((res) =>
              readTeeBody(res).then((body) => {
                if (body === null) return
                if (requestBody !== null && !withinTeeBudget(requestBody, 'fetch mutation request'))
                  return
                emitMutation(
                  new URL(reqUrl, location.origin).pathname,
                  res.status,
                  body,
                  requestBody,
                )
              }),
            )
```

The tee's XHR path keeps the request body in a WeakMap set in `send`
(`inject.content.ts:121`, `167-183`, `189-192`):

```ts
    const xhrMutationBody = new WeakMap<XMLHttpRequest, string>()
```

```ts
                emitMutation(new URL(this.responseURL).pathname, this.status, body, requestBody)
```

```ts
      override send(body?: Document | XMLHttpRequestBodyInit | null): void {
        if (isStringXhrBody(body)) xhrMutationBody.set(this, body)
        super.send(body)
      }
```

Mutation replies share one read budget with media captures
(`inject.content.ts:56`, `66-73`). The budget allows 4 reads in flight. When 4
media reads are running, a mutation reply is dropped and the witness sees
nothing:

```ts
    const teeBudget = makeTeeBudget()
```

```ts
    const readTeeBody = async (res: Response): Promise<string | null> => {
      const lease = teeBudget.acquire()
      if (!lease) {
        emitDrop('in-flight-cap')
```

The event type is declared in `index.tsx` (near line 122) as
`'xmd:mutation-response': CustomEvent<{ path; status; body; requestBody }>`
with every field typed `JsonValue`. The handler validates each field with
`isString` and `isNumber` before use.

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
code below deliberately has no comments.

One consequence matters here. The lint rule `no-await-in-loop` is on, and you
may not add a disable comment. A new function that waits several times must
recurse instead of looping. `src/background/remote-upload.ts:317-338`
(`reconcileNext`) is the existing example. Code you edit inside an existing
`// oxlint-disable no-await-in-loop` region is fine.

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

- `src/packages/clear/mutation-witness.ts`
- `src/packages/clear/tests/mutation-witness.test.ts`
- `src/packages/clear/tweet-clear.ts`
- `src/packages/clear/tests/tweet-clear.test.ts`
- `src/entrypoints/inject.content.ts`
- `src/entrypoints/overlay.content/index.tsx`
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/entrypoints/overlay.content/handlers.ts` — the manual sweep reads the
  witness once after a 350 ms pace. Plan 027 changes that path.
- `src/packages/clear/correlate.ts` — it counts only the `testid`, `detached`
  and `already-cleared` arms, so `arm=mutation` flips are uncounted in the
  correlation summary. That is a separate reporting change.
- `src/core/adapters/x/tracked-mutation.ts` — the op matcher and the error
  signal reader do not change.
- The media branch of the tee (`xmd:media-response`). Plans 016 and 021 own it.
- Any `fetch(Request)` body capture. See Maintenance notes.

## Git workflow

- Branch: `advisor/024-gate-release-on-server-reply`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `fix(clear): …` here.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. Never revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists: those files already hold uncommitted changes.
  At planning time that was `src/entrypoints/overlay.content/index.tsx`.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path.

## Steps

### Step 1: Make the witness match a reply to a click by request start time

Test first. In `src/packages/clear/tests/mutation-witness.test.ts`:

1. Add `startedAt` to every existing `record({...})` call. Give it the same
   value as that call's `t`. The existing tests keep their meaning.
2. Add the tests in "Test plan" items 1 to 4.

**Verify**: `bun run test src/packages/clear/tests/mutation-witness.test.ts` →
FAILS (type error on `startedAt`, and the new tests fail).

Then edit `src/packages/clear/mutation-witness.ts`:

1. Add one field to `MutationWitnessEvent`, below `t`:

```ts
  readonly startedAt: number
```

2. In `record`, keep the stored event when it belongs to a later request.
   Insert this as the first two statements after `const key = …`:

```ts
    const stored = events.get(key)
    if (stored !== undefined && stored.startedAt > ev.startedAt) return
```

3. In `outcome`, change the gate from `ev.t < sinceT` to
   `ev.startedAt < sinceT`.
4. Export a pure helper below `CONFIRMING_OP`:

```ts
export const resolveMutationStartedAt = (
  reported: number | undefined,
  receivedAt: number,
): number =>
  reported !== undefined && Number.isFinite(reported) && reported <= receivedAt
    ? reported
    : receivedAt
```

Do not edit the comments in this file. Some will be out of date. They are
listed in Maintenance notes.

**Verify**: `bun run test src/packages/clear/tests/mutation-witness.test.ts` →
all pass. `rg -n "\.record\(\{" src --glob '!**/*.test.ts'` → exactly one hit,
in `src/entrypoints/overlay.content/index.tsx`. Typecheck fails on that hit
until Step 3. That is expected.

### Step 2: Stamp the request start time in the tee

In `src/entrypoints/inject.content.ts`:

1. Give `emitMutation` a fifth parameter `startedAt: number` and add it to the
   event detail: `{ detail: { path, status, body, requestBody, startedAt } }`.
2. In the fetch wrapper, add `const startedAt = Date.now()` as the first
   statement of the `window.fetch = (…) => {` body, directly above
   `const promise = origFetch(input, init)`. Pass `startedAt` as the fifth
   argument of the `emitMutation(` call in the mutation branch.
3. Directly below the `xhrMutationBody` declaration add:

```ts
    const xhrMutationStartedAt = new WeakMap<XMLHttpRequest, number>()
```

4. In `send`, add `xhrMutationStartedAt.set(this, Date.now())` as the first
   statement.
5. In the XHR mutation `load` listener, pass
   `xhrMutationStartedAt.get(this) ?? Date.now()` as the fifth argument of
   `emitMutation(`. On the line after the existing `xhrMutationBody.delete(this)`
   add `xhrMutationStartedAt.delete(this)`.
6. Give mutation replies their own read budget, so busy media captures cannot
   drop them. Directly below `const teeBudget = makeTeeBudget()` add
   `const mutationTeeBudget = makeTeeBudget()`. Change `readTeeBody` to
   `async (res: Response, budget = teeBudget): Promise<string | null>` and use
   `budget.acquire()` inside it. In the fetch mutation branch call
   `readTeeBody(res, mutationTeeBudget)`. Leave the media branch call as
   `readTeeBody(res)`.

The tee still only reads. It adds no request and changes none.

**Verify**: `rg -ci "startedat" src/entrypoints/inject.content.ts` → prints `8`
or more. `rg -n "mutationTeeBudget" src/entrypoints/inject.content.ts` → 2
matches. `rg -n "origFetch\(" src/entrypoints/inject.content.ts` → still
exactly 1 match.

### Step 3: Carry the start time from the event into the witness

In `src/entrypoints/overlay.content/index.tsx`:

1. In the `DocumentEventMap` declaration for `'xmd:mutation-response'`, add
   `startedAt: JsonValue` next to `requestBody`, in the same style.
2. Import `resolveMutationStartedAt` next to the existing
   `makeMutationWitness` import.
3. In `handleMutationResponse`, directly after `const t = Date.now()`, add:

```ts
      const startedAt = resolveMutationStartedAt(
        isNumber(detail.startedAt) ? detail.startedAt : undefined,
        t,
      )
```

   Match the indentation of the surrounding lines.
4. Change the record call to
   `mutationWitness.record({ tweetId, op, status: detail.status, error, t, startedAt })`.

Do not change the `ReleaseMutationEvent` that is forwarded to the worker.

**Verify**: `bun run typecheck` → exit 0.

### Step 4: Make a DOM flip tentative while the server can still answer

Test first. In `src/packages/clear/tests/tweet-clear.test.ts` add the tests in
"Test plan" items 5 to 9. The file already has a `scriptedWitness` helper
(near line 582), a `makeClock()` helper that records `sleeps`, and tests that
flip the DOM after a click. Find one with
`rg -n "flip" src/packages/clear/tests/tweet-clear.test.ts` and reuse its way
of flipping the DOM.

**Verify**: `bun run test src/packages/clear/tests/tweet-clear.test.ts` →
the new tests FAIL. Test 5 fails because `clearScope` returns `true`.

Then edit `src/packages/clear/tweet-clear.ts`:

1. Below the `EXTRA_WITNESS_POLL_ATTEMPTS` constant add:

```ts
const WITNESS_GRACE_POLL_INTERVAL_MS = 250
const WITNESS_GRACE_POLL_ATTEMPTS = 8
```

2. In `TweetClearerDeps` add an optional field, in the style of the others:

```ts
  readonly witnessGraceAttempts?: number | undefined
```

   Read it where the other deps are destructured, with the default
   `witnessGraceAttempts = WITNESS_GRACE_POLL_ATTEMPTS`.
3. In `ClearFlipRecord` add `readonly witnessSilent?: boolean | undefined`.
   In `traceFlip`, destructure it and append one token to `detail`. The line
   becomes:

```ts
    const detail = `scope=${scope} arm=${arm} attempt=${attempt} elapsedMs=${elapsedMs} target=${target} disabled=${disabled} reresolved=${reresolved} origin=${origin}${witnessSilent === true ? ' witness=none' : ''}`
```

4. Add this function directly above `pollDomFlip`. It recurses because a new
   loop with `await` would need a lint suppression:

```ts
  async function awaitWitnessAfterFlip(
    activeWitness: Pick<MutationWitness, 'outcome'>,
    input: ClearFlipPollRecord,
    flipAttempt: number,
    graceAttempt: number,
  ): Promise<'ok' | 'error' | 'none'> {
    if (graceAttempt > witnessGraceAttempts) return 'none'
    const { article, tweetId, scope, origin, clickedAt, targetKind, disabled } = input
    await clock.sleep(WITNESS_GRACE_POLL_INTERVAL_MS)
    const verdict = activeWitness.outcome(tweetId, scope, clickedAt)
    if (verdict === 'none')
      return awaitWitnessAfterFlip(activeWitness, input, flipAttempt, graceAttempt + 1)
    const attempts = flipAttempt + graceAttempt
    const elapsedMs =
      flipAttempt * FLIP_POLL_INTERVAL_MS + graceAttempt * WITNESS_GRACE_POLL_INTERVAL_MS
    if (verdict === 'error') {
      traceAttemptFail({
        tweetId,
        scope,
        reason: 'mutation-error',
        attempts,
        article,
        click: { target: targetKind, disabled },
        origin,
        elapsedMsOverride: elapsedMs,
      })
      return 'error'
    }
    traceFlip({
      article,
      tweetId,
      scope,
      attempt: attempts,
      target: targetKind,
      disabled,
      origin,
      armOverride: 'mutation',
      elapsedMsOverride: elapsedMs,
    })
    if (onFlip) onFlip(tweetId, scope, origin)
    return 'ok'
  }
```

   `ClearFlipPollRecord` is declared just above `pollDomFlip`. If the type is
   not visible at your insertion point, insert the function directly below
   `pollDomFlip` instead. Function declarations hoist.
5. In `pollDomFlip`, change only the lines from
   `const { arm, reresolved } = classifyFlip(…)` to the final `return true`.
   Keep the six comment lines exactly as they are and in the same place,
   directly above the refusal `if`. The result:

```ts
      const { arm, reresolved } = classifyFlip(document, article, tweetId, scope)
      const refused = arm === 'detached' && (reresolved === 'member' || reresolved === 'ambiguous')
      const tentative = witness !== undefined && !refused
      if (witness && tentative) {
        const settled = await awaitWitnessAfterFlip(witness, input, i, 1)
        if (settled !== 'none') return settled === 'ok'
      }
      traceFlip({
        article,
        tweetId,
        scope,
        attempt: i,
        target: targetKind,
        disabled,
        origin,
        ...(tentative ? { witnessSilent: true } : {}),
      })
      // (the six existing comment lines stay here, unchanged)
      if (refused) return false
      if (onFlip) onFlip(tweetId, scope, origin)
      return true
```

   If `witness` is not typed as possibly `undefined` in this file, use the
   condition the file already uses (`if (witness)`) and derive `tentative`
   from it. Do not add a cast.

Behavior after this step:

- No witness supplied: unchanged. The flip is accepted on the same tick and
  the trace line has no `witness=` token.
- Witness supplied, server replies ok inside the grace: `true`, `arm=mutation`.
- Witness supplied, server replies with an error inside the grace: `false`,
  `reason=mutation-error`, no `clear-flip` line, `onFlip` not called.
- Witness supplied, no reply inside the grace (8 × 250 ms = 2 s by default):
  the DOM verdict is accepted as before, and the `clear-flip` line ends with
  ` witness=none`.

Some existing tests supply a witness that returns `'none'` while the DOM
flips. They now see up to 8 extra `250` entries in `sleeps` and a trailing
` witness=none` token. Update only those expectations. Do not change a test
that supplies no witness. If such a test fails, that is a STOP condition.

**Verify**: `bun run test src/packages/clear/tests/tweet-clear.test.ts` → all
pass. `bun run test src/packages/clear/tests` → all pass (this covers
`correlate.test.ts` and `diagnostics.test.ts`, which parse trace lines).

### Step 5: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

`src/packages/clear/tests/mutation-witness.test.ts` (extend the existing file):

1. **A reply to a request that started before the click does not count.**
   Record `{ status: 200, error: false, t: 150, startedAt: 90 }`. Then
   `outcome(id, 'bookmark', 100)` is `'none'`. Before the change it is `'ok'`.
2. **A reply to a request that started at or after the click counts.** Same
   event with `startedAt: 100` gives `'ok'`. With `status: 429` it gives
   `'error'`.
3. **A late reply to an older request does not hide a newer one.** Record
   `startedAt: 120, status: 200`, then record `startedAt: 90, status: 500`.
   `outcome(id, 'bookmark', 100)` is `'ok'`.
4. **`resolveMutationStartedAt`.** `(90, 100)` is `90`. `(undefined, 100)` is
   `100`. `(130, 100)` is `100`. `(Number.NaN, 100)` is `100`.

`src/packages/clear/tests/tweet-clear.test.ts` (extend; model on the existing
`scriptedWitness` tests near line 591):

5. **Server error after an optimistic flip fails the release.** The DOM flips
   on poll 1. The witness returns `'none'`, `'none'`, then `'error'`.
   `clearScope` resolves `false`. `trace` has one call, stage
   `clear-attempt-fail`, detail containing `reason=mutation-error`. `onFlip`
   is not called. This is the regression test for the bug.
6. **Server ok after an optimistic flip confirms with `arm=mutation`.** Same
   setup with `'ok'` third. Resolves `true`. One `clear-flip` call containing
   `arm=mutation` and not containing `witness=none`. `onFlip` called once.
7. **A silent witness falls back to the DOM and says so.** The witness always
   returns `'none'`. Resolves `true`. `sleeps` equals `[200, 250, 250, 250,
   250, 250, 250, 250, 250]`. The `clear-flip` detail ends with
   `witness=none`.
8. **No witness: unchanged.** No `witness` dep. The DOM flips on poll 1.
   Resolves `true`, `sleeps` equals `[200]`, and the detail does not contain
   `witness=`.
9. **`witnessGraceAttempts: 0` disables the wait.** With an always-`'none'`
   witness, `sleeps` equals `[200]` and the detail ends with `witness=none`.

The tee and the overlay wiring have no unit-test harness. Steps 2 and 3 are
verified by typecheck and the `rg` checks.

Verification: `bun run test src/packages/clear/tests/mutation-witness.test.ts src/packages/clear/tests/tweet-clear.test.ts`
→ all pass, 9 new tests.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `bun run lint:boundaries` exits 0
- [ ] The 9 new tests exist and pass
- [ ] `rg -n "ev\.t < sinceT" src/packages/clear/mutation-witness.ts` returns no matches
- [ ] `rg -n "awaitWitnessAfterFlip" src/packages/clear/tweet-clear.ts` returns 3 matches (declaration, recursion, call)
- [ ] `rg -n "origFetch\(" src/entrypoints/inject.content.ts` returns exactly 1 match
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git diff -U0 -- src/entrypoints/inject.content.ts | rg "^\+.*(fetch\(|\.open\(|\.send\(|cookie|authorization)" -i` returns no matches other than the unchanged `super.send(body)` context
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `pollDomFlip`, `record`, `outcome`, `emitMutation` or the fetch mutation
  branch does not match the excerpts.
- A test that supplies no witness changes behavior after Step 4.
- A test outside `tweet-clear.test.ts` and `mutation-witness.test.ts` fails
  because it parses a `clear-flip` line and rejects the trailing
  `witness=none` token.
- You find you need a new loop with `await`, a suppression comment, or an `as`
  cast to finish a step.
- Any step appears to need a request to X, a cloned `Request`, or access to a
  header, token or cookie. The design constraint forbids all of these.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Cost when the witness is blind. If the tee sees no reply (for example X
  sends the mutation with a `Request` object, so the request body and the
  tweet id are not captured), every release waits the full 2 s grace and then
  takes the DOM verdict, exactly as today. The `witness=none` token on
  `clear-flip` makes that visible. Count those lines in a real session before
  tuning `WITNESS_GRACE_POLL_ATTEMPTS`.
- Unknown live behavior, not decided here: how long X takes between the click
  and the server reply, and whether X ever answers after the 2 s grace. The
  grace is an injectable constant for that reason. Do not shorten it without a
  measured sample of `elapsedMs` on `arm=mutation` lines.
- Unknown live behavior, not decided here: the reply X gives for a post that
  is already released. If it is a 200 with an `errors` array, the witness
  reads it as `'error'`. That is fail-closed and leaves the post retryable.
- Deferred: the `fetch(Request)` body gap at `inject.content.ts:223`. Reading
  it means cloning the page's `Request`, which can disturb the page. It needs
  live evidence that X uses that form first.
- Deferred: `src/packages/clear/correlate.ts:120` does not count the
  `mutation` arm.
- Deferred: the manual sweep in `handlers.ts` still reads the witness once.
  Plan 027 handles it.
- Stale comments this plan may not edit. Report them to the owner: the module
  doc at `tweet-clear.ts:21-29` and the comment above `pollDomFlip`
  (`242-251`) describe the old "DOM flip wins on the tick" rule. The comment
  at `mutation-witness.ts:62-67` says a newer record always overwrites. The
  field doc at `mutation-witness.ts:29-33` says "observed at or after
  `sinceT`"; it is now "started at or after". The trust comment near
  `index.tsx:1860-1873` predates `startedAt`.
- Plans 016 and 021 also edit `src/entrypoints/overlay.content/index.tsx`.
  Run them one at a time with this plan and rerun the next plan's drift check
  after each lands. Plan 021 treats `inject.content.ts` as read-only, so there
  is no conflict there.
- A reviewer should check two things: the no-witness path is byte-identical,
  and the tee diff adds no request.
