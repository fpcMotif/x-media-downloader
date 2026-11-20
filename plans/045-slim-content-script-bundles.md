# Plan 045: Take the Effect runtime out of the page-world script, and measure what the overlay script carries

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat cee429a -- src/packages/clear/clearer.ts src/packages/clear/tests src/core/adapters/x/tracked-mutation.ts src/entrypoints/inject.content.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 (Part A), P3 (Part B)
- **Effort**: S (Part A), S (Part B). Part C is a design note, not executable work.
- **Risk**: LOW
- **Depends on**: none. Plans 016, 021 and 042 edit `src/entrypoints/inject.content.ts`. This plan does not edit that file, but they change its built size. Take the Step A1 baseline after they land, or take it again.
- **Category**: perf
- **Planned at**: commit `cee429a`, 2026-11-17. Excerpts were read from a working tree with uncommitted changes on top of this commit. Compare every excerpt with the live file before editing.
- **Issue**: https://github.com/fpcMotif/x-media-downloader/issues/118

## Why this matters

The extension injects two scripts into every X, Instagram and Threads tab,
including background tabs. The browser parses and keeps each script per tab.

- `inject.js` runs in the page's own world on every page load. It needs no
  Effect code, but the built file contains parts of the Effect runtime. They
  arrive through one import of a small id check.
- `overlay.js` is the larger script. The built file contains Effect's Schema
  engine and much of its runtime.

In the build that existed at planning time
(`.output/chrome-mv3/content-scripts/`, built 2026-11-16, possibly older than
the working tree), `inject.js` was 30,611 bytes and `overlay.js` was 207,646
bytes. `inject.js` held 10 distinct `effect/…` module markers and `overlay.js`
held 28.

Part A removes Effect from `inject.js`. The done criterion is measurable: zero
`effect/` markers and a smaller file. Part B measures what `overlay.js` is
made of and reports numbers. Part C records why the overlay's Schema removal
is not planned as executable work yet. No runtime or memory figure in this
plan was measured in a browser.

## Current state

Files and roles:

- `src/entrypoints/inject.content.ts` — the page-world (MAIN world) script.
  Read only in this plan.
- `src/core/adapters/x/tracked-mutation.ts` — recognises X's bookmark and like
  mutation calls for the page-world script.
- `src/packages/clear/clearer.ts` — DOM helpers for the Clear feature. It
  imports Effect's `Option`.
- `src/packages/clear/tests/clearer.test.ts` — its tests.
- `src/packages/clear/seed.ts` — a second caller of the id check. Read only.

The page-world script's imports (`src/entrypoints/inject.content.ts:1-10`):

```ts
import { adapterForHostname, ALL_ADAPTERS } from '../core/adapters/registry'
import { matchReleaseMutationOp } from '../core/adapters/x/tracked-mutation'
import {
  makeTeeBudget,
  readBoundedUtf8Response,
  utf8ByteLengthAtMost,
  MAX_TEE_BODY_BYTES,
  TEE_DROP_EVENT,
  type TeeDropCap,
} from '@/packages/kernel/tee-limits'
```

The one path to Effect (`src/core/adapters/x/tracked-mutation.ts:9-11`, `:86`):

```ts
import { isClearableTweetId } from '@/packages/clear/clearer'
import type { JsonValue } from '@/packages/schema'
import { isJsonObject, isJsonString } from '../json-predicates'
```

```ts
    return isJsonString(tweetId) && isClearableTweetId(tweetId) ? tweetId : undefined
```

The imported module starts with (`src/packages/clear/clearer.ts:9-10`):

```ts
import { Option } from 'effect'
import type { ClearScope } from '@/packages/schema'
```

The id check itself uses no Effect code (`src/packages/clear/clearer.ts:174-192`):

