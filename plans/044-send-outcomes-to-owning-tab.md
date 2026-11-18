# Plan 044: Send each transfer outcome to the tab that asked for it, and saved-status updates to X tabs only

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/background/tab-broadcaster.ts src/background/tab-broadcaster.test.ts src/entrypoints/background.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S (Part A), S (Part B)
- **Risk**: LOW (Part A), MED (Part B)
- **Depends on**: Part A: none. Part B: an owner decision that supersedes one line of ADR-0014 (see "Design constraints"). Part B also rewrites the same function as Part B of `plans/023-batch-sync-drains-and-outcome-broadcasts.md`. Run one of the two first and finish it before starting the other. Plans 013, 018, 019, 022, 041 and 043 also edit `src/entrypoints/background.ts`. Run them one at a time.
- **Category**: perf
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/117

## Why this matters

When a download finishes, the service worker tells the page so the badge can
show the real result. Today it runs `tabs.query` and sends the message to
every open X, Instagram and Threads tab. Only the tab that started the
download can use the message. Every other tab wakes its content script,
decodes the message, and drops it. A batch of 200 downloads with 10 open tabs
sends 2,000 messages, and 1,800 of them do nothing.

The "Saved ✓" update has the same shape on a smaller scale. It is sent to
every registered platform's tabs, and the handler drops it on every tab that
is not X.

Part A sends the saved-status update to X tabs only. Part B sends each
transfer outcome only to the tabs that asked for that download, and falls back
to the broadcast when the worker does not know the owner. The gain is an
estimate from reading the code. It was not measured.

## Current state

Files and roles:

- `src/background/tab-broadcaster.ts` — every tab fan-out. It has the
  `TabsPort` seam, `defaultTabsPort`, and `makeTabBroadcaster`.
- `src/background/tab-broadcaster.test.ts` — its tests. The `fakeTabs` helper
  starts near line 70.
- `src/entrypoints/background.ts` — the service worker. Line numbers in this
  file are approximate. Locate each edit by the quoted code.
- `src/entrypoints/overlay.content/handlers.ts` — the page-side handlers. Read
  only.

The tab query and the port (`src/background/tab-broadcaster.ts:69-76`, `:402-406`):

```ts
export interface TabsPort {
  /** The numeric ids of every open tab on a registered platform (not X-only —
   *  `defaultTabsPort` below queries `allAdapterHostMatch()`). */
  queryXTabs(): Promise<number[]>
  /** Send a message to one tab; resolves to its response (or undefined). Every
   *  reply shape differs by message tag, so callers narrow the `JsonValue` result
   *  themselves right after the call (see `sendClearToTabs`/`releaseViaStatusTab`). */
  sendTabMessage(tabId: number, message: Message | TabMessage): Promise<JsonValue | undefined>
```

```ts
    queryXTabs: async () => {
      const tabs = await browser.tabs.query({ url: [...allAdapterHostMatch()] })
      return tabs.flatMap((t) => (t.id !== undefined ? [t.id] : []))
    },
    sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
```

The broadcast and the outcome report (`src/background/tab-broadcaster.ts:480-501`):

```ts
  /** Broadcast a fire-and-forget message to every open X tab. A dead tab (no
   *  injected content script / stale context) is a silent no-op — the same
   *  treatment `refreshMediaUrlFromTabs` gives a missing receiver: not a failure. */
  const broadcastToXTabs = async (message: Message): Promise<void> => {
    const ids = await queryXTabs()
    await Promise.all(ids.map((id) => tabs.sendTabMessage(id, message).catch(() => {})))
  }

  /** The single seam every terminal transfer site routes through: announce a
   *  transfer's TERMINAL outcome to the overlays, so a badge marked saved at
   *  hand-off is corrected by the real result (bytes landed / 403 / timeout).
   *  Sidecar `.json` requests are not user media and carry no badge. */
  const reportTransferOutcome = (
    requestId: string,
    outcome: 'complete' | 'failed',
    at: number,
  ): void => {
    if (requestId.endsWith('.json')) return
    // `.catch` so a tabs.query failure during SW teardown is a silent no-op (the
    // same degraded outcome as no tab receiving it), never an unhandled rejection.
    void broadcastToXTabs({ _tag: 'TransferOutcome', requestId, outcome, at }).catch(() => {})
  }
```

