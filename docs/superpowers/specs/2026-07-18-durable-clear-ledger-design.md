# Durable Clear ledger design

**Date:** 2026-07-18

**Status:** Implemented

## Problem

Before this change, Clear authority lived in a service-worker `Map` and a 1.5 s
`setTimeout`. Chrome could terminate the worker at either point. The persisted
Transfer Registry then recovered the download terminal, but the missing Clear
entry left the post liked or bookmarked.

The prior cross-tab sender also used a destructive request as its presence
probe. If a tab clicked and its reply was lost, trying another tab could repeat
the mutation.

The approved Worklist design already requires a local Completion Ledger and
boot reconciliation. This design completes that requirement.

## Vocabulary

- **Completion Ledger** — durable per-post proof that every expected media file
  landed and which Clear scopes remain.
- **Transfer Registry** — durable per-transfer intent, handle correlation,
  retry, and terminal projection. It reports exact evidence; it never
  authorizes Clear.
- **Handle witness** — persisted `requestId -> downloadId` evidence used to
  re-probe a file after a browser restart.
- **Observed complete** — Chrome emitted `complete`; the settle window has not
  yet confirmed the file still exists.
- **Settled** — `downloads.search` confirmed `complete` and not `exists:false`.
- **Reservation** — a durable Clear claim made before any account mutation.
- **Attempted** — the destructive message may have reached a tab.
- **Uncertain** — the reply was lost after Attempted. Never retry automatically.
- **Tombstone** — compact durable `cleared` or `uncertain` scope proof written
  with the terminal result and retained after the heavy completion entry is pruned.
- **Visibility pulse** — a bounded content-script hint that mounted post ids
  changed. It wakes deferred Clears; it grants no authority.

## Chosen boundary

`ClearCoordinator` is the only Clear authority. Live state is in IndexedDB
`xmd-clear`. `core/clear/ledger.ts` owns the logical codec and pure transitions,
not physical persistence. The background supplies clock, download, tab, and
storage ports.

The sweep Worklist stays in `storage.local`. It answers sweep idempotency and UI
progress. A durable IDB outbox bridges the stores. Clear state and projection
intent commit together; Worklist persistence happens before exact outbox ack.

The Transfer Registry also stays separate. It is per-transfer, local-durable,
and acknowledges projected terminals. The Completion Ledger is per-post,
local-durable, and retains irreversible-action safety state.

## Durable state

`xmd-clear` version 2 has four stores:

- `meta`: migration identity and receipt.
- `active`: one compact coordinator record with monotonic revision.
- `tombstones`: immutable `(tweetId, scope)` terminal facts and Clear Log index.
- `worklistProjections`: one latest intent per `(tweetId, scope)`, ordered by
  producing revision.

The logical active value remains:

```ts
interface ClearLedgerStore {
  readonly version: 1
  readonly entries: Readonly<Record<string, StoredClearEntry>>
  readonly tombstones: Readonly<Record<string, Readonly<Partial<Record<Scope, ClearTombstone>>>>>
}

interface StoredClearEntry {
  readonly tweetId: string
  readonly manualScopes: ReadonlyArray<Scope>
  readonly automaticScopes: ReadonlyArray<Scope>
  readonly crossListAutomaticScopes: ReadonlyArray<Scope>
  readonly expected: ReadonlyArray<string>
  readonly done: ReadonlyArray<string>
  readonly failed: ReadonlyArray<string>
  readonly inProgress: ReadonlyArray<string>
  readonly clear: Readonly<Record<Scope, ClearStatus>>
  readonly handles: Readonly<Record<string, HandleWitness>>
  readonly settling: Readonly<Record<string, SettleWitness>>
  readonly createdAt: number
  readonly touchedAt: number
}

type ClearStatus =
  | 'none'
  | 'reserved'
  | 'attempted'
  | 'cleared'
  | 'failed'
  | 'skipped'
  | 'uncertain'

interface HandleWitness {
  readonly downloadId: number
  readonly startedAt: number
}

interface SettleWitness {
  readonly downloadId: number
  readonly dueAt: number
}

interface ClearTombstone {
  readonly tweetId: string
  readonly scope: Scope
  readonly state: 'cleared' | 'uncertain'
  readonly at: number
}
```

Arrays are decoded to `Set`s only inside the pure ledger module. Decode rejects
unknown versions, invalid ids, values outside `expected`, overlapping handle and
settle witnesses, unsafe numbers, and impossible clear states. Every active
`cleared` or `uncertain` state must have the matching immediate tombstone.
Corruption enters safe mode: preserve the raw value, trace it, and perform no Clear.

