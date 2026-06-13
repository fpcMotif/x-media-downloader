# Task 001 — Scaffold project

**type:** setup
**depends-on:** []

## Goal

Stand up the WXT + Bun + Preact + Tailwind v4 + Vitest + Effect toolchain with
strict TypeScript and the repo layout from design §9. No feature logic.

## Files

- `package.json`, `wxt.config.ts`, `tsconfig.json` (strict), `vitest.config.ts`
- `tailwind.config.*` / `app.css`
- `src/entrypoints/{background,content,inject,popup}/` stubs
- `src/core/` package dirs; `src/ui/`; `src/test/fixtures/`
- `.gitignore` already present

## Steps

1. `bun add -D wxt vitest typescript happy-dom @preact/preset-vite tailwindcss @tailwindcss/vite`
   and runtime deps `effect preact`. (No `@effect/schema` — Schema is in `effect`
   core in v4. No `@webext-core/fake-browser` — `fakeBrowser` ships with WXT.)
2. Configure `wxt.config.ts`: MV3, permissions `downloads`/`storage`, host perms
   `x.com`/`twitter.com`/`pbs.twimg.com`/`video.twimg.com`, Preact vite preset.
3. `tsconfig.json`: `"strict": true`, `"noUncheckedIndexedAccess": true`,
   `"exactOptionalPropertyTypes": true`, path alias `@/* -> src/*`.
4. `vitest.config.ts`: import `WxtVitest` from `wxt/testing/vitest-plugin`.
5. Add scripts: `dev`, `build`, `test`, `typecheck` (`tsc --noEmit`).

## Verification

- `bun run typecheck` passes.
- `bun run build` produces `.output/manifest.json` with the expected
  minimal permissions.
- `bun test` runs (zero tests) without config error.
