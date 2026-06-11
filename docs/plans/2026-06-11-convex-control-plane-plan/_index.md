# Implementation Plan — Convex Cloud Control Plane (Phase 1: opt-in metadata mirror)

- **ADR:** [../../adr/0009-convex-cloud-control-plane.md](../../adr/0009-convex-cloud-control-plane.md)
- **Date:** 2026-06-11
- **Approach:** Test-first (red→green→refactor) per task. Pure reducers with
  injected timestamps (metrics precedent, ADR-0008); effectful seams behind
  fetch-injected ports (aria2 precedent, ADR-0006). Effect **v4** idioms only
  (see `.claude/skills/effect-v4`).

> ⚠️ **Grounding:** Convex facts in this plan were verified against
> docs.convex.dev (2026-06): HTTP API envelope `POST /api/mutation`
> `{path, args, format: "json"}` → `{status: "success"|"error", …}`; HTTP
> actions ≤20 MiB; scheduled **mutations** exactly-once/auto-retried, scheduled
> **actions** at-most-once; per-mutation ≤16 MiB / ≤16k docs written / ≤1,000
> scheduled functions; 1 s user-code cap; auth does **not** propagate to
> scheduled functions.

## Context

The extension stays local-first (ADR-0005). Phase 1 adds an **opt-in** sidecar
that mirrors download state transitions (metadata only) into a Convex
deployment, giving a durable cross-session ledger + URL cache without changing
any default behavior. Bytes never transit Convex (ADR-0009). Phases 2–3
(durable export jobs, provider byte layer) are **out of scope** — see
[handoff-phase-2-3.md](./handoff-phase-2-3.md).

## Execution Plan

```yaml
tasks:
  - id: "101"
    subject: "SyncEvent schema + builders — metadata-only, idempotent ids (test→impl)"
    slug: "sync-events"
    type: "test+impl"
    depends-on: []
  - id: "102"
    subject: "Outbox reducer — append/dedupe/cap, FIFO batches, backoff (test→impl)"
    slug: "outbox"
    type: "test+impl"
    depends-on: ["101"]
  - id: "103"
    subject: "Convex HTTP port — fetch-based /api/mutation envelope (test→impl)"
    slug: "convex-port"
    type: "test+impl"
    depends-on: []
  - id: "104"
    subject: "Settings — cloudSyncEnabled/convexUrl/convexSyncSecret/cloudDeviceId (test→impl)"
    slug: "settings-cloud"
    type: "test+impl"
    depends-on: []
  - id: "105"
    subject: "Wire background mirror + popup Cloud Sync section + optional host permission"
    slug: "wire"
    type: "impl"
    depends-on: ["101", "102", "103", "104"]
  - id: "106"
    subject: "Convex backend package — schema, idempotent recordEvents, paginated query"
    slug: "backend"
    type: "impl"
    depends-on: []
```

## Task specs

### 101 — `src/core/sync/events.ts`

`SyncEventKind = 'queued' | 'completed' | 'failed'`. `SyncEvent` Schema.Struct:
`eventId`, `kind`, `requestId`, `deviceId`, `at` (ms), optional `media`
(`tweetId/handle/type/url/ext/index` — the URL-cache payload). Builders:
`syncEventId(deviceId, requestId, kind)` (deterministic idempotency key),
`queuedEvent(item, deviceId, at)`, `outcomeEvent(requestId, kind, deviceId,
at)`. Tests: id determinism; decode round-trip; unknown/sensitive extra keys do
not survive decode; builders mirror only the allowed metadata fields.

### 102 — `src/core/sync/outbox.ts`

Pure reducer over `OutboxState { pending, consecutiveFailures, nextAttemptAt }`
with injected `now` (no Effect, no I/O — ADR-0008 precedent): `append` (dedupe
by `eventId`, cap 2,000 dropping oldest), `takeBatch` (FIFO ≤64),
`markDrained(sentIds)` (reset backoff), `markFailed(now)` (exponential
5s·2ⁿ capped 5 min), `isReady(now)`, `decodeOutbox(raw)` (corrupt → empty).
Batch ceiling keeps a drain at ≤128 Convex doc writes — orders of magnitude
under the 16 MiB / 16k-docs mutation limits.

### 103 — `src/core/sync/convex.ts`

`buildFunctionCall(path, args)` → `{path, args, format: 'json'}`;
`convexOriginPattern(url)` → `https://<host>/*` for runtime
`permissions.request` (aria2 precedent); `makeConvexHttpPort({deploymentUrl,
fetchImpl})` → `{ mutation(path, args) }` POSTing `/api/mutation`, unwrapping
`{status:'success', value}` and throwing on `{status:'error'}`, non-2xx, or a
malformed body. Tests with a fake `fetchImpl`.

### 104 — `src/core/schema` + settings

`Settings` gains `cloudSyncEnabled` (default **false**), `convexUrl` (''),
`convexSyncSecret` (''), `cloudDeviceId` ('', filled with a UUID on first
enable by the popup). Tests: defaults off; round-trip persist.

### 105 — wiring

Background: `local:syncOutbox` storage item; all outbox read-modify-writes
serialized through a promise chain; mirror points = queued (post-dedupe in
`handleDownload`), enqueue-time terminal outcomes (aria2 hand-off / failed
start), `downloads.onChanged` terminal outcomes; drain loops FIFO until empty
or first failure; startup drain reconciles after offline; disabling sync clears
the outbox. Sidecar `data:` requests are never mirrored (id ∉ media map).
Popup: Cloud Sync section (toggle, deployment URL, secret, grant-origin
button), footer truthful per mode. Manifest: `https://*.convex.cloud/*` in
`optional_host_permissions`.

### 106 — `backend/`

Self-contained package (own `package.json`, excluded from root tsconfig/lint):
`convex/schema.ts` (`sync_events` indexed `by_event_id`+`by_at`; `media_state`
materialized per-request row indexed `by_device_request`), `convex/sync.ts`
(`recordEvents` mutation: optional shared-secret check, skip-on-duplicate
`eventId`, upsert `media_state` by latest `at`; `recent` paginated query).
README: deploy + env var + extension hookup.

## BDD Coverage

| Requirement | Task(s) |
|---|---|
| Idempotent, metadata-only event model (no captures/auth/`data:`) | 101, 105 |
| Offline-tolerant queue: dedupe, cap, FIFO, exponential backoff | 102 |
| Convex HTTP API envelope + error unwrap, no SDK in SW | 103 |
| Opt-in, default-off settings; honest footer; runtime origin grant | 104, 105 |
| Downloads never block on cloud; duplicate sends harmless | 102, 105, 106 |
| Server-side idempotency + materialized state + pagination | 106 |

## Dependency Chain

```
101 sync-events ── 102 outbox ─┐
103 convex-port ───────────────┤── 105 wire
104 settings-cloud ────────────┘
106 backend (independent; deploy-time counterpart of 103/101)
```

## Success Criteria (loopable)

1. `bun run test` green, including `src/core/sync/*`.
2. `bun run check` green end-to-end (fmt, lint, tsgo, effect-lsp, vitest);
   `backend/` excluded from root checks but `tsc --noEmit` green on its own.
3. Defaults unchanged: fresh profile decodes `cloudSyncEnabled === false`;
   manifest gains only an **optional** host permission.
4. With sync enabled + fake fetch: a 3-item grab produces 3 `queued` events,
   terminal outcomes append `completed`/`failed`, batches drain FIFO, a failed
   drain backs off and re-sends the **same** `eventId`s after the delay.
5. Backend: re-posting a drained batch inserts 0 new rows.