```ts
/** Twitter's snowflake epoch (2010-11-04T01:42:54.657Z): every genuine status id
 *  decodes to `(id >> 22) + EPOCH`. */
const SNOWFLAKE_EPOCH_MS = 1_288_834_974_657

/** Can the Clear even LOCATE this post? `findArticle` matches a tweet ONLY by its
 *  numeric `/status/{id}` permalink, so a tweetId that isn't a PLAUSIBLE snowflake
 *  can never match a mounted article — it would defer-then-drop on every tab and
 *  silently leave the post in its lists ("not mounted"). That happens for the
 *  media-key fallback the X adapter uses when a photo's tweet context can't be
 *  resolved (`tweetId ?? key`) AND for captured junk ids (live 2026-08-23:
 *  `3969701833668148185`, which decodes to year 2040 — X 404s that permalink
 *  forever while the release leg burns its whole poll budget). Gate clear seeding
 *  on digit shape AND decodable time inside [Twitter epoch, now + 1 day], so such
 *  items are skipped honestly up front, never seeded into a clear that can only fail. */
export function isClearableTweetId(tweetId: string): boolean {
  if (!/^[0-9]{1,20}$/.test(tweetId)) return false
  const createdAtMs = Number(BigInt(tweetId) >> 22n) + SNOWFLAKE_EPOCH_MS
  return createdAtMs >= SNOWFLAKE_EPOCH_MS && createdAtMs <= Date.now() + 86_400_000
}
```

`SNOWFLAKE_EPOCH_MS` is used only inside this function. The function has two
callers: `tracked-mutation.ts:86` and `src/packages/clear/seed.ts:209`.
Existing tests are in `src/packages/clear/tests/clearer.test.ts:39-57`, under
`describe('clearer — isClearableTweetId (DOM-locatable id guard)', …)`.

`type` imports are erased at build time. At planning time the other modules
on the page-world script's import path (`registry.ts`, the three adapters,
`json-predicates.ts`, `tee-limits.ts`) had no value import from `effect`.
Step A4 verifies this on the built file.

What the overlay script imports from Effect, for Parts B and C. At planning
time these files on the overlay's import path had a value import from
`effect`:

- `src/entrypoints/overlay.content/handlers.ts:10` — `Option, Result, Schema`
- `src/entrypoints/overlay.content/index.tsx:83` — `Option`
- `src/packages/settings/index.ts:1` — `Context, Effect, Layer, Schema`
- `src/packages/schema/index.ts:1` — `Schema, Effect`
- `src/packages/schema/media.ts:1` — `Schema`
- `src/packages/clear/clearer.ts`, `tweet-clear.ts`, `list-clear.ts`,
  `scroll-drain.ts`, `recheck.ts` — `Option`
- `src/packages/clear/worklist.ts:19` and `diagnostics.ts:36` — `Schema`
- `src/core/adapters/x/syndication.ts:1` — `Option`

The overlay decodes every inbound message against a Schema union
(`src/entrypoints/overlay.content/handlers.ts:1203-1216`):

```ts
const OverlayInboundMessage = Schema.Union([
  ...TAB_MESSAGE_MEMBERS,
  TransferOutcome,
  SavedStatusUpdate,
  ClearDetectedMediaRequest,
])
```

```ts
export const dispatchOverlayMessage: MessageHandler = (message, deps, sendResponse) => {
  const decoded = Schema.decodeUnknownResult(OverlayInboundMessage)(message)
```

The comment above that union says the members are spread from the same
`TAB_MESSAGE_MEMBERS` array "so the two unions can never drift". Several
`SAFETY:` comments in `handlers.ts` (for example at lines 372-376) justify a
cast by this Schema decode.

Design constraints:

- `docs/adr/0004-effect-ts-v4-core.md:7`: "The core (schema, services,
  concurrency, errors) is built on Effect." Part A does not conflict: it moves
  one pure function that uses no Effect code. Removing Schema from the overlay
  (Part C) does touch this decision.
- `docs/adr/0019-platform-identity-derives-from-adapter-registry.md:47-50`:
  "**The registry is the single source of platform identity.** Every site that
  needs "which platforms/origins/hosts are supported" reads it from
  `ALL_ADAPTERS`, directly or through a derived helper on the registry — never
  a hand-maintained parallel list." The page-world script imports
  `ALL_ADAPTERS` and with it all three adapters. Do not replace that import
  with a smaller hand-written list.
