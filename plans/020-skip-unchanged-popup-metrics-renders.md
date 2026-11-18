# Plan 020: The popup re-renders only when the metrics snapshot changes, and never paints the wrong Stage first

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7456911 -- src/entrypoints/popup/App.tsx src/entrypoints/popup/App.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `7456911`, 2026-11-16

Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

The popup asks the service worker for the download metrics every 1 s during a
batch and every 3 s when idle. It stores every reply with `setMetrics(snapshot)`.
Each reply is a new object, so the whole popup tree re-renders on every tick,
even when nothing changed. A second render follows, because `useLingeringValue`
sees a new `monitor` reference and calls `setHeld`. After this plan an
unchanged reply keeps the old state object, so Preact skips both renders.

The popup also starts with `ctx = 'none'`. If settings load before
`tabs.query` resolves, the first frame shows "Open X, Instagram, or Threads to
use this extension." and then jumps to the real layout. After this plan the
"Loading..." frame stays until the tab context is known.

**Part B is not approved.** Replacing the poll with a `storage.session` watch
would remove the wake-ups, but ADR-0008 records polling as the decided
transport. Part B is written down so the owner can approve it. Do not execute
Part B unless the operator tells you, in words, that the ADR-0008 change is
approved.

## Current state

Files:

- `src/entrypoints/popup/App.tsx` — the popup. Holds all state in `App`, runs
  the poll, and renders every zone.
- `src/entrypoints/popup/App.test.ts` — source-text tests. They read
  `App.tsx` as a string and assert on exact substrings.
- `src/entrypoints/popup/collapse.tsx` — `useLingeringValue`. Read only. It
  needs no change once the state reference is stable.
- `src/entrypoints/popup/context.test.ts` — exemplar for a pure-function test.

The poll, `src/entrypoints/popup/App.tsx:1339-1370`:

```ts
  useEffect(() => {
    // `active` gates BOTH the state update and any rearm: the popup can close
    // before sendMessage settles, and an async completion must never schedule
    // work (or set state) after unmount.
    let active = true
    let handle: ReturnType<typeof setTimeout> | undefined

    const schedule = (delayMs: number): void => {
      if (!active) return
      handle = setTimeout(poll, delayMs)
    }

    const poll = (): void => {
      void browser.runtime
        .sendMessage({ _tag: 'MetricsRequest' })
        .then((snapshot: MetricsSnapshot | null) => {
          if (!active) return false
          setMetrics(snapshot)
          // Slow the cadence when no batch is active — the monitor (and thus the
          // snapshot) is only shown while total > 0.
          schedule(snapshot && snapshot.total > 0 ? POLL_ACTIVE_MS : POLL_IDLE_MS)
          return true
        })
        .catch(() => schedule(POLL_IDLE_MS))
    }

    poll()
    return () => {
      active = false
      clearTimeout(handle) // no-op while the first timer was never armed
    }
  }, [])
```

The derived monitor, `src/entrypoints/popup/App.tsx:1395-1406`:

```ts
  const monitor = getActiveMonitor(metrics)
  const shownMonitor = useLingeringValue(monitor)

  if (!settings) {
    return (
      <div {...stylex.props(styles.popup, styles.loading)} data-xmd-popup="loading">
        Loading...
      </div>
    )
  }
```

`getActiveMonitor` (`App.tsx:682-685`) returns its argument unchanged when
`metrics.total > 0`. So a stable `metrics` reference gives a stable `monitor`.

`useLingeringValue`, `src/entrypoints/popup/collapse.tsx:38-49`:

```ts
export function useLingeringValue<T>(value: T | null): T | null {
  const [held, setHeld] = useState<T | null>(value)
  useEffect(() => {
    if (value !== null) {
      setHeld(value)
      return undefined
    }
    const timer = setTimeout(() => setHeld(null), LINGER_MS)
    return () => clearTimeout(timer)
  }, [value])
  return value ?? held
}
```

The effect depends on `[value]`. With a stable reference it does not re-run.

The tab query, `src/entrypoints/popup/App.tsx:1306-1327`:

