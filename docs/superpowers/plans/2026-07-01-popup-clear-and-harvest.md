# Popup: whole-list clear + harvest controls — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface clearing-the-browser and harvest-history controls directly in the extension popup, including a new "Clear entire list" auto-scroll sweep.

**Architecture:** One new pure core module (`core/clear/list-clear.ts`) holds the bounded auto-scroll/clear loop, reusing the `ScrollPort`/`Clock` seams from `scroll-drain.ts`; a thin content-script handler wires the live ports; the popup gains buttons/toggles that all message already-built handlers and settings. Everything but the whole-list sweep is UI wiring of existing capabilities.

**Tech Stack:** WXT + Preact (popup), Effect (`Option`), Vitest (fake-port unit tests + source-string popup tests), oxlint/tsgo via `bun run check`.

**Spec:** [docs/superpowers/specs/2026-07-01-popup-clear-and-harvest-design.md](../specs/2026-07-01-popup-clear-and-harvest-design.md)

**Branch:** Create `feat/popup-clear-and-harvest` off `main` before Task 1 (the repo's default branch is `main`; do not commit to it directly):

```bash
git checkout -b feat/popup-clear-and-harvest
```

**Commands used throughout:**
- Single test file: `bunx vitest run <path>`
- Full gate (format + lint + typecheck + tests): `bun run check`
- Coverage gate (100% over `src/core` + `src/lib`): `bun run test:coverage`

---

### Task 1: Whole-list clear core module

The bounded auto-scroll loop that clears every mounted post for the page scope, pass by pass, until the bottom. Pure + fully unit-tested (it lives under `src/core`, so it is on the 100% coverage gate). Reuses `ScrollPort`/`Clock` from `scroll-drain.ts`.

**Files:**
- Create: `src/core/clear/list-clear.ts`
- Test: `src/core/clear/list-clear.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/core/clear/list-clear.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeListClear, type ListClearDeps } from './list-clear'

const VIEWPORT = 800
const clamp = (v: number, maxY: number): number => Math.max(0, Math.min(maxY, v))

/**
 * A fake window-scroll + virtualized list. `layout` maps a postId to the absolute Y
 * where its article sits; a post is "mounted" when its Y falls in the current
 * viewport. `clearVisibleForPage` clears (deletes from `layout`) every mounted post
 * and returns the count — exactly what the real per-pass click sweep does.
 */
function harness(opts: { layout?: Record<string, number>; maxY?: number; path?: string }) {
  const layout: Record<string, number> = { ...(opts.layout ?? {}) }
  const maxY = opts.maxY ?? 4000
  const scroll = { y: 0 }
  const scrollCalls = { to: [] as number[], by: [] as number[] }
  const path = opts.path ?? '/someone/likes'

  const mounted = (): string[] =>
    Object.entries(layout)
      .filter(([, y]) => y >= scroll.y && y < scroll.y + VIEWPORT)
      .map(([id]) => id)

  const clearVisibleForPage = vi.fn(async (): Promise<number> => {
    const ids = mounted()
    for (const id of ids) delete layout[id]
    return ids.length
  })
  const report = vi.fn<ListClearDeps['report']>()

  const deps: ListClearDeps = {
    scroll: {
      position: () => scroll.y,
      to: (y) => {
        scrollCalls.to.push(y)
        scroll.y = clamp(y, maxY)
      },
      by: (dy) => {
        scrollCalls.by.push(dy)
        scroll.y = clamp(scroll.y + dy, maxY)
      },
      viewport: () => VIEWPORT,
    },
    clock: {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      after: (ms, fn) => {
        const h = setTimeout(fn, ms)
        return () => clearTimeout(h)
      },
    },
    path: () => path,
    clearVisibleForPage,
    report,
  }
  return { deps, scroll, scrollCalls, clearVisibleForPage, report }
}

const stagesOf = (report: ReturnType<typeof harness>['report']): string[] =>
  report.mock.calls.map((c) => c[0])

describe('makeListClear', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('scrolls the whole list top-to-bottom, clears every post, and restores scroll position', async () => {
    // Three posts spread down the list; the user is parked mid-list when it starts.
    const h = harness({ layout: { a: 0, b: 1500, c: 3000 }, maxY: 3200 })
    h.scroll.y = 2000
    const resP = makeListClear(h.deps).run()
    await vi.runAllTimersAsync()
    const res = await resP

    expect(res.cleared).toBe(3)
    expect(res.reason).toBeUndefined()
    expect(h.scrollCalls.to[0]).toBe(0) // jumped to the top first
    expect(h.scroll.y).toBe(2000) // restored to where the user was
    expect(stagesOf(h.report)).toContain('clear-list-start')
    expect(stagesOf(h.report)).toContain('clear-list-end')
  })

  it('returns not-list-page and never scrolls when off a Likes/Bookmarks list', async () => {
    const h = harness({ layout: { a: 0 }, path: '/home' })
    const res = await makeListClear(h.deps).run()

    expect(res).toEqual({ cleared: 0, reason: 'not-list-page' })
    expect(h.clearVisibleForPage).not.toHaveBeenCalled()
    expect(h.scrollCalls.to).toHaveLength(0)
    expect(h.scrollCalls.by).toHaveLength(0)
  })

  it('stops at the bottom after a run of stalls instead of running to the step cap', async () => {
    const h = harness({ layout: {}, maxY: 0 }) // empty list, can't scroll
    const resP = makeListClear(h.deps).run()
    await vi.runAllTimersAsync()
    const res = await resP

    expect(res.cleared).toBe(0)
    expect(h.scrollCalls.by.length).toBeGreaterThanOrEqual(3) // needed the stall run
    expect(h.scrollCalls.by.length).toBeLessThan(20) // nowhere near the 400-step cap
  })

  it('honors the step cap when clears never stop (pathological never-empty list)', async () => {
    const h = harness({ maxY: 1_000_000 })
    h.clearVisibleForPage.mockImplementation(async () => 1) // always one more to clear
    const resP = makeListClear(h.deps).run()
    await vi.runAllTimersAsync()
    const res = await resP

    expect(h.clearVisibleForPage).toHaveBeenCalledTimes(400) // MAX_STEPS backstop
    expect(res.cleared).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/core/clear/list-clear.test.ts`
Expected: FAIL — `Failed to resolve import './list-clear'` / `makeListClear is not defined`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/clear/list-clear.ts`:

```ts
/**
 * Whole-list clear: auto-scroll a Likes/Bookmarks list top-to-bottom, clicking
 * every mounted post's clear control on each pass, until the list is empty and the
 * bottom is reached. The sibling of `scroll-drain` — which clears a KNOWN set of
 * not-mounted ids — but this one owns no queue: it clears WHATEVER mounts for the
 * page scope, then stops when a run of passes both clear nothing and can't scroll.
 *
 * Same injected `ScrollPort` + `Clock` seams as the drain, so the bounded-step /
 * stall-detection / restore-position loop is testable with a fake scroller + fake
 * timers, never the real DOM.
 */
import { Option } from 'effect'
import { pageScope } from './clearer'
import type { Clock, ScrollPort } from './scroll-drain'

const SETTLE_MS = 600
const VIEWPORT_FRACTION = 0.9
const MAX_STEPS = 400
const BOTTOM_STALLS = 3

export interface ListClearDeps {
  readonly scroll: ScrollPort
  readonly clock: Clock
  /** Live pathname, read once at run start — a non-list page ends before any scroll. */
  readonly path: () => string
  /** Click the clear control on every mounted clearable post for the page's scope,
   *  paced one at a time; returns how many were clicked this pass. */
  readonly clearVisibleForPage: () => Promise<number>
  /** Progress trace sink (start / end). */
  readonly report: (stage: string, detail: string) => void
}

export interface ListClearResult {
  readonly cleared: number
  readonly reason?: 'not-list-page'
}

export interface ListClear {
  readonly run: () => Promise<ListClearResult>
}

export function makeListClear(deps: ListClearDeps): ListClear {
  const run = async (): Promise<ListClearResult> => {
    // Only Likes/Bookmarks have a clear scope — For You / profiles / search have no
    // membership to remove, and the sweep must never hijack scrolling there.
    if (Option.isNone(pageScope(deps.path()))) {
      deps.report('clear-list-skip', 'not a Likes/Bookmarks list')
      return { cleared: 0, reason: 'not-list-page' }
    }
    const startY = deps.scroll.position()
    let cleared = 0
    let noProgress = 0
    deps.report('clear-list-start', 'scanning the list from the top')
    try {
      deps.scroll.to(0)
      await deps.clock.sleep(SETTLE_MS)
      // oxlint-disable no-await-in-loop -- a paced scroll pass, one viewport at a time
      for (let step = 0; step < MAX_STEPS; step++) {
        const clearedThisStep = await deps.clearVisibleForPage()
        cleared += clearedThisStep
        await deps.clock.sleep(SETTLE_MS)
        const before = deps.scroll.position()
        deps.scroll.by(Math.round(deps.scroll.viewport() * VIEWPORT_FRACTION))
        await deps.clock.sleep(SETTLE_MS)
        const advanced = deps.scroll.position() > before
        // The bottom is "nothing cleared AND scroll can't advance", sustained over a
        // run of passes so a lazy virtualized re-render doesn't end the scan early.
        if (clearedThisStep === 0 && !advanced) {
          noProgress += 1
          if (noProgress >= BOTTOM_STALLS) break
        } else {
          noProgress = 0
        }
      }
      // oxlint-enable no-await-in-loop
    } finally {
      deps.scroll.to(startY) // put the user back where they were
      deps.report('clear-list-end', `cleared ${cleared}`)
    }
    return { cleared }
  }
  return { run }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/core/clear/list-clear.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/clear/list-clear.ts src/core/clear/list-clear.test.ts
git commit -m "feat(clear): bounded auto-scroll whole-list clear core module"
```

---

### Task 2: Extract the shared per-pass clear helper

Pull the inner click loop out of `handleClearVisible` into a reusable `clearMountedForScope` so the one-shot visible clear and the whole-list sweep share one click path. Pure relocation — behavior identical.

**Files:**
- Modify: `src/entrypoints/overlay.content/handlers.ts`

- [ ] **Step 1: Add the shared helper**

In `src/entrypoints/overlay.content/handlers.ts`, first extend the existing import from `../../core/clear/clearer` to add `MembershipScope` (it currently imports `TWEET_ARTICLE_SEL, clearControl, clearableScope, findArticle, isMember, pageScope, shouldClickScope, tweetIdOfArticle`):

```ts
import {
  TWEET_ARTICLE_SEL,
  clearControl,
  clearableScope,
  findArticle,
  isMember,
  pageScope,
  shouldClickScope,
  tweetIdOfArticle,
  type MembershipScope,
} from '../../core/clear/clearer'
```

Then add this helper just above `handleClearVisible`:

```ts
/** Click the clear control on every mounted post that is a clearable member of
 *  `scope`, paced one click at a time so X registers each. Returns how many were
 *  clicked. Shared by the one-shot visible clear and the whole-list scroll sweep. */
export async function clearMountedForScope(
  document: Document,
  scope: MembershipScope,
  paceMs: number,
): Promise<number> {
  let cleared = 0
  // oxlint-disable no-await-in-loop -- paced one-at-a-time bulk clear
  for (const article of document.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const ctrl = clearControl(article, scope)
    if (ctrl === null) continue
    const target = (ctrl.closest('button,[role="button"]') as HTMLElement | null) ?? ctrl
    target.click()
    cleared++
    await new Promise((r) => setTimeout(r, paceMs))
  }
  // oxlint-enable no-await-in-loop
  return cleared
}
```

- [ ] **Step 2: Refactor `handleClearVisible` to use it**

Replace the body of `handleClearVisible`'s async IIFE (the `let cleared = 0` … `for (const article …)` loop) so it delegates to the helper. The full handler becomes:

```ts
export const handleClearVisible: MessageHandler = (_message, deps, sendResponse) => {
  // List-scoped: only ever clear the list you're ON — Likes page un-likes,
  // Bookmarks page un-bookmarks. Never both at once.
  const scope = pageScope(deps.location.pathname)
  if (import.meta.env.DEV)
    deps.clearLog(
      'clear-visible request · page scope =',
      Option.getOrElse(scope, () => '(not a Likes/Bookmarks page)'),
    )
  void (async () => {
    if (Option.isNone(scope)) {
      sendResponse({ _tag: 'ClearVisibleResponse', cleared: 0 })
      return
    }
    const cleared = await clearMountedForScope(deps.document, scope.value, 350)
    if (import.meta.env.DEV) deps.clearLog('clear-visible done · cleared', cleared, scope.value)
    sendResponse({ _tag: 'ClearVisibleResponse', cleared })
  })()
  return true
}
```

- [ ] **Step 3: Verify nothing broke**

Run: `bunx vitest run src/entrypoints/overlay.content/handlers.test.ts`
Expected: PASS (existing handler tests unchanged; the refactor is behavior-identical).

- [ ] **Step 4: Commit**

```bash
git add src/entrypoints/overlay.content/handlers.ts
git commit -m "refactor(clear): extract clearMountedForScope shared by visible + whole-list clear"
```

---

### Task 3: Whole-list clear content handler + dispatch registration

Wire the live window/document/timer ports into `makeListClear` and register `ClearWholeListRequest`.

**Files:**
- Modify: `src/entrypoints/overlay.content/handlers.ts`

- [ ] **Step 1: Import the core module**

At the top of `handlers.ts`, add next to the other core imports:

```ts
import { makeListClear } from '../../core/clear/list-clear'
```

- [ ] **Step 2: Add the handler**

Add `handleClearWholeList` just below `handleClearVisible`:

```ts
// "Clear entire list" (popup): auto-scroll the whole Likes/Bookmarks list and click
// every post's clear control as it mounts — a list-scoped, download-free bulk clear.
// The bounded scroll loop lives in core/clear/list-clear; here we wire the live
// window/document/timer ports + the shared per-pass clear.
export const handleClearWholeList: MessageHandler = (_message, deps, sendResponse) => {
  const scope = pageScope(deps.location.pathname)
  if (Option.isNone(scope)) {
    sendResponse({ _tag: 'ClearWholeListResponse', cleared: 0, reason: 'not-list-page' })
    return true
  }
  const view = deps.document.defaultView ?? window
  const listClear = makeListClear({
    scroll: {
      position: () => view.scrollY,
      to: (y) => view.scrollTo(0, y),
      by: (dy) => view.scrollBy(0, dy),
      viewport: () => view.innerHeight,
    },
    clock: {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      after: (ms, fn) => {
        const h = setTimeout(fn, ms)
        return () => clearTimeout(h)
      },
    },
    path: () => deps.location.pathname,
    clearVisibleForPage: () => clearMountedForScope(deps.document, scope.value, 350),
    report: (stage, detail) => {
      if (import.meta.env.DEV) deps.clearLog(stage, detail)
    },
  })
  void (async () => {
    const result = await listClear.run()
    sendResponse({ _tag: 'ClearWholeListResponse', ...result })
  })()
  return true
}
```

- [ ] **Step 3: Register in the dispatch table**

In `messageHandlers` at the bottom of `handlers.ts`, add the entry next to `ClearVisibleRequest`:

```ts
export const messageHandlers: Record<string, MessageHandler> = {
  TransferOutcome: handleTransferOutcome,
  RefreshMediaUrlRequest: handleRefreshMediaUrl,
  ClearVisibleRequest: handleClearVisible,
  ClearWholeListRequest: handleClearWholeList,
  DrainPageRequest: handleDrainPage,
  SweepPageRequest: handleSweepPage,
  ClearTweetRequest: handleClearTweet,
  ClearDetectedMediaRequest: handleClearDetectedMedia,
}
```

- [ ] **Step 4: Verify typecheck + existing tests**

Run: `bun run check`
Expected: PASS (format, lint, typecheck, and all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints/overlay.content/handlers.ts
git commit -m "feat(clear): ClearWholeListRequest handler wiring the auto-scroll sweep"
```

---

### Task 4: Popup — "Clear entire list" action

Add the popup button (list-page-gated, single confirm) that triggers the new handler.

**Files:**
- Modify: `src/entrypoints/popup/App.tsx`
- Test: `src/entrypoints/popup/popup-layout.test.ts`

- [ ] **Step 1: Write the failing source-string test**

In `src/entrypoints/popup/popup-layout.test.ts`, add a new `describe` block at the end:

```ts
describe('popup hosts whole-list clear', () => {
  it('offers a list-page-gated whole-list clear that messages the new handler', () => {
    expect(popupSource).toContain('ClearWholeListRequest')
    expect(popupSource).toContain('Clear entire list')
    expect(popupSource).toContain('onListPage')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/entrypoints/popup/popup-layout.test.ts`
Expected: FAIL — substrings `ClearWholeListRequest` / `Clear entire list` / `onListPage` not found.

- [ ] **Step 3: Implement in `App.tsx`**

a) Add imports at the top (extend existing). Add `Option` from effect and `pageScope`:

```ts
import { Option } from 'effect'
import { pageScope } from '@/core/clear/clearer'
```

b) Add an `onListPage` state next to `onXTab`:

