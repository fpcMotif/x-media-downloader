---
name: jsdoc-contract
description: >-
  JSDoc as calling contract, enforced by type-aware oxlint. Use when writing or
  reviewing a JSDoc/TSDoc block, deciding whether an export needs documenting at
  all, setting up oxlint + oxfmt + tsgolint in a TypeScript repo, or debugging
  type-aware lint, require-jsdoc, or a tag rule that misfires.
---

# JSDoc contract

Sources of truth, in order: types → names → runtime schemas → tests. A JSDoc
block carries only what those four cannot: the **contract**.

Most exports carry no contract beyond their signature. Those stay **bare** —
that is the finished state, not an unfinished one.

Setting up the toolchain that enforces this: [`SETUP.md`](SETUP.md).

## Deciding

Run this per symbol, before writing a word.

1. **Who calls it?** A framework contract (called by the router/runtime, not by
   your code) or a primitive consumed across modules is a candidate. A symbol
   whose only callers sit beside it in the same folder is not.
2. **Reconstruct it.** Given the name, signature, and types alone, could a
   competent TypeScript developer state the whole contract? If yes → **bare**.
   Stop here.
3. **Name what the type cannot carry.** Exactly one of these, or none:
   - when it runs, and who calls it
   - side effects visible outside the function — clipboard, network, storage,
     focus, DOM, mutation of an argument
   - what it throws, and when
   - ordering, caching, or ownership of the return; what `null`/empty means
   - an invariant the caller must maintain
   - units, ranges, or normalization on a parameter
   - merge-vs-replace or override semantics against a sibling export

Step 3 produces the block. Nothing else goes in it. If step 3 comes back empty
after step 2 said "candidate", the symbol is bare — a candidate that survives
step 1 still loses to step 2 and 3.

**Read the implementation body before writing.** A block describing behavior the
code does not have is worse than no block: agents read documentation as
instructions and act on it.

## Writing

- Open with a third-person verb phrase stating the contract — "Streams…",
  "Returns…", "Submits…".
- Let the type speak for the type. Prose restating a signature is **filler**.
- `@param` earns its place with domain meaning, units, ranges, normalization, or
  a default — omit it when the name and type already say it.
- `@returns` earns its place with non-obvious semantics: ordering, ownership,
  caching, what an empty result means.
- Put a function parameter's default in its `@param` text. `@defaultValue` is
  for fields and properties.
- `@deprecated` names the replacement and how to fix call sites.
- Examples live in tests. `@example` is for a call pattern that is hard to
  discover.
- Tag order: description → `@remarks` → `@param` → `@returns` → `@throws` →
  `@defaultValue` → `@example` → `@deprecated` → `@see`.
- Architecture and trade-offs live in an ADR or README; point at them with
  `@see`.

`/** */` documents the caller's contract. `//` carries implementation notes, and
answers *why*. Stack `//` lines for multi-line notes.

### Tags that restate TypeScript

`@type`, `@typedef`, `@private`, `@enum`, `@implements`, `@override`, and
`{braces}` around any type all duplicate what the compiler already knows. The
keyword or the signature is the statement. Enforce this with
`jsdoc-js/no-types` and `jsdoc/check-tag-names` (`typed: true`).

## When the block resists

A block that will not come out clean is usually reporting a bad API, not a
writing problem. Reach for the refactor first: an options object, a
discriminated union, a branded type, a runtime schema, or a better name. Then
the contract shrinks to one line — or disappears.

When lint demands a block and step 3 is empty, the fix is to narrow the rule's
scope by directory so it stops asking, or to remove the export. Both are
policy — see `SETUP.md`. Reaching for `oxlint-disable` on a whole directory's
worth of symbols means the policy is wrong, not the symbols.

## Keeping it true

A behavior change updates or deletes its block in the same diff. A block that
outlived its behavior is a defect that actively misleads.

## Done

- Every export you touched has an explicit outcome: a contract written, or left
  bare for a reason you can state.
- Every block you wrote names something from step 3.
- You read the body of every symbol you documented.
- The repo's lint and type gates pass.
