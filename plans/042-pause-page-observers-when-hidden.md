# Plan 042: Pause the saved-status sweep in hidden tabs and stop it from re-asking known posts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/entrypoints/overlay.content/handlers.ts src/entrypoints/overlay.content/handlers.test.ts src/entrypoints/overlay.content/index.tsx src/entrypoints/inject.content.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. Plans 012, 013, 016 and 021 also edit `src/entrypoints/overlay.content/index.tsx`. Run them one at a time and rerun this drift check after each lands. Run this plan before plan 007, which splits that file.
- **Category**: perf
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/116

## Why this matters

On X's home and List timelines the content script paints a "Saved ✓" chip on
posts that were already downloaded. A `MutationObserver` on `document.body`
restarts a 500 ms timer on every DOM change. Each sweep reads every mounted
post and sends all their ids to the service worker. Three things waste work:

1. The sweep keeps running while the tab is hidden. Each sweep wakes the
   service worker.
2. Painting a chip is itself a DOM change, so every sweep that paints causes
   one more full sweep.
3. Every sweep re-asks about posts that already have a chip and posts the
   worker answered "not saved" a moment ago.

After this plan the sweep stops while the tab is hidden, ignores its own chip
insertions, and asks only about posts it has no recent answer for. The gain is
an estimate from reading the code. It was not measured.

This plan also adds one missing rejection handler in the page-world tee (Step 5).

## Current state

Files and roles:

- `src/entrypoints/overlay.content/handlers.ts` — holds `sweepSavedStatus`,
  `markArticleSaved`, and the chip class constant.
- `src/entrypoints/overlay.content/handlers.test.ts` — tests. The block
  `describe('sweepSavedStatus — Saved ✓ chip', …)` starts near line 1247.
- `src/entrypoints/overlay.content/saved-status-lifecycle.ts` — owns the
  observer, the debounce timer, and the in-flight sweep. This plan does not
  edit it.
- `src/entrypoints/overlay.content/index.tsx` — the content script. It wires
  the lifecycle.
- `src/entrypoints/inject.content.ts` — the page-world (MAIN world) tee.

The chip and the sweep (`src/entrypoints/overlay.content/handlers.ts:291`, `:308-346`):

```ts
const SAVED_CHIP_CLASS = 'xdl-saved-chip'
```

```ts
function markArticleSaved(article: Element, doc: Document): void {
  if (article.querySelector(`.${SAVED_CHIP_CLASS}`) !== null) return
  // Give the chip a positioning context without disturbing X's own layout classes.
  if (article instanceof HTMLElement && article.style.position === '') {
    article.style.position = 'relative'
  }
  const chip = doc.createElement('div')
  chip.className = SAVED_CHIP_CLASS
  chip.textContent = 'Saved ✓'
  chip.setAttribute('aria-label', 'Already downloaded')
  article.appendChild(chip)
}
```

```ts
export async function sweepSavedStatus(deps: {
  readonly document: Document
  readonly inScope: () => boolean
  readonly requestSavedStatus: (tweetIds: string[]) => Promise<string[]>
}): Promise<void> {
  if (!deps.inScope()) return
  const byTweet = new Map<string, Element>()
  for (const article of deps.document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const tweetId = tweetIdOfArticle(article)
    if (Option.isNone(tweetId) || byTweet.has(tweetId.value)) continue
    byTweet.set(tweetId.value, article)
  }
  if (byTweet.size === 0) return
  const saved = await deps.requestSavedStatus([...byTweet.keys()])
  // The route/setting may have changed while the request was in flight — never
  // paint chips after scope was lost.
  if (!deps.inScope()) return
  for (const tweetId of saved) {
    const article = byTweet.get(tweetId)
    if (article !== undefined) markArticleSaved(article, deps.document)
  }
}
```

The lifecycle observes `childList` and `subtree` only
(`saved-status-lifecycle.ts:94-97`), and a mutation during a running sweep
marks one rerun (`:55-60`):

```ts
    if (observer === null) {
      observer = deps.makeObserver(schedule)
      observer.observe(deps.root, { childList: true, subtree: true })
    }
```

```ts
  const schedule = (): void => {
    if (disposed || !deps.isActive()) return
    if (running) {
      rerun = true
      return
    }
```