```ts
  const [onListPage, setOnListPage] = useState(false)
```

c) In the effect that computes `onXTab` (the `browser.tabs.query` block), set `onListPage` too:

```ts
        const tab = tabs[0]
        if (!tab) return
        const url = tab.url ?? ''
        setOnXTab(isXUrl(url))
        try {
          setOnListPage(isXUrl(url) && Option.isSome(pageScope(new URL(url).pathname)))
        } catch {
          setOnListPage(false)
        }
```

d) Add a `usePageAction` for the whole-list clear, next to the existing `clearVisible` hook:

```ts
  // Whole-list clear: auto-scroll the entire Likes/Bookmarks list and un-like /
  // un-bookmark every post — heavier and irreversible, so it carries the strongest
  // confirm and is gated to list pages.
  const clearWholeList = usePageAction<{ cleared?: number; reason?: string }>({
    confirm:
      'Un-like / un-bookmark EVERY post on this list by scrolling through all of it? ' +
      'This can affect hundreds of posts and cannot be undone.',
    request: { _tag: 'ClearWholeListRequest' },
    format: (res) => {
      if (res?.reason === 'not-list-page') return 'Open a Likes or Bookmarks list to clear it.'
      const n = res?.cleared ?? 0
      return n === 0 ? 'No posts to clear on this list.' : `Cleared ${plural(n, 'post')} across the list.`
    },
  })
```

