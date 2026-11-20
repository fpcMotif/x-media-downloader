# Plan 028: Bound every release message and keep the hidden release tab's waits on time

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/background/tab-broadcaster.ts src/background/tab-broadcaster.test.ts src/packages/clear src/packages/schema/index.ts src/packages/kernel/sender-guard.ts src/entrypoints/overlay.content/index.tsx src/entrypoints/background.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Plans 024, 025 and 027 change
> `tab-broadcaster.ts` and `index.tsx`; their changes are expected.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/024-gate-release-on-server-reply.md. Run after 025 and 027 when they are planned to run, because they edit the same functions.
- **Category**: bug
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/102

## Why this matters

When no open list tab can release a post, the service worker loads the post's
own page in one hidden tab and asks that page to click. Two things can stall
there.

First, the worker awaits each message to a tab with no time limit. A tab that
is frozen or discarded mid-reply never answers. That one release then waits
forever, and every later permalink release waits behind it in the same queue.

Second, the page's own waits use `setTimeout`. Chrome slows timers in hidden
tabs to at most one per second, and after about five minutes hidden to one per
minute. The page's click-then-poll sequence is written for 200 ms steps. In
the hidden tab it can take many seconds or minutes, which is longer than the
worker's 12 s budget for the whole leg.

After this plan every release message has a deadline, a timeout ends that
dispatch safely without a second click, and a hidden page takes its wait
ticks from the service worker, whose timers are not slowed.

The second fault is inferred from Chrome's documented timer policy. It has not
been measured in this extension. Step 4 adds the measurement, and the new
behavior sits behind one named constant.

## Hard design constraint

The extension never sends X's GraphQL requests itself and never replays
credentials. It only clicks X's own controls and observes X's own requests
through the MAIN-world tee. The new message in this plan travels only between
the extension's content script and its own service worker. Nothing goes to X.

## Vocabulary

- **Clear** (code noun) and **Release** (UI verb): the opt-in un-bookmark or
  un-like after a save.
- **Fan-out**: the worker sends `ClearTweetRequest` to each open X list tab in
  turn.
- **Permalink leg** or **release tab**: one hidden tab (`active: false`) that
  the worker navigates to the post's own page. The worker then sends
  `ClearTweetRequest` to it every 600 ms until the post is mounted. The first
  mounted answer performs the click. This repeated send is the **probe**.
- **Witness**: the in-page log of X's own server replies (plan 024).

`docs/research/2026-09-03-release-root-cause.md` lists this as an open
question: do hidden-tab timers fit the 12 s `RELEASE_POLL_BUDGET_MS`? Its
suggested answer is: "If yes, drive the poll from the service worker (probe
messages)."

## Current state

Files and roles:

- `src/background/tab-broadcaster.ts` — worker dispatch. Has uncommitted
  changes.
- `src/background/tab-broadcaster.test.ts` — its tests, with a fake
  `TabsPort` and `instantClock`.
- `src/background/clear-session.ts` — read-only here. Its `SettleClock`
  (lines 68–79) is the pattern for a cancellable timer port.
- `src/packages/clear/` — pure Clear logic and tests.
- `src/packages/schema/index.ts` — message schemas.
- `src/packages/kernel/sender-guard.ts` — the list of message tags a content
  script may send (`CONTENT_SCRIPT_TAGS`).
- `src/entrypoints/overlay.content/index.tsx` — builds the in-page clicker.
- `src/entrypoints/background.ts` — the worker's message handler table.

Constants (`tab-broadcaster.ts:185-189`): `RELEASE_POLL_INTERVAL_MS = 600`,
`RELEASE_POLL_BUDGET_MS = 12_000`, `RELEASE_UNREACHABLE_MS = 4_000`,
`RELEASE_STUCK_MS = 4_000`, `RELEASE_BACKOFF_MS = 60_000`.

The port and the clock (`tab-broadcaster.ts:76`, `112-114`, `512-515`):

