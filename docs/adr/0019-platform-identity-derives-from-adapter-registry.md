# ADR-0019 — Platform identity derives from the adapter registry

- **Status:** Accepted (2026-07-05)
- **Builds on:** the multi-platform adapter abstraction
  (`docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md`,
  `src/core/adapters/registry.ts`).

## Context

The adapter registry (`ALL_ADAPTERS`) correctly drives the overlay content
script's `matches` (`Object.assign`ed from every adapter's `hostMatch`) — one
seam, three registered adapters (X, Instagram, Threads). But platform identity
was hand-copied into four other places, each expected to stay in lockstep with
the registry by eyeball rather than by construction:

- **`sender-guard.ts`'s `ALLOWED_CONTENT_SCRIPT_ORIGINS`** — a literal origin
  set, independent of `hostMatch`. It drifted once: Instagram/Threads origins
  were missing, so every message from those content scripts was silently
  dropped by the sender guard. Recovering from that drift took a 3-commit
  debugging spiral (682dd47 → 39ff403 → 670d5a6) before the guard was patched
  to allow the Instagram/Threads origins through.
- **`tab-broadcaster.ts`'s `defaultTabsPort`** — `queryXTabs` calls
  `browser.tabs.query({ url: [...X_HOST_MATCH] })`, X-only by construction.
  `reportTransferOutcome` (the Terminal Outcome badge-correction fan-out) routes
  through this same X-only query. **Live bug found in this review:** a
  Terminal Outcome badge correction for a download started from an
  Instagram/Threads tab never reaches that tab — the query never returns it —
  leaving a permanent false "saved" badge after a failed download on either
  platform.
- **Popup `App.tsx`'s `isXUrl` gate** (`isXUrl(url)` from `core/adapters/x`) — the
  popup's "is this tab usable" check is X's own URL regex, not the registry.
  On a recognized Instagram/Threads tab the popup falls back to its
  unrecognized-tab copy, "Open X or Twitter," even though the tab is on a
  platform the extension fully supports.
- **`wxt.config.ts`'s host lists** — `host_permissions` /
  `optional_host_permissions` hand-list the X, Instagram, and Threads origins,
  synced to each adapter's `hostMatch` only by a code comment ("mirror the X
  pair above").

Four independent copies of the same fact is a seam that looks real (three
adapters, one registry) but isn't load-bearing anywhere except the one content
script. Everywhere else, "which platforms exist" is a fact re-typed by hand,
and re-typed facts drift.

## Decision

**The registry is the single source of platform identity.** Every site that
needs "which platforms/origins/hosts are supported" reads it from
`ALL_ADAPTERS`, directly or through a derived helper on the registry — never a
hand-maintained parallel list.

- **Derived helpers on the registry** (`src/core/adapters/registry.ts`):
  `originsForAllAdapters()` — the pure transform `'https://' + host` over
  every adapter's `hostMatch` pattern, and `allAdapterHostMatch()` — the
  flattened `hostMatch` union the content script already builds inline today.
  Both are pure functions of `ALL_ADAPTERS`; adding an adapter to the array is
  the only edit either one needs.
- **`sender-guard.ts`** consumes `originsForAllAdapters()` in place of the
  literal `ALLOWED_CONTENT_SCRIPT_ORIGINS` set — a fourth platform's origin is
  allowed through the guard the moment its adapter is registered, with no
  parallel edit.
- **`tab-broadcaster.ts`'s generic broadcast** (`reportTransferOutcome` and any
  other cross-platform fan-out) queries `originsForAllAdapters()` /
  `allAdapterHostMatch()` instead of `X_HOST_MATCH`, so a Terminal Outcome
  reaches whichever tab actually started the transfer, on any registered
  platform.
- **`wxt.config.ts`** imports `ALL_ADAPTERS` directly and derives its host
  lists from it. Verified feasible: the registry's transitive import closure
  is pure TypeScript + Effect, with no browser globals, and `wxt.config.ts`
  already runs Node-side (loaded via `c12`) — nothing in the import chain
  requires a browser or content-script context.
