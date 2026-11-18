# Plan 016: A test locks the overlay's teardown so every document listener it adds is removed on invalidation

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 7456911 -- src/entrypoints/overlay.content/index.tsx src/entrypoints/overlay.content/listener-teardown.test.ts`
> `index.tsx` already shows as changed: the working tree had uncommitted edits
> when this plan was written, and the fix this plan guards is one of them.
> Compare the "Current state" excerpts against the live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none. Plan 021 edits the final `ctx.onInvalidated` block that this plan's test reads; run them one after the other, never in parallel.
- **Category**: tests
- **Planned at**: commit `7456911`, 2026-11-16. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.

## Why this matters

The overlay content script adds three listeners directly on the page's
`document`. Until recently its teardown removed only two of them. The third,
`xmd:mutation-response`, stayed attached after the extension was reloaded or
updated.

A listener that stays attached keeps its closure alive. Every function inside
`main()` shares one closure scope, so one leaked listener keeps the whole old
overlay reachable: its media store, its timers' state, and its Preact tree.
One copy leaked per extension reload, for the life of the tab.

The missing removal has since been added in the working tree (uncommitted).
Nothing stops the same mistake from returning: the three registrations and
the teardown are about 400 lines apart. This plan adds a test that fails
whenever a direct `document.addEventListener` has no matching
`document.removeEventListener`. It changes no source code.

## Current state

- `src/entrypoints/overlay.content/index.tsx` — the overlay content script
  (about 2347 lines). `main()` registers listeners. It contains two
  `ctx.onInvalidated` blocks: a small one near line 1562 that unwatches
  settings, and the final teardown block that starts near line 2298. This plan
  is about the final one. This file is READ-ONLY for this plan.
- `src/entrypoints/overlay.content/accessibility.test.ts` — an existing test
  that reads `index.tsx` as text and asserts on its source. It is the pattern
  for the new test.

The three direct registrations, each right after its handler is defined:

```ts
// src/entrypoints/overlay.content/index.tsx:1850
    document.addEventListener('xmd:media-response', handleMediaResponse)
```

```ts
// src/entrypoints/overlay.content/index.tsx:1920
    document.addEventListener('xmd:mutation-response', handleMutationResponse)
```

```ts
// src/entrypoints/overlay.content/index.tsx:1949
    document.addEventListener(TEE_DROP_EVENT, handleTeeDrop)
```

The end of the final teardown block, with all three removals present:

```ts
// src/entrypoints/overlay.content/index.tsx:2340-2347
      // `browser.runtime` is already undefined once the context is invalidated.
      browser.runtime?.onMessage?.removeListener(handleRuntimeMessage)
      document.removeEventListener('xmd:media-response', handleMediaResponse)
      document.removeEventListener('xmd:mutation-response', handleMutationResponse)
      document.removeEventListener(TEE_DROP_EVENT, handleTeeDrop)
    })
  },
})
```

Every other listener in `main()` is registered through `ctx.addEventListener`.
WXT removes those automatically on invalidation. They are correct and are not
part of this plan.

The existing source-text test pattern to copy:

```ts
// src/entrypoints/overlay.content/accessibility.test.ts:1-11
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const overlaySource = readFileSync('src/entrypoints/overlay.content/index.tsx', 'utf8')
const overlayCss = readFileSync('src/entrypoints/overlay.content/style.css', 'utf8')