```ts
  sendTabMessage(tabId: number, message: Message | TabMessage): Promise<JsonValue | undefined>
```

```ts
  readonly clock?:
    | { readonly sleep: (ms: number) => Promise<void>; readonly now: () => number }
    | undefined
```

```ts
  const clock = deps.clock ?? {
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }
```

The probe has no deadline (`tab-broadcaster.ts`, `probeReleaseTab`):

```ts
    try {
      const res = asClearTweetResponse(
        await tabs.sendTabMessage(tabId, {
          _tag: 'ClearTweetRequest',
          tweetId,
          scopes,
          allLists,
          ...(asPageScope === undefined ? {} : { asPageScope }),
          ...(probes >= 2 ? { probe: true } : {}),
        }),
      )
      if (res?.mounted === true) return { kind: 'mounted', results: res.results }
      return { kind: 'unmounted', page: res?.page }
    } catch {
      return { kind: 'threw' }
    }
```

Its result type (`tab-broadcaster.ts:232-235`):

```ts
type ProbeResult =
  | { readonly kind: 'threw' }
  | { readonly kind: 'mounted'; readonly results: ReadonlyArray<ClearScopeResult> }
  | { readonly kind: 'unmounted'; readonly page: ReleasePageEvidence | undefined }
```

The poll loop that calls it (`releaseViaStatusTab`, near line 696):

```ts
    while (elapsed < RELEASE_POLL_BUDGET_MS) {
      await clock.sleep(RELEASE_POLL_INTERVAL_MS)
      elapsed = clock.now() - start
      probes++
      const probe = await probeReleaseTab({ tabId, tweetId, scopes, allLists, asPageScope, probes })

      if (probe.kind === 'threw') {
        threw++
```

Every exit of that function traces one folded line built by
`formatReleasePoll` (`tab-broadcaster.ts:272-295`):

```ts
interface ReleasePollSummary {
  readonly tabId: number | undefined
  readonly probes: number
  readonly threw: number
  readonly unmounted: number
  readonly lastPage: ReleasePageEvidence | undefined
  readonly reloaded: boolean
  readonly elapsedMs: number
  readonly reason: ReleasePollReason
}
```

`ReleasePollReason` (line 218) is
`'mounted' | 'exhausted' | 'unreachable' | 'nav-failed' | 'page-error' | 'backoff'`.
The failing exits return `{ ok: false, tabId }`.

The fan-out has no deadline either (`runFanOut`):

```ts
        const res = asClearTweetResponse(
          await tabs.sendTabMessage(id, {
            _tag: 'ClearTweetRequest',
            tweetId,
            scopes,
            allLists,
          }),
        )
        clearOrphanRecord(id)
```

`sendClearToTabs` handles the fan-out result with
`if (fanOut.kind === 'mounted') { traceDispatch('mounted', false); return fanOut.results }`.
A failed dispatch returns `scopes.map((scope) => ({ scope, ok: false }))`.

The cancellable timer pattern to copy (`src/background/clear-session.ts:68-79`):

```ts
export interface SettleClock {
  readonly schedule: (fn: () => void, ms: number) => () => void
}

const realSettleClock: SettleClock = {
  schedule: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
}
```

The in-page clicker gets a plain timer sleep
(`src/entrypoints/overlay.content/index.tsx`, near line 168):

```ts
const { clearScope } = makeTweetClearer({
  document,
  clock: { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
```

Its waits are short and many: 200 ms × 6, then 250 ms steps (see plan 024).

How an existing content-to-worker message is declared. `ReleaseMutationEvent`
is the model. It appears at these places:

- `src/packages/schema/index.ts:596` — the `Schema.TaggedStruct` and its type.
- `src/packages/schema/index.ts:689` — its entry in the `Message` union list.
- `src/packages/kernel/sender-guard.ts:45` — its tag in `CONTENT_SCRIPT_TAGS`.
- `src/entrypoints/background.ts:1962` — its handler,
  `handle<'ReleaseMutationEvent'>(async (msg) => { … })`, in the handler
  table.

