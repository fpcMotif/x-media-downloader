# Handoff: capture-copy — one home for the capture surfaces' shared copy/formatting

- **Date:** 2026-07-05 · **Origin:** round-4 /improve-codebase-architecture (8 survey lenses → 21
  adversarial skeptics → survivors grilled; decisions adjudicated by the lead architect)
- **Status:** READY — not started. **Branch discipline:** implement on a fresh branch off main (or the
  current branch per the user's instruction at execution time); this handoff is self-contained.
- **Skeptic tally:** 3–0. Strength: WORTH EXPLORING (small, certain).

## Problem

Downstream of the genuinely-shared module `src/components/capture-export.ts`, four capture-adjacent
call sites hand-roll the same presentation logic. The duplication was introduced by sequential commits
(`b7a4e3c` added `archive.tsx`, then `fe0b6fe` added `capture-quick-actions.tsx` by copying its shape).

Verified byte-identical `plural` definitions, all reading
`` const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}` ``:
- `src/entrypoints/options/panels/capture.tsx:7`
- `src/entrypoints/options/panels/archive.tsx:21`
- `src/entrypoints/popup/capture-quick-actions.tsx:10`
- `src/entrypoints/popup/App.tsx:31` (a 4th, page-scope-context consumer)

Verified identical `fmtDay` definitions, both reading
`` new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) ``:
- `src/entrypoints/options/panels/archive.tsx:23`
- `src/entrypoints/popup/capture-quick-actions.tsx:12`

Verified character-identical confirm-gated clear copy and cleared-flash copy:
- Confirm: `` `Delete all ${plural(tweets, 'captured tweet')}? This cannot be undone.` `` at
  `archive.tsx:49` and `capture-quick-actions.tsx:59`
- Cleared flash: `` `Cleared ${plural(tweets, 'tweet')} from the archive.` `` at
  `archive.tsx:54` and `capture-quick-actions.tsx:62`

One wording or format change today means hand-syncing 2–4 files by eyeball, with no compiler or test
signal if one is missed.

All four consumers already import from `@/components/capture-export`
(`capture.tsx:5`, `archive.tsx:7-12`, `capture-quick-actions.tsx:3`, `App.tsx:15`), confirming the `@/`
alias and the sibling-module placement both already work from every call site.

## Grilled design decisions

1. **Question:** Where does the shared module live?
   **Decision:** `src/components/capture-copy.ts`, a sibling of `capture-export.ts`, imported via the
   uniform `@/` alias (`@/components/capture-copy`).
   **Decisive reason:** every one of the four consumers already imports `@/components/capture-export`
   from that exact directory — zero new resolution risk, and it groups with the module it downstreams
   from.

2. **Question:** What does the module export?
   **Decision:** `plural(n, noun)`, `fmtDay(ms)` (match the existing signature — `ms: number`, not a
   `Date`, per the four verified definitions above), and two copy builders,
   `confirmClearArchiveCopy(count)` and `clearedArchiveCopy(count)`. Pure string builders only.
   **Decisive reason:** these are exactly the four repeated shapes found across the surfaces; no more,
   no less.

3. **Question:** Does `flashStatus` move too?
   **Decision:** No — excluded.
   **Decisive reason:** `flashStatus` closes over local `setState` (see `archive.tsx:37-40` and
   `capture-quick-actions.tsx:34-37`); sharing it means extracting a hook, which is a refuted lane for
   this round. The module must stay a plain, stateless import usable from anywhere — no JSX, no state,
   nothing stateful.

4. **Question:** Does `App.tsx:31`'s `plural` (a 4th, non-capture-panel consumer) get folded in, or left
   alone to avoid over-generalizing the module's name?
   **Decision:** Fold it in.
   **Decisive reason:** three of the four consumers are capture surfaces; creating a second, generic
   `formatters.ts` module to serve one caller is a one-adapter seam — not worth a second module. Accept
   the minor wart that a page-scope caller (`App.tsx`) imports from a capture-named module.

## Interface sketch

```ts
// src/components/capture-copy.ts
export const plural = (n: number, noun: string): string =>
  `${n} ${noun}${n === 1 ? '' : 's'}`

export const fmtDay = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

export const confirmClearArchiveCopy = (count: number): string =>
  `Delete all ${plural(count, 'captured tweet')}? This cannot be undone.`

export const clearedArchiveCopy = (count: number): string =>
  `Cleared ${plural(count, 'tweet')} from the archive.`