- **Popup `App.tsx`** gates "is this tab on a platform we support" on
  `adapterForUrl(url) !== undefined`, replacing the X-only `isXUrl` check. The
  popup's platform-recognized state now matches the registry, not one
  adapter's regex.
- **Genuinely X-only behaviour stays X-only, explicitly.** Clear-family
  semantics (auto un-bookmark / un-like on save) are gated per-handler with the
  existing `adapter.platform === 'x'` idiom — that gate is a deliberate
  product decision, not a drifted copy, and this ADR does not touch it.
  `handleClearDetectedMedia` is the one clear-family handler deliberately left
  UNGATED: every line it runs (dropping detected picks, resetting badge/
  launcher/cursor state) is adapter-agnostic UI-state reset, and its sole
  DOM-touching branch already dispatches through `adapter.detectRenderedMedia`
  — correctly per-platform (X resolves real media; Instagram/Threads return
  `[]` today). Gating it would have disabled legitimate non-X "clear detected
  media" behaviour for no safety gain.

**Explicit non-decision: no capability fields on the adapter record.** Clear
support has exactly one adapter today; a capability flag for a set of size one
is a hypothetical seam, not a real one (`codebase-design` vocabulary: a seam
earns its keep when a second concrete case needs it, not in anticipation of
one). Revisit only when a second platform's clear semantics actually need to
differ from X's — until then, `adapter.platform === 'x'` says exactly what is
true today.

## Consequences

- Adding a fourth platform is: a new adapter directory + one entry in
  `ALL_ADAPTERS`. The manifest's host permissions update automatically through
  the same import; `sender-guard.ts` and the tab-broadcaster's generic
  broadcast pick it up with no parallel edit.
- Origin/host drift of the kind that caused the 682dd47→39ff403→670d5a6
  debugging spiral becomes structurally impossible rather than
  test-detected — there is no second list to fall out of sync.
- The X-only gates that remain (`adapter.platform === 'x'` at the clear-family
  call sites) are now legible as an explicit, intentional contract — the only
  hand-written platform check left in the codebase — rather than accidental
  selector no-matches on Instagram/Threads pages.

## Alternatives considered

- **A lint rule / codemod that checks the four sites stay in sync with the
  registry.** Rejected: catches drift after it happens (test-detected, exactly
  today's failure mode) rather than making the drift impossible to write.
- **Capability fields on `PlatformAdapter` now** (e.g. `supportsClear:
  boolean`), to pre-empt the next platform needing different clear semantics.
  Rejected per the explicit non-decision above — one adapter is not a seam,
  and a speculative field would itself be an untested, unexercised copy of a
  fact nothing yet needs.

## Amendment (2026-07-11) — CDN-host identity

The same registry-derivation principle now covers a platform's media-CDN
hosts too, not just its page-origin identity. `PlatformAdapter` gained a
required `cdnHosts` field — `{ host, includeSubdomains }`, exact hostnames
with opt-in dot-anchored subdomain matching (`sub.host`, never a suffix
look-alike like `evilhost.com`).

Derived consumers, all reading `ALL_ADAPTERS` through registry helpers rather
than a hand-maintained list: the Cloud Upload SSRF allow-list
(`src/core/sync/url-guard.ts`), the Fetched-strategy optional-permission
request (`src/core/download/fetched-strategy.ts`), and the manifest's CDN
`optional_host_permissions` (`wxt.config.ts`).

The SSRF guard's semantics are unchanged by this: exact-Set / dot-anchored
matching only, never wildcard matching. A pinned test in `url-guard.test.ts`
forces a conscious update whenever a new adapter (or a new `cdnHosts` entry
on an existing one) is registered, rather than silently widening what the
guard accepts.

This closes a live gap: Cloud Upload and Fetched mode were twimg-only, so
neither worked for Instagram/Threads media — the same drift shape flagged in
commit 670d5a6's message for page-origin identity, recurring here for CDN
identity.
