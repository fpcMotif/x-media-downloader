# Twitter List Membership Backup — Design Spec

**Date:** 2026-06-13
**Status:** Approved (brainstorming) — pending implementation plan
**Branch:** `claude/elegant-franklin-g4ofol` (PR #3, the Convex control-plane branch, with `main` merged in)
**Related:** ADR-0009 (Convex cloud control plane), ADR-0001 (passive-first capture), ADR-0008 (pure reducers, injected time), ADR-0005 (ephemeral state). A **new ADR** will record this decision during the documentation pass (next free number — `0010` on this branch today, bumped if the archive-job ADR-0010 from PR #4/#5 lands first).

## 1. Purpose & scope

Back up the **membership of Twitter Lists** the user browses, in a privacy-preserving, passive, offline-first way. For each List the user scrolls through, capture its members, store the snapshot **both** in local storage **and** (when Cloud Sync is on) mirror it to the user's own Convex deployment, and maintain an append-only **changelog of join/leave deltas** over time.

The user juggles **multiple Twitter accounts**, so every backup is attributed to the **capturing account** (the logged-in account that observed the List) and also records the **List's own owner** (creator).

### In scope
- Passive capture of List members via the existing GraphQL tee.
- Local snapshot store + bounded local changelog.
- Convex mirror (new tables + idempotent ingest mutation), reusing the existing outbox pattern.
- Multi-account attribution: capturing account **and** list owner, both recorded.
- Complete-vs-partial snapshots; join/leave deltas computed only between **complete** snapshots.
- Opt-in popup section + a default-off "Back up Twitter Lists" toggle.

### Out of scope (explicitly excluded)
- **Active add/remove of members on Twitter** (write actions). This feature is **observe-only**.
- Full-list enumeration via authenticated API / auth fallback (only what the user scrolls past).
- Cross-device conflict resolution beyond the append-only ledger.
- A Convex-side dashboard / analytics UI.
- Restoring a List from a backup.

## 2. Decisions locked during brainstorming
| Question | Decision |
|---|---|
| Core operation | **Observe-only**: snapshot members + log join/leave deltas. No writes to Twitter. |
| Owner model | Record **both** the List's real owner (handle + stable id) **and** the capturing account. |
| Snapshot completeness | **Complete-vs-partial flag.** Only diff two *complete* snapshots; partials are stored for display but never emit `left` events. |
| Architecture | **Separate module + dedicated Convex tables** (`core/lists/` + `lists`/`roster_events`/`list_membership`), reusing the outbox *pattern*. |
| Local backup gating | **Opt-in, default off** (`backupListsEnabled`). Keeps the "no remote telemetry / local-only" footer honest. The Convex mirror reuses the existing Cloud Sync enablement. |

## 3. Domain language (new — to land in `CONTEXT.md` during the grill pass)
- **List Snapshot** — the set of members of one Twitter List observed at a point in time, under one **capturing account**, tagged with the List's **owner**. Marked **complete** (we believe we saw every member) or **partial**.
- **List Member** — a user in a List: stable `userId` (rest_id) plus denormalized `handle`/`name`. Identity is `userId`; handles change and are never used as identity.
- **Roster Event** — one append-only `joined`/`left` transition for a (capturing account, list, member), derived by diffing two complete snapshots. Carries a deterministic idempotency id. The List analogue of the existing **Sync Event**, kept in a separate ledger.
- **Capturing Account** — the logged-in account that observed the List (distinct from the List's owner).
- **List Owner** — the List's creator (from the List object).

## 4. Architecture & data flow
```
X list-members page → tee (GraphQL responses) → X adapter (parse ListMembers + List object)
   → overlay content script: accumulate unique members across scroll; decide complete?
   → background (serialized read-modify-write):
        load last COMPLETE snapshot → diffSnapshots() → Roster Events
          ├─ storage.local: persist snapshot + bounded changelog          (LOCAL STORE)
          └─ roster outbox → ConvexPort → lists:recordRoster (drain)        (CONVEX MIRROR)
   → popup: read local backups + changelog, grouped by capturing account → list
```
Local store is authoritative and offline-first; Convex is a fire-and-forget mirror, exactly like the existing download-sync outbox. Downloads/captures never block on the cloud.

## 5. Pure core — `src/core/lists/` (no I/O, injected time; the TDD heart)

### `snapshot.ts`
Effect `Schema` definitions (unknown keys dropped on decode, same posture as `SyncEvent`):
- `ListIdentity` = `{ listId, listName, ownerId, ownerHandle }`
- `CapturingAccount` = `{ accountId, accountHandle }`
- `ListMember` = `{ userId, handle, name? }`
- `ListSnapshot` = `ListIdentity & CapturingAccount & { capturedAt, complete, expectedCount?, members: ListMember[] }`
- `snapshotId = accountId/listId/capturedAt` (deterministic).

### `diff.ts`
- `diffSnapshots(previousComplete: ListSnapshot | null, next: ListSnapshot): RosterEvent[]`
- Keyed on `userId`. `previous === null` ⇒ every member is a `joined` (bootstrap). Members in `previous` but not `next` ⇒ `left`. Members in `next` but not `previous` ⇒ `joined`. Handle-only change (same `userId`) ⇒ **no event**. Identical sets ⇒ `[]`.
- Caller contract: only ever pass **complete** snapshots; partials are filtered upstream.

### `events.ts`
- `RosterEvent` schema = `{ eventId, kind: 'joined' | 'left', accountId, listId, userId, handle, at }` + builders.
- `eventId = accountId/listId/userId/kind/toSnapshotId`. Re-diffing the same `(previous, next)` pair is idempotent; a leave-then-rejoin later produces distinct ids (different `toSnapshotId`).

## 6. Outbox generalization (targeted improvement)
The existing `src/core/sync/outbox.ts` reducer is already a pure FIFO-with-backoff over `{ eventId }`-bearing items. Generalize it to `OutboxState<E extends { eventId: string }>` with a `decodeOutbox(schema)` factory (Effect needs a concrete schema to decode). Download-sync uses `OutboxState<SyncEvent>`; Lists use `OutboxState<RosterEvent>`. **Regression gate:** the existing sync outbox tests must stay green. If genericization endangers them, fall back to a sibling `core/lists/outbox.ts` — but the reducer is generic enough that this is expected to be clean.

## 7. Local storage model (`storage.local`)
- `local:listBackups` — map keyed `accountId/listId` → `{ identity, lastComplete: ListSnapshot | null, lastSeen: ListSnapshot, memberCount }`. `lastComplete` drives diffing; `lastSeen` (possibly partial) drives display.
- `local:listChangelog` — bounded (e.g. 200) recent Roster Events, newest-first, for the popup.
- `local:listOutbox` — `OutboxState<RosterEvent>` for the Convex mirror.

## 8. Convex backend — `backend/convex/lists.ts` + `schema.ts`
New tables (kept separate from `sync_events`/`media_state`):
- **`lists`** — `accountId, listId, listName, ownerId, ownerHandle, memberCount, lastSnapshotAt`; index `by_account_list [accountId, listId]`.
- **`roster_events`** — append-only ledger: `eventId, kind, accountId, listId, userId, handle, at`; indexes `by_event_id`, `by_account_list_at [accountId, listId, at]`.
- **`list_membership`** — materialized current members: `accountId, listId, userId, handle, name?, present, firstSeenAt, lastSeenAt`; indexes `by_account_list`, `by_account_list_user`.

Functions (mirror `sync:recordEvents` shape, including the optional `SYNC_SHARED_SECRET` gate):
- **`lists:recordRoster`** — idempotent batch ingest. Skips already-seen `eventId` (at-least-once delivery ⇒ exactly-once recording), upserts `lists`, and applies `joined`/`left` to `list_membership`. Membership is fully reconstructable from the ledger (the first complete snapshot bootstraps all-joined). Batches stay ≤64 events like the existing outbox.
- **`lists:rosterEvents`** / **`lists:membership`** — cursor-paginated reads for a future dashboard.

The client computes the diff and sends only **deltas** + list metadata — compute and bytes stay on the client; Convex remains a metadata control plane (ADR-0009 posture).

## 9. Capture wiring
- **X adapter (`core/adapters/x/`)** — detect the List-members GraphQL operation + the List object; parse → `ListMember[]` + page cursor, and `ListIdentity` + `expectedCount` (member_count) + owner. Field paths pinned by a fixture (like `src/test/fixtures/tweet-detail.json`). Garbage / spoofed payloads → `null`.
- **Overlay content script** — on list-members routes, accumulate unique members across paginated responses while the user scrolls; mark **complete** when the next cursor is empty **or** unique-observed ≥ `expectedCount`. Identify the capturing account from the active-session signal available in-page (exact source pinned during TDD). Hand the finished snapshot to the background.
- **Background** — serialized read-modify-write: load `lastComplete`, `diffSnapshots`, append events to the roster outbox + changelog, persist the snapshot, drain to Convex fire-and-forget (never blocks). Startup drain reconciles after offline (existing pattern). Disabling the mirror clears the roster outbox.

## 10. Popup UI
New **"Twitter Lists backup"** `<Section>` (styled with the existing `xmd-*` components, like the Cloud Sync section): grouped by capturing account → lists, each showing name, owner (`you` vs `@handle`), member count, last-snapshot time with a **complete/partial** badge, and recent joins/leaves from the local changelog. Read-only; capture is passive while browsing. A default-off **"Back up Twitter Lists"** toggle (`backupListsEnabled`) gates the new capture.

## 11. Error handling / edge cases
- Handle rename ⇒ no event (`userId` stable).
- Partial snapshot ⇒ stored as `lastSeen` for display only; never diffed; never emits `left`.
- Account switch mid-scroll ⇒ keyed per `accountId`; a new accumulation starts.
- Same list under two accounts ⇒ independent backups (separate `accountId/listId` keys).
- Convex disabled / offline ⇒ local backup still works; outbox holds; drains on re-enable.
- Adapter schema drift ⇒ `null`, skip, log; no snapshot recorded.

## 12. Testing strategy (red-green order for the TDD phase)
1. `diff.ts` — bootstrap (null→all joined); add/remove deltas; handle-rename no-op; identical sets → none; deterministic `eventId`s; idempotent re-diff.
2. `events.ts` — builders + deterministic ids; leave-then-rejoin yields distinct ids.
3. `snapshot.ts` — decode/encode round-trip; unknown keys dropped; completeness flag.
4. Generalized `outbox.ts` — parametric over event type; **existing sync outbox tests stay green**.
5. X adapter — fixture-pinned `ListMembers` + List object → members/owner/count/cursor; spoofed payloads → `null`.
6. Convex `lists:recordRoster` — idempotent ingest (seen `eventId` skip), membership materialization, secret gate (backend test harness like the existing one).
7. Background wiring + popup — contract-level, last phase.

## 13. Sequencing
- **Step 0 — DONE:** merge `main` (incl. photo-download badge) into PR #3's branch, conflicts resolved, `bun run check` + `bun run build` green (180 tests). PR #3 kept open.
- **Next:** `writing-plans` → `/tdd` builds §5 → §6 → §8 → §9–10 in red-green order. `/grill-with-docs` sharpens the §3 terms, updates `CONTEXT.md`, and writes the new ADR (§ header) as decisions crystallize.
