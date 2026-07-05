# Handoff: composeCaptureExport moves under the coverage gate

- **Date:** 2026-07-05 · **Origin:** round-4 /improve-codebase-architecture (8 survey lenses → 21
  adversarial skeptics → survivors grilled; decisions adjudicated by the lead architect)
- **Status:** READY — not started. **Branch discipline:** implement on a fresh branch off main (or the
  current branch per the user's instruction at execution time); this handoff is self-contained.
- **Skeptic tally:** 2–0 (a third skeptic objection failed on tooling grounds, not substance; cost was
  adjudicated trivially by the architect). Strength: **STRONG**.

## Problem

`buildCaptureExport` lives in `src/entrypoints/background.ts:1123-1139` and dispatches all three export
kinds (`jsonl` / `tree` / `markdown`) plus filename stamping:

```ts
const buildCaptureExport = async (
  kind: 'jsonl' | 'tree' | 'markdown',
  conversationId: string | undefined,
): Promise<{ filename: string; text: string } | null> => {
  if (kind === 'jsonl') {
    const records = await captureDb.allRecords()
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    return { filename: `xharvest-${day}.jsonl`, text: toJsonl(records) }
  }
  if (conversationId === undefined) return null
  const all = await captureDb.allRecords()
  const [tree] = buildTree(selectConversation(all, conversationId))
  if (tree === undefined) return null
  if (kind === 'tree')
    return { filename: `thread-${conversationId}.json`, text: toTreeJson(tree, all) }
  return { filename: `thread-${conversationId}.md`, text: toMarkdown(tree, all) }
}
```

It is called from the `ExportCaptureRequest` handler at `background.ts:1223-1230`.

The only behavioral coverage today is source-text substring assertions in
`src/entrypoints/popup/popup-layout.test.ts:139-145` and `:166-175` — e.g.
`expect(captureQuickActionsSource).toContain("runCaptureExport('tree'")`. These confirm a call site
exists in the popup's compiled source string; they never execute `buildCaptureExport` itself, so its two
not-found branches are reachable only by hand-clicking the UI:

1. `conversationId === undefined` → `return null` (`background.ts:1132`)
2. `buildTree(...)` yields no root for the given id → `return null` (`background.ts:1135`)

The function is dark purely because it lives in `background.ts`, outside the 100%-coverage gate
(`src/core` + `src/lib` only — see test-coverage-gate memory). Every ingredient it calls
(`toJsonl` / `toTreeJson` / `toMarkdown` in `src/core/capture/export.ts:107,123,164`; `buildTree` in
`src/core/capture/tree.ts:23`; `selectConversation` in `src/core/capture/store.ts:40-45`) is already a
tested `core/capture` module — the orchestration on top of them is the only untested part.

**Corrected claim from review:** `captureDb.allRecords()` is awaited once per export call (the two awaits
at `background.ts:1128` and `:1133` are branch-exclusive — only one ever executes for a given call), so
this is duplicate *code*, not duplicate I/O. Extracting the function collapses the two call sites to one
`await`, which is a code-clarity win, not a perf fix — don't oversell it as one.

## Grilled design decisions

1. **Signature:**
   ```ts
   function composeCaptureExport(
     records: ReadonlyArray<TweetRecord>,
     kind: 'jsonl' | 'tree' | 'markdown',
     conversationId: string | undefined,
     nowMs: number,
   ): { filename: string; text: string } | null
   ```
   `TweetRecord` is `src/core/capture/record.ts:62` (`export type TweetRecord = typeof TweetRecord.Type`).
   Passing `records` in means the pure function never touches `captureDb` — the shell fetches once and
   hands the array down.

2. **Time → plain `nowMs: number` param**, not a `now()` port. Decisive reason: this matches the sibling
   idiom already in the codebase — `src/core/download/daily-budget.ts:10`, `localDay(nowMs: number)` —
   where `background.ts` computes "now" once and passes it down as a value. A `now()` port is reserved for
   long-lived stateful stores (e.g. `budgetStore`), which this is not: `composeCaptureExport` is a single
   pure calculation per call, not a store with its own lifecycle.

3. **File → `src/core/capture/build-export.ts`.** Verified existing files in `src/core/capture/`:
   `card.ts`, `export.ts`, `harvest.ts`, `record.ts`, `store.ts`, `tree.ts` (each with a co-located
   `*.test.ts`). Decisive reasoning for the name:
   - Mirrors the existing function name (`buildCaptureExport` → `build-export.ts`) 1:1 — no renaming
     puzzle for future readers grepping for the call site.
   - Verb-phrase filename matches the `harvest.ts` naming convention already in the directory.
   - `compose.ts` was rejected as too generic — it says nothing about what's being composed.
   - `export-request.ts` was rejected because it would smuggle message-schema vocabulary
     (`ExportCaptureRequest` lives in `src/core/schema/index.ts:462-466`) into a directory that should stay
     schema-agnostic; `core/capture/` files describe capture domain operations, not wire messages.

4. **Shell shape mirrors the `CaptureSummaryRequest` handler** (`background.ts:1217-1222`): one `await` of
   the impure fetch (`captureDb.allRecords()`) feeds directly into one pure call, whose result is the
   reply. The shell keeps only the null-check, the `console.info` log line, and reply-shaping — no
   business logic. Concretely, the `ExportCaptureRequest` handler body becomes:
   ```ts
   ExportCaptureRequest: handle<'ExportCaptureRequest'>(async (msg) => {
     const records = await captureDb.allRecords()
     const built = composeCaptureExport(records, msg.kind, msg.conversationId, Date.now())
     if (built === null) return { ok: false, filename: '', text: '' }
     console.info(
       `[XMD] capture export ${msg.kind} → ${built.filename} (${built.text.length} bytes)`,
     )
     return { ok: true, filename: built.filename, text: built.text }
   }),
   ```

## Interface sketch

```ts
// src/core/capture/build-export.ts
import type { TweetRecord } from './record'
import { buildTree } from './tree'
import { selectConversation } from './store'
import { toJsonl, toTreeJson, toMarkdown } from './export'

/**
 * Compose one capture export artifact: filename + serialized text, or `null`
 * if the requested conversation can't be resolved. Pure — the caller supplies
 * the full record set and the instant to stamp filenames with.
 */
export function composeCaptureExport(
  records: ReadonlyArray<TweetRecord>,
  kind: 'jsonl' | 'tree' | 'markdown',
  conversationId: string | undefined,
  nowMs: number,
): { filename: string; text: string } | null {
  if (kind === 'jsonl') {
    const day = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '')
    return { filename: `xharvest-${day}.jsonl`, text: toJsonl(records) }
  }
  if (conversationId === undefined) return null
  const [tree] = buildTree(selectConversation(records, conversationId))
  if (tree === undefined) return null
  if (kind === 'tree')
    return { filename: `thread-${conversationId}.json`, text: toTreeJson(tree, records) }
  return { filename: `thread-${conversationId}.md`, text: toMarkdown(tree, records) }
}
```

Verified against the real types in the tree: `ReadonlyArray<TweetRecord>` matches the existing signatures
of `buildTree` (`tree.ts:23`), `selectConversation` (`store.ts:40-45`), `toJsonl` (`export.ts:107`),
`toTreeJson` (`export.ts:123`), `toMarkdown` (`export.ts:164`) — no adapter/glue types needed at the seam.

## Out of scope — DO NOT

- Touch `export.ts` or `tree.ts` internals. They are already tested `core/capture` leaves; this handoff
  only relocates the orchestration that sits above them.
- Touch the capture-copy UI module — that's a separate handoff (per the coordination note below).
- Delete the `popup-layout.test.ts` source-grep assertions (`:139-145`, `:166-175`) until the new
  behavioral tests in `build-export.test.ts` exist and pass. Then **replace**, don't layer: remove only
  the assertions the new tests make redundant (the ones asserting export-call-site strings), not the
  whole `describe` blocks — some of those blocks also cover unrelated UI wiring (e.g. the collapsed-state
  and clear-archive assertions at `:167-168`, `:172,174`) that must stay.

## Plan with verifiable goals

1. Create `src/core/capture/build-export.ts` (interface above) and
   `src/core/capture/build-export.test.ts` covering: all 3 kinds' happy paths, both `null` branches
   (`conversationId === undefined`; conversation id with no matching records), and filename shapes under
   a fixed `nowMs` (assert the exact `xharvest-YYYYMMDD.jsonl` / `thread-<id>.json` / `thread-<id>.md`
   strings).
   → verify: `bun run test:coverage` — 100% must hold over `src/core` + `src/lib` (new file included).
2. Shrink the `background.ts` shell: delete `buildCaptureExport` (`:1123-1139`), import
   `composeCaptureExport` from `src/core/capture/build-export.ts`, rewrite the `ExportCaptureRequest`
   handler body (`:1223-1230`) per the shell shape in decision 4.
   → verify: `bun run check` (runs oxfmt --check, oxlint, wxt prepare, tsgo --noEmit, vitest run) and
   `bun run build` (wxt build) both green.
3. Remove the now-superseded source-grep assertions from `popup-layout.test.ts` (the `runCaptureExport`
   substring lines at `:142-143` and `:169-170` that only proved a call site exists in source text — now
   redundant with real behavioral coverage of `composeCaptureExport`). Leave the rest of each `describe`
   block intact.
   → verify: `bun run test:coverage` full suite green, no assertion count regression outside the intended
   deletions.

## Files

- **New:** `src/core/capture/build-export.ts`, `src/core/capture/build-export.test.ts`
- **Edit:** `src/entrypoints/background.ts` (delete `:1123-1139`, rewrite `:1223-1230`, add one import)
- **Edit:** `src/entrypoints/popup/popup-layout.test.ts` (trim superseded substrings at `:142-143`,
  `:169-170`)

## Test plan

Mirror the existing sibling idiom in `src/core/capture/store.test.ts` and `src/core/capture/tree.test.ts`
— plain Vitest `describe`/`it`, hand-built `TweetRecord` fixtures (no fakes/mocks needed since
`composeCaptureExport` is pure). Structure `build-export.test.ts` as:

- `describe('composeCaptureExport')`
  - `'jsonl' kind` → filename stamped from `nowMs`, text matches `toJsonl(records)` output
  - `'tree' kind, conversationId undefined'` → returns `null`
  - `'tree' kind, conversationId with no matching records'` → returns `null` (drives the
    `buildTree(...)` empty-array branch)
  - `'tree' kind, matching conversation'` → filename `thread-<id>.json`, text matches `toTreeJson(...)`
  - `'markdown' kind, matching conversation'` → filename `thread-<id>.md`, text matches `toMarkdown(...)`

Use `selectConversation`'s own test fixtures in `store.test.ts:82-87` as a model for building a small
multi-record, multi-conversation `TweetRecord[]` fixture.

## Coordination

`background.ts` is also touched by the retry-plan and clear-seed handoffs dated 2026-07-05, but in
different regions (this handoff's edits are confined to `:1123-1139` and `:1223-1230`). No line-range
overlap expected — verify against the working tree at execution time since those handoffs may land first
and shift line numbers. Recommended ordering: no hard dependency; this handoff can land independently of
the other two.