The object `makeTabBroadcaster` returns (`src/background/tab-broadcaster.ts:1030-1038`):

```ts
  return {
    queryXTabs,
    makeTabMessagingPort,
    broadcastToXTabs,
    reportTransferOutcome,
    sendClearToTabs,
    resolveTabListScope,
    staleTabCount,
  }
```

The only caller of `reportTransferOutcome` (`src/entrypoints/background.ts`, near line 799):

```ts
      reportBacklink: (backlink) =>
        reportTransferOutcome(backlink.requestId, backlink.outcome, backlink.at),
```

The saved-status push (`src/entrypoints/background.ts`, near lines 659-662):

```ts
  // Late cross-device hits (the sweep replied before the backstop answered):
  // push them to every X tab so the chips land without waiting for a re-sweep.
  notifyFresh: (saved) =>
    void tabBroadcaster.broadcastToXTabs({ _tag: 'SavedStatusUpdate', saved }).catch(() => {}),
```

The page drops that message off X (`src/entrypoints/overlay.content/handlers.ts:352-356`):

```ts
export const handleSavedStatusUpdate: MessageHandler = (message, deps) => {
  // The sweep/chip DOM (TWEET_ARTICLE_SEL, tweetIdOfArticle) is X-specific; an
  // Instagram/Threads tab has nothing to chip. Fire-and-forget, so a bare early
  // return (no sendResponse) is the correct no-op here too.
  if (deps.adapter.platform !== 'x') return
```

The worker already knows which tab asked. The download message passes the
sender's tab id (`src/entrypoints/background.ts`, near line 1810), and
`handleDownload` receives it (near line 1325):

```ts
      Effect.runPromise(handleDownload(msg.items, undefined, msg.clearExpect, sender.tab?.id)),
```

```ts
const handleDownload = (
  items: ReadonlyArray<MediaItem>,
  sweep?: { readonly scope: Scope },
  clearExpect?: ReadonlyArray<{ readonly tweetId: string; readonly ids: ReadonlyArray<string> }>,
  originTabId?: number,
) =>
  Effect.gen(function* () {
    const requestReceivedAt = Date.now()
```

A download started from the popup has no sender tab, so `originTabId` is
`undefined` there.

The page-side guard (`src/entrypoints/overlay.content/handlers.ts:371-394`)
acts only when `m.requestId` equals the tab's own badge request id or is in
the tab's own launcher batch. A tab that did not ask for the download ignores
the message.

Tests that pin today's behaviour (`src/background/tab-broadcaster.test.ts:1279-1291`):

```ts
describe('reportTransferOutcome', () => {
  it('fans the terminal outcome out to every open X tab', async () => {
    const tabs = fakeTabs([1, 2])
    makeTabBroadcaster(tabs).reportTransferOutcome('req-1', 'complete', 1234)
    await tick() // fire-and-forget
    expect(tabs.sent.map((s) => s.tabId)).toEqual([1, 2])
```

Design constraints:

- `docs/adr/0014-transfer-tracker-outcome-backlink.md:43-45`: "**A backlink
  message** (`TransferOutcome { requestId, outcome, at }`, schema/index.ts):
  broadcast fire-and-forget to every open X tab on a terminal browser
  outcome." The same ADR, lines 91-93, lists this plan's Part B as a rejected
  alternative: "**Targeted send to the originating tab** (persist
  `sender.tab.id`) — more precise than broadcast, but adds state; the
  broadcast + per-entrance guard is sufficient and simpler for v1."
  Part B therefore needs the owner to say yes first. Part B differs from the
  rejected option in one way: it keeps the tab id in memory only and persists
  nothing. After a worker restart it broadcasts as today.
- The same ADR fixes the message shape, and
  `requestId` "is the `SaveRequest.id` (== `MediaItem.id`)". Neither part
  changes the message.
