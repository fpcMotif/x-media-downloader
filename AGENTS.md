# Agent notes

Packages are deep modules — see [src/packages/README.md](./src/packages/README.md) before adding or importing one. Import a package only through its entry points (its root files); everything in its subfolders is private. Enforced by `bun run lint:boundaries`.

## Checks

`bun run check` is the gate: oxfmt, oxlint (type-aware), varlock audit, tsgo, depcruise, vitest.

- `bun run lint` — oxlint with type-aware rules. Needs `oxlint-tsgolint`.
- `bun run lint:complexity` — advisory cyclomatic-complexity report (max 15). Also runs on every commit via prek; it warns, it never blocks.
- `bun run lint:boundaries` — [scripts/lint-boundaries.ts](./scripts/lint-boundaries.ts), which enforces the deep-module rule above. It replaced dependency-cruiser, which resolves through the `typescript` compiler API, refuses >= 7, and so cruised **zero** modules on this repo while still exiting 0 — a green check that parsed nothing and hid four real violations. If you ever change the checker, prove it still fails on a deliberate violation before trusting a pass.
- Package manager is **bun**. Never npm/npx.

## Never game a lint rule

A finding is a claim about the code, not an obstacle. Satisfy it by changing the code.

Forbidden, without exception:

- `oxlint-disable` / `eslint-disable` / `@ts-ignore` / `@ts-expect-error`
- turning a rule off, or narrowing its scope, to make your own diff pass
- renaming an identifier to land on a rule's exempt list, or moving code somewhere the rule does not look

That last one is the subtle one, so here is the real case. `anti-slop/no-unknown-parameters`
exempts a parameter literally named `cause`. So `(reason: unknown)` → `(cause: unknown)`
silences the rule and changes nothing — the input is still unparsed. The honest fix is the
**type**: `(cause: Error | string)` passes because `Error | string` is a contract a caller
can rely on, not because of the name. Where the value truly arrives as `unknown` — a
`catch` binding, which TypeScript always types that way — narrow it at the `catch` and pass
the narrowed value on. `unknown` should never cross a function boundary.

If the only way to clear a finding is a trick, leave the finding and say so. A comment
explaining how a rule was evaded is proof the fix was wrong.

## JSDoc is a calling contract

Sources of truth, in order: types → names → runtime schemas → tests. A `/** */` block
carries only what those four cannot — the **contract**.

Most exports carry no contract beyond their signature. Those stay **bare**. That is the
finished state, not an unfinished one.

### Deciding — run this per symbol, before writing a word

1. **Who calls it?** A framework contract (called by WXT, Chrome, or a message channel —
   not by your code) or a primitive used across packages is a candidate. A symbol whose
   only callers sit beside it in the same folder is not.
2. **Reconstruct it.** From the name, signature, and types alone, could a competent
   TypeScript developer state the whole contract? If yes → **bare**. Stop here.
3. **Name what the type cannot carry.** Exactly one of these, or none:
   - when it runs, and who calls it
   - side effects visible outside the function — `chrome.storage`, `chrome.downloads`,
     network, DOM, focus, clipboard, mutation of an argument
   - what it throws, and when
   - ordering, caching, or ownership of the return; what `null`/empty means
   - an invariant the caller must maintain
   - units, ranges, or normalization on a parameter
   - merge-vs-replace or override semantics against a sibling export

If step 3 comes back empty, the symbol is bare — a candidate that survives step 1 still
loses to steps 2 and 3.

**Read the body before writing.** A block describing behaviour the code does not have is
worse than no block: agents read documentation as instructions and act on it. The live
example is `interruptBackoffMs`, whose block read "2s, 4s, 8s" while the function applied
no cap at all — that is the caller's current usage, not the contract.

### Writing

- Open with a third-person verb phrase stating the contract — "Streams…", "Returns…",
  "Refuses…".
- Let the type speak for the type. Prose restating a signature is **filler**.
- `@param` earns its place with domain meaning, units, ranges, normalization, or a
  default — omit it when the name and type already say it. A bare `attempt: number` that
  is 0-based, or a `number` that is milliseconds, earns one.
- `@returns` earns its place with non-obvious semantics: ordering, ownership, caching,
  what an empty result means.
- `@see` points at an ADR. Architecture and trade-offs live in `docs/adr/`, not inside the
  block — cite them with the tag rather than in prose.
- Examples live in tests. `@example` is only for a call pattern that is hard to discover.
- Put a function parameter's default in its `@param` text; `@defaultValue` is for fields
  and properties.
