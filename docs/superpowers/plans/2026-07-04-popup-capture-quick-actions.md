# Popup Capture Quick Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inline, collapsed-by-default "Recent" disclosure to the popup's Capture row that reveals the 3 most recent captured conversations (with per-row export links) plus "Export all · JSONL" and a confirm-gated "Clear archive…" — so harvesting tweets no longer requires opening the full Settings tab.

**Architecture:** A new self-contained Preact component, `src/entrypoints/popup/capture-quick-actions.tsx`, renders the disclosure and calls the already-existing `fetchCaptureSummary`/`runCaptureExport` helpers (`src/components/capture-export.ts`) plus the already-handled `ClearCaptureRequest` background message — no new messages, no backend changes. `App.tsx` bumps its summary fetch from `limit=0` to `limit=3` and renders the new component under the existing Capture `Field`. Both changes are verified with the codebase's established convention for these entrypoint files: `popup-layout.test.ts` reads the `.tsx` source as text and asserts on it with `toContain`/`not.toContain` (see the existing `popupSource`/`generalSource` consts) — this codebase does not render/mount these popup components in tests (confirmed: no `@testing-library` usage anywhere under `src/entrypoints/popup/`).

**Tech Stack:** Preact (via `preact/hooks`), WXT (`browser.*` ambient global), Vitest, TypeScript (`tsgo`), oxlint/oxfmt.

**Spec:** [`docs/superpowers/specs/2026-07-04-popup-capture-quick-actions-design.md`](../specs/2026-07-04-popup-capture-quick-actions-design.md)

---

### Task 1: Create the `CaptureQuickActions` component

**Files:**
- Create: `src/entrypoints/popup/capture-quick-actions.tsx`
- Modify: `src/entrypoints/popup/popup-layout.test.ts:1-9` (add a source-read const), and append a new `describe` block at the end of the file (after line 153)

- [ ] **Step 1: Write the failing test**

In `src/entrypoints/popup/popup-layout.test.ts`, add a new source-read const alongside the existing ones (after line 9, `const generalSource = ...`):

```ts
const captureQuickActionsSource = readFileSync(
  'src/entrypoints/popup/capture-quick-actions.tsx',
  'utf8',
)
```

Then append this new `describe` block at the very end of the file (after the last block, `describe('popup folds monitor-clear into the monitor block', ...)` which currently ends at line 153):

```ts
describe('CaptureQuickActions renders a popup-sized recent-archive disclosure', () => {
  it('starts collapsed, is hidden with nothing captured, and wires export + clear', () => {
    expect(captureQuickActionsSource).toContain('useState(false)')
    expect(captureQuickActionsSource).toContain('if (tweets === 0) return null')
    expect(captureQuickActionsSource).toContain("runCaptureExport('jsonl')")
    expect(captureQuickActionsSource).toContain("runCaptureExport('tree'")
    expect(captureQuickActionsSource).toContain("runCaptureExport('markdown'")
    expect(captureQuickActionsSource).toContain("_tag: 'ClearCaptureRequest'")
    expect(captureQuickActionsSource).toContain('Export all')
    expect(captureQuickActionsSource).toContain('Clear archive')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/entrypoints/popup/popup-layout.test.ts`
Expected: the whole file errors out (not just the new block) with something like:
```
ENOENT: no such file or directory, open 'src/entrypoints/popup/capture-quick-actions.tsx'
```
This is the expected red state — `capture-quick-actions.tsx` doesn't exist yet, so the module-level `readFileSync` throws before any test in the file can run.

- [ ] **Step 3: Write the component**

Create `src/entrypoints/popup/capture-quick-actions.tsx`:

```tsx
import { useState } from 'preact/hooks'
import { EraserIcon } from '@/components/icons'
import {
  fetchCaptureSummary,
  runCaptureExport,
  type CaptureSummary,
} from '@/components/capture-export'

// Keep this in sync with the eager fetch in App.tsx (fetchCaptureSummary(3)) —
// the popup asks the background for exactly this many recent conversations, so
// slicing here is a defensive no-op, not a real pagination cut.
const RECENT_LIMIT = 3

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`

const fmtDay = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

interface CaptureQuickActionsProps {
  readonly summary: CaptureSummary | null
  /** Called after a successful clear so the parent can zero its own captureSummary
   *  state (mirrors the reset the Archive settings panel does locally). */
  readonly onCleared: () => void
}

