# ADR-0005 — State persistence split

- **Status:** Accepted (2026-06-07)
- **Amended by:** [ADR-0010](0010-durable-local-download-history.md), which adds
  an opt-in durable Download History.

## Context

Three kinds of state exist: **Settings** (filename template, concurrency, the
auth-fallback and Download-Strategy toggles, theme), **Transfers**, and
**Captures** (harvested tweet records). MV3 workers are disposable. Durable
intent must survive worker and browser restarts. Captures can be large and may
contain sensitive data.

## Decision

- **Settings → `storage.local`** — durable across browser restarts (single-writer:
  the background SW; popup/content observe via `storage.onChanged`).
- **Transfer Registry → `storage.local`** — durable intent, correlation,
  retries, external profile snapshots, and terminal projection.
- **Captures → IndexedDB `xmd-capture`** — durable source of truth. Users erase
  it through Clear Capture. The extension requests `unlimitedStorage` to reduce
  eviction risk.
- **Download History → `storage.local` when enabled** — bounded and governed by
  ADR-0010.
- **Clear authority → IndexedDB `xmd-clear`** — one revisioned active record,
  immutable per-scope tombstones, and a coalescing Worklist projection outbox.
  Old `local:clearCompletionLedger` and `local:clearCoordinator` values are
  migration inputs only. `session:clearSessionMarker` remains a boot claim/open
  marker, never budget authority.

## Consequences

- Preferences persist.
- Transfer ownership and recovery survive worker and browser restarts.
- Captures persist until the user clears them. UI and docs must state that
  privacy boundary.
- Large capture archives avoid `storage.local` quotas and whole-store reads.

## Alternatives considered

- **Captures in `storage.session`** — loses archives on browser close and cannot
  support durable export workflows.
- **Captures in `storage.local`** — poor fit for large archives and its quota.
- **Everything in `session`** — resets Settings every browser restart (poor UX);
  rejected after surfacing the contradiction.

## Amendment (2026-07-18) — enforce the Settings single writer

The original single-writer rule is now structural: Popup and Options send
Settings patches to one background-owned writer. Cloud token/folder writes and
development seeding use the same writer. It serializes a fresh read, merge,
normalization, and durable write. Reads and storage-change watches remain local.
Long Cloud operations also fence their final writes and byte dispatch against
the latest per-provider lifecycle intent.

This closes the prior implementation gap: Popup and Options called the
non-atomic storage read/merge/write directly, while Cloud serialized only its
own writes. Two contexts could therefore read the same snapshot and overwrite
each other's unrelated fields.

## Amendment (2026-07-22) — durable transfers and captures

The original active-queue and Capture placements are superseded. Browser and
aria2 transfer intent, correlation, retries, and terminal projection live in
the local Transfer Registry v4. Captures live in durable IndexedDB. Settings
remain local.

## Amendment (2026-07-26) — transactional Clear authority

Clear state outgrew whole-value `storage.local` writes. IndexedDB `xmd-clear`
now owns active completion and safety state, immutable terminal tombstones, and
manual Worklist intents. Active revision and observed tombstones are checked in
the same strict transaction that writes the winner. The Worklist stays in
`storage.local`; an alarm-backed outbox writes it first and exact-acks second.
This prevents lost projections without merging Worklist policy into Clear
authority.

The migration pointer is the cutover. Legacy values stay inert and are never
deleted after publication; delete-after-validate has a writer race. This relies
on Chrome installing an extension update only when the old extension is idle
(no running worker or open extension page), and on content scripts having no
Clear-state write port. See Chrome's
[extension update lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle).

## Amendment (2026-07-28) — versioned Settings and explicit recovery

Settings use one in-value v1 envelope:

```ts
{ version: 1, revision: number, settings: Settings }
```

The background Settings Writer still owns every production mutation. Its FIFO
now owns decode, migration, patch preservation, revision, and recovery too.
Valid unversioned Settings migrate on the next writer turn. Another version is
never interpreted as legacy.

Malformed known fields and unknown fields do not become defaults and then get
silently overwritten by an unrelated patch. Bounded recoverable values keep
their raw fields; a normal patch replaces only named Settings fields. Unsafe,
oversized, or unsupported values refuse normal writes.

Reads expose a safe projection while recovery is pending: Direct remains
available for local saves; Cloud Sync, Cloud upload, Clear, and Capture Mirror
are off. Options states this explicitly. Repair keeps valid known fields,
defaults invalid fields, and drops unknown fields. Reset uses all defaults.
Lifecycle owners keep that availability separate from committed user intent.
Pending recovery pauses Cloud Sync and removes its wake, but preserves its
Outbox and status. Only an available, committed opt-out may clear them.
Both compare the current raw fingerprint with the inspected fingerprint inside
the Settings Writer FIFO. Unsafe/oversized values use a one-generation opaque
confirmation because they cannot be hashed safely; that fallback is scoped to
the sole writer lane and expires on a write or worker recycle.

WXT's item fallback remains `{}` so removal still projects defaults. The
envelope version stays in the value, not WXT migration metadata: the application
must distinguish future values and preserve recoverable raw data rather than
running an automatic rewrite.