```ts
  useEffect(() => {
    void (async () => {
      try {
        const tabs = await browser.tabs.query({
          active: true,
          currentWindow: true,
        })
        const tab = tabs[0]
        if (!tab) return
        const url = tab.url ?? ''
        setTabAdapter(adapterForUrl(url))
        // …
        setCtx(tabContext(url))
        setScope(tabScope(url))
      } catch {
        /* permission unavailable; the action stays disabled */
      }
    })()
  }, [])
```

State declaration, `App.tsx:1228-1230`:

```ts
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [tabAdapter, setTabAdapter] = useState<PlatformAdapter | undefined>(undefined)
  const [ctx, setCtx] = useState<TabContext>('none')
```

The existing source-text tests that pin the poll,
`src/entrypoints/popup/App.test.ts:152-177`. One of them:

```ts
  it('gates setMetrics behind the active flag', () => {
    const idx = popupSource.indexOf('setMetrics(snapshot)')
    expect(idx).toBeGreaterThan(-1)
    expect(popupSource.slice(Math.max(0, idx - 120), idx)).toContain('if (!active) return')
  })
```

This test searches for the literal `setMetrics(snapshot)`. Step 2 changes that
call, so the test must be updated in the same step.

`background.ts` line numbers in this plan are approximate, because that file
is being edited. Locate each reference by the quoted code.

Where the snapshot comes from, `src/entrypoints/background.ts` near lines
1811-1817:

```ts
    'MetricsRequest',
    async () => {
      const base = (await metricsItem.getValue()) ?? currentSnapshot(Date.now())
      const releaseDiagnostics = await releaseDiagnosticsSummary()
      return releaseDiagnostics === undefined ? base : { ...base, releaseDiagnostics }
    },
```

The reply is the persisted snapshot. It carries no clock-derived field that
changes between two idle polls, so two idle replies serialize to the same JSON.
The snapshot holds at most 12 trace events (`MAX_TRACE_EVENTS = 12`,
`background.ts` near line 156), so serializing it is cheap.

ADR-0008 (`docs/adr/0008-monitoring-metrics-model.md:25-27`) — stay consistent
with this:

> **Transport is poll-on-demand**: the background SW persists the latest
> `MetricsSnapshot` to `storage.session` (ADR-0005) and answers a `MetricsRequest`
> message with it; the popup polls (~1 s) and renders counters. No long-lived port.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. Prefer narrowing.
- `unknown` is banned in parameters, returns and type aliases. Use the domain
  type (`MetricsSnapshot`).
- Named constants, not magic numbers.
- Preact function components only. Hooks at the top level with complete
  dependency arrays.
- Tests are vitest with assertions inside `it()`.

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Format check | `bun run fmt:check` | exit 0 |
| Boundaries | `bun run lint:boundaries` | exit 0 |
| Focused tests | `bun run test <path/to/file.test.ts>` | all pass |
| Full gate | `bun run check` | exit 0 |
| Build | `bun run build` | exit 0 |

Package manager is bun. Never use npm or npx.

## Scope

**In scope** (the only files you should modify):

- `src/entrypoints/popup/metrics-equal.ts` (create)
- `src/entrypoints/popup/metrics-equal.test.ts` (create)
- `src/entrypoints/popup/App.tsx`
- `src/entrypoints/popup/App.test.ts`
- `plans/README.md` (only this plan's status row in the
  "Performance plans (012–023)" table)

**Out of scope** (do NOT touch):

- `src/entrypoints/background.ts` — the `MetricsRequest` handler and
  `persistSnapshot` stay as they are.
- `src/entrypoints/popup/collapse.tsx` — a stable state reference already
  stops its extra render.
- `POLL_ACTIVE_MS` and `POLL_IDLE_MS` — the poll cadence is an ADR-0008
  decision.
- `docs/adr/0008-monitoring-metrics-model.md` — only the owner changes ADRs.

## Git workflow

- Branch: `advisor/020-skip-unchanged-popup-metrics-renders`
- Conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `perf(popup): …` or `fix(popup): …`.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes, and some sit inside this
  plan's in-scope files. At planning time `src/entrypoints/popup/App.tsx`
  already had uncommitted edits. Never revert or stash them.
- Before editing, run the drift-check command from the top of this plan and
  note which in-scope files already show uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Leave
  this plan's edits unstaged in that file and name the file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage them by
  path.

