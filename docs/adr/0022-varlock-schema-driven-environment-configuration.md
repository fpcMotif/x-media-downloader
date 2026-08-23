# ADR-0022 — Varlock schema-driven environment configuration and leak scanning

- **Status:** Accepted (2026-08-03)

## Context

The extension and backend rely on environment variables across development, testing, and deployment:
- Extension dev-seeding (`WXT_CONVEX_URL`, `WXT_CONVEX_SECRET`, `WXT_GDRIVE_CLIENT_ID`, `WXT_DROPBOX_APP_KEY`)
- Convex cloud deployment (`CONVEX_DEPLOYMENT`, `CONVEX_URL`, `CONVEX_SITE_URL`, `SYNC_SHARED_SECRET`)

Previously, these variables were implicitly defined in `.env` / `.env.local` files without strict schema validation, unified type definitions, or leak detection. Sensitive write credentials like `WXT_CONVEX_SECRET` and `SYNC_SHARED_SECRET` risked accidental plaintext exposure in logs or AI transcripts.

## Decision

Adopt **Varlock** (`@env-spec`) as the universal environment variable management, validation, and security layer:

1. **Schema-driven contract (`.env.schema`):** A single root `.env.schema` defines every environment variable used by the project, annotating types (`@type=url`), requirements (`@defaultRequired=false`), and sensitivity (`@sensitive`).
2. **Type safety (`env.d.ts`):** `varlock codegen` automatically generates `env.d.ts`, augmenting `ImportMetaEnv` (`import.meta.env`) and `ProcessEnv` (`process.env`) with exact TypeScript types and documentation.
3. **Leak protection & Redaction:** Sensitive variables (`WXT_CONVEX_SECRET`, `SYNC_SHARED_SECRET`) are redacted in `varlock load` output and transcripts. Proactive scanning (`varlock scan`) verifies no sensitive values leak in plaintext into source files.
4. **Bun integration (`bunfig.toml`):** Configured `bunfig.toml` with `env = false` so Bun's implicit `.env` auto-loader does not bypass Varlock's schema validation.
5. **Lifecycle hooks (`package.json`):**
   - `"prepare": "varlock codegen && wxt prepare"` ensures generated types are kept in sync before build/typecheck.
   - `"env:audit": "varlock audit src backend"` verifies code references match `.env.schema`.
   - `"env:check": "varlock load"` validates local environment configuration.
   - `"env:scan": "varlock scan"` checks repository files for plaintext secrets.
   - `"check"` incorporates `varlock audit src backend` to enforce schema parity on every check run.
## Consequences

- All project environment variables are explicitly declared, typed, and documented in `.env.schema`.
- Secret variables are guarded against accidental exposure in build logs, AI assistant transcripts, and commit history.
- `ImportMetaEnv` and `NodeJS.ProcessEnv` have full IntelliSense support throughout the codebase.
- Environment check (`bun run env:check`) and secret leak scan (`bun run env:scan`) are available as standard scripts.
