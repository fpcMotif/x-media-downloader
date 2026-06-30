# Plan — Timeline "Saved" status from Convex (B+C)

Executable implementation plan for the approved design
`docs/superpowers/specs/2026-06-27-timeline-saved-status-design.md`.
Work on branch `docs/timeline-saved-status-spec`. TDD throughout (Red before
Green); coverage gate over `src/core`.

## Context

The extension already mirrors every download to a Convex control plane
(`sync_events` → `media_state`, ADR-0009) and keeps a durable local download
history (ADR-0010/0014), but nothing surfaces "already downloaded" back onto the
timeline. This plan reads that ledger back and paints a **cross-device** "Saved ✓"
chip onto posts in the For You / Following / List timelines.

Approach **B+C**: exact membership via a promoted `media_state.tweetId` index +
`downloadedAmong` query (B), layered over a local-first `SavedIndex` that seeds
from local history and marks on completion (C). Read-only status surfacing — no new
download or clear behavior. Badge-only v1; skip-on-sweep is deferred to phase 2.

### Current state vs target state

| Dimension | Current | Target |
|---|---|---|
| Convex client | `mutation()` only (`POST /api/mutation`) | adds `query()` (`POST /api/query`) |
| Convex backend | `recordEvents`, `recentEvents` | adds `downloadedAmong`, `backfillTweetId` |
| `media_state` identity | indexed by `deviceId+requestId`; `tweetId` nested in `media` | adds top-level `tweetId` + `by_tweet` index |
| "Already saved" signal | none on the timeline | `SavedIndex` (local seed + Convex union) behind a background message |
| Overlay | hover/clear affordances only | adds debounced status sweep + idempotent "Saved ✓" chip |
| Settings | no status toggle | `showSavedStatus` (default on; C-only when sync unconfigured) |

## Execution Plan

```yaml
tasks:
  - id: "001-test"
    subject: "media_state.tweetId materialization — test"
    slug: "backend-tweetid-test"
    type: "test"
    depends-on: []
  - id: "001-impl"
    subject: "media_state.tweetId column + by_tweet index + materializeState"
    slug: "backend-tweetid-impl"
    type: "impl"
    depends-on: ["001-test"]
  - id: "002-test"
    subject: "downloadedAmong + backfillTweetId — test"
    slug: "downloaded-among-test"
    type: "test"
    depends-on: ["001-impl"]
  - id: "002-impl"
    subject: "downloadedAmong query + backfillTweetId mutation"
    slug: "downloaded-among-impl"
    type: "impl"
    depends-on: ["002-test"]
  - id: "003-test"
    subject: "ConvexPort.query + queryDownloadedAmong — test"
    slug: "convex-query-port-test"
    type: "test"
    depends-on: []
  - id: "003-impl"
    subject: "ConvexPort.query over POST /api/query + queryDownloadedAmong caller"
    slug: "convex-query-port-impl"
    type: "impl"
    depends-on: ["003-test"]
  - id: "004-test"
    subject: "SavedIndex local-first merge — test"
    slug: "saved-index-test"
    type: "test"
    depends-on: []
  - id: "004-impl"
    subject: "SavedIndex (seed / markSaved / resolve / TTL / offline-degrade)"
    slug: "saved-index-impl"
    type: "impl"
    depends-on: ["004-test"]
  - id: "005"
    subject: "SavedStatus messages + showSavedStatus setting"
    slug: "schema-messages-settings"
    type: "config"
    depends-on: []
  - id: "006-test"
    subject: "Background seed + markSaved + SavedStatusRequest handler — test"
    slug: "background-wiring-test"
    type: "test"
    depends-on: ["004-impl", "005"]
  - id: "006-impl"
    subject: "Background wiring (seed, markSaved hook, request handler)"
    slug: "background-wiring-impl"
    type: "impl"
    depends-on: ["006-test", "003-impl"]
  - id: "007-test"
    subject: "Overlay sweep + Saved chip render — test"
    slug: "overlay-sweep-render-test"
    type: "test"
    depends-on: ["005"]
  - id: "007-impl"
    subject: "Overlay status sweep + idempotent Saved ✓ chip + scope gating"
    slug: "overlay-sweep-render-impl"
    type: "impl"
    depends-on: ["007-test", "005"]
  - id: "008-test"
    subject: "showSavedStatus toggle behavior — test"
    slug: "settings-toggle-test"
    type: "test"
    depends-on: ["005", "007-impl"]
  - id: "008-impl"
    subject: "showSavedStatus toggle in options/popup + overlay gating"
    slug: "settings-toggle-impl"
    type: "impl"
    depends-on: ["008-test", "007-impl"]
```

## Task File References

- [Task 001 (test): backend tweetId materialization](./task-001-backend-tweetid-test.md)
- [Task 001 (impl): media_state.tweetId column + by_tweet index](./task-001-backend-tweetid-impl.md)
- [Task 002 (test): downloadedAmong + backfill](./task-002-downloaded-among-test.md)
- [Task 002 (impl): downloadedAmong query + backfillTweetId](./task-002-downloaded-among-impl.md)
- [Task 003 (test): ConvexPort.query + queryDownloadedAmong](./task-003-convex-query-port-test.md)
- [Task 003 (impl): ConvexPort.query + caller](./task-003-convex-query-port-impl.md)
- [Task 004 (test): SavedIndex](./task-004-saved-index-test.md)
- [Task 004 (impl): SavedIndex](./task-004-saved-index-impl.md)
- [Task 005 (config): SavedStatus messages + setting](./task-005-schema-messages-settings.md)
- [Task 006 (test): background wiring](./task-006-background-wiring-test.md)
- [Task 006 (impl): background wiring](./task-006-background-wiring-impl.md)
- [Task 007 (test): overlay sweep + render](./task-007-overlay-sweep-render-test.md)
- [Task 007 (impl): overlay sweep + render](./task-007-overlay-sweep-render-impl.md)
- [Task 008 (test): settings toggle](./task-008-settings-toggle-test.md)
- [Task 008 (impl): settings toggle](./task-008-settings-toggle-impl.md)

## BDD Coverage

All scenarios in `bdd-specs.md` are covered:

| Feature | Scenarios | Tasks |
|---|---|---|
| 1 — backend tweetId materialization | 2 | 001-test / 001-impl |
| 2 — downloadedAmong + backfill | 5 | 002-test / 002-impl |
| 3 — ConvexPort.query + caller | 5 | 003-test / 003-impl |
| 4 — SavedIndex | 5 | 004-test / 004-impl |
| 5 — messages + setting | 2 | 005 |
| 6 — background wiring | 3 | 006-test / 006-impl |
| 7 — overlay sweep + render | 4 | 007-test / 007-impl |
| 8 — settings toggle | 2 | 008-test / 008-impl |

## Dependency Chain

```
001-test → 001-impl → 002-test → 002-impl
003-test → 003-impl ───────────────┐
004-test → 004-impl ──┐             │
005 ──────────────────┼→ 006-test → 006-impl
                      │
005 ──┬─────────────→ 007-test → 007-impl ──┐
      │                                      │  (007-impl also needs 005)
      └────────────────────────→ 008-test → 008-impl
                                  (008-test & 008-impl both need 007-impl)
```

Independent roots (can start in parallel): `001-test`, `003-test`, `004-test`, `005`.
`006-impl` additionally requires `003-impl` (the real `queryDownloadedAmong`).
`008-*` gate the `sweepSavedStatus` created by `007-impl` and edit the same
`index.tsx`, so they chain after `007-impl` (no parallel write conflict).
