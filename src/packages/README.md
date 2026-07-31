# Packages are deep modules

Packages live in `src/packages/<name>/` and follow a strict structure:

```
src/packages/
  <name>/
    index.ts        ← an entry point (public). Import this from outside.
    client.ts       ← another entry point. Packages may expose SEVERAL.
    lib/            ← implementation: hidden from outside, free to import each other.
    tests/          ← co-located tests + fixtures (private like any subfolder).
```

## Entry-point boundary

Code outside a package may import only a package's root files (entry points like `index.ts`, `client.ts`), never anything in its subfolders. This boundary is the whole point: it makes packages self-contained and refactorable.

## Intra-package freedom

Inside a package, any file imports any other file freely—`lib/` files import each other, entry points delegate to `lib/`, no restrictions. The package's public surface is just its entry points.

## Tests through the entry points

Files under `tests/` may import any package's entry points and their own test fixtures, but never a package's subfolder internals (not even their own `lib/`). This enforces that every code path is testable via the public surface.

Unit tests that exercise a `lib/` internal directly are co-located next to that internal (`lib/thing.test.ts`), not placed in `tests/` — intra-package imports are free, so co-location stays legal while `tests/` keeps its entry-points-only discipline. Shared test helpers live in `src/test/` (cross-package fixture imports are forbidden).

## No cycles

No dependency cycles among packages. One package may not import another that imports the first. Enforced by the linter across all of `src`, type-only imports included.

## Avoid barrel files

Do not re-export a whole subtree through one giant `index.ts`. Instead, expose several small entry points: `index.ts`, `client.ts`, `server.ts`. Public vs private is decided by depth (root vs subfolders), so adding an entry point is just adding a root file—no config change ever needed. This keeps each entry point focused and discoverable.

## Checking the boundary

Run `bun run lint:boundaries` to verify all rules. This also runs as part of `bun run check`. Rules are defined in `.dependency-cruiser.cjs` at the repo root.

`src/packages/example/` is a starter template—copy it or delete it.