An inactive `sync()` already disconnects the observer and cancels the timer
(`saved-status-lifecycle.ts:88-93`). The test file
`saved-status-lifecycle.test.ts` pins this ("active → inactive transition
disconnects and cancels").

The wiring (`src/entrypoints/overlay.content/index.tsx`, near lines 1028-1049):

```ts
    const savedStatusIsActive = (): boolean =>
      savedStatusAlive &&
      adapter.platform === 'x' &&
      savedStatusVisible(savedStatusCommittedPath ?? location.pathname, savedStatusOn)
    const savedStatusLifecycle = makeSavedStatusLifecycle({
      isActive: savedStatusIsActive,
      root: document.body,
      delayMs: SAVED_SWEEP_DEBOUNCE_MS,
      makeObserver: (notify) => new MutationObserver(notify),
      clock: {
        after: (ms, run) => {
          const t = setTimeout(run, ms)
          return () => clearTimeout(t)
        },
      },
      sweep: () =>
        sweepSavedStatus({
          document,
          inScope: savedStatusIsActive,
          requestSavedStatus,
        }),
    })
```

The only visibility listener (`index.tsx`, near lines 1979-1983):

```ts
    // Don't lose a sub-debounce batch when the tab is navigated away or unloaded.
    ctx.addEventListener(window, 'pagehide', flushCaptures)
    ctx.addEventListener(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushCaptures()
    })
```

`requestSavedStatus` returns `[]` when the message fails (`index.tsx:213-219`).

Late hits are pushed separately: the worker sends `SavedStatusUpdate` when a
cross-device lookup or a finished download marks a post saved, and
`handleSavedStatusUpdate` (`handlers.ts:352-365`) chips it. So a short
overlay-side memory of "not saved" answers cannot hide a new save for long.

The tee's unguarded promise (`src/entrypoints/inject.content.ts:208-220`):

```ts
          void promise.then((res) => {
            if (res.ok) {
              void readTeeBody(res)
                .then((body) => {
                  if (body !== null) emit(new URL(reqUrl, location.origin).pathname, body)
                })
                .catch(() => {})
            } else if (import.meta.env.DEV) {
              console.debug(
                `[XMD] tee fetch non-ok · ${adapter.platform} · status=${res.status} · ${reqUrl}`,
              )
            }
          })
```

`promise` is the page's own `fetch` result. When the page aborts that fetch,
the derived promise from `.then` rejects with no handler. The browser reports
an unhandled rejection in the page. The mutation branch a few lines below
already ends with `.catch(() => { … })`.

Findings that this plan does not act on, after reading the code:

- The auto-reveal and stub-collapse observers (`index.tsx`, near lines
  955-1000) only set a flag and call `ctx.requestAnimationFrame`. A hidden tab
  does not run animation frames, so their scan already waits until the tab is
  visible. Leave them alone.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Named constants, not magic numbers.
- `for...of` over `.forEach()`.
- Tests are vitest with happy-dom. Assertions live inside `it()`.

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
| Focused tests | `bun run test <path/to/file.test.ts>`   | all pass            |
| Full gate     | `bun run check`                         | exit 0              |
| Build         | `bun run build`                         | exit 0              |

The package manager is bun. Never use npm or npx. If `bun run fmt:check` fails
only on files you edited, run `bunx oxfmt --write <those files>` and re-check.

## Scope

**In scope** (the only files you should modify):

- `src/entrypoints/overlay.content/handlers.ts`
- `src/entrypoints/overlay.content/handlers.test.ts`
- `src/entrypoints/overlay.content/index.tsx`
- `src/entrypoints/inject.content.ts` (Step 5 only, one line)
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/entrypoints/overlay.content/saved-status-lifecycle.ts` and its test.
  The lifecycle already handles an inactive `sync()`.
- `setAutoReveal`, `setStubCollapse`, and their observers.
- `handleSavedStatusUpdate` and `markArticleSaved`.
- `src/background/saved-status.ts` and `src/packages/sync/saved-index.ts`
  (the worker side).
- Any other part of `inject.content.ts`. Plans 016 and 021 read it and other
  plans may edit it.

## Git workflow

- Branch: `advisor/042-pause-page-observers-when-hidden`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `perf(overlay): …` and `fix(tee): …` here.
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

In `src/entrypoints/overlay.content/handlers.test.ts`, add the tests in
"Test plan" items 1–5. Put items 1–3 inside
`describe('sweepSavedStatus — Saved ✓ chip', …)` and reuse its way of building
articles. Put items 4–5 in a new `describe('isOnlySavedChipMutation', …)`
block. Import `isOnlySavedChipMutation` next to the existing
`sweepSavedStatus` import.

**Verify**: `bun run test src/entrypoints/overlay.content/handlers.test.ts` →
the new tests FAIL. The existing tests pass.

### Step 2: Ask only about posts with no recent answer

In `src/entrypoints/overlay.content/handlers.ts`:

1. Next to `SAVED_CHIP_CLASS`, add:

```ts
const SAVED_UNSAVED_MEMO_MS = 60_000
const SAVED_UNSAVED_MEMO_CAP = 2_000
```

2. Change `sweepSavedStatus` to this shape. Keep the two existing comments
   where they are:

```ts
export async function sweepSavedStatus(deps: {
  readonly document: Document
  readonly inScope: () => boolean
  readonly requestSavedStatus: (tweetIds: string[]) => Promise<string[]>
  readonly unsavedUntil?: Map<string, number>
  readonly now?: () => number
}): Promise<void> {
  if (!deps.inScope()) return
  const memo = deps.unsavedUntil
  const now = deps.now === undefined ? Date.now() : deps.now()
  if (memo !== undefined) {
    for (const [tweetId, until] of memo) if (until <= now) memo.delete(tweetId)
  }
  const byTweet = new Map<string, Element>()
  for (const article of deps.document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const tweetId = tweetIdOfArticle(article)
    if (Option.isNone(tweetId) || byTweet.has(tweetId.value)) continue
    if (article.querySelector(`.${SAVED_CHIP_CLASS}`) !== null) continue
    if (memo?.has(tweetId.value) === true) continue
    byTweet.set(tweetId.value, article)
  }
  if (byTweet.size === 0) return
  const saved = await deps.requestSavedStatus([...byTweet.keys()])
  if (memo !== undefined) {
    const hits = new Set(saved)
    for (const tweetId of byTweet.keys()) {
      if (!hits.has(tweetId) && memo.size < SAVED_UNSAVED_MEMO_CAP)
        memo.set(tweetId, now + SAVED_UNSAVED_MEMO_MS)
    }
  }
  // The route/setting may have changed while the request was in flight — never
  // paint chips after scope was lost.
  if (!deps.inScope()) return
  for (const tweetId of saved) {
    const article = byTweet.get(tweetId)
    if (article !== undefined) markArticleSaved(article, deps.document)
  }
}
```

   Without `unsavedUntil` the function behaves as before, except that it now
   skips articles that already carry a chip.

3. Add this export below `sweepSavedStatus`:

```ts
export const isOnlySavedChipMutation = (records: ReadonlyArray<MutationRecord>): boolean =>
  records.length > 0 &&
  records.every(
    (record) =>
      record.removedNodes.length === 0 &&
      record.addedNodes.length > 0 &&
      [...record.addedNodes].every(
        (node) => node instanceof Element && node.classList.contains(SAVED_CHIP_CLASS),
      ),
  )
```

**Verify**: `bun run test src/entrypoints/overlay.content/handlers.test.ts` →
all pass.

### Step 3: Wire the memo and the chip filter

In `src/entrypoints/overlay.content/index.tsx`:

1. Add `isOnlySavedChipMutation` to the existing import list from
   `'./handlers'` (the list that already holds `sweepSavedStatus`).
2. Directly above `const savedStatusIsActive`, add:

```ts
    const savedStatusUnsavedUntil = new Map<string, number>()
```

3. In the `makeSavedStatusLifecycle({ … })` call, replace the `makeObserver`
   line with:

```ts
      makeObserver: (notify) =>
        new MutationObserver((records) => {
          if (!isOnlySavedChipMutation(records)) notify()
        }),
```

4. In the same call, add one property to the `sweepSavedStatus({ … })`
   argument:

```ts
          unsavedUntil: savedStatusUnsavedUntil,
```

**Verify**: `bun run typecheck` → exit 0.
`rg -n "isOnlySavedChipMutation|savedStatusUnsavedUntil" src/entrypoints/overlay.content/index.tsx`
→ 4 matches.

### Step 4: Stop the sweep while the tab is hidden

In `src/entrypoints/overlay.content/index.tsx`:

1. Change `savedStatusIsActive` to:

```ts
    const savedStatusIsActive = (): boolean =>
      savedStatusAlive &&
      adapter.platform === 'x' &&
      document.visibilityState === 'visible' &&
      savedStatusVisible(savedStatusCommittedPath ?? location.pathname, savedStatusOn)
```

2. In the existing `visibilitychange` listener, add a second statement so the
   listener body reads:

```ts
      if (document.visibilityState === 'hidden') flushCaptures()
      savedStatusLifecycle.sync()
```

   Keep the comment above the `pagehide` line unchanged. A hidden tab makes
   `sync()` take its inactive branch, which disconnects the observer and
   cancels the timer. A visible tab re-attaches the observer and schedules one
   sweep.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -n "visibilityState === 'visible'" src/entrypoints/overlay.content/index.tsx`
→ 1 match.
`bun run test src/entrypoints/overlay.content/saved-status-lifecycle.test.ts`
→ all pass (unchanged file, proves the inactive branch still holds).

### Step 5: Catch a rejected page fetch in the tee

In `src/entrypoints/inject.content.ts`, find the block quoted in "Current
state" that starts with `void promise.then((res) => {`. Its last line is `})`.
Change that last line to:

```ts
          }).catch(() => {})
```

Change nothing else in the file. The `.catch(() => {})` form is the one the
file already uses a few lines above.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -c "\.catch\(\(\) => \{\}\)" src/entrypoints/inject.content.ts` → one more
than before this step (count it before you edit).

### Step 6: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

In `src/entrypoints/overlay.content/handlers.test.ts`, modelled on the
existing tests in `describe('sweepSavedStatus — Saved ✓ chip', …)`:

1. **A chipped post is not asked again.** Mount two articles. Run one sweep
   whose `requestSavedStatus` answers with the first id. Run a second sweep.
   The second call receives only the second id.
2. **A post answered "not saved" is not asked again inside the memo window.**
   Pass `unsavedUntil: new Map()` and `now: () => 1_000`. The first sweep
   answers `[]`. A second sweep at the same time does not call
   `requestSavedStatus`.
3. **The memo expires.** Continue from test 2 with `now: () => 1_000 + 60_001`.
   The sweep calls `requestSavedStatus` again with the id. The 60 s window
   comes from this plan's requirement, not from the code under test.
4. **A chip insertion alone is recognised.** Build a container, observe it
   with a real `MutationObserver` and `{ childList: true, subtree: true }`,
   append a `div` with class `xdl-saved-chip`, and read `takeRecords()`.
   `isOnlySavedChipMutation(records)` is `true`.
5. **Any other change is not swallowed.** `isOnlySavedChipMutation` is `false`
   for an empty array, for a record that adds a plain `div`, for a record that
   adds a chip and a plain `div` together, and for a record that removes a
   node.

If happy-dom's `MutationObserver.takeRecords()` returns nothing in test 4,
build the record objects by hand with `addedNodes` and `removedNodes` taken
from `document.createDocumentFragment().childNodes`-style node lists, and
report that in your final message.

The `index.tsx` and `inject.content.ts` edits have no unit-test harness. They
are verified by typecheck, lint, and the `rg` checks.

Verification: `bun run test src/entrypoints/overlay.content/handlers.test.ts`
→ all pass, 5 new tests.

Optional check in a real browser (the operator runs this): open x.com/home in
two tabs with "Saved" status on. Open the service worker console from
`chrome://extensions`. Leave one tab in the background for five minutes.
Before this plan `SavedStatusRequest` messages keep arriving from the hidden
tab. After it, none arrive until the tab is shown again.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] The 5 new tests exist and pass
- [ ] `rg -n "visibilityState === 'visible'" src/entrypoints/overlay.content/index.tsx` returns 1 match
- [ ] `git diff --stat cee429a -- src/entrypoints/overlay.content/saved-status-lifecycle.ts` shows no change made by this plan
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `sweepSavedStatus`, the lifecycle wiring, or the tee block does not match
  the excerpts.
- `rg -n "xdl-saved-chip" src` shows code that removes chips. A removed chip
  with a live memo entry would not be repainted for up to 60 s.
- An existing `sweepSavedStatus` or `handleSavedStatusUpdate` test fails after
  Step 2.
- Another plan has already changed the `void promise.then((res) => {` block in
  `inject.content.ts`. Skip Step 5 and report it.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- A post answered "not saved" is not re-asked for 60 s. A save that happens
  in that window still reaches the tab through `SavedStatusUpdate`. If that
  push is ever removed, shorten or remove the memo.
- A failed `SavedStatusRequest` returns `[]`, so its ids are held for 60 s as
  "not saved". That delays a chip. It never paints a wrong one.
- The memo holds at most 2,000 ids and drops expired ids at the start of each
  sweep.
- Deferred: the worker-side `misses` map in `src/packages/sync/saved-index.ts`
  is never pruned by its TTL. It is small and dies with the worker.
- Reviewer: confirm that a `/likes → /home` navigation still paints chips.
  `savedStatusCommittedPath` handling is unchanged, and the tab is visible
  during a user navigation.