```

Signatures verified against the four existing definitions in the tree (see Problem section above) —
`fmtDay` takes `ms: number`, not `Date`, matching both current call sites exactly.

## Out of scope — DO NOT

- Any state/hook sharing (e.g. extracting `flashStatus` into a shared hook) — explicitly refuted lane.
- A generic UI formatters module for `App.tsx`'s lone non-capture `plural` use — fold it into
  `capture-copy.ts` instead (see decision 4).
- Touching `src/components/capture-export.ts` itself — it is already correctly shared; this handoff only
  adds a sibling.
- Any change to the *wording* of the copy strings — this is a pure de-duplication, not a copy revision.

## Plan with verifiable goals

1. Create `src/components/capture-copy.ts` with the four exports from the Interface sketch above.
   → verify: `bun run check` passes with the new file (typecheck + lint + format clean).

2. In `src/entrypoints/options/panels/capture.tsx`: delete the local `plural` (line 7), import `plural`
   from `@/components/capture-copy`, update all call sites.
   → verify: `rg -n "^const plural" src/entrypoints/options/panels/capture.tsx` returns nothing.

3. In `src/entrypoints/options/panels/archive.tsx`: delete the local `plural` (line 21) and `fmtDay`
   (line 23), replace the inline confirm-copy literal (line 49) and cleared-flash literal (line 54) with
   `confirmClearArchiveCopy(tweets)` / `clearedArchiveCopy(tweets)`, import all four names from
   `@/components/capture-copy`.
   → verify: `rg -n "^const plural|^const fmtDay|Delete all \\\$\\{plural|Cleared \\\$\\{plural" src/entrypoints/options/panels/archive.tsx` returns nothing.

4. In `src/entrypoints/popup/capture-quick-actions.tsx`: same swap as step 3 (local `plural` line 10,
   `fmtDay` line 12, confirm-copy line 59, cleared-flash line 62).
   → verify: `rg -n "^const plural|^const fmtDay|Delete all \\\$\\{plural|Cleared \\\$\\{plural" src/entrypoints/popup/capture-quick-actions.tsx` returns nothing.

5. In `src/entrypoints/popup/App.tsx`: delete the local `plural` (line 31), import from
   `@/components/capture-copy`.
   → verify: `rg -n "^const plural" src/entrypoints/popup/App.tsx` returns nothing.

6. Sweep the whole tree for stragglers.
   → verify: `rg -n "n === 1 \\? '' : 's'" src -g '!capture-copy.ts'` returns nothing (the only surviving
   definition is inside the new module).

7. Full gate pass.
   → verify: `bun run check` (oxfmt + oxlint + wxt prepare + tsgo + vitest, per `package.json`) exits 0;
   `bun run build` (`wxt build`) exits 0. Skip `bun run test:coverage` deliberately — UI under
   `src/entrypoints` and `src/components` is outside the 100%-coverage gate (`src/core` + `src/lib`
   only), so this change has no coverage impact by design.

## Files

- **New:** `src/components/capture-copy.ts`
- **Edit:** `src/entrypoints/options/panels/capture.tsx`
- **Edit:** `src/entrypoints/options/panels/archive.tsx`
- **Edit:** `src/entrypoints/popup/capture-quick-actions.tsx`
- **Edit:** `src/entrypoints/popup/App.tsx`

## Test plan

No new `*.test.ts` is required by the coverage gate (UI is excluded by design — see plan step 7). If a
regression test is wanted for the de-duplication itself, mirror the existing source-grep idiom already
used for these exact panels, e.g. `src/entrypoints/options/panels/worklist.test.ts` (reads the `.tsx`
source via `readFileSync` and asserts on string content/ordering, not a rendered DOM). A parallel
`capture-copy.test.ts` in the same style would assert each of the four consumer files imports from
`@/components/capture-copy` and contains no local `plural`/`fmtDay` re-definition — but this is optional
polish, not required to close the plan.

## Coordination

This handoff touches the same four UI files (`capture.tsx`, `archive.tsx`, `capture-quick-actions.tsx`,
`App.tsx`) as the uncommitted R4 "instrument" redesign currently sitting in the working tree on
`ux/knowledge-capture-discoverability` (per git status: all four show as modified, plus `archive.tsx` is
new/untracked from that same redesign). **Execute this handoff in a session that owns those files'
current state** — i.e. after the R4 redesign has landed (committed) on this branch, not concurrently with
it, to avoid clobbering uncommitted hunks.

No file overlap with the other 2026-07-05 handoffs — this is the only one touching
`src/components/capture-copy.ts` or these four entrypoint files.
