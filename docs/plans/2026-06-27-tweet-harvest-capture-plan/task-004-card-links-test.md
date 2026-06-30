# Task 004: Card / link de-shortening test (Red)

**depends-on**: task-001-capture-test-fixtures

## Description
Add a failing unit test that pins down the pure link/card helpers in the capture layer: de-shortening `t.co` URLs inline within a tweet's full text in an index-safe way, projecting URL entities into `Link[]`, and reading card metadata (title/description/domain) from both the flat `summary` binding-values encoding and the JSON-encoded `unified_card` blob. The test also asserts the malformed-card path yields no title and never throws. This task only writes the test and the exported type plus signature stubs needed to compile it; the real bodies land in the paired Green task.

## Execution Context
**Task Number**: 004 of 30
**Phase**: Foundation
**Prerequisites**: Task 001 (capture test fixtures) is complete, so realistic tweet/URL-entity and card-node fixtures are available for the test to import. No implementation of `card.ts` bodies exists yet.

## BDD Scenario
```gherkin
Scenario: links are de-shortened and card titles reused, index-safe
  Given a tweet whose full_text contains a t.co at a known offset AND an astral/emoji char before it
  When expandText runs
  Then every t.co is replaced inline by its expanded_url with correct offsets (apply from highest index backward)
  And linksFromEntities returns Link[] with expandedUrl/displayUrl
  And cardMeta reads title/description/domain from a flat summary card AND from a unified_card JSON blob
  And a malformed card yields no title and never throws
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§6.3)

## Files to Modify/Create
- Create: `src/core/capture/card.test.ts`
- Create (stubs only): `src/core/capture/card.ts`

## Contracts (signatures/types ONLY — no bodies)
```ts
export type Link = { expandedUrl: string; displayUrl?: string; title?: string; description?: string; domain?: string }
export function expandText(fullText: string, urlEntities: ReadonlyArray<{ url: string; expanded_url: string; display_url?: string; indices?: [number, number] }>): string
export function linksFromEntities(urlEntities: ReadonlyArray<{ url: string; expanded_url: string; display_url?: string }>): Link[]
export function cardMeta(cardNode: unknown): { title?: string; description?: string; domain?: string }
```

## Steps
1. Confirm the scenario and contracts against §6.3 of the spec, noting: entity indices are UTF-16 code-unit offsets, replacements must be applied from the highest index backwards so an astral/emoji char before a `t.co` does not corrupt the rewrite, and `cardMeta` must be best-effort (flat `summary`/`summary_large_image` binding values plus `unified_card` JSON, never throwing).
   - Verification: re-read §6.3; the four contract signatures match exactly.
2. Create `src/core/capture/card.ts` exporting the `Link` type and the three functions `expandText`, `linksFromEntities`, and `cardMeta` with the EXACT signatures above, each function body being `throw new Error("not implemented")` so the test file type-checks and imports resolve.
   - Verification: `bunx tsc --noEmit` reports no errors for `src/core/capture/card.ts`; the stubs export the named symbols.
3. Write `src/core/capture/card.test.ts` mapping the Gherkin Given/When/Then:
   - Given: build (or import from Task 001 fixtures) a `full_text` containing an astral/emoji char before a `t.co` token at a known offset, with a matching URL entity carrying `url`, `expanded_url`, `display_url`, and code-unit `indices`; also build a second entity so multiple replacements are exercised.
   - When: call `expandText(fullText, urlEntities)`.
   - Then (expansion): assert each `t.co` is replaced inline by its `expanded_url` and the surrounding emoji/text is intact (verifies highest-index-backward application; offsets stay valid).
   - Then (links): assert `linksFromEntities(urlEntities)` returns `Link[]` whose elements carry `expandedUrl` and `displayUrl`.
   - Then (cards): assert `cardMeta` reads `title`/`description`/`domain` from a flat `summary` card node AND from a `unified_card` JSON-blob node.
   - Then (malformed): assert `cardMeta` on a malformed/garbage node returns no `title` and does not throw (wrap in a `expect(() => ...).not.toThrow()` plus an assertion that `title` is undefined).
   - Verification: the test file imports `expandText`, `linksFromEntities`, `cardMeta`, and `Link` from `./card` with no unresolved references.
4. Run the test and confirm it FAILS on an assertion (the stubs throw `not implemented`), not on a compile or import error.
   - Verification: `bunx vitest run src/core/capture/card.test.ts` exits non-zero with assertion/`not implemented` failures, and the spec/imports resolved cleanly.

## Verification Commands
```bash
bunx vitest run src/core/capture/card.test.ts   # MUST FAIL (Red)
```

## Success Criteria
- `src/core/capture/card.test.ts` and the stub `src/core/capture/card.ts` exist; the test file compiles and imports `expandText`, `linksFromEntities`, `cardMeta`, and the `Link` type from `./card`.
- The test encodes every clause of the scenario: index-safe inline `t.co`→`expanded_url` expansion with an astral/emoji char before the offset, `Link[]` with `expandedUrl`/`displayUrl`, `cardMeta` from both a flat `summary` card and a `unified_card` JSON blob, and a malformed card yielding no `title` without throwing.
- `bunx vitest run src/core/capture/card.test.ts` FAILS on assertions (stubs throw `not implemented`), not on a compile/import error — establishing a valid Red for the paired Green task.
- No implementation bodies are present in `card.ts` beyond the `throw new Error("not implemented")` stubs; the 100% unit-coverage gate is satisfied later by the paired Green task.