## Steps

### Step 1: Add a pure snapshot-equality helper with tests

Create `src/entrypoints/popup/metrics-equal.ts`:

```ts
import type { MetricsSnapshot } from '@/packages/schema'

export const sameMetricsSnapshot = (
  a: MetricsSnapshot | null,
  b: MetricsSnapshot | null,
): boolean => {
  if (a === b) return true
  if (a === null || b === null) return false
  return JSON.stringify(a) === JSON.stringify(b)
}
```

Create `src/entrypoints/popup/metrics-equal.test.ts`. Model it on
`src/entrypoints/popup/context.test.ts` (plain `describe`/`it`, no mocks).
Build fixtures by decoding with the schema so they are complete:
`Schema.decodeUnknownSync(MetricsSnapshot)({...})` — import `Schema` from
`effect` and `MetricsSnapshot` from `@/packages/schema`. Read the
`MetricsSnapshot` struct at `src/packages/schema/index.ts:225` to fill every
required field. Cases:

1. Two separately built snapshots with identical fields → `true`.
2. Snapshots that differ only in `completed` → `false`.
3. `null` vs `null` → `true`.
4. `null` vs a snapshot → `false`, in both argument orders.
5. Snapshots that differ only in `releaseDiagnostics.clears` → `false`.

**Verify**: `bun run test src/entrypoints/popup/metrics-equal.test.ts` → all pass.

### Step 2: Keep the previous state object when the reply is unchanged

In `src/entrypoints/popup/App.tsx`:

1. Import `sameMetricsSnapshot` from `./metrics-equal`.
2. In the poll's `.then`, replace `setMetrics(snapshot)` with:

```ts
          setMetrics((previous) => (sameMetricsSnapshot(previous, snapshot) ? previous : snapshot))
```

Leave the `if (!active) return false` line directly above it. Leave the
`schedule(...)` line unchanged. Leave `setMetrics(null)` in `resetMonitor`
unchanged.

In `src/entrypoints/popup/App.test.ts`, update the test
`'gates setMetrics behind the active flag'` so it searches for the new call.
Change the `indexOf` argument to
`'setMetrics((previous) => (sameMetricsSnapshot(previous, snapshot) ? previous : snapshot))'`.
Keep the rest of that test.

Add one new source-text test in the same `describe` block:

```ts
  it('keeps the previous metrics object when the poll reply is unchanged', () => {
    expect(popupSource).toContain("import { sameMetricsSnapshot } from './metrics-equal'")
    expect(popupSource).not.toContain('setMetrics(snapshot)')
  })
```

This test fails before the `App.tsx` edit (the source still contains
`setMetrics(snapshot)`) and passes after.

**Verify**: `bun run test src/entrypoints/popup/App.test.ts` → all pass.

### Step 3: Hold the loading frame until the tab context is known

In `src/entrypoints/popup/App.tsx`:

1. Add state next to `ctx`:

```ts
  const [ctxResolved, setCtxResolved] = useState(false)
```

2. In the tab-query effect, mark the context resolved on every exit path. Add
   a `finally` to the existing `try`:

```ts
      } catch {
        /* permission unavailable; the action stays disabled */
      } finally {
        setCtxResolved(true)
      }
    })()
  }, [])
```

This is the tail of the effect only. The single edit is to insert the three
lines `} finally {`, `setCtxResolved(true)`, `}` in place of the `}` that
closes the `catch`. Do not retype or replace the `try` body. Every existing
line and comment inside the effect stays byte-for-byte as it is. The `finally`
covers the early `if (!tab) return`, the success path, and the `catch` path.

3. Change the loading gate from `if (!settings) {` to
   `if (!settings || !ctxResolved) {`.

Add source-text tests to `src/entrypoints/popup/App.test.ts`, in a new
`describe('the first frame waits for the tab context', …)`:

```ts
  it('keeps the loading frame until settings AND the tab context resolve', () => {
    expect(popupSource).toContain('if (!settings || !ctxResolved) {')
    expect(popupSource).toContain('setCtxResolved(true)')
  })

  it('resolves the tab context on every exit path via finally', () => {
    const idx = popupSource.indexOf('setCtxResolved(true)')
    expect(idx).toBeGreaterThan(-1)
    expect(popupSource.slice(Math.max(0, idx - 40), idx)).toContain('finally')
  })
```