- `docs/adr/0019-platform-identity-derives-from-adapter-registry.md:47-50`:
  "**The registry is the single source of platform identity.** Every site that
  needs "which platforms/origins/hosts are supported" reads it from
  `ALL_ADAPTERS`, directly or through a derived helper on the registry — never
  a hand-maintained parallel list." Part A reads X's host patterns from
  `ALL_ADAPTERS`. It does not import `X_HOST_MATCH`.
- The same ADR, lines 76-79: "**Genuinely X-only behaviour stays X-only,
  explicitly.**" Saved status is X-only by the handler gate quoted above.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Named constants, not magic numbers.
- `for...of` over `.forEach()`.
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
| Focused tests | `bun run test <path/to/file.test.ts>`   | all pass            |
| Full gate     | `bun run check`                         | exit 0              |
| Build         | `bun run build`                         | exit 0              |

The package manager is bun. Never use npm or npx. If `bun run fmt:check` fails
only on files you edited, run `bunx oxfmt --write <those files>` and re-check.

## Scope

**In scope** (the only files you should modify):

- `src/background/tab-broadcaster.ts`
- `src/background/tab-broadcaster.test.ts`
- `src/entrypoints/background.ts` (one changed call in Part A, one added statement in Part B)
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/packages/schema/index.ts`. The `TransferOutcome` and
  `SavedStatusUpdate` messages do not change.
- `src/entrypoints/overlay.content/handlers.ts`. The page-side guards stay as
  the safety net for the broadcast fallback.
- `queryXTabs` and the test "queries browser.tabs with every registered
  adapter hostMatch, not X alone". The wide query stays for the fallback and
  for the clear fan-out.
- `session:transfers` and every other persisted record. Part B persists
  nothing.
- `docs/adr/0014-transfer-tracker-outcome-backlink.md`. The owner updates it.
  See "Maintenance notes" for the text it needs.

## Git workflow

- Branch: `advisor/044-send-outcomes-to-owning-tab`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `perf(background): …` here. One commit per part.
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

### Part A — send `SavedStatusUpdate` to X tabs only

#### Step A1: Write the failing test

In `src/background/tab-broadcaster.test.ts`:

1. In `fakeTabs`, add an option `platformTabIds?: number[]` to the `opts`
   type. In the returned object, next to `queryXTabs`, add:

```ts
    queryTabsMatching: vi.fn<TabsPort['queryTabsMatching']>(
      async () => opts.platformTabIds ?? ids,
    ),
```

2. Add the two tests in "Test plan" items 1–2 in a new
   `describe('broadcastToPlatformTabs', …)` block after the existing
   `describe('broadcastToXTabs', …)` block.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → the two
new tests FAIL (the method does not exist). `bun run typecheck` fails on the
same missing names. That is expected until Step A2.

#### Step A2: Add the platform-scoped broadcast

In `src/background/tab-broadcaster.ts`:

1. Change the registry import to also bring in `ALL_ADAPTERS`:

```ts
import { ALL_ADAPTERS, adapterForUrl, allAdapterHostMatch } from '../core/adapters/registry'
```

   Add a type import for the platform tag. Find its export with
   `rg -n "export type Platform" src`. Import it from that module with
   `import type`.

2. In `interface TabsPort`, directly below the `queryXTabs(): Promise<number[]>`
   line, add:

```ts
  queryTabsMatching(hostMatch: ReadonlyArray<string>): Promise<number[]>
```

3. In `defaultTabsPort`, directly below the `queryXTabs` property, add:

```ts
    queryTabsMatching: async (hostMatch) => {
      const tabs = await browser.tabs.query({ url: [...hostMatch] })
      return tabs.flatMap((t) => (t.id !== undefined ? [t.id] : []))
    },
```

4. In `interface TabBroadcaster`, directly below the `broadcastToXTabs` line,
   add:

```ts
  readonly broadcastToPlatformTabs: (platform: Platform, message: Message) => Promise<void>
```

5. In `makeTabBroadcaster`, directly below the `broadcastToXTabs` function,
   add:

```ts
  const broadcastToPlatformTabs = async (platform: Platform, message: Message): Promise<void> => {
    const hostMatch = ALL_ADAPTERS.filter((a) => a.platform === platform).flatMap(
      (a) => a.hostMatch,
    )
    if (hostMatch.length === 0) return
    const ids = await tabs.queryTabsMatching(hostMatch)
    await Promise.all(ids.map((id) => tabs.sendTabMessage(id, message).catch(() => {})))
  }