Tweet ids and request ids stay strings. X snowflakes are 1–20 decimal digits and
may exceed JavaScript's safe integer range. They are never converted to `number`.
Tombstones are nested by tweet id and scope; the codec verifies both keys match
the value. An active entry may share a tombstone only when its same scope has the
same terminal `cleared` or `uncertain` state.

`manualScopes` records explicit list sweeps. `automaticScopes` records hook
policy. `crossListAutomaticScopes` contains only scopes that have never had
ordinary automatic intent and so still require "Release from every list." An
ordinary hook permanently removes that scope from the cross-list-only subset;
a later cross-list seed cannot re-gate it. A scope may also be manual; manual
intent wins.

## Write protocol

All mutations run through one recoverable serial queue:

1. Load the current revision and requested tombstones.
2. Strictly decode them.
3. Apply one synchronous, deterministic, retry-safe transition.
4. In one strict IDB transaction, compare the active revision and observed
   tombstones, then write active state, new immutable tombstones, and Worklist
   intents.
5. On conflict, load the winner and rerun the pure transition.
6. Destructive sends, tab probes, and projection drains happen only after their
   owning commit. A recurring recovery alarm may be armed first.

Projection rows coalesce by `(tweetId, scope)`. A recurring recovery alarm is
established before any producer commit or Clear click. The drainer writes
`storage.local`, then deletes only the exact revision it applied. Sink or ack
failure leaves the row for alarm or boot replay. A Sweep claim stores its Clear
seed revision, so older rows cannot overwrite a newer generation after clock
rollback.

A storage failure may skip a Clear. It must never authorize one. Seeding failure
aborts the affected download batch before any download, history, sync, upload, or
monitor side effect begins. Starting anyway is unsafe: an older durable entry may
become Truly Complete while the new media is untracked.

## Download lifecycle

1. **Seed.** Persist every expected request id before starting downloads. The
   seed separately names the ids it starts: `expected` widens prerequisites;
   `starting` is an expected subset whose old terminal state and witnesses are
   discarded before the replacement binds. It also rearms a newly intended
   `skipped` scope; a repeated seed never shrinks a post.
2. **Bind.** The queue's per-start callback persists the handle immediately after
   `downloads.download` returns, before the batch waits for sibling starts. Retry
   starts replace the old witness.
3. **Observe complete.** The Transfer Registry first persists exact terminal
   evidence in `terminal-pending`. Its projector then persists the pure `Complete`
   transition and `{downloadId, dueAt: now + 1500}` before registry acknowledgement.
4. **Fail.** A final start or transfer failure persists `Fail` and removes its
   handle/settle witness.
5. **Settle.** At `dueAt`, probe the exact download id. Confirmed landed applies
   `Settle`. Interrupted, deleted, or missing applies `LateInterrupt`. A
   transient API error retains the witness and retries later.
6. **Authorize.** Only a Truly Complete entry may reserve a scope. The master
   switch gates every scope. Automatic scopes also require their current
   per-scope switch; manual sweep scopes do not. Cross-list automatic scopes also
   require the current "Release from every list" switch.

Every terminal transition carries `requestId` and `downloadId`. It applies only
when that id matches the current handle or settle witness. A late terminal from a
replaced retry handle is ignored.

The terminal ledger write is awaited before the Transfer Registry acknowledges
and removes `terminal-pending`. Boot-recovered transfers carry their persisted
request item; correctness does not depend on volatile request metadata.

## Boot reconciliation

Boot order is fixed:

1. Inspect typed Fetched leases without releasing transfer-owned rows.
2. Load and migrate the local Transfer Registry. It owns retry state and replays
   terminal projections through the Completion Ledger before acknowledgement.
3. Read the Registry's active handles and retry-owned request ids.
4. Reconcile ledger-owned handle witnesses not owned by Registry retry:
   - complete -> Observed complete and a fresh settle window;
   - interrupted or missing file -> Fail;
   - downloading -> retain;
   - missing row -> Fail closed;
   - search error -> retain.
     Expected ids with neither a handle nor settle witness are failed closed unless
     the rehydrated retry queue owns them. This covers a worker death between Seed
     and Bind.
5. Resume every settle witness from its absolute `dueAt`.
6. Convert restored `reserved` to `failed`; no destructive send began.
7. Convert restored `attempted` to `uncertain` and write its tombstone at
   recovery time; never retry it.
8. Attempt ready entries against currently open X tabs.
9. Replay the Worklist projection outbox independently of destructive readiness.

Every transition is idempotent. Boot and live terminal events may race without
double completion or double Clear.

## Two-phase Clear

Presence checks are read-only.

1. `LocateClearTweetRequest { tweetId, scopes, allLists }` asks tabs about the
   exact mounted tweet. It never clicks or queues a later click. Its exact tagged
   reply is either `{ mounted:false }` or one result per requested scope:
   `actionable | already-clear | not-applicable | unknown`.