- `@deprecated` names the replacement and how to fix call sites.
- Tag order: description → `@remarks` → `@param` → `@returns` → `@throws` →
  `@defaultValue` → `@example` → `@deprecated` → `@see`.

`/** */` documents the caller's contract. `//` carries implementation notes and answers
*why*. Stack `//` lines for multi-line notes.

### Tags that restate TypeScript

`@type`, `@typedef`, `@private`, `@enum`, `@implements`, `@override`, and `{braces}` around
any type all duplicate what the compiler already knows. The keyword or the signature is the
statement. Enforced by `jsdoc/check-tag-names` with `typed: true`.

`@throws` is normally unnecessary here — Effect carries errors in the type. Use it only for
a genuine `throw` outside an Effect.

### When the block resists

A block that will not come out clean is usually reporting a bad API, not a writing problem.
Reach for the refactor first: an options object, a discriminated union, a branded type, a
runtime schema, or a better name. Then the contract shrinks to one line — or disappears.

### Keeping it true

A behaviour change updates or deletes its block in the same diff. A block that outlived its
behaviour is a defect that actively misleads.

## Code standards

Adapted from [Ultracite](https://www.ultracite.ai)'s agent rules. Most are enforced by
`.oxlintrc.json` — this section is for what a linter cannot check.

### Types

- Explicit parameter and return types where they add clarity.
- Narrow with control flow (`typeof`, `instanceof`, `Array.isArray`, `in`, type predicates) instead of asserting.
- Every `as` needs an uppercase `SAFETY:` comment stating the invariant that makes it sound (`anti-slop/require-safety-comment-for-type-assertion`). If you cannot state the invariant, the cast is wrong — narrow instead.
- Never `x as unknown as T`.
- Third-party JSON is typed `JsonValue` / `JsonObject` from `@/packages/schema`, never `Record<string, unknown>`.
- `satisfies` over a widening annotation: `const X = {...} satisfies T`, not `const X: T = {...}`.
- Named constants, not magic numbers.

### Modern JS/TS

- `const` by default, `let` only when reassigned, never `var`.
- Arrow functions for callbacks; `for...of` over `.forEach()`; optional chaining and `??`; template literals over concatenation; destructuring.

### Async

- Always `await` promises in async functions, and use the result.
- `async/await` over promise chains. Never an async Promise executor.

### Preact / JSX

- Function components only. Hooks at the top level, never conditionally, with complete dependency arrays.
- `key` on iterated elements — a stable id, not the array index.
- Never define a component inside another component.
- Semantic HTML and ARIA: real `<button>`/`<nav>` over divs with roles, alt text, heading hierarchy, labelled inputs, keyboard handlers alongside mouse handlers.

### Errors and debugging

- Throw `Error` objects with descriptive messages, never strings.
- `try`/`catch` must do something — never catch just to rethrow.
- Early returns over nested conditionals.
- No `console.log`, `debugger`, or `alert`. Diagnostics use `console.warn`/`error`/`info`, or DEV-gated `console.debug` (stripped from production builds).

### Organisation

- Keep functions focused; extract complex conditions into named booleans.
- No nested ternaries.

### Security

- `rel="noopener"` with `target="_blank"`.
- No `eval()`, no direct `document.cookie` assignment, no `dangerouslySetInnerHTML` without a hard reason.
- Validate and sanitise anything crossing a boundary.

### Performance

- No spread in a loop accumulator.
- Regex literals at module top level, not rebuilt inside loops.
- Specific imports over namespace imports.

### Testing

- Assertions live inside `it()` / `test()`.
- `async`/`await`, never done callbacks.
- No `.only` or `.skip` in committed code.
- Keep `describe` nesting shallow.

## Where Ultracite's generic advice does NOT apply here

Three of Ultracite's stock rules conflict with this repo. Follow the repo, not the stock rule.

1. **"Prefer `unknown` over `any`."** Not here. The `anti-slop` rules we run ban `unknown` in parameters, returns, and type aliases — it states that a value exists while giving callers no contract. Use the real domain type, or `JsonValue`/`JsonObject` at a third-party boundary. (`any` remains banned outright.)
2. **"Avoid barrel files."** This repo is built on them: a package is a deep module reached only through its entry point, enforced by `bun run lint:boundaries`. Do not flatten package entry points.
3. **"Avoid conditional empty-object spread."** `tsconfig.json` sets `exactOptionalPropertyTypes`, under which `...(cond ? { k: v } : {})` is the only way to conditionally omit an optional property. That anti-slop rule is deliberately off.

Framework-specific Ultracite guidance for Next.js, Solid, Svelte, Vue and Qwik is not applicable — this is Preact on WXT.