```

6. Add `broadcastToPlatformTabs,` to the returned object, below
   `broadcastToXTabs,`.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → all pass.
`bun run typecheck` → exit 0.

#### Step A3: Use it for the saved-status push

In `src/entrypoints/background.ts`, in the `notifyFresh` property quoted in
"Current state", replace

```ts
    void tabBroadcaster.broadcastToXTabs({ _tag: 'SavedStatusUpdate', saved }).catch(() => {}),
```

with

```ts
    void tabBroadcaster
      .broadcastToPlatformTabs('x', { _tag: 'SavedStatusUpdate', saved })
      .catch(() => {}),
```

Keep the two comment lines above `notifyFresh` unchanged. They stay true.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -n "broadcastToPlatformTabs" src/entrypoints/background.ts` → 1 match.

You may stop here, run Step B5, and mark the plan
`DONE (Part A; Part B waits for the ADR-0014 decision)`.

### Part B — send `TransferOutcome` to the tabs that asked

Do not start Part B unless the operator who dispatched you states that the
owner approved targeted sends. If you have no such statement, stop after
Part A.

Check which variant applies:
`rg -n "OUTCOME_COALESCE_MS" src/background/tab-broadcaster.ts`.
No match means plan 023 Part B has not landed. Use Variant 1 in Step B3. A
match means it has landed. Use Variant 2.

#### Step B1: Write the failing tests

In `src/background/tab-broadcaster.test.ts`, inside
`describe('reportTransferOutcome', …)`, add the tests in "Test plan" items
3–7. Do not change the two existing tests in that block. They describe the
fallback and must keep passing.

If plan 023 Part B has landed, the existing tests in this block already wait
for the coalesce delay. Use the same waiting pattern in the new tests.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → the new
tests FAIL (`noteTransferOrigin` does not exist). The existing tests pass.

#### Step B2: Remember which tabs asked

In `src/background/tab-broadcaster.ts`:

1. Add a module-level constant above `makeTabBroadcaster`:

```ts
const ORIGIN_TAB_REQUEST_CAP = 4_000
```

2. In `interface TabBroadcaster`, directly below the `reportTransferOutcome`
   member, add:

```ts
  readonly noteTransferOrigin: (requestIds: ReadonlyArray<string>, tabId: number) => void
```

3. In `makeTabBroadcaster`, directly above the JSDoc block that starts
   "The single seam every terminal transfer site routes through", add:

```ts
  const originTabsByRequest = new Map<string, Set<number>>()

  const noteTransferOrigin = (requestIds: ReadonlyArray<string>, tabId: number): void => {
    if (originTabsByRequest.size + requestIds.length > ORIGIN_TAB_REQUEST_CAP)
      originTabsByRequest.clear()
    for (const requestId of requestIds) {
      if (requestId.endsWith('.json')) continue
      const known = originTabsByRequest.get(requestId)
      if (known === undefined) originTabsByRequest.set(requestId, new Set([tabId]))
      else known.add(tabId)
    }
  }

  const takeOwnerTabs = (message: TransferOutcome): ReadonlyArray<number> | undefined => {
    const owners = originTabsByRequest.get(message.requestId)
    if (message.outcome === 'complete') originTabsByRequest.delete(message.requestId)
    return owners === undefined ? undefined : [...owners]
  }
```

   Import `TransferOutcome` as a type from `@/packages/schema` if the file
   does not import it yet. A `failed` outcome keeps the entry, because a retry
   can still report `complete` for the same request id.

4. Add `noteTransferOrigin,` to the returned object, below
   `reportTransferOutcome,`.

**Verify**: `bun run typecheck` → exit 0.

#### Step B3: Send to the owners, or broadcast when there is none

**Variant 1** (plan 023 Part B has not landed). Directly above the same JSDoc
block, below `takeOwnerTabs`, add:

```ts
  const sendOutcome = async (message: TransferOutcome): Promise<void> => {
    const ids = takeOwnerTabs(message) ?? (await queryXTabs())
    await Promise.all(ids.map((id) => tabs.sendTabMessage(id, message).catch(() => {})))
  }
```