- `src/packages/README.md`: code outside a package imports only the package's
  root files. A new root file in `src/packages/clear/` is a new entry point.
  `bun run lint:boundaries` enforces this.

Repo conventions that apply (from `AGENTS.md`):

- No `oxlint-disable`, `eslint-disable`, `@ts-ignore`, or `@ts-expect-error`.
- Every `as` needs an uppercase `SAFETY:` comment. This plan needs no `as`.
- `unknown` is banned in parameters, returns, and type aliases.
- Named constants, not magic numbers.
- Tests are vitest. Assertions live inside `it()`. Property tests use
  `fast-check` (see `src/core/adapters/hover-resolve.property.test.ts`).

Comment rule: do not add, edit, or delete code comments, except a comment that
describes code this plan removes. A pre-edit hook (`doc-lock`) blocks other
comment changes. Carry intent in names, types, and tests. Do not edit any
Markdown file except this plan's status row in `plans/README.md`. The target
code below deliberately has no comments.

## Commands you will need

| Purpose        | Command                                                  | Expected on success |
|----------------|----------------------------------------------------------|---------------------|
| Typecheck      | `bun run typecheck`                                      | exit 0, no errors   |
| Lint           | `bun run lint`                                           | exit 0              |
| Format check   | `bun run fmt:check`                                      | exit 0              |
| Boundaries     | `bun run lint:boundaries`                                | exit 0              |
| Focused tests  | `bun run test <path/to/file.test.ts>`                    | all pass            |
| Full gate      | `bun run check`                                          | exit 0              |
| Build          | `bun run build`                                          | exit 0              |
| Script sizes   | `wc -c .output/chrome-mv3/content-scripts/inject.js .output/chrome-mv3/content-scripts/overlay.js` | two byte counts |
| Effect markers | `rg -o "effect/[A-Za-z]+" .output/chrome-mv3/content-scripts/inject.js \| sort -u` | a list, one marker per line |

The package manager is bun. Never use npm or npx. If `bun run fmt:check` fails
only on files you edited, run `bunx oxfmt --write <those files>` and re-check.

## Scope

**In scope** (the only files you should modify or create):