The content script sends with `browser.runtime.sendMessage(msg)`
(`index.tsx:383`, inside `postEvent`).

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
- `src/packages/clear/hidden-sleep.ts` (create)
- `src/packages/clear/tests/hidden-sleep.test.ts` (create)
- `src/packages/schema/index.ts`
- `src/packages/kernel/sender-guard.ts`
- `src/entrypoints/overlay.content/index.tsx`
- `src/entrypoints/background.ts`
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/packages/clear/tweet-clear.ts` — it keeps its injected `clock.sleep`.
  Only the function injected into it changes.
- The `ClearTweetRequest` protocol. The first mounted probe still performs
  the click. Do not split it into separate "click" and "check" messages.
- `RELEASE_POLL_BUDGET_MS` and the other poll constants.
- The manual sweep and the "Clear entire list" loop. They run in a tab the
  user is looking at.
- Making the release tab visible or focused.

## Git workflow

- Branch: `advisor/028-drive-release-poll-from-worker`
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

### Step 1: Give every tab message a deadline

Test first. In `src/background/tab-broadcaster.test.ts` add tests 1 to 4 from
"Test plan". Each needs a fake `schedule` that records its callbacks so the
test can fire the deadline by hand, and a `sendTabMessage` that returns a
promise the test never resolves.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → the new
tests FAIL (the `schedule` dep does not exist, and the calls hang).

Then edit `src/background/tab-broadcaster.ts`:

1. Next to the poll constants add:

```ts
export const TAB_MESSAGE_DEADLINE_MS = 20_000
```

2. In `TabBroadcasterDeps`, below `clock`, add:

```ts
  readonly schedule?: ((fn: () => void, ms: number) => () => void) | undefined
```

3. Inside `makeTabBroadcaster`, below the `const clock = …` statement, add:

```ts
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    })

  const sendWithDeadline = (
    tabId: number,
    message: Message | TabMessage,
  ): Promise<JsonValue | undefined | typeof TAB_MESSAGE_TIMED_OUT> =>
    new Promise((resolve, reject) => {
      const cancel = schedule(() => resolve(TAB_MESSAGE_TIMED_OUT), TAB_MESSAGE_DEADLINE_MS)
      tabs.sendTabMessage(tabId, message).finally(cancel).then(resolve, reject)
    })
```

   and at module level, next to the constant from item 1:

```ts
const TAB_MESSAGE_TIMED_OUT = Symbol('tab-message-timed-out')
```

   The deadline uses its own cancellable timer and not `clock.sleep`. The
   tests' `instantClock.sleep` resolves at once, so a race against it would
   time out every existing test.
4. Add `| { readonly kind: 'timed-out' }` to `ProbeResult`. Add
   `'probe-timeout'` to `ReleasePollReason`.
5. In `probeReleaseTab`, send through the helper and return early on a
   timeout. The `try` body becomes:

```ts
      const reply = await sendWithDeadline(tabId, {
        _tag: 'ClearTweetRequest',
        tweetId,
        scopes,
        allLists,
        ...(asPageScope === undefined ? {} : { asPageScope }),
        ...(probes >= 2 ? { probe: true } : {}),
      })
      if (reply === TAB_MESSAGE_TIMED_OUT) return { kind: 'timed-out' }
      const res = asClearTweetResponse(reply)
