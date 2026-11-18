# Plan 047: Mount-time data loads through one hook with a named state

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 2089ed0 -- src/components/capture-export.ts src/entrypoints/popup src/entrypoints/options`
> The plan was written against a working tree with uncommitted changes on top
> of `2089ed0`, and `src/entrypoints/popup/App.tsx` was being edited while the
> plan was written. Locate every edit by the quoted text, not by line number.
> If quoted text is missing from the live file, that is a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW–MED
- **Depends on**: plans/046-remove-state-deriving-effects.md (same files; run 046 first)
- **Category**: tech-debt
- **Planned at**: commit `2089ed0`, 2026-11-20
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/121

## Why this matters

Eight effects in the popup and options pages do the same thing: call an async
loader once on mount and copy the result into `useState<T | null>`. `null`
then means "still loading" in some readers and "the load failed" in others,
and readers hide both with `?.` and `?? 0`. None of the eight guards against a
reply that arrives after unmount. After this plan one hook owns the effect and
the guard, and its state is a tagged union: `Loading`, `Ready`, or `Failed`.
Eight effects become eight hook calls and seven `T | null` states disappear.

## Current state

Preact extension built with WXT. Hooks come from `preact/hooks`. Effect's
`Option` is in use elsewhere, and tagged unions use a `_tag` field.

The eight mount loaders (quoted text is the anchor):

`src/entrypoints/popup/App.tsx`, inside `export function App()`:

```tsx
  const [settings, setSettingsState] = useState<Settings | null>(null)
```
```tsx
  const [captureSummary, setCaptureSummary] = useState<CaptureSummary | null>(null)
  const [introState, setIntroState] = useState<FirstRunState | null>(null)
```
```tsx
  useEffect(() => {
    void getSettings().then(setSettingsState)
  }, [])
```
```tsx
  useEffect(() => {
    // limit 3: enough for the popup's own trimmed recent-conversation disclosure
    // (CaptureQuickActions) without paying for the full archive-browser payload.
    void fetchCaptureSummary(3).then(setCaptureSummary)
  }, [])

  useEffect(() => {
    void recordOpen().then(setIntroState)
  }, [])
```

Other writers and readers in the same file:

```tsx
    setSettingsState(await setSettings(patch))
```
```tsx
  const dismissFirstRun = (): void => void markDone().then(setIntroState)
```
```tsx
          onCleared={() => setCaptureSummary({ tweets: 0, conversations: 0, recent: [] })}
```
```tsx
  if (!settings) {
    return (
      <div {...stylex.props(styles.popup, styles.loading)} data-xmd-popup="loading">
        Loading...
      </div>
    )
  }
```
```tsx
function shouldShowFirstRunIntro(introState: FirstRunState | null, ctx: TabContext): boolean {
  if (introState === null || !isXContext(ctx)) return false
  return shouldShowIntro(introState)
}
```

`captureSummary` is also passed to two child components as a
`CaptureSummary | null` prop and read as `captureSummary?.tweets ?? 0`.

`src/entrypoints/options/App.tsx`:

```tsx
  const [settings, setSettingsState] = useState<Settings | null>(null)