describe('overlay save-status announcements (a11y)', () => {
  it('wires the badge name and status to the pure helpers', () => {
    expect(overlaySource).toContain('aria-label={badgeAriaLabel(badge.phase, mediaType)}')
    expect(overlaySource).toContain('{badgeStatusMessage(badge.phase, mediaType)}')
  })
```

Repo conventions that apply (from `AGENTS.md`):

- "Forbidden, without exception: `oxlint-disable` / `eslint-disable` /
  `@ts-ignore` / `@ts-expect-error`".
- "Regex literals at module top level, not rebuilt inside loops."
- "Assertions live inside `it()` / `test()`."
- "Named constants, not magic numbers."

Comment rule: do not add, edit, or delete code comments. A pre-edit hook
(`doc-lock`) blocks comment changes. Carry intent in names, types, and tests.
Do not edit any Markdown file except this plan's status row in
`plans/README.md`.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Typecheck | `bun run typecheck` | exit 0 |
| Lint | `bun run lint` | exit 0 |
| Format check | `bun run fmt:check` | exit 0 |
| Boundaries | `bun run lint:boundaries` | exit 0 |
| Focused tests | `bun run test src/entrypoints/overlay.content/listener-teardown.test.ts` | all pass |
| Full gate | `bun run check` | exit 0 |
| Build | `bun run build` | exit 0 |

The package manager is bun. Never use npm or npx.

## Scope

**In scope** (the only files you should modify):

- `src/entrypoints/overlay.content/listener-teardown.test.ts` (create)
- `plans/README.md` — this plan's row in the "Performance plans (012–023)"
  table only

**Out of scope** (do NOT touch, even though they look related):

- `src/entrypoints/overlay.content/index.tsx` — read-only. The fix is already
  there. Step 2 changes one line temporarily and restores it; the file must
  end byte-identical to how you found it. Never stage or commit this file.
- `src/entrypoints/inject.content.ts` — the page-world script that dispatches
  these events.
- The `ctx.addEventListener(...)` calls in `index.tsx`. WXT already removes them.

## Git workflow

- Branch: `advisor/016-remove-mutation-response-listener`
- Commit message style is conventional commits. Example from this repo:
  `feat(relay): support Last-Modified validator, direct folder upload, and bump Convex to 1.46.0`.
  Use `test(overlay): lock document listener teardown`.
- Do NOT push or open a PR.
- The working tree has unrelated uncommitted user changes. Never revert,
  stash, or stage them. Stage only the new test file and `plans/README.md`,
  by exact path.
- Staging rule: if an in-scope file already had uncommitted changes before
  you started (`plans/README.md` may), do not commit it. Leave your edit there
  unstaged and report it.

## Steps

### Step 1: Write the test (expected to pass)

Before you start, save the current state of the source file for Step 2:
`git diff -- src/entrypoints/overlay.content/index.tsx > "$TMPDIR/016-before.diff"`.

Create `src/entrypoints/overlay.content/listener-teardown.test.ts`.

The test reads `index.tsx` as text, collects every direct
`document.addEventListener(EVENT, HANDLER)` call, and asserts that the same
`(EVENT, HANDLER)` pair appears in a `document.removeEventListener` call.

Target shape:

```ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const overlaySource = readFileSync('src/entrypoints/overlay.content/index.tsx', 'utf8')

const DOCUMENT_ADD = /document\.addEventListener\(\s*([^,()]+?)\s*,\s*(\w+)\s*\)/g
const DOCUMENT_REMOVE = /document\.removeEventListener\(\s*([^,()]+?)\s*,\s*(\w+)\s*\)/g

const pairs = (pattern: RegExp): string[] =>
  [...overlaySource.matchAll(pattern)].map((match) => `${match[1]} -> ${match[2]}`)

describe('overlay document listeners', () => {
  it('finds the direct document listeners it is meant to guard', () => {
    expect(pairs(DOCUMENT_ADD)).toContain("'xmd:mutation-response' -> handleMutationResponse")
  })

  it('removes every direct document listener on invalidation', () => {
    const removed = new Set(pairs(DOCUMENT_REMOVE))
    const leaked = pairs(DOCUMENT_ADD).filter((pair) => !removed.has(pair))
    expect(leaked).toEqual([])
  })
})
```

The first test proves the pattern matches real code, so the second test can
never pass by matching nothing.

**Verify**: `bun run test src/entrypoints/overlay.content/listener-teardown.test.ts`
→ 2 passed. If the second test fails, go to "STOP conditions".

### Step 2: Prove the test can fail (mutation check)

A test that has never been seen failing proves nothing. Do this check and
report its result.

1. In `src/entrypoints/overlay.content/index.tsx`, temporarily delete the one
   line `document.removeEventListener('xmd:mutation-response', handleMutationResponse)`.
2. Run `bun run test src/entrypoints/overlay.content/listener-teardown.test.ts`.
   Expected: the first test passes and the second test FAILS with `leaked`
   equal to `["'xmd:mutation-response' -> handleMutationResponse"]`.
3. Restore the line exactly where it was.

**Verify**: `git diff -- src/entrypoints/overlay.content/index.tsx | diff - "$TMPDIR/016-before.diff"`
→ prints nothing (the file is identical to how you found it).
**Verify**: `bun run test src/entrypoints/overlay.content/listener-teardown.test.ts`
→ 2 passed.

In your final report, state: "mutation check: test failed with the named
pair when the remove line was deleted; line restored".

### Step 3: Run the gates

**Verify**: `bun run typecheck` → exit 0.
**Verify**: `bun run lint` → exit 0.
**Verify**: `bun run fmt:check` → exit 0.
**Verify**: `bun run check` → exit 0.

## Test plan

- New file `src/entrypoints/overlay.content/listener-teardown.test.ts` with two
  tests:
  1. The add-listener pattern matches the known `xmd:mutation-response`
     registration (guards against a pattern that matches nothing).
  2. Every direct `document.addEventListener(EVENT, HANDLER)` in `index.tsx`
     has a matching `document.removeEventListener(EVENT, HANDLER)`. The
     expectation comes from the requirement "no document listener outlives the
     content-script context".
- Red proof: Step 2's mutation check. The test fails when the remove line is
  absent and passes when it is present.
- Structural pattern: `src/entrypoints/overlay.content/accessibility.test.ts`.
- Verification: `bun run test src/entrypoints/overlay.content/listener-teardown.test.ts`
  → 2 passed.

## Done criteria

ALL must hold:

- [ ] `bun run test src/entrypoints/overlay.content/listener-teardown.test.ts` exits 0 with 2 passing tests
- [ ] The mutation check in Step 2 was run and its result is in the report
- [ ] `git diff -- src/entrypoints/overlay.content/index.tsx | diff - "$TMPDIR/016-before.diff"` prints nothing
- [ ] `rg -c "document.removeEventListener\('xmd:mutation-response', handleMutationResponse\)" src/entrypoints/overlay.content/index.tsx` prints `1`
- [ ] `bun run check` exits 0
- [ ] `git status --short` shows no newly modified files other than the new test file and `plans/README.md` (files that were already modified before you started do not count)
- [ ] `plans/README.md` status row for 016 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The line `document.removeEventListener('xmd:mutation-response', handleMutationResponse)`
  is absent from `index.tsx` when you start. Do not add it. Report that the
  fix is missing; the owner decides how it lands.
- Step 1's second test fails and lists any leaked pair. Report the pairs. Do
  not edit `index.tsx` to make the test pass.
- The final teardown block does not look like the excerpt in "Current state"
  (plan 021 may have changed it). Report the difference.
- You cannot restore `index.tsx` to its exact earlier state after Step 2.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Anyone who adds a new `document.addEventListener` to the overlay must either
  add the matching removal or use `ctx.addEventListener`. The new test enforces
  the first option for direct registrations.
- Plan 021 also edits the final `ctx.onInvalidated` block. Run the two plans
  one after the other. Whichever runs second must re-read the block first.
- Plan 007 (`plans/007-split-overlay-content-controller.md`) plans to split
  `index.tsx` into modules. When that lands, this test's file path must follow
  the listeners to their new module.
- The fix line itself is uncommitted at the time of writing. The owner should
  commit it; this plan deliberately does not.
- Not covered here: measuring how much memory the leak retained.
