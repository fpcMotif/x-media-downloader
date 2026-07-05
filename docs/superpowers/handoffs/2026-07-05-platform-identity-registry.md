# Handoff: Platform identity derives from the adapter registry

- **Date:** 2026-07-05 · **Origin:** round-4 /improve-codebase-architecture (8 survey lenses → 21
  adversarial skeptics → survivors grilled; decisions adjudicated by the lead architect)
- **Status:** READY — not started. **Branch discipline:** implement on a fresh branch off main (or the
  current branch per the user's instruction at execution time); this handoff is self-contained.
- **Skeptic tally:** 3–0. Strength: STRONG — round-4 top recommendation. Companion: docs/adr/0019
  (numbered `0019-*`, written alongside this handoff — `docs/adr/` currently ends at `0018-capture-mirror-extends-convex-scope.md`).

## Problem  (friction + verified evidence, file:line)

Five consumers hand-maintain platform identity that `ALL_ADAPTERS` (`src/core/adapters/registry.ts:12`)
already owns as a single module: `export const ALL_ADAPTERS: readonly PlatformAdapter[] = [xAdapter,
instagramAdapter, threadsAdapter]`. Each `PlatformAdapter.hostMatch` (`src/core/adapters/types.ts:15`)
is documented as "Manifest content-script match patterns AND the `browser.tabs.query` filter — single
source of truth (mirrors X_HOST_MATCH's role today)" — but three of the five consumers below don't
consume it, they re-derive it by hand:

1. **Shipped incident** — sender-guard drift (fixed in 670d5a6, after a 3-commit spiral: 682dd47 →
   39ff403 → 670d5a6). `src/core/sender-guard.ts:36-48` hand-lists `ALLOWED_CONTENT_SCRIPT_ORIGINS` as a
   literal `Set` of 5 origin strings, with a comment admitting the failure mode: "This set was NOT
   updated when Instagram/Threads content scripts were added, which silently dropped every
   overlay-to-background message from those tabs (DownloadRequest included) with no error signal." The
   regression test lives at `src/core/sender-guard.test.ts:85-99`. The literal list is correct today
   only because someone remembered to hand-sync it once — the drift class itself is still live.

2. **LIVE bug** — `src/background/tab-broadcaster.ts:1` imports `X_HOST_MATCH` from
   `../core/adapters/x` and line 52's `defaultTabsPort` does `browser.tabs.query({ url: [...X_HOST_MATCH] })`
   — X-only. `reportTransferOutcome` (lines 79-88 of the same file) is called unconditionally from
   `src/entrypoints/background.ts:465`: `if (fx.backlink) reportTransferOutcome(fx.backlink.requestId,
   fx.backlink.outcome, fx.backlink.at)` — no platform check. A download that fails on an
   Instagram/Threads tab never reaches any tab (the query only returns X tab ids), so the badge set at
   hand-off stays "saved" forever — the exact failure class ADR-0014 (Transfer Tracker) exists to fix,
   silently reintroduced for two of the three registered platforms.

3. Clear-family handlers in `src/entrypoints/overlay.content/handlers.ts` have zero platform gate:
   `handleClearVisible` (line 244), `handleClearWholeList` (line 269), `handleClearTweet` (line 433),
   `handleClearDetectedMedia` (line 462), and `handleSavedStatusUpdate` (line 151) all run unconditionally
   on any adapter. They're safe today only because `pageScope`/`TWEET_ARTICLE_SEL` (X-specific DOM
   selectors) match nothing off-X — an accident of selector shape, not a guard.

4. `src/entrypoints/popup/App.tsx:7` imports `isXUrl` from `@/core/adapters/x`; lines 215/217 gate on it
   (`setOnXTab(isXUrl(url))`, `setOnListPage(isXUrl(url) && ...)`); line 309 renders `'Open X or Twitter'`
   for any tab that isn't X — including a tab the registry itself recognizes as Instagram or Threads. The
   popup falsely claims the extension is inactive on a platform it has adapters for.

5. `wxt.config.ts:38-54` hand-lists `host_permissions` (x.com, twitter.com, instagram.com, threads.net,
   threads.com) with a comment noting they "mirror the X pair above" — synced by comment, not by import.
   By contrast, `src/entrypoints/inject.content.ts:11` already proves the derived form works today:
   `matches: [...new Set(ALL_ADAPTERS.flatMap((a) => a.hostMatch))]`. `wxt.config.ts` is the one
   remaining hand-synced host list in the codebase.

## Grilled design decisions

1. **wxt.config.ts enforcement → DIRECT IMPORT of `ALL_ADAPTERS`, not a pinning test.**
   Verified feasible: the registry's full transitive closure (x/instagram/threads adapters, meta-shared,
   `core/clear`/`clearer`, `core/resolver`, `core/selection`, `core/schema`) contains zero
   wxt/browser/`#imports`/DOM-global references — only `effect` and internal modules. `wxt.config.ts` is
   loaded Node-side via c12's `loadConfig`, and `inject.content.ts:11` already imports `ALL_ADAPTERS` and
   calls `.flatMap((a) => a.hostMatch)` inside a WXT-processed entrypoint, proving the import graph is
   traversable outside the browser runtime. Derive the platform pair of `host_permissions` as
   `ALL_ADAPTERS.flatMap((a) => a.hostMatch)` (deduplicated, converted from `*://host/*` match-pattern
   shape to `https://host/*` — confirm the exact string transform matches what `host_permissions` expects,
   since `hostMatch` entries are manifest match-pattern syntax `*://x.com/*` while `host_permissions`
   entries in the current file are `https://x.com/*`). Non-platform permissions (the syndication CDN,
   Convex origin, media CDNs, OAuth/API hosts) stay hand-listed — they aren't adapter-owned.
   **Fallback ONLY if c12 fights the import in practice:** a test pinning the manifest's host array ⊇
   `hostMatch`, mirroring `sender-guard.test.ts`'s existing pinning idiom.

