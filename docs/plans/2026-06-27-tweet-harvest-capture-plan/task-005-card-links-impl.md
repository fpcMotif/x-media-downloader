# Task 005: Card / link de-shortening impl (Green)

**depends-on**: task-004-card-links-test

## Description
Implement the bodies of the pure card/link helpers in `src/core/capture/card.ts` so the failing test from task 004 passes. `expandText` must replace every `t.co` with its `expanded_url` inline using index-safe (highest-offset-first) rewriting so UTF-16 offsets stay valid even when astral/emoji characters precede an entity; `linksFromEntities` must project URL entities into `Link[]`; and `cardMeta` must read card titles/descriptions/domains from both the flat `summary`/`summary_large_image` `binding_values[]` encoding and the JSON-encoded `unified_card` blob, returning best-effort fields and never throwing on malformed input.

## Execution Context
**Task Number**: 005 of 30
**Phase**: Foundation
**Prerequisites**: Task 004 (Red) has created `src/core/capture/card.ts` with exported type and function signature stubs that throw `not implemented`, and `src/core/capture/card.test.ts` which currently fails on an assertion. This task fills in the bodies only — no signatures change.

## BDD Scenario
```gherkin
Scenario: links are de-shortened and card titles reused, index-safe
  Given a tweet whose full_text contains a t.co at a known offset AND an astral/emoji char before it
  When expandText runs
  Then every t.co is replaced inline by its expanded_url with correct offsets
  And cardMeta supports flat summary cards and the unified_card JSON blob, never throwing on malformed input
```
**Spec Source**: docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md (§6.3)

## Files to Modify/Create
- Modify: `src/core/capture/card.ts` (implement bodies — signatures unchanged from task 004)

## Contracts (signatures/types ONLY — no bodies)
```ts
// Implement the signatures already defined in task 004 (src/core/capture/card.ts):
//   type Link
//   expandText(fullText, urlEntities) -> string
//   linksFromEntities(urlEntities) -> Link[]
//   cardMeta(cardNode) -> { title?; description?; domain? }
// No new exports or signature changes are introduced by this task.
```

## Steps
1. Read `src/core/capture/card.ts` and `src/core/capture/card.test.ts` to confirm the exported signatures and the Given/When/Then assertions the test encodes (the t.co-after-emoji offset case, flat `summary` card, `unified_card` JSON blob, and the malformed-input non-throwing case).
   - Verification: the stubs currently throw `not implemented` and `bunx vitest run src/core/capture/card.test.ts` fails on an assertion, not a compile/import error.
2. Implement `expandText` so URL-entity replacements are applied from the highest UTF-16 index backwards, leaving the original code-unit offsets of earlier entities valid; preserve all non-entity text verbatim.
   - Verification: the emoji-preceding-t.co assertion passes — the expanded URL lands at the correct position with no truncated or shifted characters.
3. Implement `linksFromEntities` to project each URL entity into a `Link` with `expandedUrl` (and `displayUrl` when present).
   - Verification: the test's expected `Link[]` for the sample entities matches exactly.
4. Implement `cardMeta` to read titles/descriptions/domains from the flat `summary`/`summary_large_image` `binding_values[]` keyed `title`/`description`/`domain`/`card_url`, and from the `unified_card` `string_value` (JSON-parsed) via `component_objects[*].data.title.content`/`.subtitle.content` and `destination_objects[*].data.url_data.{url,vanity}`; on any structural mismatch or parse failure, return without those fields and never throw.
   - Verification: the flat-card and unified_card assertions pass; the malformed-input case returns an object (no thrown error).
5. Re-run the paired test, then the full coverage gate.
   - Verification: `bunx vitest run src/core/capture/card.test.ts` is green and `bun run test:coverage` keeps the `src/core/**` 100% gate satisfied for `card.ts`.

## Verification Commands
```bash
bunx vitest run src/core/capture/card.test.ts   # MUST PASS (Green)
bun run test:coverage
```

## Success Criteria
- The task-004 scenario test (`src/core/capture/card.test.ts`) passes: t.co entities expand inline at correct offsets even with an astral/emoji char before them.
- `cardMeta` resolves titles/descriptions/domains from both the flat summary encoding and the `unified_card` JSON blob, and returns best-effort (never throws) on malformed input.
- No exported signature or type from task 004 changed — bodies only.
- `bun run test:coverage` passes with `src/core/capture/card.ts` fully covered under the existing 100% `src/core/**` gate.
