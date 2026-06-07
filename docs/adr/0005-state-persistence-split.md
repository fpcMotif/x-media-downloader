# ADR-0005 — State persistence split: settings local, queue + captures session

- **Status:** Accepted (2026-06-07)

## Context

Three kinds of state exist: **Settings** (filename template, concurrency, the
auth-fallback and Download-Strategy toggles, theme), the **active Download Queue**,
and **Captures** (teed JSON / auth headers). MV3 offers `storage.local` (durable
across restarts) and `storage.session` (in-memory, survives SW recycle, cleared on
browser close). Settings must persist; Captures are sensitive and ephemeral.

## Decision

- **Settings → `storage.local`** — durable across browser restarts (single-writer:
  the background SW; popup/content observe via `storage.onChanged`).
- **Active Download Queue + Captures → `storage.session`** — survives SW recycle
  within a session, auto-clears on browser close.
- **No persistent download history in v1.**

## Consequences

- Preferences stick; the user never re-configures them.
- An in-flight Bulk resumes across SW recycle but **not** a full browser restart —
  acceptable, since downloads complete within a session.
- Minimal sensitive data at rest; no `unlimitedStorage` needed.

## Alternatives considered

- **Everything in `local`** — would persist Captures (privacy) and demand history
  cleanup.
- **Everything in `session`** — resets Settings every browser restart (poor UX);
  rejected after surfacing the contradiction.