Then, in `reportTransferOutcome`, replace the last statement

```ts
    void broadcastToXTabs({ _tag: 'TransferOutcome', requestId, outcome, at }).catch(() => {})
```

with

```ts
    void sendOutcome({ _tag: 'TransferOutcome', requestId, outcome, at }).catch(() => {})
```

Keep the JSDoc block and the two-line `.catch` comment unchanged.

**Variant 2** (plan 023 Part B has landed). The file then has a
`flushOutcomes` function that ends with these statements:

```ts
    const ids = await queryXTabs()
    await Promise.all(
      ids.flatMap((id) =>
        outcomes.map((message) => tabs.sendTabMessage(id, message).catch(() => {})),
      ),
    )
```

Replace those statements with:

```ts
    const targeted = outcomes.map((message) => ({ message, owners: takeOwnerTabs(message) }))
    const everyTab = targeted.some((t) => t.owners === undefined) ? await queryXTabs() : []
    await Promise.all(
      targeted.flatMap(({ message, owners }) =>
        (owners ?? everyTab).map((id) => tabs.sendTabMessage(id, message).catch(() => {})),
      ),
    )
```

Change nothing else in `flushOutcomes` or `reportTransferOutcome`. If
`flushOutcomes` does not end with the statements quoted above, that is a STOP
condition.

**Verify**: `bun run test src/background/tab-broadcaster.test.ts` → all pass.

#### Step B4: Record the asking tab

In `src/entrypoints/background.ts`, inside `handleDownload`, directly after
the line `const requestReceivedAt = Date.now()`, add:

```ts
    if (originTabId !== undefined)
      tabBroadcaster.noteTransferOrigin(
        items.map((item) => item.id),
        originTabId,
      )
```

This runs before the admission gate on purpose. A second tab that asks for a
download that is already in flight is noted too, so its badge is corrected
when the first tab's download finishes.

**Verify**: `bun run typecheck` → exit 0. `bun run lint` → exit 0.
`rg -n "noteTransferOrigin" src/entrypoints/background.ts` → 1 match.

#### Step B5: Run the gate

**Verify**: `bun run check` → exit 0. `bun run build` → exit 0.

## Test plan

All in `src/background/tab-broadcaster.test.ts`.

Part A, in `describe('broadcastToPlatformTabs', …)`:

1. **It asks only for the platform's host patterns and sends only to those
   tabs.** `fakeTabs([1, 2, 3], {}, { platformTabIds: [1] })`. Call
   `broadcastToPlatformTabs('x', { _tag: 'SavedStatusUpdate', saved: ['10'] })`.
   `tabs.queryTabsMatching` was called once with
   `['*://x.com/*', '*://twitter.com/*']`. `tabs.sent.map((s) => s.tabId)`
   equals `[1]`. `tabs.queryXTabs` was not called. The two patterns are X's
   documented hosts, the same literals the existing widened-query test uses.
2. **A dead tab does not reject.** `fakeTabs([1], { 1: new Error('dead') })`.
   The call resolves to `undefined`.

Part B, in `describe('reportTransferOutcome', …)`:

3. **A noted request goes only to its tab.** `fakeTabs([1, 2, 3])`. Call
   `noteTransferOrigin(['req-1'], 2)`, then
   `reportTransferOutcome('req-1', 'complete', 5)`. After the same wait the
   existing tests use, `tabs.sent.map((s) => s.tabId)` equals `[2]`, and
   `tabs.queryXTabs` was not called.
4. **Two tabs that asked both receive it.** Note `'req-1'` for tab 1 and for
   tab 3. The outcome reaches `[1, 3]`.
5. **A failed outcome keeps the owner for the retry.** Note `'req-1'` for
   tab 2. Report `'failed'`, then `'complete'`. Both messages reach tab 2
   only.
6. **After `complete`, the owner is forgotten.** Continue from test 3. A
   second `reportTransferOutcome('req-1', 'complete', 6)` reaches every tab
   (`[1, 2, 3]`), which is the fallback.