e) In the "On this page" `Card`, add the button just after the existing "Clear this page now" ghost `Button` (before the `{(drain.msg || sweep.msg || clearVisible.msg) && …}` status paragraph):

```tsx
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="w-full gap-1.5"
              disabled={!onListPage || clearWholeList.busy}
              title={!onListPage ? 'Open a Likes or Bookmarks list' : undefined}
              onClick={() => void clearWholeList.run()}
            >
              <EraserIcon className="size-3.5" />
              {clearWholeList.busy ? 'Clearing entire list…' : 'Clear entire list (no download)'}
            </Button>
```

f) Add `clearWholeList.msg` to that status paragraph's condition and fallback chain:

```tsx
            {(drain.msg || sweep.msg || clearVisible.msg || clearWholeList.msg) && (
              <p className="text-xs leading-snug text-muted-foreground">
                {drain.msg ?? sweep.msg ?? clearVisible.msg ?? clearWholeList.msg}
              </p>
            )}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/entrypoints/popup/popup-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints/popup/App.tsx src/entrypoints/popup/popup-layout.test.ts
git commit -m "feat(popup): Clear entire list action gated to Likes/Bookmarks pages"
```

---

### Task 5: Popup — per-surface clear toggles

Surface `autoUnbookmarkOnSave` / `autoUnlikeOnSave` / `autoNotInterestedOnSave` in the popup when clear-on-save is on, replacing the "Manage in settings" deep-link.