```

   Keep every line that follows `const res = …` in that `try` as it is
   (plan 027 may have added one).
6. In the poll loop of `releaseViaStatusTab`, directly above
   `if (probe.kind === 'threw') {`, add:

```ts
      if (probe.kind === 'timed-out') {
        trace(
          'clear-release-poll',
          formatReleasePoll({
            tabId,
            probes,
            threw,
            unmounted,
            lastPage,
            reloaded,
            elapsedMs: clock.now() - start,
            reason: 'probe-timeout',
          }),
          tweetId,
        )
        return { ok: false, tabId }
      }
```

   The leg ends. It does not probe again, because the page may still be
   clicking and a second request could click twice.
7. Add `| { readonly kind: 'timed-out' }` to `FanOutOutcome`. In `runFanOut`,
   replace the `const res = asClearTweetResponse(await tabs.sendTabMessage(id, { … }))`
   statement with:

```ts
        const reply = await sendWithDeadline(id, {
          _tag: 'ClearTweetRequest',
          tweetId,
          scopes,
          allLists,
        })
        if (reply === TAB_MESSAGE_TIMED_OUT) {
          answered.push(`${id}:timeout`)
          return { kind: 'timed-out' }
        }
        const res = asClearTweetResponse(reply)
```

8. In `sendClearToTabs`, directly after the
   `if (fanOut.kind === 'mounted') { … }` block, add:

```ts
    if (fanOut.kind === 'timed-out') {
      traceDispatch('tab-timeout', true)
      return scopes.map((scope) => ({ scope, ok: false }))
    }
```

   A list tab that timed out may still click. The dispatch ends here on
   purpose. It does not ask another tab and does not run the permalink leg.
   The post stays retryable.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → all pass.
`rg -n "tabs\.sendTabMessage\(" src/background/tab-broadcaster.ts` → every
remaining hit is inside `sendWithDeadline`, the default port, or a call that
does not send `ClearTweetRequest`.

### Step 2: Add a tested hidden-aware sleep

Create `src/packages/clear/tests/hidden-sleep.test.ts` with tests 5 to 9 from
"Test plan". Import from `'../hidden-sleep'`.

**Verify**: `bun run test src/packages/clear/tests/hidden-sleep.test.ts` →
FAILS (module not found).

Then create `src/packages/clear/hidden-sleep.ts`:

```ts
export const WORKER_TICKS_WHEN_HIDDEN = true
export const WORKER_TICK_MIN_FRACTION = 0.5

export interface HiddenAwareSleepDeps {
  readonly isHidden: () => boolean
  readonly now: () => number
  readonly timerSleep: (ms: number) => Promise<void>
  readonly workerSleep: (ms: number) => Promise<void>
  readonly enabled?: boolean
}

export const makeHiddenAwareSleep = (
  deps: HiddenAwareSleepDeps,
): ((ms: number) => Promise<void>) => {
  const enabled = deps.enabled ?? WORKER_TICKS_WHEN_HIDDEN
  return async (ms) => {
    if (!enabled || !deps.isHidden()) return deps.timerSleep(ms)
    const startedAt = deps.now()
    try {
      await deps.workerSleep(ms)
    } catch {
      return deps.timerSleep(ms)
    }
    const waited = deps.now() - startedAt
    if (waited < ms * WORKER_TICK_MIN_FRACTION) await deps.timerSleep(ms - waited)
  }
}
```

Rules this encodes:

- A visible page keeps the plain timer. Nothing changes for list tabs the
  user is looking at.
- A hidden page asks the worker to wait.
- If the worker cannot be reached, the page falls back to the timer.
- If the worker answers far too early (a missing handler answers at once),
  the page tops the wait up with the timer. The poll can never spin.

**Verify**: `bun run test src/packages/clear/tests/hidden-sleep.test.ts` →
all pass.

### Step 3: Add the tick message and wire both ends

Add a content-to-worker message named `ReleaseTickRequest`. Follow
`ReleaseMutationEvent` at each of its four places listed in "Current state".

1. `src/packages/schema/index.ts`, below the `ReleaseMutationEvent` type:

```ts
export const ReleaseTickRequest = Schema.TaggedStruct('ReleaseTickRequest', {
  ms: Schema.Number,
})
export type ReleaseTickRequest = typeof ReleaseTickRequest.Type
```

   Add `ReleaseTickRequest,` to the `Message` union list, next to
   `ReleaseMutationEvent,`.
2. `src/packages/kernel/sender-guard.ts`: add `'ReleaseTickRequest',` to
   `CONTENT_SCRIPT_TAGS`, next to `'ReleaseMutationEvent',`.
3. `src/entrypoints/background.ts`: near the other module constants add
   `const RELEASE_TICK_MAX_MS = 1_000`. In the handler table, directly after
   the `ReleaseMutationEvent` entry, add:

```ts
  [
    'ReleaseTickRequest',
    handle<'ReleaseTickRequest'>(async (msg) => {
      const waitMs = Math.max(0, Math.min(msg.ms, RELEASE_TICK_MAX_MS))
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
      return { ok: true }
    }),
  ],
```

   Match the bracket and comma style of the neighbouring entries.
4. `src/entrypoints/overlay.content/index.tsx`: import `makeHiddenAwareSleep`
   from the clear package's new root file. Directly above the
   `const { clearScope } = makeTweetClearer({` statement add:

```ts
const releaseSleep = makeHiddenAwareSleep({
  isHidden: () => document.visibilityState === 'hidden',
  now: Date.now,
  timerSleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  workerSleep: async (ms) => {
    await browser.runtime.sendMessage({ _tag: 'ReleaseTickRequest', ms })
  },
})
```

   Then change the clicker's clock line to `clock: { sleep: releaseSleep },`.
   Do not change any other `setTimeout` in the file.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -n "ReleaseTickRequest" src --glob '!**/*.test.ts'` → hits in exactly
these four files: `schema/index.ts`, `kernel/sender-guard.ts`,
`entrypoints/background.ts`, `overlay.content/index.tsx`.
`bun run test src/packages/kernel` → all pass. If a test enumerates
`CONTENT_SCRIPT_TAGS` or the `Message` union and fails, add the new tag to
that test's expected list.

### Step 4: Record how long the slowest probe took

The claim that hidden timers are too slow is not measured yet. Add the
measurement to the line every leg already traces.

In `src/background/tab-broadcaster.ts`:

1. Add `readonly maxProbeMs: number` to `ReleasePollSummary`.
2. In `formatReleasePoll`, destructure `maxProbeMs` and change the last
   template line to
   `` `reloaded=${reloaded} elapsedMs=${elapsedMs} maxProbeMs=${maxProbeMs} reason=${reason}` ``.
3. In `releaseViaStatusTab`, next to `let elapsed = 0` add
   `let maxProbeMs = 0`. Replace the single probe line in the loop with:

```ts
      const probeStartedAt = clock.now()
      const probe = await probeReleaseTab({ tabId, tweetId, scopes, allLists, asPageScope, probes })
      maxProbeMs = Math.max(maxProbeMs, clock.now() - probeStartedAt)
```

4. Add `maxProbeMs,` to every `formatReleasePoll({ … })` call inside the loop
   and after it. The two calls before the loop (reasons `backoff` and
   `nav-failed`) pass `maxProbeMs: 0`. Typecheck lists any call you missed.

Existing tests that compare the whole `clear-release-poll` string need the
new token added to their expected text. Change nothing else in them.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → all pass.
`bun run typecheck` → exit 0.

### Step 5: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

`src/background/tab-broadcaster.test.ts` (model on the existing release-leg
tests; inject `schedule` as a fake that stores `fn` and returns a cancel spy):

1. **A probe that never answers ends the leg.** The release tab's
   `sendTabMessage` returns a promise that never settles. Fire the stored
   deadline callback. `sendClearToTabs` resolves with every scope
   `ok: false`. The `clear-release-poll` line contains `reason=probe-timeout`.
   Exactly one `ClearTweetRequest` was sent to the release tab. Before the
   change this test hangs.
2. **A list tab that never answers ends the dispatch.** One list tab hangs.
   Fire the deadline. The result is every scope `ok: false`, the
   `clear-dispatch` line contains `outcome=tab-timeout`, no other tab was
   asked, and the release tab was not navigated.
3. **An answer cancels its deadline.** A tab answers mounted and ok. The
   cancel spy returned by `schedule` was called once.
4. **A rejected send still cancels and is handled as before.** A tab whose
   `sendTabMessage` rejects is recorded as `no-receiver`, and the cancel spy
   was called.

`src/packages/clear/tests/hidden-sleep.test.ts` (plain fakes, no timers):

5. **Visible: the timer is used.** `isHidden` false. `timerSleep` called with
   the given ms, `workerSleep` not called.
6. **Hidden: the worker is used.** `isHidden` true, `workerSleep` advances the
   fake `now` by the full ms. `timerSleep` not called.
7. **Hidden and the worker rejects: fall back to the timer.** `timerSleep`
   called once with the full ms.
8. **Hidden and the worker answers at once: top up.** `workerSleep` resolves
   without advancing `now`. `timerSleep` called once with the full ms.
9. **`enabled: false` always uses the timer.** Even when hidden.

`index.tsx` and `background.ts` wiring have no unit-test harness. Step 3 is
verified by typecheck, lint and the `rg` check.

Verification: `bun run test src/background/tab-broadcaster.test.ts src/packages/clear/tests/hidden-sleep.test.ts`
→ all pass, 9 new tests.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `bun run lint:boundaries` exits 0
- [ ] The 9 new tests exist and pass
- [ ] `rg -n "sendWithDeadline\(" src/background/tab-broadcaster.ts` returns 2 call sites plus the definition
- [ ] `rg -n "maxProbeMs=" src/background/tab-broadcaster.ts` returns 1 match
- [ ] `rg -n "clock: \{ sleep: releaseSleep \}" src/entrypoints/overlay.content/index.tsx` returns 1 match
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `probeReleaseTab`, `runFanOut` or the poll loop does not match the excerpts
  after allowing for the changes that plans 025 and 027 describe.
- An existing tab-broadcaster test starts timing out after Step 1. The
  deadline must not depend on `clock.sleep`.
- The `handle<…>` helper in `background.ts` does not accept an `async`
  function that returns `{ ok: true }` for a new tag without a cast.
- Adding the message needs a change to the manifest or to a permission.
- The fix appears to need a second click path, a change to the
  `ClearTweetRequest` protocol, or making the release tab visible.
- You find you need a suppression comment or an `as` cast.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Unverified assumption, to check in a real browser before relying on this
  plan: Chrome slows `setTimeout` in a hidden tab but still delivers
  `runtime.sendMessage` replies promptly. Check it with the new `maxProbeMs`
  token. Release a post that is not mounted in any open tab, with the release
  tab hidden for more than five minutes, and read the `clear-release-poll`
  line. A healthy mounted probe should take a few seconds at most. If
  `maxProbeMs` stays large with this plan applied, set
  `WORKER_TICKS_WHEN_HIDDEN` to `false` and report it. The assumption is then
  false and a different design is needed.
- `TAB_MESSAGE_DEADLINE_MS = 20_000` must stay longer than the page's longest
  honest click-and-poll. After plan 024 that is about 3.2 s per scope with
  healthy timers. If `maxProbeMs` in real traces comes near the deadline,
  raise the deadline; do not lower the page's poll counts.
- A timeout fails the dispatch without a retry. The session keeps the post
  retryable, and plan 026 retries it on the next sweep.
- Each hidden-tab tick is one extension message. A release in the hidden tab
  costs about 10 to 20 of them and keeps the service worker awake for that
  time. The worker is already awake while it runs the leg.
- The tick handler caps one wait at `RELEASE_TICK_MAX_MS = 1_000`. The page's
  top-up rule covers a longer request.
- Plans 016 and 021 edit `overlay.content/index.tsx`. Plans 018 and 019 edit
  `background.ts`. Run one at a time and rerun the next plan's drift check.
- A reviewer should check that no code path sends a second
  `ClearTweetRequest` after a timeout, and that the new message carries only
  a number.