```
```tsx
  useEffect(() => {
    void getSettings().then(setSettingsState)
    const handleHash = () => {
```
```tsx
    setSettingsState(await setSettings(patch))
```
```tsx
  const reload = async (): Promise<void> => {
    setSettingsState(await getSettings())
  }
```
```tsx
          {settings ? <ActivePanel settings={settings} update={update} reload={reload} /> : null}
```

`src/entrypoints/options/panels/capture.tsx`:

```tsx
  const [summary, setSummary] = useState<CaptureSummary | null>(null)
```
```tsx
  useEffect(() => {
    void fetchCaptureSummary(0).then(setSummary)
  }, [])
```

`src/entrypoints/options/panels/archive.tsx`:

```tsx
  const [summary, setSummary] = useState<CaptureSummary | null>(null)
```
```tsx
  const refreshSummary = (): void => void fetchCaptureSummary(ARCHIVE_FETCH_LIMIT).then(setSummary)
  useEffect(refreshSummary, [])
```
```tsx
      setSummary({ tweets: 0, conversations: 0, recent: [] })
```
```tsx
        {summary === null ? (
          <FieldDescription>Loading…</FieldDescription>
```

`src/entrypoints/options/panels/history.tsx`:

```tsx
  const [history, setHistory] = useState<ReadonlyArray<DownloadRecord>>([])
```
```tsx
  useEffect(() => {
    void fetchHistory().then(setHistory)
  }, [])
```
```tsx
    setHistory([])
```

`src/entrypoints/options/panels/saving.tsx`:

```tsx
  const [usage, setUsage] = useState<BudgetRecord | null>(null)
```
```tsx
  const refreshUsage = async (): Promise<void> => {
    const stored = await budgetItem.getValue()
    setUsage(freshRecord(stored, Date.now()))
  }
  useEffect(() => {
    void refreshUsage()
  }, [])

  const resetToday = async (): Promise<void> => {
    await budgetItem.setValue(freshRecord(null, Date.now()))
    await refreshUsage()
  }
```

`src/components/capture-export.ts` resolves `null` when the worker does not
answer:

```ts
export const fetchCaptureSummary = (limit?: number): Promise<CaptureSummary | null> =>
  browser.runtime
    .sendMessage(
      limit === undefined
        ? { _tag: 'CaptureSummaryRequest' }
        : { _tag: 'CaptureSummaryRequest', limit },
    )
    .then((s: CaptureSummary | null) => {
      // …three comment lines…
      return s ?? null
    })
    .catch(() => null)
```

It has exactly three callers: the popup `App.tsx`, `capture.tsx`, and
`archive.tsx`.

### Conventions that apply

- Most tests here are source-text pins that read a `.tsx` file as a string.
  `src/entrypoints/popup/popup-layout.test.ts` pins the text
  `fetchCaptureSummary(3)`. Keep that exact text in `App.tsx`.
- Behavior tests that need no DOM are plain vitest. See
  `src/components/owned-timer.test.ts`.
- Never add `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or
  `@ts-expect-error`. Never use `unknown` in a parameter or return type.
- `satisfies` over a widening annotation. No `as` cast without a `// SAFETY:`
  comment. Prefer no cast.
- A hook must list every dependency. Do not keep "latest value" in a ref
  (`bun/react-no-latest-value-ref` is an error).
- Keep existing comments. A comment leaves only with the code it describes.
- Package manager is `bun`. Never `npm` or `npx`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0, no new warning |
| One test file | `bun run test src/components/use-loaded.test.ts` | all pass |
| All tests | `bun run test` | all pass |

## Scope

**In scope**:

- `src/components/use-loaded.ts` (create)
- `src/components/use-loaded.test.ts` (create)
- `src/components/capture-export.ts`
- `src/entrypoints/popup/App.tsx`
- `src/entrypoints/popup/capture-quick-actions.tsx` (prop type only, see Step 4)
- `src/entrypoints/options/App.tsx`
- `src/entrypoints/options/panels/capture.tsx`
- `src/entrypoints/options/panels/archive.tsx`
- `src/entrypoints/options/panels/history.tsx`
- `src/entrypoints/options/panels/saving.tsx`
- Test files beside those sources, only to update a pin that quotes text you
  changed
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- The popup effect that calls `browser.tabs.query`. It sets three states and
  `App.test.ts` pins its text.
- The popup metrics poll effect. `App.test.ts` pins it.
- The permission-check effects in `saving.tsx` and `sync.tsx`, and all of
  `sync.tsx`. Plan 048 owns them.
- The `hashchange` listener in `options/App.tsx`. Keep it in its effect.
- Background and worker code that answers `CaptureSummaryRequest`.

## Git workflow

- Branch: `advisor/047-load-mount-data-through-one-hook`
- One commit per step. Message style: `refactor(popup): …`, `refactor(options): …`.
- Do NOT push or open a PR unless the operator told you to.

## Steps

### Step 1: Write the failing tests for the load core

Create `src/components/use-loaded.test.ts`. It tests a pure function
`runLoad`, so it needs no DOM:

```ts
import { describe, expect, it } from 'vitest'
import { type Loaded, runLoad } from './use-loaded'

const collect = <T>(): { readonly seen: Loaded<T>[]; readonly push: (s: Loaded<T>) => void } => {
  const seen: Loaded<T>[] = []
  return { seen, push: (s) => seen.push(s) }
}

describe('runLoad', () => {
  it('reports Ready with the loaded value', async () => {
    const out = collect<number>()
    await runLoad(() => Promise.resolve(7), () => true, out.push)
    expect(out.seen).toEqual([{ _tag: 'Ready', value: 7 }])
  })

  it('reports Failed when the loader rejects', async () => {
    const out = collect<number>()
    await runLoad(() => Promise.reject(new Error('worker gone')), () => true, out.push)
    expect(out.seen).toEqual([{ _tag: 'Failed' }])
  })

  it('reports nothing once the owner is no longer active', async () => {
    const out = collect<number>()
    await runLoad(() => Promise.resolve(7), () => false, out.push)
    await runLoad(() => Promise.reject(new Error('late')), () => false, out.push)
    expect(out.seen).toEqual([])
  })
})
```

**Verify**: `bun run test src/components/use-loaded.test.ts` → FAILS, because
`./use-loaded` does not exist. That failure is the expected result.

### Step 2: Write the hook

Create `src/components/use-loaded.ts`:

```ts
import { useEffect, useState } from 'preact/hooks'

export type Loaded<T> =
  | { readonly _tag: 'Loading' }
  | { readonly _tag: 'Ready'; readonly value: T }
  | { readonly _tag: 'Failed' }

export interface LoadedHandle<T> {
  readonly state: Loaded<T>
  readonly reload: () => void
  readonly setValue: (value: T) => void
}

export const runLoad = async <T>(
  load: () => Promise<T>,
  isActive: () => boolean,
  report: (state: Loaded<T>) => void,
): Promise<void> => {
  try {
    const value = await load()
    if (isActive()) report({ _tag: 'Ready', value })
  } catch {
    if (isActive()) report({ _tag: 'Failed' })
  }
}

export const readyOr = <T>(state: Loaded<T>, fallback: T): T =>
  state._tag === 'Ready' ? state.value : fallback

/** Runs `load` on mount and on every `reload()`, and ignores a result that
 *  arrives after unmount or after a newer run started.
 *  @param load Must keep one identity for the component's lifetime. Pass a
 *  module-level function; an inline arrow restarts the load on every render. */
export function useLoaded<T>(load: () => Promise<T>): LoadedHandle<T> {
  const [state, setState] = useState<Loaded<T>>({ _tag: 'Loading' })
  const [run, setRun] = useState(0)
  useEffect(() => {
    let active = true
    void runLoad(load, () => active, setState)
    return () => {
      active = false
    }
  }, [load, run])
  return {
    state,
    reload: () => setRun((n) => n + 1),
    setValue: (value) => setState({ _tag: 'Ready', value }),
  }
}
```

If lint rejects the empty `catch` binding or the bare `catch`, keep the
behavior and satisfy the rule in code. Do not disable it.

**Verify**: `bun run test src/components/use-loaded.test.ts` → 3 pass.
Then `bun run typecheck && bun run lint` → exit 0.

### Step 3: Make `fetchCaptureSummary` reject instead of resolving `null`

In `src/components/capture-export.ts`:

1. Change the return type to `Promise<CaptureSummary>`.
2. Delete the trailing `.catch(() => null)`.
3. In the `.then`, replace `return s ?? null` with:

   ```ts
      if (s === null) throw new Error('The extension worker returned no capture summary.')
      return s
   ```

4. The comment inside the `.then` says "`.catch` below already covers that
   with `null`". That is now false. Reword that clause to say the promise
   rejects and `useLoaded` reports `Failed`.
5. Add near the top-level exports:

   ```ts
   export const EMPTY_CAPTURE_SUMMARY = {
     tweets: 0,
     conversations: 0,
     recent: [],
   } satisfies CaptureSummary
   ```

Typecheck now fails at the three callers. Steps 4–6 fix them.

**Verify**: `bun run typecheck` → errors only in `popup/App.tsx`,
`options/panels/capture.tsx`, and `options/panels/archive.tsx`.

### Step 4: Convert the popup

In `src/entrypoints/popup/App.tsx`:

1. Import `readyOr`, `useLoaded`, and the `Loaded` type from
   `@/components/use-loaded`, and `EMPTY_CAPTURE_SUMMARY` from
   `@/components/capture-export`.
2. At module level, above `App`, add (keep the two comment lines that sat in
   the old effect above this constant):

   ```tsx
   const loadPopupSummary = (): Promise<CaptureSummary> => fetchCaptureSummary(3)
   ```

3. Replace the three state lines and the three effects quoted in "Current
   state" with:

   ```tsx
   const settingsLoad = useLoaded(getSettings)
   const summaryLoad = useLoaded(loadPopupSummary)
   const introLoad = useLoaded(recordOpen)
   ```

4. Writers:
   - `setSettingsState(await setSettings(patch))` →
     `settingsLoad.setValue(await setSettings(patch))`
   - `markDone().then(setIntroState)` → `markDone().then(introLoad.setValue)`
   - `setCaptureSummary({ tweets: 0, conversations: 0, recent: [] })` →
     `summaryLoad.setValue(EMPTY_CAPTURE_SUMMARY)`
5. Replace `if (!settings) {` with
   `if (settingsLoad.state._tag !== 'Ready') {` and, right after that block,
   add `const settings = settingsLoad.state.value`. If any code above that
   line reads `settings`, move the read below it or read
   `settingsLoad.state` there. Do not reorder hook calls.
6. Change `shouldShowFirstRunIntro` to take `Loaded<FirstRunState>`:

   ```tsx
   function shouldShowFirstRunIntro(intro: Loaded<FirstRunState>, ctx: TabContext): boolean {
     if (intro._tag !== 'Ready' || !isXContext(ctx)) return false
     return shouldShowIntro(intro.value)
   }
   ```

   and pass `introLoad.state` at its call site.
7. Add `const captureSummary = readyOr(summaryLoad.state, EMPTY_CAPTURE_SUMMARY)`
   after the `settings` line. Change the two child-component props typed
   `CaptureSummary | null` to `CaptureSummary`, and replace
   `captureSummary?.tweets ?? 0` style reads with plain member reads. One of
   the two children is `CaptureQuickActions` in
   `src/entrypoints/popup/capture-quick-actions.tsx`. Change only its
   `summary` prop type and the null handling of that prop.

**Verify**: `bun run test src/entrypoints/popup` → all pass.
`export CODEDB_NO_HOOKS=1; rg -n 'CaptureSummary \| null|Settings \| null|FirstRunState \| null' src/entrypoints/popup`
→ no match.

### Step 5: Convert the options shell

In `src/entrypoints/options/App.tsx`:

1. Replace the `settings` state line with
   `const settingsLoad = useLoaded(getSettings)`.
2. Delete only the line `void getSettings().then(setSettingsState)` from the
   mount effect. The `hashchange` code stays.
3. `update`: `settingsLoad.setValue(await setSettings(patch))`.
4. `reload`: `settingsLoad.setValue(await getSettings())`.
5. Render:

   ```tsx
   {settingsLoad.state._tag === 'Ready' ? (
     <ActivePanel settings={settingsLoad.state.value} update={update} reload={reload} />
   ) : null}
   ```

Fix any other read of `settings` in this file the same way.

**Verify**: `bun run test src/entrypoints/options/App.test.ts` → all pass.

### Step 6: Convert the four panels

`capture.tsx`:

- Module level: `const loadCaptureCounts = (): Promise<CaptureSummary> => fetchCaptureSummary(0)`.
  Move the two comment lines from the old effect above it.
- In the component:
  `const summary = readyOr(useLoaded(loadCaptureCounts).state, EMPTY_CAPTURE_SUMMARY)`.
- `summary?.tweets ?? 0` → `summary.tweets`. Same for `conversations`.

`archive.tsx`:

- Module level:
  `const loadArchiveSummary = (): Promise<CaptureSummary> => fetchCaptureSummary(ARCHIVE_FETCH_LIMIT)`.
- In the component: `const summaryLoad = useLoaded(loadArchiveSummary)` and
  `const summary = readyOr(summaryLoad.state, EMPTY_CAPTURE_SUMMARY)`.
- Delete the `refreshSummary` line and `useEffect(refreshSummary, [])`.
  Replace every remaining call of `refreshSummary()` with
  `summaryLoad.reload()`.
- `setSummary({ tweets: 0, conversations: 0, recent: [] })` →
  `summaryLoad.setValue(EMPTY_CAPTURE_SUMMARY)`.
- `summary === null ? (<FieldDescription>Loading…</FieldDescription>)` becomes
  a three-way choice on `summaryLoad.state._tag`: `Loading` keeps
  `Loading…`; `Failed` renders
  `<FieldDescription>Could not load the archive. Reload this page.</FieldDescription>`;
  `Ready` renders what the non-null branch rendered. The repo bans nested
  ternaries, so write an early-return helper function at module level or an
  `if` chain that assigns a `const` body.
- Remove the `?.` and `?? 0` reads of `summary`.

`history.tsx`:

- `const historyLoad = useLoaded(fetchHistory)` and
  `const history = readyOr(historyLoad.state, EMPTY_HISTORY)` with a
  module-level `const EMPTY_HISTORY: ReadonlyArray<DownloadRecord> = []`.
- Delete the effect. `setHistory([])` → `historyLoad.setValue(EMPTY_HISTORY)`.

`saving.tsx`:

- Module level:

  ```tsx
  const loadUsage = async (): Promise<BudgetRecord> =>
    freshRecord(await budgetItem.getValue(), Date.now())
  ```

- In the component: `const usageLoad = useLoaded(loadUsage)`.
- Delete `refreshUsage` and its effect. In `resetToday`, replace
  `await refreshUsage()` with `usageLoad.reload()`.
- `usage ? … : 0` → read from `usageLoad.state` with `_tag === 'Ready'`.
  `usage?.count ?? 0` likewise.

Remove `useEffect` and `useState` imports that are now unused.

**Verify**: `bun run typecheck && bun run lint && bun run test` → exit 0.

## Test plan

- New: `src/components/use-loaded.test.ts`, three behavior tests (Step 1),
  seen failing before Step 2.
- Updated: any source-text pin that quotes a line you changed. Find them with
  `export CODEDB_NO_HOOKS=1; rg -n "setSettingsState|setCaptureSummary|setIntroState|refreshSummary|refreshUsage" src --glob '*.test.ts'`.
- Pattern: `src/components/owned-timer.test.ts`.

## Done criteria

ALL must hold:

- [ ] `bun run typecheck` exits 0
- [ ] `bun run lint` exits 0
- [ ] `bun run test` exits 0, including 3 tests in `use-loaded.test.ts`
- [ ] `export CODEDB_NO_HOOKS=1; rg -n 'useState<(Settings|CaptureSummary|FirstRunState|BudgetRecord) \| null>' src` → no match
- [ ] `export CODEDB_NO_HOOKS=1; rg -n 'fetchCaptureSummary\(3\)' src/entrypoints/popup/App.tsx` → one match
- [ ] `export CODEDB_NO_HOOKS=1; rg -c 'useEffect\(' src/entrypoints/options/panels/history.tsx src/entrypoints/options/panels/capture.tsx src/entrypoints/options/panels/archive.tsx` → no file listed
- [ ] `git status --short` shows no modified file outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- Quoted text in "Current state" is missing from the live file.
- `fetchCaptureSummary` has a caller other than the three named files. Check
  with `export CODEDB_NO_HOOKS=1; rg -n 'fetchCaptureSummary' src --glob '!*.test.ts'`.
- A hook would have to move below an early `return` to make Step 4 compile.
- A test pins text that this plan tells you to remove and the pin protects a
  safety property that you cannot restate against the new text.
- Lint can be cleared only by disabling, renaming, or moving code.

## Maintenance notes

- `useLoaded(load)` restarts when `load` changes identity. Always pass a
  module-level function.
- The archive panel now shows a failure line. Before this plan a dead worker
  left "Loading…" on screen forever. A reviewer should confirm the wording.
- Plan 048 converts the remaining nullable UI state. Plans 017, 020, and 022
  touch the same panels. Run them one at a time.
- Deferred: the popup tab-query effect could use `useLoaded` too. It is left
  alone because `App.test.ts` pins its body for ADR-0019.
