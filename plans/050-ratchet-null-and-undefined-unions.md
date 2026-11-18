# Plan 050: The count of `| null` and `| undefined` unions can only go down

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report. Do not improvise. When done, update the status row for this plan in
> `plans/README.md`, unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 2089ed0 -- scripts/lint-boundaries.ts package.json`
> The plan was written against a working tree with uncommitted changes on top
> of `2089ed0`. `package.json` already had uncommitted changes then. Compare
> the "Current state" excerpts with the live files before you edit.

## Status

- **Priority**: P2
- **Effort**: S for this plan. The conversions it enables are L in total.
- **Risk**: LOW
- **Depends on**: none. Run it after 046–048 so the first budget is lower.
- **Category**: dx
- **Planned at**: commit `2089ed0`, 2026-11-20
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/124

## Why this matters

The owner's rule is that a type must say what absence means, so `| null` and
`| undefined` are not acceptable in first-party types. A text search on
2026-11-20 found 306 `| null` and 230 `| undefined` in non-test files under
`src`. Converting 536 sites in one change is not safe, and nothing stops a
new one from landing tomorrow. This plan adds a checker with a per-folder
budget. The gate fails when a folder's count rises, and it also fails when
the count falls until the budget is lowered to match. Later plans then convert
one module at a time and the budget records the progress.

The owner has not yet confirmed which boundaries are exempt. This plan counts
every union and exempts nothing. A boundary exemption, if the owner wants
one, is a later change to the checker.

## Current state

- `scripts/lint-boundaries.ts` is the house pattern for a custom checker. It
  is a Bun script with a shebang, parses with `oxc-parser`, exports a pure
  function, and runs under `if (import.meta.main)`:

  ```ts
  #!/usr/bin/env bun
  ```
  ```ts
  import { readFileSync, readdirSync, statSync } from 'node:fs'
  import { parseSync } from 'oxc-parser'
  ```
  ```ts
  export const cruise = (root = 'src'): Violation[] => {
  ```
  ```ts
  if (import.meta.main) {
  ```

  It exits 0 when clean and 1 on a violation.

- `oxc-parser` is already a dev dependency (`^0.153.0`). Add no dependency.
- `package.json` scripts:

  ```json
      "lint:boundaries": "bun scripts/lint-boundaries.ts",
  ```

  The `check` script is one `&&` chain that contains
  `bun scripts/lint-boundaries.ts && vitest run`.

- `AGENTS.md` says about custom checkers: "If you ever change the checker,
  prove it still fails on a deliberate violation before trusting a pass."
  This plan follows that rule in Step 4.
- `vitest` only collects tests under `src/**`. `lint-boundaries.ts` has no
  unit test. This plan proves the checker with deliberate violations instead.
- `tools/anti-slop/plugin.mjs` is a vendored, generated lint plugin. Do not
  edit it.
- Largest clusters on 2026-11-20, by text search (the checker's AST count
  will differ slightly):

  | File | `\| null` | `\| undefined` |
  | --- | --- | --- |
  | `src/background/tab-broadcaster.ts` | 0 | 42 |
  | `src/entrypoints/overlay.content/index.tsx` | 34 | 5 |
  | `src/entrypoints/popup/App.tsx` | 20 | 5 |
  | `src/packages/download/terminal-outcome.ts` | 15 | 1 |
  | `src/entrypoints/overlay.content/handlers.ts` | 9 | 13 |
  | `src/packages/clear/tweet-clear.ts` | 9 | 11 |
  | `src/entrypoints/background.ts` | 6 | 14 |

### Conventions that apply

- Never add `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or
  `@ts-expect-error`. No `any`. No `unknown` in a parameter or return type.
- `scripts/**` is linted with relaxed rules for `no-console` and
  `no-await-in-loop` only. Everything else applies.
- Named constants, `const` by default, `for...of` over `.forEach()`.
- Package manager is `bun`. Never `npm` or `npx`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Run the checker | `bun scripts/lint-absence.ts` | exit 0 |
| Print counts | `bun scripts/lint-absence.ts --print` | one line per folder, exit 0 |
| Lint | `bun run lint` | exit 0, no new warning |
| Typecheck | `bun run typecheck` | exit 0 |

## Scope

**In scope**:

- `scripts/lint-absence.ts` (create)
- `scripts/absence-budget.json` (create)
- `package.json` (two script lines only)
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch):

- Every file under `src`. This plan converts nothing.
- `hk.pkl`, `.oxlintrc.json`, `tools/anti-slop/plugin.mjs`.
- Optional properties (`name?: T`). `tsconfig.json` sets
  `exactOptionalPropertyTypes`, so an optional property already means
  "absent", not "present and undefined". The checker does not count them.

## Git workflow

- Branch: `advisor/050-ratchet-null-and-undefined-unions`
- One commit. Message: `chore(lint): ratchet null and undefined unions per folder`.
- Do NOT push or open a PR unless the operator told you to.

## Steps

### Step 1: Confirm the AST shape

Run:

```bash
bun -e "import {parseSync} from 'oxc-parser'; const r = parseSync('a.ts', 'let a: string | null; let b: number | undefined'); console.log(JSON.stringify(r.program.body[0].declarations[0].id.typeAnnotation, null, 1))"
```

**Verify**: the output contains a node with `"type": "TSUnionType"` whose
`types` array holds a node with `"type": "TSNullKeyword"`. If the names
differ, use the names you see in Step 2. If `r.program` is undefined, STOP.

### Step 2: Write the checker

Create `scripts/lint-absence.ts`. Required behavior:

1. Walk every `.ts` and `.tsx` file under `src`. Skip files that end in
   `.test.ts`, `.test.tsx`, `.spec.ts`, `.spec.tsx`, or `.d.ts`, and skip any
   path that contains `/tests/`.
2. Parse each file with `parseSync(path, source)`. Visit every AST node by
   walking object and array values recursively. Count each `TSUnionType` node
   whose direct `types` include a `TSNullKeyword` or a `TSUndefinedKeyword`.
   One union counts once, even if it holds both.
3. Group counts by folder key. The key is the first two path segments, for
   example `src/background`, `src/components`, `src/core`, `src/entrypoints`,
   `src/packages`. A file directly under `src` uses the key `src`.
4. Read `scripts/absence-budget.json`, an object from folder key to number.
5. Compare. A folder fails when its count is above its budget, when its count
   is below its budget, or when it has a count and no budget entry. A budget
   entry for a folder that no longer has any file also fails.
6. Print one line per failing folder, in this exact form:

   ```text
   absence: src/packages has 141 null/undefined unions, budget 139. Remove the new ones.
   absence: src/core has 60 null/undefined unions, budget 64. Lower the budget to 60.
   ```

   Exit 1 if any folder fails. Otherwise print
   `absence: N unions in M folders, all at budget.` and exit 0.
7. With `--print`, print `"<folder>": <count>` per folder, sorted by folder
   name, and exit 0 without comparing.
8. With `--files <folder>`, print `<count> <path>` for each file in that
   folder with a count above 0, highest first, and exit 0. Later conversion
   plans use this to pick a module.

Shape to follow, taken from `scripts/lint-boundaries.ts`: a shebang line, a
module doc comment that states what the checker enforces and why the budget
must equal the count, an exported pure function
`countAbsence(file: string, source: string): number`, an exported
`tally(root = 'src'): Map<string, number>`, and the CLI under
`if (import.meta.main)`. Resolve the budget path from the script's own
location with `new URL('./absence-budget.json', import.meta.url)`, not from
the current directory.

Type the walker's input without `any` or `unknown`. The parsed program is a
JSON-like tree, so a recursive type is enough:

```ts
type AstValue = string | number | boolean | null | ReadonlyArray<AstValue> | AstNode
interface AstNode {
  readonly [key: string]: AstValue
}
```

If the parser's own types do not assign to `AstNode`, STOP and report the
error text. Do not cast through `unknown`.

Note that this script itself contains `| null` in `AstValue`. It lives under
`scripts`, which the checker does not walk.

**Verify**: `bun scripts/lint-absence.ts --print` → prints at least the keys
`src/background`, `src/components`, `src/core`, `src/entrypoints`,
`src/packages`, each with a number above 0. The numbers sum to between 400
and 650.

### Step 3: Write the budget

Create `scripts/absence-budget.json` from the `--print` output: one JSON
object, keys sorted, two-space indent, trailing newline.

**Verify**: `bun scripts/lint-absence.ts` → exit 0 and the "all at budget"
line.

### Step 4: Prove it fails both ways

1. Append the line `export type AbsenceProbe = string | null` to
   `src/components/owned-timer.ts`. Run `bun scripts/lint-absence.ts`.
   Expect exit 1 and a "Remove the new ones." line for `src/components`.
2. Remove that line. Run `git diff --stat -- src/components/owned-timer.ts`
   and expect no output.
3. In `scripts/absence-budget.json`, raise the `src/core` number by 1. Run
   the checker. Expect exit 1 and a "Lower the budget to" line for
   `src/core`.
4. Restore the number. Run the checker. Expect exit 0.

**Verify**: all four expectations held, and `git status --short src` prints
nothing.

### Step 5: Wire it into the gate

In `package.json`:

1. After the `"lint:boundaries"` line add
   `"lint:absence": "bun scripts/lint-absence.ts",`.
2. In the `check` script, change
   `bun scripts/lint-boundaries.ts && vitest run` to
   `bun scripts/lint-boundaries.ts && bun scripts/lint-absence.ts && vitest run`.

**Verify**: `bun run lint:absence` → exit 0. `bun run lint` → exit 0.
`bun run typecheck` → exit 0.

## Test plan

No vitest file, because vitest collects only `src/**` and the sibling checker
has none. Step 4 is the test: one deliberate violation per failure direction,
each seen failing and then seen passing.

## Done criteria

ALL must hold:

- [ ] `bun run lint:absence` exits 0
- [ ] Step 4's four expectations were observed and are listed in the report
- [ ] `bun run lint` and `bun run typecheck` exit 0
- [ ] `export CODEDB_NO_HOOKS=1; rg -n 'lint-absence' package.json` → two matches
- [ ] `git status --short` shows only `scripts/lint-absence.ts`,
      `scripts/absence-budget.json`, `package.json`, and `plans/README.md`
      as changed by this plan
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report if:

- `parseSync` returns no `program`, or union nodes have no recognizable type
  name (Step 1).
- The total from `--print` is outside 400–650. The walker then misses nodes
  or counts them twice.
- `package.json` no longer contains the quoted `check` fragment.
- Lint on the new script can be cleared only by disabling a rule.

## Maintenance notes

- Every conversion plan ends with "lower the budget". A pull request that
  removes unions and forgets the budget fails the gate with the exact number
  to write.
- Suggested conversion order, smallest blast radius first:
  `src/packages/download/admission.ts`, then
  `src/packages/download/terminal-outcome.ts`, then
  `src/background/tab-broadcaster.ts`. Each needs its own plan, because the
  right replacement (Effect `Option`, a `_tag` union, or a named literal)
  depends on what absence means at each site.
- Owner decision still open: whether DOM, `browser.*`, and backend-JSON
  boundary lines are exempt. Today they count. If they become exempt, the
  checker needs a rule that can be stated without a suppression comment,
  because the repo forbids those.
- The overlay content script and `background.ts` are edited by many open
  plans (012, 013, 016, 021, 024–028, 042, 043). Each of those can change a
  count. Whoever lands one reruns `bun run lint:absence` and adjusts the
  budget in the same commit.