Both fail before the edit and pass after. The `expect(idx).toBeGreaterThan(-1)`
line is required: `App.tsx` already contains an unrelated `} finally {` (near
line 636), so without it the second test would pass on today's source.

**Verify**: `bun run test src/entrypoints/popup/App.test.ts` → all pass.

### Step 4: Full gate

**Verify**: `bun run check` → exit 0. Then `bun run build` → exit 0.

### Part B (NOT approved — do not execute without the operator's explicit approval of an ADR-0008 change)

Goal: stop the poll and subscribe to the persisted snapshot.

Facts the owner needs to decide:

- The snapshot lives at `session:metrics`
  (`src/entrypoints/background.ts` near line 139). The service worker writes it through
  `persistSnapshot` on every change.
- Extension pages (popup, options) can read `chrome.storage.session` by
  default. Only content scripts are blocked by default. The repo never calls
  `setAccessLevel`, so no manifest or access-level change is needed for the
  popup.
- `releaseDiagnostics` is NOT in the persisted item. The `MetricsRequest`
  handler adds it from an in-memory cache (`releaseDiagnosticsSummary()`,
  `background.ts` near line 419). A watch on `session:metrics` alone would never see a
  Release summary change. Part B therefore needs one of:
  a) the popup keeps one `MetricsRequest` on open and sends another each time
     the watched item changes, or
  b) the service worker persists the summary into its own `session:` item and
     the popup watches both.
- ADR-0008 says "Transport is poll-on-demand … the popup polls (~1 s)". A
  watch replaces that sentence. The owner must rewrite the ADR in place first.

If approved, the operator will supply a follow-up plan. Do not start from this
sketch.

## Test plan

- New file `src/entrypoints/popup/metrics-equal.test.ts`: the five cases in
  Step 1.
- `src/entrypoints/popup/App.test.ts`: one updated test and three new tests
  (Steps 2 and 3). Each new test fails on the current source and passes after
  its step.
- Pattern to follow: `src/entrypoints/popup/context.test.ts` for the pure
  helper; the existing `describe` blocks in `App.test.ts` for source-text
  tests.
- Verification: `bun run test src/entrypoints/popup/metrics-equal.test.ts src/entrypoints/popup/App.test.ts`
  → all pass, including 5 + 3 new tests.

## Done criteria

ALL must hold:

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] `rg -n "setMetrics\(snapshot\)" src/entrypoints/popup/App.tsx` returns no matches
- [ ] `rg -n "if \(!settings \|\| !ctxResolved\)" src/entrypoints/popup/App.tsx` returns 1 match
- [ ] `rg -n "POLL_ACTIVE_MS = 1000|POLL_IDLE_MS = 3000" src/entrypoints/popup/App.tsx` returns 2 matches (cadence unchanged)
- [ ] `git status --short` shows no file changed by this plan outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code in "Current state" does not match the live files.
- The `MetricsRequest` handler in `background.ts` now builds its reply from
  `currentSnapshot(Date.now())` on every request instead of the persisted
  item. Then two idle replies may differ and the equality gate needs a
  different comparison.
- The loading gate change makes the popup stay on "Loading..." in any test or
  manual run. That means an exit path does not reach `setCtxResolved(true)`.
- Any step needs a change to `background.ts`, `collapse.tsx`, or an ADR.
- The `doc-lock` hook blocks an edit. Report the blocked line; do not rephrase
  comments to get past it.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- If a time-derived field (for example a live ETA computed at request time) is
  added to the `MetricsRequest` reply, every reply will differ again and the
  equality gate stops helping. Keep clock-derived values out of the reply or
  compare without them.
- All popup state still lives in `App`. A real metrics change still re-renders
  every zone. Moving the monitor into its own subscribing component is a
  possible follow-up; it was left out to keep this change small.
- Reviewer: check that the `finally` did not move or reword the two comments
  inside the tab-query effect.
- Deferred: Part B (storage watch). It needs an ADR-0008 rewrite by the owner.