7. **Overflow falls back to the broadcast.** Note 4,001 distinct ids for
   tab 2 in two calls (4,000, then 1). An outcome for an id from the first
   call reaches every tab. The 4,000 limit comes from this plan's requirement
   that the map stays bounded.

The existing test "fans the terminal outcome out to every open X tab" stays
unchanged. It now pins the fallback for a request with no noted owner.

The `background.ts` edits have no unit-test harness. They are verified by
typecheck, lint, and the `rg` checks.

Verification: `bun run test src/background/tab-broadcaster.test.ts` → all
pass, 2 new tests for Part A and 5 for Part B.

Optional check in a real browser (the operator runs this): open x.com in two
tabs. Open DevTools in the second tab, select the extension's content-script
context, and add a `chrome.runtime.onMessage` listener that logs `_tag`. Save
one image from the first tab. Before Part B the second tab logs
`TransferOutcome`. After it, the second tab logs nothing and the first tab's
badge still turns to its final state. Then save from the popup and confirm
that both tabs log the message (fallback).

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] Part A: the 2 new tests exist and pass, and `rg -n "broadcastToPlatformTabs" src/entrypoints/background.ts` returns 1 match
- [ ] Part A: `rg -n "X_HOST_MATCH" src/background/tab-broadcaster.ts` returns only comment lines, as before this plan
- [ ] Part B (if done): the 5 new tests exist and pass
- [ ] Part B (if done): `rg -n "ORIGIN_TAB_REQUEST_CAP" src/background/tab-broadcaster.ts` returns 2 matches
- [ ] Part B (if done): `rg -n "noteTransferOrigin" src/entrypoints/background.ts` returns 1 match
- [ ] `git diff --stat cee429a -- src/packages/schema/index.ts src/entrypoints/overlay.content/handlers.ts` shows no change made by this plan
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started
- [ ] `plans/README.md` status row updated (say whether Part B was done)

## STOP conditions

Stop and report back (do not improvise) if:

- `broadcastToXTabs`, `reportTransferOutcome`, `TabsPort`, or the
  `handleDownload` signature does not match the excerpts, apart from the
  plan 023 Part B change that Variant 2 describes.
- `rg -n "TabsPort" src -l` lists a file other than `tab-broadcaster.ts` and
  `tab-broadcaster.test.ts`. Another fake would need `queryTabsMatching`.
- `rg -n "reportTransferOutcome\(" src -g '!*.test.*'` shows a caller other
  than the `reportBacklink` line in `background.ts`.
- You have no statement that the owner approved Part B and you are about to
  start it.
- Plan 023 Part B is in progress in another branch or session. Finish one
  before the other.
- An existing test asserts that a `TransferOutcome` reaches a tab that did not
  ask for the download, and Step B4 would break it.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Owner decision needed before Part B. ADR-0014 says the outcome is
  "broadcast fire-and-forget to every open X tab" and lists the targeted send
  as a rejected alternative. If the owner approves, a docs session must update
  ADR-0014: the decision line becomes "sent to the tabs that asked for the
  download, with the broadcast as the fallback when the worker has no owner in
  memory", and the alternative moves out of "Alternatives considered".
- Stale comments after Part B, for the same docs session. The executor must
  not edit them. `src/entrypoints/overlay.content/handlers.ts:367-370` says
  "Broadcast to every X tab". The member doc on `TabBroadcaster` and the test
  title "fans the terminal outcome out to every open X tab" describe only the
  fallback.
- The owner map lives in worker memory. After a worker restart, and for
  popup-started downloads, outcomes are broadcast as before. The page-side
  guard must therefore stay.
- With Part B done, plan 023 Part B saves little. A targeted outcome runs no
  `tabs.query`. If plan 023 Part B is still TODO, mark it skipped in
  `plans/README.md` after the owner agrees.
- A tab that navigates to another site keeps its tab id. A send to it fails
  or is ignored, and the `.catch` swallows the failure. That matches today's
  dead-tab handling.
- Deferred: `orphanRecords` in this file is never pruned when tabs close. It
  is small and dies with the worker.
- Reviewer: check Step B4's position before the admission gate, and that no
  path sends a `TransferOutcome` for a `.json` sidecar.
