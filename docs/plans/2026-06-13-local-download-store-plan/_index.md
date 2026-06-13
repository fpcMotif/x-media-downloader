# Implementation Plan — Durable Local Download Store

**Design source:** [docs/superpowers/specs/2026-06-13-local-download-store-design.md](../../superpowers/specs/2026-06-13-local-download-store-design.md)
**Branch:** `claude/elegant-franklin-g4ofol` (PR #3, with `main` merged in)
**Date:** 2026-06-13
**Workflow:** TDD red-green. Each feature has a `*-test` task (Red) that must precede its paired `*-impl` task (Green). Verification runs the specs via `bun run test`.

## Context

### Why
X Media Downloader is local-only but keeps **no durable local record** of what was downloaded: the popup Monitor is derived from the ephemeral `session:metrics` (resets on SW recycle/restart, ADR-0005), and the only durable history is **remote** (the opt-in Convex `media_state`). This adds the local-first piece — a durable **Download Store** of every download's original media link + status + provenance — and reconciles it with the existing Convex mirror so the two are the same view of the same data.

### Core insight (no backend change)
Convex's `media_state` is already a per-`requestId` view of `lastKind` (`queued|completed|failed`) + media provenance (incl. `url`). The local store is its **local-first twin**: same key, same status, same payload shape (`SyncMediaMeta`), fed from the **same** background outcome path — so local and Convex agree **by construction**. `backend/` is **not** modified.

### Current state → Target state
| Dimension | Current | Target |
|---|---|---|
| Durable local history | none (only ephemeral `session:metrics`) | `local:downloadHistory` durable Download Store |
| Source of truth | Convex `media_state` (remote, opt-in) | local store authoritative; Convex = opt-in mirror of same data |
| Core modules | `core/sync`, `core/download/metrics` | + `core/history/` (`record`, `store`) |
| Settings | Cloud Sync / Quick Grab toggles | + `downloadHistoryEnabled` (default off) |
| Background outcome path | builds Sync Events only | shared derivation → Sync Event **and** Download Record |
| Messages | `MetricsRequest`, `ClearDownloadMonitorRequest`, … | + `HistoryRequest`/`HistoryResponse`, `ClearHistoryRequest` |
| Popup | Monitor + Cloud Sync sections | + "Download history" section (toggle + list + Clear history) |

### Constraints
- **No implementation bodies** — contracts (signatures/types) + BDD scenarios only.
- **No new install-time permissions**; no `backend/` change.
- **Regression gate:** existing `bun run check` (180 tests) stays green; Sync Event behaviour unchanged.
- **Test doubles:** `chrome.storage` via WXT `fakeBrowser`; time injected; no live network/DB.
- Local write gated by `downloadHistoryEnabled`; Convex enqueue independently gated by `cloudSyncEnabled` (orthogonal).
- BDD scenarios are derived from the design spec (§5–§10); there is no separate `bdd-specs.md`.

## Execution Plan

```yaml
tasks:
  - id: "001"
    subject: "DownloadRecord schema + builders — test"
    slug: "record-test"
    type: "test"
    depends-on: []
  - id: "002"
    subject: "DownloadRecord schema + builders — impl"
    slug: "record-impl"
    type: "impl"
    depends-on: ["001"]
  - id: "003"
    subject: "DownloadStore reducer (upsert/cap/transition/decode) — test"
    slug: "store-test"
    type: "test"
    depends-on: ["002"]
  - id: "004"
    subject: "DownloadStore reducer (upsert/cap/transition/decode) — impl"
    slug: "store-impl"
    type: "impl"
    depends-on: ["003"]
  - id: "005"
    subject: "downloadHistoryEnabled setting (default off) — test"
    slug: "settings-test"
    type: "test"
    depends-on: []
  - id: "006"
    subject: "downloadHistoryEnabled setting (default off) — impl"
    slug: "settings-impl"
    type: "impl"
    depends-on: ["005"]
  - id: "007"
    subject: "Shared outcome derivation + local persist wiring — test"
    slug: "background-test"
    type: "test"
    depends-on: ["004", "006"]
  - id: "008"
    subject: "Background wiring + HistoryRequest/ClearHistory + storage — impl"
    slug: "background-impl"
    type: "impl"
    depends-on: ["007"]
  - id: "009"
    subject: "Popup history section helpers (group/format/gate) — test"
    slug: "popup-test"
    type: "test"
    depends-on: ["002", "006"]
  - id: "010"
    subject: "Popup Download history section + toggle + Clear history — impl"
    slug: "popup-impl"
    type: "impl"
    depends-on: ["009", "008"]
```

## Task File References

- [Task 001: DownloadRecord schema — test](./task-001-record-test.md)
- [Task 002: DownloadRecord schema — impl](./task-002-record-impl.md)
- [Task 003: DownloadStore reducer — test](./task-003-store-test.md)
- [Task 004: DownloadStore reducer — impl](./task-004-store-impl.md)
- [Task 005: downloadHistoryEnabled setting — test](./task-005-settings-test.md)
- [Task 006: downloadHistoryEnabled setting — impl](./task-006-settings-impl.md)
- [Task 007: Shared derivation + persist wiring — test](./task-007-background-test.md)
- [Task 008: Background wiring + messages — impl](./task-008-background-impl.md)
- [Task 009: Popup history helpers — test](./task-009-popup-test.md)
- [Task 010: Popup Download history section — impl](./task-010-popup-impl.md)

## BDD Coverage

| Design area (spec §) | Behaviour | Red task |
|---|---|---|
| §5 `record.ts` | schema round-trip; `recordFromMediaItem` carries url/provenance; `applyOutcome` sets status+finishedAt; unknown keys dropped | 001 |
| §5 `store.ts` | `upsert` dedupe by requestId; cap ring-evict; `applyTransition` monotonic (completed↛queued); `decodeStore` corrupt→empty | 003 |
| §3/§8 settings | `downloadHistoryEnabled` default off; corrupt recovery; watch delivers changes | 005 |
| §2/§7/§9 background | shared derivation feeds record + Sync Event from same inputs; sidecar excluded; local gated by toggle, Convex by cloudSync; reconciliation by construction | 007 |
| §8 popup | `HistoryRequest` returns records; toggle gates recording; grouping/format; Clear history clears store not downloads | 009 |

## Dependency Chain

```
001 ─▶ 002 ─▶ 003 ─▶ 004 ─────────────▶ 007 ─▶ 008 ─────▶ 010
                 │                  ▲                        ▲
005 ─▶ 006 ──────┴──────────────────┴───────────▶ 009 ──────┘
002 ──────────────────────────────────────────────▶ 009

Red→Green pairs: (001→002) (003→004) (005→006) (007→008) (009→010)
Independent roots: 001 (record), 005 (settings) can start in parallel.
```