**Files:**
- Modify: `src/entrypoints/popup/App.tsx`
- Test: `src/entrypoints/popup/popup-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `popup-layout.test.ts`:

```ts
describe('popup hosts per-surface clear toggles', () => {
  it('binds the three clear-on-save surface toggles', () => {
    expect(popupSource).toContain('autoUnbookmarkOnSave')
    expect(popupSource).toContain('autoUnlikeOnSave')
    expect(popupSource).toContain('autoNotInterestedOnSave')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/entrypoints/popup/popup-layout.test.ts`
Expected: FAIL — the `auto*OnSave` substrings are absent.

- [ ] **Step 3: Implement in `App.tsx`**

a) Add a small `ScopeToggle` helper component at the bottom of the file, next to `Stat`:

```tsx
function ScopeToggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <FieldContent>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
      </FieldContent>
      <Switch id={id} aria-label={label} checked={checked} onCheckedChange={onChange} />
    </Field>
  )
}
```

b) In the clear-config `Card` (the one holding the `clearOnSave` `Switch`), replace the `{clearScopeNote && ( … )}` block with the three toggles shown when clear-on-save is on:

```tsx
            {settings.clearOnSave && (
              <div className="grid gap-2">
                <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
                  CLEAR FROM
                </span>
                <ScopeToggle
                  id="autoUnbookmarkOnSave"
                  label="Bookmarks (un-bookmark)"
                  checked={settings.autoUnbookmarkOnSave}
                  onChange={(v) => void update({ autoUnbookmarkOnSave: v })}
                />
                <ScopeToggle
                  id="autoUnlikeOnSave"
                  label="Likes (un-like)"
                  checked={settings.autoUnlikeOnSave}
                  onChange={(v) => void update({ autoUnlikeOnSave: v })}
                />
                <ScopeToggle
                  id="autoNotInterestedOnSave"
                  label="For You (Not interested)"
                  checked={settings.autoNotInterestedOnSave}
                  onChange={(v) => void update({ autoNotInterestedOnSave: v })}
                />
              </div>
            )}
```

c) Remove the now-unused `clearScopeNote` / `clearSurfaces` computation (the lines building `clearSurfaces` and `clearScopeNote` above the `return`) since the deep-link they fed is gone. If `openOptions` becomes unused after this, leave it — it is still used by the header gear button and footer link.

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/entrypoints/popup/popup-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints/popup/App.tsx src/entrypoints/popup/popup-layout.test.ts
git commit -m "feat(popup): per-surface clear-on-save toggles inline in the popup"
```

---

### Task 6: Popup — Local data wipes

A new "Local data" card with confirm-gated buttons that send the existing `ClearHistoryRequest` / `ClearCaptureRequest`.

**Files:**
- Modify: `src/entrypoints/popup/App.tsx`
- Test: `src/entrypoints/popup/popup-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `popup-layout.test.ts`:

```ts
describe('popup hosts local-data wipes', () => {
  it('offers confirm-gated wipes for download history and the harvest archive', () => {
    expect(popupSource).toContain('ClearHistoryRequest')
    expect(popupSource).toContain('ClearCaptureRequest')
    expect(popupSource).toContain('Clear download history')
    expect(popupSource).toContain('Clear harvest archive')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/entrypoints/popup/popup-layout.test.ts`
Expected: FAIL — none of those substrings exist yet.

- [ ] **Step 3: Implement in `App.tsx`**

a) Add the two handlers next to the existing `clearMonitor`:

```ts
  const clearLocalHistory = async (): Promise<void> => {
    if (!confirm('Delete the local download history? Files already saved to disk are untouched.'))
      return
    await browser.runtime.sendMessage({ _tag: 'ClearHistoryRequest' }).catch(() => {})
    setHistory([])
  }

  const clearLocalHarvest = async (): Promise<void> => {
    if (!confirm('Delete the entire harvested-tweet archive? This cannot be undone.')) return
    await browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' }).catch(() => {})
    setCaptureSummary({ tweets: 0, conversations: 0, recent: [] })
  }
```

b) Add the card in `<main>`, just before the `{recent.length > 0 && ( … )}` Recent-downloads card:

```tsx
        <Card size="sm" aria-label="Local data">
          <CardHeader className="gap-0.5">
            <CardTitle className="text-[13px] font-semibold">Local data</CardTitle>
            <CardDescription className="text-xs leading-snug">
              Wipe this extension’s stored data. Never deletes files on disk.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full gap-2"
              onClick={() => void clearLocalHistory()}
            >
              <EraserIcon className="size-4" />
              Clear download history
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full gap-2"
              onClick={() => void clearLocalHarvest()}
            >
              <EraserIcon className="size-4" />
              Clear harvest archive
            </Button>
          </CardContent>
        </Card>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/entrypoints/popup/popup-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints/popup/App.tsx src/entrypoints/popup/popup-layout.test.ts
git commit -m "feat(popup): Local data card to clear download history + harvest archive"
```

---

### Task 7: Popup — harvest toggle, conversation list, per-conversation exports

Make the Knowledge Capture card always render; add the harvest on/off toggle, the harvested-conversation list, and per-conversation tree/Markdown exports.

**Files:**
- Modify: `src/entrypoints/popup/App.tsx`
- Test: `src/entrypoints/popup/popup-layout.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `popup-layout.test.ts`:

```ts
describe('popup hosts harvest controls', () => {
  it('lets harvesting be toggled and exported per conversation from the popup', () => {
    expect(popupSource).toContain('captureEnabled')
    expect(popupSource).toContain('exportConvo')
    expect(popupSource).toContain("exportConvo('tree'")
    expect(popupSource).toContain("exportConvo('markdown'")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/entrypoints/popup/popup-layout.test.ts`
Expected: FAIL — `captureEnabled` / `exportConvo` not present.

- [ ] **Step 3: Implement in `App.tsx`**

a) Extend the `@/components/capture-export` import to add the `CaptureExportKind` type:

```ts
import {
  fetchCaptureSummary,
  runCaptureExport,
  type CaptureExportKind,
  type CaptureSummary,
} from '@/components/capture-export'
```

b) Add a per-conversation export handler next to the existing `exportHarvest`:

```ts
  const exportConvo = async (kind: CaptureExportKind, conversationId: string): Promise<void> => {
    const outcome = await runCaptureExport(kind, conversationId)
    setCaptureMsg(outcome.detail)
    setTimeout(() => setCaptureMsg(null), 5000)
  }
```

c) Replace the entire existing Knowledge Capture block — `{(settings.captureEnabled || (captureSummary?.tweets ?? 0) > 0) && ( <Card …Knowledge Capture…> … </Card> )}` — with an always-rendered card:

```tsx
        <Card size="sm" aria-label="Knowledge Capture">
          <CardHeader className="gap-0.5">
            <CardTitle className="text-[13px] font-semibold">Knowledge Capture</CardTitle>
            <CardDescription className="text-xs leading-snug">
              {captureSummary?.tweets ?? 0} tweets · {captureSummary?.conversations ?? 0}{' '}
              conversations harvested locally
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2.5">
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="captureEnabled">Harvest tweets</FieldLabel>
                <FieldDescription>Save the text and metadata of tweets you view</FieldDescription>
              </FieldContent>
              <Switch
                id="captureEnabled"
                aria-label="Harvest tweets"
                checked={settings.captureEnabled}
                onCheckedChange={(checked: boolean) => void update({ captureEnabled: checked })}
              />
            </Field>

            {(captureSummary?.recent ?? []).length > 0 && (
              <ol className="grid gap-1.5" aria-label="Harvested conversations">
                {(captureSummary?.recent ?? []).map((c) => (
                  <li
                    key={c.conversationId}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <div className="grid min-w-0 gap-0.5">
                      <span className="truncate font-medium">@{c.rootHandle}</span>
                      <span className="truncate text-muted-foreground">{c.rootText}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void exportConvo('tree', c.conversationId)}
                      >
                        Tree
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void exportConvo('markdown', c.conversationId)}
                      >
                        MD
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            )}

            <Button
              type="button"
              variant="outline"
              className="h-9 w-full gap-2"
              disabled={(captureSummary?.tweets ?? 0) === 0}
              onClick={() => void exportHarvest()}
            >
              <DownloadIcon className="size-4" />
              Export all (JSONL)
            </Button>
            {captureMsg && (
              <p className="text-xs leading-snug text-muted-foreground">{captureMsg}</p>
            )}
          </CardContent>
        </Card>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run src/entrypoints/popup/popup-layout.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/entrypoints/popup/App.tsx src/entrypoints/popup/popup-layout.test.ts
git commit -m "feat(popup): harvest on/off toggle, conversation list, per-conversation exports"
```

---

### Task 8: Full gate + build verification

Confirm the whole change passes the project gates and the extension still builds.

**Files:** none (verification only)

- [ ] **Step 1: Run the full check gate**

Run: `bun run check`
Expected: PASS — oxfmt, oxlint, `tsgo --noEmit`, and the full Vitest suite all green. Fix any formatting/lint nits inline (e.g. run `bunx oxfmt src` if formatting fails) and re-run.

- [ ] **Step 2: Run the coverage gate**

Run: `bun run test:coverage`
Expected: PASS — 100% over `src/core` + `src/lib`. `src/core/clear/list-clear.ts` must be fully covered by Task 1's tests (the new entrypoint/popup code is outside the gate by design).

- [ ] **Step 3: Build the extension**

Run: `bun run build` (or the project's WXT build script if named differently — check `package.json` `scripts`).
Expected: a successful production build with no type/bundle errors.

- [ ] **Step 4: Final commit (if anything changed in Steps 1–3)**

```bash
git add -A
git commit -m "chore(popup): pass format/lint/typecheck/coverage gates for clear + harvest controls"
```

---

## Manual verification (not automated)

After the gates pass, the change is **not browser-verified** until someone loads the unpacked build and confirms on a real X tab:
1. On a **Likes** page: popup shows "Clear entire list" enabled; clicking it confirms, auto-scrolls the list, and the list empties; scroll position is restored.
2. On the **For You** feed: "Clear entire list" is disabled with the list-page hint.
3. Per-surface clear toggles persist (reopen the popup) and match Settings.
4. "Clear download history" / "Clear harvest archive" wipe their data after confirm; files on disk untouched.
5. Harvest toggle flips `captureEnabled`; the conversation list and Tree/MD exports download files.

Flag this in the PR description as the remaining manual step.

## Self-review notes (already reconciled)

- **Spec coverage:** every spec section maps to a task — whole-list core (T1), shared helper (T2), handler+dispatch (T3), popup whole-list button (T4), per-surface toggles (T5), local-data wipes (T6), harvest toggle/list/exports (T7), gates (T8).
- **Type consistency:** `clearMountedForScope(document, scope: MembershipScope, paceMs)` is defined in T2 and consumed unchanged in T3; `makeListClear` / `ListClearDeps` / `ListClearResult` defined in T1 and consumed in T3; `ClearWholeListRequest` / `ClearWholeListResponse` `_tag`s match across handler (T3) and popup (T4); `CaptureExportKind` imported in T7 matches `exportConvo`'s signature.
- **No placeholders:** every code step shows complete code; commands have expected output.