- `src/packages/clear/tweet-id.ts` (create)
- `src/packages/clear/tests/tweet-id.test.ts` (create)
- `src/packages/clear/clearer.ts` (the id check only)
- `src/core/adapters/x/tracked-mutation.ts` (one import, one call)
- `plans/README.md` (only this plan's status row)

**Out of scope** (do NOT touch, even though they look related):

- `src/entrypoints/inject.content.ts`. Its imports stay as they are.
- `src/core/adapters/registry.ts` and the adapters. ADR-0019 keeps the
  registry import.
- `src/entrypoints/overlay.content/handlers.ts`, `src/packages/schema/`, and
  `src/packages/settings/`. Part C explains why.
- `src/packages/clear/seed.ts`. It keeps importing `isClearableTweetId` from
  `./clearer`.
- `wxt.config.ts` and any build setting.

## Git workflow

- Branch: `advisor/045-slim-content-script-bundles`
- Conventional commits. Example from this repo:
  `perf(cloud): copy each byte once when chunking upload streams`.
  Use `perf(tee): …` here.
- Do NOT push or open a PR.
- The working tree has uncommitted user changes. Never revert or stash them.
- Before editing, run the drift check command from the top of this plan. Note
  every in-scope file it lists: those files already hold uncommitted changes.
- Do not commit a file that had uncommitted changes before you started. Make
  the plan's edits in it, leave them unstaged, and name that file in your final
  message.
- Commit only in-scope files that were clean before you started. Stage each by
  explicit path. Never stage `.output/`.

## Steps

### Part A — make `inject.js` free of Effect

#### Step A1: Record the baseline

Run `bun run build`. Then run the "Script sizes" and "Effect markers"
commands from the table. Write down:

- the byte count of `inject.js` (call it `INJECT_BEFORE`),
- the byte count of `overlay.js` (call it `OVERLAY_BEFORE`),
- the number of distinct `effect/` markers in `inject.js`.

**Verify**: the build exits 0 and the marker list for `inject.js` is not
empty. If the list is empty, Part A is already done by another change. Skip
to Part B and say so in your final message.

#### Step A2: Write the failing tests

Create `src/packages/clear/tests/tweet-id.test.ts` with the tests in "Test
plan" items 1–4. Import `isPlausibleSnowflakeId` from `'../tweet-id'`, the
same way `clearer.test.ts` imports from `'../clearer'`.

**Verify**: `bun run test src/packages/clear/tests/tweet-id.test.ts` → FAILS
(module not found).

#### Step A3: Move the check into a file with no Effect import

1. Create `src/packages/clear/tweet-id.ts`:

```ts
const SNOWFLAKE_EPOCH_MS = 1_288_834_974_657
const SNOWFLAKE_TIMESTAMP_SHIFT = 22n
const FUTURE_SKEW_ALLOWANCE_MS = 86_400_000
const SNOWFLAKE_DIGITS = /^[0-9]{1,20}$/

export function isPlausibleSnowflakeId(id: string): boolean {
  if (!SNOWFLAKE_DIGITS.test(id)) return false
  const createdAtMs = Number(BigInt(id) >> SNOWFLAKE_TIMESTAMP_SHIFT) + SNOWFLAKE_EPOCH_MS
  return createdAtMs >= SNOWFLAKE_EPOCH_MS && createdAtMs <= Date.now() + FUTURE_SKEW_ALLOWANCE_MS
}
```

   The file must have no `import` line.

2. In `src/packages/clear/clearer.ts`:
   - Add `import { isPlausibleSnowflakeId } from './tweet-id'` below the
     existing `import type { ClearScope } from '@/packages/schema'` line.
   - Delete the `const SNOWFLAKE_EPOCH_MS = 1_288_834_974_657` line together
     with the two-line doc comment directly above it. That comment describes
     only the constant you are removing.
   - Keep the long doc comment above `isClearableTweetId` unchanged. Replace
     only the function body so the function reads:

```ts
export function isClearableTweetId(tweetId: string): boolean {
  return isPlausibleSnowflakeId(tweetId)
}
```

3. In `src/core/adapters/x/tracked-mutation.ts`:
   - Replace the line
     `import { isClearableTweetId } from '@/packages/clear/clearer'` with
     `import { isPlausibleSnowflakeId } from '@/packages/clear/tweet-id'`.
   - In the line quoted in "Current state" (near line 86), replace
     `isClearableTweetId(tweetId)` with `isPlausibleSnowflakeId(tweetId)`.
   - Do not change any comment in this file. The comment near line 68 names
     `isClearableTweetId`. It stays correct, because that function now calls
     the same check.

**Verify**:
- `bun run test src/packages/clear/tests/tweet-id.test.ts src/packages/clear/tests/clearer.test.ts` → all pass.
- `bun run typecheck` → exit 0. `bun run lint` → exit 0.
- `bun run lint:boundaries` → exit 0.
- `rg -n "^import" src/packages/clear/tweet-id.ts` → no match.
- `rg -n "packages/clear/clearer" src/core/adapters/x/tracked-mutation.ts` → no match.

#### Step A4: Measure the result

Run `bun run build`, then the "Script sizes" and "Effect markers" commands.

**Verify**:
- `rg -c "effect/" .output/chrome-mv3/content-scripts/inject.js` prints
  nothing and exits 1 (no match).
- The byte count of `inject.js` is lower than `INJECT_BEFORE`.

If markers remain, find the path: run
`rg -l "from 'effect'" src/core src/packages/kernel src/packages/clear/tweet-id.ts`
and compare with the imports of `inject.content.ts`. Report the remaining
path. Do not edit files outside the scope to remove it.

Put `INJECT_BEFORE`, the new byte count, and both marker counts in your final
message.

#### Step A5: Run the gate

**Verify**: `bun run check` → exit 0.

### Part B — measure what `overlay.js` is made of (no code change)

#### Step B1: Produce the size report

Run `bun run build -- --analyze`. WXT writes a bundle report (a `stats`
file) and prints its path. Do not commit the report. If the command does not
accept the flag, run `bunx wxt build --analyze` through the same environment
wrapper the `build` script in `package.json` uses, and report which form
worked.

From the report, read the modules inside the `overlay` content-script chunk
and add up bytes for these groups:

1. `node_modules/effect` files whose path contains `Schema` or `schema`
2. all other `node_modules/effect` files
3. `src/packages/schema/`
4. `src/packages/settings/`
5. `src/packages/clear/`
6. `preact` and StyleX runtime
7. everything else

**Verify**: your final message has a table with the seven groups, each with
bytes and a percentage of `overlay.js`, plus the byte count of `overlay.js`.
If the report format does not allow per-module numbers, report the distinct
marker list from
`rg -o "effect/[A-Za-z]+" .output/chrome-mv3/content-scripts/overlay.js | sort -u`
instead, and say that per-module numbers were not available.

Make no source change in Part B.

### Part C — design note: the overlay's Schema use (not executable here)

Do not implement this part. It is recorded so the next plan starts from
facts.

The audit proposed removing Effect Schema and the full `Settings` and message
schemas from `overlay.js`. After reading the code, that is not one small
change:

- Schema reaches the overlay through four packages, not one call:
  `handlers.ts` (the inbound decode), `src/packages/settings` (the `Settings`
  decode on every settings change), `src/packages/schema` (value imports), and
  `src/packages/clear` (`worklist.ts`, `diagnostics.ts`).
- `Option` and `Result` are used across the overlay and the clear package. As
  long as any of them stays, part of the Effect runtime stays.
- The inbound union is built from `TAB_MESSAGE_MEMBERS` so it "can never
  drift" from the worker's union. A hand-written guard gives that up unless a
  test holds the two together.
- Several `SAFETY:` comments justify casts by the Schema decode. They would
  need rewriting in a docs session.
- ADR-0004 makes Effect the core. Removing it from one runtime context is an
  owner decision.

If Part B shows that groups 1, 3 and 4 together are a large share of
`overlay.js`, the follow-up plan should use this shape:

1. A Schema-free root file in the schema package, for example
   `src/packages/schema/overlay-inbound.ts`, that exports a strict guard
   `decodeOverlayInbound(raw: JsonValue)`. It checks `_tag` against a literal
   list and each field's type, and it rejects unknown shapes exactly as the
   Schema decode does today.
2. Parity tests with `fast-check`: for generated valid and invalid messages,
   the guard accepts exactly when
   `Schema.decodeUnknownResult(OverlayInboundMessage)` accepts. A second test
   derives the tag list from `TAB_MESSAGE_MEMBERS` and fails when a member is
   added without updating the guard. The Schema decoder stays in the test as
   the oracle. It leaves the shipped bundle, not the repository.
3. A page settings reader that validates only the fields the overlay uses.
   Plan 043 adds `src/packages/settings/page.ts` and an `OverlaySettings`
   field list. Build on those.
4. A measurable criterion: zero `effect/Schema` and `effect/schema` markers in
   `overlay.js`, and a byte count below `OVERLAY_BEFORE` by at least the size
   Part B attributes to groups 1, 3 and 4.

## Test plan

`src/packages/clear/tests/tweet-id.test.ts`, modelled on
`src/packages/clear/tests/clearer.test.ts:39-57` and, for the property tests,
on `src/core/adapters/hover-resolve.property.test.ts`. The expected values
come from the snowflake definition in the `clearer.ts` doc comment: an id
decodes to `(id >> 22) + 1_288_834_974_657` milliseconds, and the accepted
window is from that epoch to one day after now.

1. **Known ids.** `'2069527192787472572'` and `'1'` give `true`.
   `'jO4OvymczbTx7WL4'`, `''`, `'123abc'`, `'12 34'`,
   `'123456789012345678901'` (21 digits) and `'3969701833668148185'` (decodes
   to year 2040) give `false`. These are the documented cases the existing
   `isClearableTweetId` tests use.
2. **Property: any id built from a past timestamp is accepted.** Generate a
   millisecond offset from 0 to `Date.now() - 1_288_834_974_657` and a low
   part from 0 to `2 ** 22 - 1`. Build
   `((BigInt(offset) << 22n) | BigInt(low)).toString()`. The result is `true`.
3. **Property: any id more than two days in the future is rejected.** Use an
   offset from `Date.now() - 1_288_834_974_657 + 2 * 86_400_000` up to
   `2 ** 41 - 1`. The result is `false`.
4. **Property: any string with a non-digit character is rejected.** Generate
   a string and keep it only when `/[^0-9]/.test(s)` is true. The result is
   `false`.

The existing `isClearableTweetId` tests in `clearer.test.ts` stay unchanged
and must pass. They prove the wrapper kept its behaviour.

Verification:
`bun run test src/packages/clear/tests/tweet-id.test.ts src/packages/clear/tests/clearer.test.ts`
→ all pass, 4 new tests.

The bundle result is verified on the built file in Step A4, not by a unit
test.

Optional check in a real browser (the operator runs this): load the built
extension, open x.com, and confirm that media detection still works and that
a save with clear-on-save still un-bookmarks. In DevTools, the Sources panel
lists the page-world script, and its size should match Step A4.

## Done criteria

- [ ] `bun run check` exits 0
- [ ] `bun run build` exits 0
- [ ] The 4 new tests exist and pass
- [ ] `rg -c "effect/" .output/chrome-mv3/content-scripts/inject.js` finds no match
- [ ] `inject.js` byte count after Step A4 is lower than `INJECT_BEFORE`, and both numbers are in the final message
- [ ] `rg -n "^import" src/packages/clear/tweet-id.ts` returns no match
- [ ] `rg -n "SNOWFLAKE_EPOCH_MS" src/packages/clear/clearer.ts` returns no match
- [ ] Part B: the group table, or the marker list with the stated reason, is in the final message
- [ ] `git diff --stat cee429a -- src/entrypoints/inject.content.ts src/entrypoints/overlay.content src/packages/schema src/packages/settings` shows no change made by this plan
- [ ] `git diff -U0 -- src | rg "^\+.*(oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error)"` returns no matches
- [ ] `git status --short` shows no modified file outside the in-scope list that was not already modified before you started, apart from `.output/`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `isClearableTweetId`, the `tracked-mutation.ts` import, or the
  `inject.content.ts` import list does not match the excerpts.
- `rg -n "SNOWFLAKE_EPOCH_MS" src -g '!*.test.*'` shows a use outside
  `isClearableTweetId` before you edit.
- `bun run build` fails in Step A1, before any edit. The baseline cannot be
  taken.
- `inject.js` still contains `effect/` markers after Step A3, and the
  remaining path is outside this plan's scope.
- An existing test in `clearer.test.ts` or a `tracked-mutation` test fails
  after Step A3.
- `bun run lint:boundaries` rejects the import of
  `@/packages/clear/tweet-id` from `src/core/`.
- You are about to edit `handlers.ts`, `src/packages/schema/`, or
  `src/packages/settings/`. That is Part C, which this plan does not execute.
- The `doc-lock` hook rejects an edit. Report which edit and its message.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- `src/packages/clear/tweet-id.ts` must stay free of imports. The page-world
  script depends on that. The `rg -n "^import"` done criterion is the guard.
  A later change that adds an Effect import to `tracked-mutation.ts`,
  `json-predicates.ts`, `tee-limits.ts`, the registry, or an adapter brings
  the runtime back into `inject.js`.
- The page-world script still bundles all three adapters through
  `ALL_ADAPTERS`. Loading only the adapter for the current host would shrink
  it further, but ADR-0019 requires the registry as the single list. That
  needs an owner decision and is not planned.
- Open decision for the owner after Part B: whether the overlay may decode
  messages and settings without Effect Schema (Part C). It touches ADR-0004
  and the "can never drift" design of the inbound union.
- Plan 043's `src/packages/settings/page.ts` still uses a Schema decode. Part
  C's follow-up would replace it.
- Reviewer: check that `clearer.ts` keeps the long doc comment on
  `isClearableTweetId`, and that the built `inject.js` has no `effect/`
  marker.