2. `already-clear` is positive inactive-control evidence. It becomes `skipped`
   without a tombstone. For a manual Worklist scope, the same atomic transition
   queues `cleared`. `not-applicable` and `unknown` stay ready.
3. Choose one tab with at least one actionable scope. No target leaves the entry
   ready.
4. Choose exactly one actionable scope and persist its `reserved` state.
5. Recheck policy through the same serialized settings authority that owns
   settings writes. If disabled, release the reservation. Otherwise persist
   `attempted` and send while holding that policy turn.
6. Send one `ClearTweetRequest` to that one tab. Never fall through to another
   tab after an Attempted write.
7. The target rechecks tweet id, mount, membership, and control before the one
   click. Its exact scope result is `cleared | already-clear |
not-actionable | preflight-failed | uncertain`.
8. `cleared` is a verified flip and creates a tombstone. `already-clear` becomes
   `skipped` without one. Both queue manual Worklist `cleared`.
   `not-actionable` and `preflight-failed` are retryable `failed` because no
   account mutation began.
9. Once a control or destructive menu item is clicked, failure to verify the
   result is `uncertain`, not `failed`. A lost or malformed reply also makes every
   attempted scope `uncertain`. Uncertain scopes get tombstones and never retry
   automatically.

This may miss a Clear if the worker dies between persisting Attempted and sending.
That is the safe side of an irreversible boundary. It cannot double-mutate.

## Deferred retry

When the rendered post-id set changes, the content script sends at most 100
unique 1–20 digit string ids in `ClearVisibilityPulse`. The background treats them only as
a wake-up hint, rechecks the durable entry and settings, and targets only the
sender tab. A stale or forged hint cannot create an entry or bypass Truly
Complete.

No-target entries remain durable. They retry on a later pulse or worker boot.

## Pruning and reset

- A verified `cleared` or ambiguous `uncertain` result writes its tombstone at
  that exact result time. Fully resolved entries then drop their media/handle data.
- `skipped` scopes create no tombstone.
- Automatic-only failed download entries may be compacted after 24 hours only
  when they have no manual scope, live handle, settle witness, reservation, or
  attempt. They never authorize Clear.
- Tombstones have no automatic expiry. Forgetting them requires a separate,
  explicit destructive control.

## Preserved safety policy

This durability repair does not supersede the approved Worklist policy:

- Clear attempts remain single-flight and paced.
- Per-minute and per-browser-session caps remain required.
- Repeated selector or flip failures trigger backoff.
- Verified Clears remain available through a durable, user-visible Clear Log.

The Clear Log reads the newest indexed `cleared` tombstones directly. It includes
scope, exact proof time, DOM-click mechanism, and stable post permalink.
`uncertain` never appears as verified.

## Rejected designs

- **Keep the Map and rely on session transfer state:** it drops terminals and
  loses all state on browser restart.
- **Put Clear fields into the Transfer Registry:** mixes per-transfer recovery
  with per-post irreversible policy.
- **Persist only expected/done ids:** without `downloadId`, boot cannot re-probe
  the byte that authorizes Clear.
- **Retry a lost destructive reply:** may clear twice after the first click
  succeeded.
- **Use destructive requests to find a mounted tab:** a lost reply can fall
  through to a second tab and repeat the mutation.
- **Merge the sweep worklist now:** broad migration with no extra safety.
- **Clear on Observed complete:** reopens the late-interrupt blind spot.

## Verification

- Codec round-trip, normalization, every corrupt/impossible state.
- Serialized overlapping seed, bind, complete, fail, settle, and extend writes.
- Existing-entry plus failed extension seed: no new download starts and no old
  entry authorizes Clear.
- Restart at seed, handle, observed-complete, settle, reserved, attempted, and
  result boundaries.
- Browser restart with the local Transfer Registry retained.
- Retry-owned handle deferral and fresh retry-handle replacement.
- Late terminal for a replaced retry handle is ignored.
- Search complete/interrupted/deleted/missing/error matrix.
- Multi-media partial failure; duplicate and out-of-order terminals.
- Toggle off/on around settle and reservation.
- Toggle off between reserve and attempted send: no click.
- Read-only locate, one chosen destructive target, lost reply -> uncertain, no
  second send.
- No target -> retained; later visibility pulse -> one attempt.
- Wrong tweet, stale DOM, no-op scope, partial per-scope flip.
- Pre-click failure is retryable; post-click unverified outcome is uncertain.
- 20-digit snowflakes remain exact through pulse and tab protocols.
- Reset and corruption never remove safety tombstones or authorize Clear.
- Full gates, production build, and live MV3 worker-restart proof.