/** Popup-sized quick actions for the harvest archive: a collapsed disclosure that,
 *  once opened, shows the most recent conversations (with per-row export links)
 *  plus a bulk "Export all" and a confirm-gated "Clear archive…" — all without
 *  leaving the popup for the full Archive settings tab. Renders nothing until
 *  something has actually been captured. */
export function CaptureQuickActions({ summary, onCleared }: CaptureQuickActionsProps) {
  const [open, setOpen] = useState(false)
  const [statusMsg, setStatusMsg] = useState<string | null>(null)

  const tweets = summary?.tweets ?? 0
  if (tweets === 0) return null

  const flashStatus = (msg: string): void => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(null), 5000)
  }

  const doExport = async (kind: 'jsonl' | 'tree' | 'markdown', conversationId?: string) => {
    const outcome = await runCaptureExport(kind, conversationId)
    flashStatus(outcome.detail)
  }

  // Fire-and-forget, matching the Archive settings panel's clearArchive: the
  // local reset + status message happen unconditionally, since ClearCaptureRequest
  // is a durable local wipe with no partial-failure mode worth branching on.
  const clearArchive = async (): Promise<void> => {
    if (!confirm(`Delete all ${plural(tweets, 'captured tweet')}? This cannot be undone.`)) return
    await browser.runtime.sendMessage({ _tag: 'ClearCaptureRequest' }).catch(() => {})
    onCleared()
    flashStatus(`Cleared ${plural(tweets, 'tweet')} from the archive.`)
  }

  const recent = (summary?.recent ?? []).slice(0, RECENT_LIMIT)

  return (
    <div className="grid gap-2 border-t border-border pt-3">
      <button
        type="button"
        className="flex items-center justify-between text-xs font-medium text-foreground/80 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        Recent
        <span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
      </button>

      {open && (
        <div className="grid gap-2.5">
          {recent.length > 0 ? (
            <ol className="grid gap-2" aria-label="Recently captured conversations">
              {recent.map((c) => (
                <li key={c.conversationId} className="grid gap-0.5 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      <span className="font-medium">@{c.rootHandle}</span>
                      <span className="font-mono text-muted-foreground">
                        {' '}
                        · {plural(c.count, 'tweet')} · {fmtDay(c.lastAt)}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => void doExport('tree', c.conversationId)}
                      >
                        JSON
                      </button>
                      <span aria-hidden="true" className="text-muted-foreground">
                        ·
                      </span>
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => void doExport('markdown', c.conversationId)}
                      >
                        Markdown
                      </button>
                    </span>
                  </div>
                  <span className="truncate text-muted-foreground">{c.rootText}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing captured yet.</p>
          )}

          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => void doExport('jsonl')}
            >
              Export all · JSONL
            </button>
            <button
              type="button"
              className="flex items-center gap-1 text-xs font-medium text-destructive hover:underline"
              onClick={() => void clearArchive()}
            >
              <EraserIcon className="size-3.5" />
              Clear archive…
            </button>
          </div>

          {statusMsg && (
            <p aria-live="polite" className="text-xs leading-snug text-muted-foreground">
              {statusMsg}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/entrypoints/popup/popup-layout.test.ts`
Expected: all tests in the file PASS, including the new `CaptureQuickActions renders a popup-sized recent-archive disclosure` block.

- [ ] **Step 5: Typecheck and lint the new file**

Run: `bun run typecheck && bun run lint`
Expected: no errors. (`CaptureQuickActions` is not imported anywhere yet, so this only checks the new file compiles and lints cleanly in isolation — an unused-export warning is expected and fine, since Task 2 wires it in.)

- [ ] **Step 6: Commit**

```bash
git add src/entrypoints/popup/capture-quick-actions.tsx src/entrypoints/popup/popup-layout.test.ts
git commit -m "feat(popup): add CaptureQuickActions disclosure (export + clear, not yet wired)"
```

---

### Task 2: Wire `CaptureQuickActions` into the popup

**Files:**
- Modify: `src/entrypoints/popup/App.tsx:15` (import), `App.tsx:226-229` (fetch limit), `App.tsx:469-476` (render)
- Modify: `src/entrypoints/popup/popup-layout.test.ts:117-144` (flip the two stale assertions)

- [ ] **Step 1: Write the failing tests (flip the stale assertions)**

In `src/entrypoints/popup/popup-layout.test.ts`, replace the block currently at lines 117-124:

```ts
describe('popup local-data wipes moved to Settings', () => {
  it('no longer offers download-history or harvest-archive wipes from the popup', () => {
    expect(popupSource).not.toContain('ClearHistoryRequest')
    expect(popupSource).not.toContain('ClearCaptureRequest')
    expect(popupSource).not.toContain('Clear download history')
    expect(popupSource).not.toContain('Clear harvest archive')
  })
})
```

with:

```ts
describe('popup local data: history wipe stays in Settings, harvest wipe moves inline', () => {
  it('does not offer a download-history wipe from the popup', () => {
    expect(popupSource).not.toContain('ClearHistoryRequest')
    expect(popupSource).not.toContain('Clear download history')
  })

  it('offers a harvest-archive wipe via the inline CaptureQuickActions component', () => {
    expect(popupSource).toContain('CaptureQuickActions')
    expect(captureQuickActionsSource).toContain('ClearCaptureRequest')
  })
})
```

Then, in the same file, replace the block currently at lines 126-144:

```ts
describe('popup hosts a minimal capture toggle', () => {
  it('lets capturing be toggled from the popup', () => {
    expect(popupSource).toContain('captureEnabled')
    expect(popupSource).toContain('Capture tweets')
  })

  it('no longer hosts the captured-conversation list or per-conversation exports (moved to Settings)', () => {
    expect(popupSource).not.toContain('exportConvo')
    expect(popupSource).not.toContain('Export all (JSONL)')
  })

  it('surfaces the archive size as a deep link into the Knowledge Capture settings panel', () => {
    expect(popupSource).toContain('captureSummary?.tweets')
    // openOptionsPage always lands on General; the capture card must deep-link
    // straight to #capture so the options app opens on the Capture panel.
    expect(popupSource).toContain("openOptionsSection('capture')")
    expect(popupSource).toContain('openCaptureArchive')
  })
})
```

with:

```ts
describe('popup hosts a minimal capture toggle', () => {
  it('lets capturing be toggled from the popup', () => {
    expect(popupSource).toContain('captureEnabled')
    expect(popupSource).toContain('Capture tweets')
  })

  it('hosts a trimmed (3-row) recent-conversation list with per-conversation exports via CaptureQuickActions', () => {
    expect(popupSource).toContain('fetchCaptureSummary(3)')
    expect(captureQuickActionsSource).toContain('RECENT_LIMIT')
    expect(captureQuickActionsSource).toContain("runCaptureExport('tree'")
    expect(captureQuickActionsSource).toContain("runCaptureExport('markdown'")
    expect(captureQuickActionsSource).toContain('Export all')
  })

  it('surfaces the archive size as a deep link into the Knowledge Capture settings panel', () => {
    expect(popupSource).toContain('captureSummary?.tweets')
    // openOptionsPage always lands on General; the capture card must deep-link
    // straight to #capture so the options app opens on the Capture panel.
    expect(popupSource).toContain("openOptionsSection('capture')")
    expect(popupSource).toContain('openCaptureArchive')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test src/entrypoints/popup/popup-layout.test.ts`
Expected: FAIL — the new assertions reference `CaptureQuickActions`, `fetchCaptureSummary(3)`, `'ClearCaptureRequest'` (in `popupSource`/expecting it wired), none of which exist in `App.tsx` yet (it still calls `fetchCaptureSummary(0)` and doesn't import the new component).

- [ ] **Step 3: Wire the component into `App.tsx`**

In `src/entrypoints/popup/App.tsx`, change the import block at line 15 from:

```ts
import { fetchCaptureSummary, type CaptureSummary } from '@/components/capture-export'
```

to:

```ts
import { fetchCaptureSummary, type CaptureSummary } from '@/components/capture-export'
import { CaptureQuickActions } from './capture-quick-actions'
```

Then change the effect at lines 226-229 from:

```ts
  useEffect(() => {
    // limit 0: the popup shows only the tweet count — skip the recent-list payload.
    void fetchCaptureSummary(0).then(setCaptureSummary)
  }, [])
```

to:

```ts
  useEffect(() => {
    // limit 3: enough for the popup's own trimmed recent-conversation disclosure
    // (CaptureQuickActions) without paying for the full archive-browser payload.
    void fetchCaptureSummary(3).then(setCaptureSummary)
  }, [])
```

Then, in the Capture `Field` block, change (currently lines 469-476):

```tsx
              <Switch
                id="captureEnabled"
                aria-label="Capture tweets"
                checked={settings.captureEnabled}
                onCheckedChange={(checked: boolean) => void update({ captureEnabled: checked })}
              />
            </Field>
          </div>
        </div>
```

to:

```tsx
              <Switch
                id="captureEnabled"
                aria-label="Capture tweets"
                checked={settings.captureEnabled}
                onCheckedChange={(checked: boolean) => void update({ captureEnabled: checked })}
              />
            </Field>

            <CaptureQuickActions
              summary={captureSummary}
              onCleared={() => setCaptureSummary({ tweets: 0, conversations: 0, recent: [] })}
            />
          </div>
        </div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test src/entrypoints/popup/popup-layout.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Typecheck and lint**

Run: `bun run typecheck && bun run lint`
Expected: no errors (this confirms `CaptureQuickActionsProps.summary`'s `CaptureSummary | null` type lines up with `captureSummary` state in `App.tsx`, and that `onCleared`'s zeroed object matches the `CaptureSummary` shape).

- [ ] **Step 6: Commit**

```bash
git add src/entrypoints/popup/App.tsx src/entrypoints/popup/popup-layout.test.ts
git commit -m "feat(popup): wire CaptureQuickActions into the Capture row"
```

---

### Task 3: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full gate**

Run: `bun run check`
Expected: `oxfmt --check src`, `oxlint`, `wxt prepare`, `tsgo --noEmit`, and `vitest run` all exit 0.

- [ ] **Step 2: Run the coverage gate**

Run: `bun run test:coverage`
Expected: exits 0. `src/entrypoints/popup/capture-quick-actions.tsx` is under `src/entrypoints`, which is excluded from the 100% `src/core`/`src/lib` coverage gate by design, so no coverage-threshold failure is expected from the new file itself.

- [ ] **Step 3: Manually sanity-check the popup**

This is a UI change with no automated render test (matching this repo's existing convention for popup components — see Task 1 notes). Before considering this done, load the unpacked extension, open the popup with `captureEnabled` on and at least one captured tweet, and confirm by hand:
- The Capture row shows the tweet count as before.
- A new "Recent ⌄" row appears below it; clicking it expands to show up to 3 conversations with JSON/Markdown links, an "Export all · JSONL" button, and a "Clear archive…" button.
- Clicking "Export all · JSONL" downloads a `.jsonl` file and shows a status line.
- Clicking "Clear archive…" prompts a native `confirm()`, and on confirming, the list disappears, the tweet count in the row above resets to 0, and the whole "Recent" block disappears (since `tweets === 0`).
- With `captureEnabled` off and nothing ever captured, the "Recent" row does not appear at all.

No commit expected from this task unless the manual check surfaces a bug — if it does, fix it, re-run `bun run check`, and commit the fix before considering the plan complete.

---

## Self-Review Notes

- **Spec coverage:** every in-scope item from the design doc maps to a task — disclosure/hidden-at-zero (Task 1), 3-row list + per-row JSON/Markdown export (Task 1), Export all · JSONL (Task 1), confirm-gated Clear archive… (Task 1), `fetchCaptureSummary(3)` bump + render wiring (Task 2), the two stale test flips (Task 2). Out-of-scope items (search, pagination, history-clear, Archive tab changes) are untouched by every step above.
- **Placeholder scan:** no TBD/TODO; every step has literal code or an exact command + expected output.
- **Type consistency:** `CaptureQuickActionsProps.summary: CaptureSummary | null` matches `captureSummary` state's type in `App.tsx` (`useState<CaptureSummary | null>`); `onCleared`'s reset object `{ tweets: 0, conversations: 0, recent: [] }` matches the `CaptureSummary` interface in `capture-export.ts` exactly (same three fields, `recent` as an empty array). `runCaptureExport`'s `kind` parameter (`'jsonl' | 'tree' | 'markdown'`) and optional `conversationId` are used identically to how `archive.tsx` already calls it.
