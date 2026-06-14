# Plan — Phase 1 MVP: Convex Link Catalog

- **Date:** 2026-06-14
- **Status:** ⚠️ **Largely SUPERSEDED** — the Phase-1 link catalog is already shipped on `main`
  (`media_state`/`sync_events` + `src/core/sync/convex.ts`). See **Reconciliation outcome** below.
  Do NOT execute tasks 001/004/005/006/007 as written. (task 015 resolved 2026-06-14)
- **Design:** [spec](../../superpowers/specs/2026-06-14-convex-cloud-backup-design.md) (§9 Phase 1) · ADR-0011/0012 · [BDD specs](./bdd-specs.md)
- **Phase-0 prototype (validated):** `study/cloud-sync-prototype/machine.ts`

## Reconciliation outcome (task 015 — resolved 2026-06-14)

Run before any code, this spike found the Phase-1 MVP is **mostly already shipped**. Grounded in
`main:backend/convex/schema.ts` + `sync.ts` + `src/core/sync/convex.ts`, and consistent with the
[A0 reconciliation brief](../2026-06-14-cloud-destinations-plan/A0-reconciliation.md) (the authoritative
reconciliation — read it, don't duplicate it):

| This plan assumed | Shipped reality | Verdict |
|---|---|---|
| New `catalogItems` table | `media_state` already stores `{tweetId,handle,type,url,ext,index}` per request | **`media_state` IS the catalog** — drop `catalogItems` |
| New `syncItems` mutation, deduped | `recordEvents` + `sync_events.eventId` idempotency (at-least-once→exactly-once) | Already done — drop `syncItems` |
| Backend at top-level `convex/` | Backend is a separate bun package at `backend/convex/` | Wrong path — use `backend/convex/` |
| Create `src/core/sync/` (task 007) | `src/core/sync/convex.ts` (HTTP port) already shipped | Collision — new code goes in `src/core/cloud/` |
| Convex Auth day one (task 005) | `deviceId` + `SYNC_SHARED_SECRET`; no Auth | Deferred (A0 §3 Option B) — Auth is a later `deviceId`→`userId` migration |
| Byte path | (matches) presign-everything | ✅ consistent |

**Decision:** this plan is retired in favour of the shipped mirror + the
[cloud-destinations plan](../2026-06-14-cloud-destinations-plan/_index.md), which the parallel build
owns. **Blocking prerequisite (A0 §0):** this branch is based on pre-mirror `main` (`c3be490`) and
must be rebased/merged onto `main` (`bbdad24`) before any `backend/` work exists to build on.

**Possible salvage (small, non-duplicative):** the only Phase-1 ideas NOT in the shipped mirror are
the *flexible trigger* (`onDownload`/`onDemand`/`both` + on-demand "Back up" button) and the *popup
consent gate + 3-state status line*. If wanted, re-scope those as a thin increment on top of the
shipped `media_state` seam — **not** the backend tasks here. Validate against the rebased tree first.

## Context

The extension is local-only today: grabbed X media is downloaded to disk and nothing leaves the
device. X's original media URLs rot (expire / get deleted), so a user who wants a durable record of
what they saved has no recourse once the link dies. Phase 1 introduces the smallest honest defense:
**sync the original link + metadata of items the user chose to grab into a Convex catalog**, deduped
and surfaced as honest per-item status — strictly opt-in and off by default.

Phase 1 is deliberately **link-catalog only**. No bytes leave for any cloud, no provider matrix, no
presign/video path (those are Phase 2+). This keeps the privacy reframe (ADR-0011) minimal and the
surface small, while delivering the part the user named first: *"sync the media original links into
Convex."*

The pure sync state machine was already validated in the Phase-0 prototype; Phase 1 lifts the
Phase-1-relevant slice (capture seam + durable queue + 3-state rollup) into `src/core/sync/` and
drops the prototype's upload-job/provider machinery until Phase 2.

### Current state → target state

| Dimension | Current | Target (Phase 1) |
|---|---|---|
| Backend | none (no Convex) | Convex deployment + Convex Auth; `catalogItems` table |
| Media leaving device | nothing | original link + metadata only, opt-in, per-user |
| Settings | download/aria2/badge flags | + `cloudSyncEnabled` (off), `syncTrigger`, `cloudConvexUrl` (no default) |
| Capture seam | n/a | durable `local:sync-queue`, flush on download-complete + popup-open |
| Status | download metrics only | + 3-state per-item catalog status (pending/safe/failed) |
| Popup | precise tools | + sign-in, master consent gate, one quiet status line, on-demand backup |
| Privacy promise | "local-only" | "local-first; optional cloud sync, off by default" (ADR-0011) |

### Out of scope (Phase 2+)

Bring-your-own-cloud (R2/S3/Dropbox/Google Photos), provider matrix UI, presigned-POST/video byte
path + SSRF guard, options page for connections, retry sweeper cron, backfill. iCloud is dropped
entirely (spec §7).

## Execution Plan

```yaml
tasks:
  - id: "001"
    subject: "Convex scaffold + client wiring"
    slug: "convex-scaffold"
    type: "config"
    depends-on: []
  - id: "002"
    subject: "Cloud-sync settings schema — test"
    slug: "settings-schema-test"
    type: "test"
    depends-on: []
  - id: "003"
    subject: "Cloud-sync settings schema — impl"
    slug: "settings-schema-impl"
    type: "impl"
    depends-on: ["002"]
  - id: "004"
    subject: "Convex catalog backend (schema + syncItems + auth) — test"
    slug: "convex-catalog-test"
    type: "test"
    depends-on: ["001"]
  - id: "005"
    subject: "Convex catalog backend (schema + syncItems + auth) — impl"
    slug: "convex-catalog-impl"
    type: "impl"
    depends-on: ["004"]
  - id: "006"
    subject: "Sync core (lift prototype machine, Phase-1 slice) — test"
    slug: "sync-core-test"
    type: "test"
    depends-on: ["003"]
  - id: "007"
    subject: "Sync core (lift prototype machine, Phase-1 slice) — impl"
    slug: "sync-core-impl"
    type: "impl"
    depends-on: ["006"]
  - id: "008"
    subject: "Durable local:sync-queue — test"
    slug: "sync-queue-test"
    type: "test"
    depends-on: ["007"]
  - id: "009"
    subject: "Durable local:sync-queue — impl"
    slug: "sync-queue-impl"
    type: "impl"
    depends-on: ["008"]
  - id: "010"
    subject: "Background sync seam (download-complete → flush) — test"
    slug: "background-integration-test"
    type: "test"
    depends-on: ["005", "009"]
  - id: "011"
    subject: "Background sync seam (download-complete → flush) — impl"
    slug: "background-integration-impl"
    type: "impl"
    depends-on: ["010"]
  - id: "012"
    subject: "Popup consent gate + 3-state status + on-demand — test"
    slug: "popup-consent-status-test"
    type: "test"
    depends-on: ["005", "009"]
  - id: "013"
    subject: "Popup consent gate + 3-state status + on-demand — impl"
    slug: "popup-consent-status-impl"
    type: "impl"
    depends-on: ["012"]
  - id: "014"
    subject: "PRODUCT.md local-first reframe + ADR-0013"
    slug: "product-reframe-and-adr"
    type: "docs"
    depends-on: []
  - id: "015"
    subject: "Reconciliation spike vs elegant-franklin sync_events/media_state"
    slug: "reconciliation-spike"
    type: "spike"
    depends-on: ["005", "009"]
```

## Task File References

- [Task 001: Convex scaffold + client wiring](./task-001-convex-scaffold-config.md)
- [Task 002: Settings schema — test](./task-002-settings-schema-test.md)
- [Task 003: Settings schema — impl](./task-003-settings-schema-impl.md)
- [Task 004: Convex catalog backend — test](./task-004-convex-catalog-test.md)
- [Task 005: Convex catalog backend — impl](./task-005-convex-catalog-impl.md)
- [Task 006: Sync core — test](./task-006-sync-core-test.md)
- [Task 007: Sync core — impl](./task-007-sync-core-impl.md)
- [Task 008: Durable sync-queue — test](./task-008-sync-queue-test.md)
- [Task 009: Durable sync-queue — impl](./task-009-sync-queue-impl.md)
- [Task 010: Background sync seam — test](./task-010-background-integration-test.md)
- [Task 011: Background sync seam — impl](./task-011-background-integration-impl.md)
- [Task 012: Popup consent + status — test](./task-012-popup-consent-status-test.md)
- [Task 013: Popup consent + status — impl](./task-013-popup-consent-status-impl.md)
- [Task 014: PRODUCT.md reframe + ADR-0013](./task-014-product-reframe-and-adr.md)
- [Task 015: Reconciliation spike](./task-015-reconciliation-spike.md)

## BDD Coverage

| BDD Feature (bdd-specs.md) | Covered by |
|---|---|
| Cloud-sync settings (off by default) | 002 / 003 |
| Convex catalog backend (catalogItems + syncItems) | 004 / 005 |
| Sync core — pure state | 006 / 007 |
| Durable local sync-queue | 008 / 009 |
| Background integration (the sync seam) | 010 / 011 |
| Popup — consent gate and honest status | 012 / 013 |
| Documentation & reconciliation | 014, 015 |

Every BDD feature maps to at least one Red/Green pair (or a docs/spike task). No scenario is orphaned;
no task lacks a scenario.

## Dependency Chain

```
001 ─────────────► 004 ──► 005 ─────────────┬─► 010 ──► 011
                                            ├─► 012 ──► 013
                                            └─► 015
002 ──► 003 ──► 006 ──► 007 ──► 008 ──► 009 ─┤
                                            (009 also feeds 010, 012, 015)
014  (independent docs)
```

Two independent chains converge at the background seam (011) and popup (013):
- **Backend chain:** 001 → 004 → 005
- **Extension chain:** 002 → 003 → 006 → 007 → 008 → 009
- **Convergence:** 010/012/015 each depend on both 005 and 009.
- 014 (docs) is independent and can land anytime.

No cycles. Parallelizable fronts: {001, 002, 014} can all start immediately.

## Risks / open items

- **ADR-0013 exists on disk as _Proposed_.** Task 014 promotes it to _Accepted_ (the spec treats its
  decisions as canonical).
- **Two catalog designs for one seam.** Branch `claude/elegant-franklin-g4ofol` shipped
  `sync_events`/`media_state` + an Outbox; this plan adds `catalogItems`/`syncItems`. Task 015 is a
  spike to pick one seam **before** 005's schema is treated as final — if reconciliation changes the
  table shape, 004/005 must be revised. Sequence 015 early in execution despite its `depends-on`.
- **Convex Auth in an MV3 service worker** (HTTP client, token storage) is the least-proven piece;
  005 carries that risk.
```