2. **sender-guard → registry gains `originsForAllAdapters()`** using the verified pure transform
   `'https://' + pattern.split('://')[1].split('/')[0]` (this mirrors the exact logic already inlined in
   `hostMatchesHostname`, `src/core/adapters/registry.ts:40-49` — that function already splits on
   `'://'` then `'/'` to extract the host segment; this decision reuses the same split, just to build an
   origin string instead of a comparison). Applied to the 5 current `hostMatch` entries across
   x/instagram/threads adapters, it reproduces today's `ALLOWED_CONTENT_SCRIPT_ORIGINS`
   (`src/core/sender-guard.ts:42-48`) EXACTLY: `https://x.com`, `https://twitter.com`,
   `https://www.instagram.com`, `https://www.threads.net`, `https://www.threads.com`. No wildcard
   subdomains exist — `hostMatchesHostname` is exact-match only, by design (per its own comment: "no
   `*.`-wildcard subdomain patterns exist to dispatch on, so this stays exact-match only (YAGNI)"). Zero
   behavior change today; the drift class dies because origins now flow from one place adding a platform
   already updates.

3. **tab-broadcaster → WIDEN the single `TabsPort` query to all-adapters `hostMatch`; do NOT add a
   parallel second query.** Verified consumer classification by reading every call site in
   `src/background/tab-broadcaster.ts`:
   - `sendClearToTabs` (lines 94-128) is genuinely X-only — it drives `ClearTweetRequest`, whose receiving
     handler (`handleClearTweet`, `handlers.ts:433`) depends on `TWEET_ARTICLE_SEL` and X-specific clear
     semantics (bookmark/like/notInterested scopes). It must stay scoped to X tabs, or it wastes
     round-trips querying tabs that can never answer.
   - `reportTransferOutcome` (lines 79-88) is platform-generic: it's `requestId`-keyed, and its receiving
     handler `handleTransferOutcome` (background/overlay wiring — confirm handler name at execution time)
     touches only badge/launcher closures, no X selectors. This is the live bug: it rides the same
     X-only `queryXTabs()` as everything else in the file, so it silently can't reach an Instagram/Threads
     tab.
   - `SavedStatusUpdate` broadcast is generic-in-intent (it's a "which tweets are already downloaded" push)
     but its receiving handler `handleSavedStatusUpdate` (`handlers.ts:151`) is X-DOM (walks
     `sweepSavedStatus`'s tweet-article matching) — which is exactly why decision 4 gates receivers rather
     than senders.

   Widen the ONE `queryXTabs`/`TabsPort.queryXTabs` (`tab-broadcaster.ts:43-56`) to query
   `ALL_ADAPTERS.flatMap((a) => a.hostMatch)` instead of `X_HOST_MATCH` alone. Do not introduce a second
   query method — `broadcastToXTabs` (line 70) and `sendClearToTabs` both already funnel through the same
   `queryXTabs()`, so a second query would duplicate the fan-out plumbing for no benefit; the X-only
   *behavior* for clear lives in the handler gate (decision 4), not in which tabs get asked.
   **THE LIVE-BUG FIX (widening so `TransferOutcome` reaches IG/Threads) SHIPS FIRST as an isolated
   commit, independently revertable** — it's the one change in this handoff with real user-facing
   impact today; the rest is drift-prevention.

4. **handlers.ts gating → per-handler early-return `if (deps.adapter.platform !== 'x') return <no-op
   reply>`** for the clear-family handlers (`handleClearVisible`, `handleClearWholeList`,
   `handleClearTweet`, `handleClearDetectedMedia`) plus `handleSavedStatusUpdate`. Verified:
   `HandlerDeps` (`handlers.ts:41`) already carries the resolved `PlatformAdapter` as `adapter` — the field
   is constructed once at `overlay.content/index.tsx:671` via `adapterForHostname(location.hostname)` and
   threaded into `handlerDeps` at `index.tsx:1645-1646` (`const handlerDeps: HandlerDeps = { adapter,
   store, ... }`). The dispatch table (`messageHandlers`, `handlers.ts:489-497`) is a flat `_tag → handler`
   lookup, invoked from `index.tsx:1683-1692`'s `handleRuntimeMessage`; keep it a flat lookup — table-level
   filtering has no precedent in this file and would duplicate the per-handler classification decision 3
   already made (clear-family = X-only, transfer-outcome = generic). This matches the existing
   `adapter.platform === 'x'` idiom used throughout `index.tsx` (lines 781, 928, 1278, 1281, 1286, 1512 —
   the pattern 00c4683 established for X-only overlay features).

5. **popup → replace `isXUrl` with `adapterForUrl(url)`:** three-way state (`undefined` / non-X adapter /
   X adapter). Current code: `src/entrypoints/popup/App.tsx:7` (`import { isXUrl } from
   '@/core/adapters/x'`), lines 215/217 (the two `isXUrl` call sites inside the tab-detection `useEffect`,
   `App.tsx:205-225`), and line 309 (`{onXTab ? 'Ready on this X tab' : 'Open X or Twitter'}`). Swap the
   import to `adapterForUrl` from `@/core/adapters/registry` (already used the same way by
   `overlay.content/index.tsx:3` and `inject.content.ts:1`, so this is an established import path, not a
   new one). All four gated buttons (drain/sweep/clearVisible/clearWholeList — the disabled-state
   conditions at `App.tsx:352,367,377,387`) stay X-only via `adapter?.platform === 'x'`; NONE newly light
   up (verified: all four trigger X clear semantics per decision 3/4's classification). Only the header
   status + hint copy change: name the recognized platform ("Ready on this Instagram tab — clear/sweep
   are X-only") instead of falsely claiming the extension is inactive (current `PAGE_UNREACHABLE`/
   `'Open X or Twitter'` copy at lines 39 and 309 don't distinguish "no adapter" from "adapter, but not
   X").

## Interface sketch

```ts
// src/core/adapters/registry.ts — new exports, additive only

/** Every distinct origin (`scheme://host`) a registered adapter's content
 *  script may legitimately send a message from — the single source
 *  sender-guard's ALLOWED_CONTENT_SCRIPT_ORIGINS derives from. */
export function originsForAllAdapters(): ReadonlySet<string> {
  const origins = new Set<string>()
  for (const adapter of ALL_ADAPTERS) {
    for (const pattern of adapter.hostMatch) {
      // mirrors hostMatchesHostname's own '://' + '/' split (registry.ts:40-49)
      const afterScheme = pattern.split('://')[1] ?? pattern
      const host = afterScheme.split('/')[0] ?? afterScheme
      origins.add(`https://${host}`)
    }
  }
  return origins
}

/** Every registered adapter's hostMatch, deduplicated — the manifest
 *  host_permissions and browser.tabs.query source of truth. */
export function allAdapterHostMatch(): readonly string[] {
  return [...new Set(ALL_ADAPTERS.flatMap((a) => a.hostMatch))]
}
```

```ts
// src/core/sender-guard.ts — swap the literal for the derived set
import { originsForAllAdapters } from './adapters/registry'
const ALLOWED_CONTENT_SCRIPT_ORIGINS: ReadonlySet<string> = originsForAllAdapters()
```

```ts
// src/background/tab-broadcaster.ts — widen defaultTabsPort's query (line 50-56)
import { allAdapterHostMatch } from '../core/adapters/registry'
const defaultTabsPort = (): TabsPort => ({
  queryXTabs: async () => {
    const tabs = await browser.tabs.query({ url: [...allAdapterHostMatch()] })
    return tabs.flatMap((t) => (t.id !== undefined ? [t.id] : []))
  },
  sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
})
```

```ts
// src/entrypoints/overlay.content/handlers.ts — per-handler gate, e.g.:
export const handleClearVisible: MessageHandler = (_message, deps, sendResponse) => {
  if (deps.adapter.platform !== 'x') {
    sendResponse({ _tag: 'ClearVisibleResponse', cleared: 0, reason: 'not-x' } /* shape per existing response type */)
    return
  }
  // ...existing body
}
```

```ts
// src/entrypoints/popup/App.tsx — three-way adapter state
import { adapterForUrl } from '@/core/adapters/registry'
import type { PlatformAdapter } from '@/core/adapters/types'
const [tabAdapter, setTabAdapter] = useState<PlatformAdapter | undefined>(undefined)
// ...
setTabAdapter(adapterForUrl(url))
// ...
const onXTab = tabAdapter?.platform === 'x'
```

```ts
// wxt.config.ts — replace the hand-listed platform pair with a derived spread
import { ALL_ADAPTERS } from './src/core/adapters/registry' // verify actual relative path from repo root
// inside host_permissions array, replace the 5 hand-listed platform lines with:
...[...new Set(ALL_ADAPTERS.flatMap((a) => a.hostMatch))].map(
  (m) => `https://${m.split('://')[1]!.split('/')[0]}/*`,
),
```
Verify the exact match-pattern-to-permission-string transform against `wxt.config.ts`'s current literal
strings (`'https://x.com/*'` etc.) before landing — `hostMatch` uses `*://host/*` (see
`X_HOST_MATCH = ['*://x.com/*', '*://twitter.com/*']`, `src/core/adapters/x/index.ts:19`), which is
NOT byte-identical to `host_permissions`' `https://host/*`; the transform must reconstruct the scheme.

## Out of scope — DO NOT

- Capability fields on the adapter record (e.g. `supportsClear: boolean`) — a hypothetical seam for now;
  ADR-0019 records this as considered-and-deferred, not forgotten.
- Touching `sendClearToTabs`'s X-only scope — it stays X-only per decision 3's verified classification.
- The DOM/hover stub trio asymmetry on `PlatformAdapter` (`resolveHoverItem`/`canResolveHoverItem`/
  `findMediaNeedingRecovery?` — see `src/core/adapters/types.ts:47-65`) — separately parked, re-assess
  when Instagram/Threads CDN verification lands.
- Anything in the refuted list: tab-broadcaster core extraction (i.e. relocating it out of
  `src/background/`) was refuted in an earlier round — this handoff widens a query INSIDE the existing
  module (`tab-broadcaster.ts`), no relocation, no new module.

## Plan with verifiable goals

1. **Hotfix — widen the TabsPort query + gate off-X handlers.**
   - Widen `defaultTabsPort.queryXTabs` (`tab-broadcaster.ts:50-56`) to `allAdapterHostMatch()`.
   - Add `if (deps.adapter.platform !== 'x') return <no-op>` to `handleClearVisible`,
     `handleClearWholeList`, `handleClearTweet`, `handleClearDetectedMedia`, `handleSavedStatusUpdate` in
     `handlers.ts`.
   - Add `originsForAllAdapters`/`allAdapterHostMatch` to `registry.ts` (needed by this step's widened
     query import).
   → verify: `bun run test -- tab-broadcaster handlers` green, new off-X no-op cases pass, then
     `bun run check`.

2. **sender-guard derivation.**
   - Add a test asserting `originsForAllAdapters()` equals today's `ALLOWED_CONTENT_SCRIPT_ORIGINS`
     literal (5 origins) before swapping.
   - Swap `sender-guard.ts:42-48`'s literal `Set` for `originsForAllAdapters()`.
   → verify: `bun run test -- sender-guard` green (existing Instagram-origin regression test at
     `sender-guard.test.ts:91-99` must still pass unmodified), `bun run test:coverage` stays 100% over
     `src/core` + `src/lib`.

3. **wxt.config.ts direct import.**
   - Replace the hand-listed platform host pair in `host_permissions` with the derived spread; keep
     non-platform permissions (syndication CDN, Convex origin, media CDNs, OAuth hosts) hand-listed.
   - If c12's `loadConfig` chokes on the import in practice, fall back to the pinning-test form described
     in decision 1.
   → verify: `bun run build` succeeds and the built `manifest.json` (check `.output/*/manifest.json` per
     this repo's WXT output convention) still lists all 5 platform host permissions plus the untouched
     non-platform ones.

4. **popup three-way state.**
   - Replace `isXUrl` import/usage in `App.tsx` with `adapterForUrl`; keep all four button gates on
     `adapter?.platform === 'x'`.
   - Update header status copy to name a recognized non-X platform.
   - Create `src/entrypoints/popup/App.test.ts` (does not exist yet — see Test plan) with a
     recognized-non-X-tab case.
   → verify: `bun run test -- popup/App` green, `bun run check`, `bun run test:coverage` still 100%.

Each step gated by `bun run check` (runs `oxfmt --check`, `oxlint`, `wxt prepare`, `tsgo --noEmit`,
`vitest run`), `bun run test:coverage` (must stay 100% over `src/core` + `src/lib` — UI/entrypoints are
excluded by the existing coverage-gate design, so step 4's popup test is for regression safety, not
coverage), and `bun run build` (`wxt build`) for step 3.

## Files

- `src/core/adapters/registry.ts` — add `originsForAllAdapters`, `allAdapterHostMatch`.
- `src/core/sender-guard.ts` — swap literal `ALLOWED_CONTENT_SCRIPT_ORIGINS` for the derived call.
- `src/background/tab-broadcaster.ts` — widen `defaultTabsPort.queryXTabs`.
- `src/entrypoints/overlay.content/handlers.ts` — add platform gate to 5 handlers.
- `src/entrypoints/popup/App.tsx` — `isXUrl` → `adapterForUrl`, three-way state, copy.
- `wxt.config.ts` — derive the platform pair of `host_permissions`.
- `docs/adr/0019-*.md` — new ADR (companion, written alongside this handoff per the Origin line).

## Test plan

- `src/core/sender-guard.test.ts` — gains a derivation-equality case (`originsForAllAdapters()` output
  === today's 5-origin literal), added near the existing `CONTENT_SCRIPT_TAGS` pinning test
  (lines 8-21) which is the sibling idiom to mirror (`expect([...set].toSorted()).toEqual([...].toSorted())`).
  Existing regression tests (lines 76-99, the x.com/twitter.com/instagram allow-list cases) must keep
  passing unmodified — they're the behavior-preservation check for decision 2.
- `src/entrypoints/overlay.content/handlers.test.ts` — gains an off-X no-op case per gated handler
  (`handleClearVisible`, `handleClearWholeList`, `handleClearTweet`, `handleClearDetectedMedia`,
  `handleSavedStatusUpdate`), mirroring the existing `makeDeps`/`run` harness pattern at lines 44-64
  (cast a partial `HandlerDeps`, this time including `adapter: { platform: 'instagram' | 'threads', ... }`
  in the override).
- `src/background/tab-broadcaster.test.ts` — extend (file already exists) with a case proving
  `queryXTabs` now includes Instagram/Threads host patterns in its `browser.tabs.query` call, per this
  file's existing `TabsPort` fake-injection idiom.
- `src/entrypoints/popup/App.test.ts` — **does not exist yet; this is a new file**, not an addition to an
  existing one (verified: `fd` over `src/entrypoints/popup/` finds only `history-section.test.ts` and
  `popup-layout.test.ts`, no `App.test.ts`). Model it on `src/entrypoints/options/App.test.ts`'s
  render-and-inspect idiom for the sibling options-page `App.tsx`, adapted to the popup's tab-detection
  `useEffect` (mock `browser.tabs.query` to return an Instagram tab URL, assert the header renders the
  recognized-non-X copy and all four clear buttons stay disabled).

## Coordination

- `src/core/sender-guard.ts` is also touched by the message-reply-contract handoff (the other one types
  `CONTENT_SCRIPT_TAGS`). **Land this handoff FIRST** — it only changes where the origin list COMES FROM
  (`ALLOWED_CONTENT_SCRIPT_ORIGINS`'s source), not `CONTENT_SCRIPT_TAGS` itself, so the two changes touch
  disjoint declarations in the same file and this one going first avoids a rebase on the typing change.
- `src/entrypoints/overlay.content/handlers.ts` is also read by the reply-contract handoff's cast fixes
  in `index.tsx` — different files (that handoff edits `index.tsx`, this one edits `handlers.ts`), no
  conflict expected; still worth a diff check before merging both since both touch the overlay content
  script's message-handling seam.
