# ADR-0004 — Effect v4 (beta) as the core runtime

- **Status:** Accepted (2026-06-07)

## Context

The core (schema, services, concurrency, errors) is built on Effect. The project
owner mandated the **bleeding-edge Effect v4** (`4.0.0-beta.78`, the "effect-smol"
rewrite), which differs materially from v3: no `Effect.Service`, no
`Schema.optionalWith`, no `decodeUnknownEither`/`ParseError`; `Schema`,
`Semaphore`, `Result` live in core (grounding §0, §f, §g).

## Decision

Build the core on **Effect v4 beta**, using its actual API: `Context.Service` +
explicit `Layer`, `Schema.Struct/Literals/Union` with `withDecodingDefaultKey`,
`Semaphore.make`, `Schedule.exponential` + `recurs`, `Data.TaggedError`,
`decodeUnknownResult` (→ `SchemaError`). **Pin the exact version**; re-verify the
grounding snippets on any bump.

## Consequences

- Modern, smaller API surface; aligns with owner preference.
- Pre-release churn risk — APIs may shift before stable 4.0; v3 docs/idioms and
  most blog examples do **not** apply. The grounding doc is the source of truth.
- All Effect snippets in the grounding compiled clean against the installed types
  (`tsc 6.0.3 --strict`).

## Alternatives considered

- **Effect v3 stable** — safer, well-documented, but rejected by the owner.
- **No Effect** — would forgo typed errors, DI via Layers, and the concurrency /
  retry primitives the Download Queue relies on.
