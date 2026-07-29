# Transfer Registry v4

**Date:** 2026-07-18
**Status:** Implemented

## Truth

`local:browserTransferRegistry` is the durable owner for transfer intent,
correlation, retries, observations, and terminal projection. The Queue only
bounds start calls. It never declares byte completion.

This replaces the old split `session:transfers`, `session:requestMeta`,
`session:interruptRetries`, and volatile maps. It also replaces the old
session-scoped Transfer Tracker as the transfer owner.

## Store

The strict, bounded v4 store contains:

- `entries`: immutable request intent plus one phase;
- `profiles`: durable aria2 RPC endpoint snapshots and probe backoff;
- `legacy`: metadata-free v1 rows, retained only for safe migration.

Each request has a stable `projectionId`. Browser ids are unique. aria2 GIDs
are unique per canonical absolute HTTP(S) endpoint, including host-case and
default-port aliases.
The codec rejects corruption; it does not partially decode or reset it.

New work first persists `direct-prepared`, `fetched-prepared`, or
`aria2-prepared`. These rows are inert across worker restart. After Clear and
cloud admission, one exact durable permit moves them to `direct-ready`,
Registry `ready`, or `aria2-ready`. Direct then commits `launching` immediately
before Chrome. Fetched Registry `ready` exists before any response opens. Its
later Gateway Blob Lease `ready` means the Blob URL is finalized; these two
`ready` names belong to different stores.
Other browser phases are `fetched-capacity-wait`,
`fetched-call-armed`, `active`, `retry-wait`, `retry-refreshing` (a URL refresh
is durably requested), `retry-launching`, `unresolved-launch`,
`browser-unresolved`, `forget-pending` (a user dismissal awaits its Clear
fence), and `terminal-pending`. `aria2-prepared` and `aria2-ready` retain the
profile, GID, and options. `aria2-call-armed` commits immediately before `addUri`.
Other aria2 phases are `aria2-active`, `aria2-unresolved`,
`forget-pending`, and `terminal-pending`.

Old v3 `launching` and `aria2-launching` rows retain their uncertain legacy
meaning. Boot never reinterprets them as v4 pre-call readiness.

## Start contract

1. Persist every request intent before a strategy call.
2. After Clear and cloud admission, atomically permit the exact prepared batch.
3. Commit `launching` immediately before the one allowed Direct Chrome call.
   Bind Chrome's returned `downloadId` before further
   side effects. A failed bind quarantines the known handle; it never starts again.
4. For aria2, reserve a GID and profile in the durable intent.
5. Commit `aria2-call-armed` immediately before the one allowed `aria2.addUri`
   RPC. That call starts a transfer; it does not complete one.
6. Bind its returned receipt to `aria2-active`. If the call or bind is ambiguous,
   preserve an unresolved row and never repeat `addUri`.

This deliberately trades ambiguous-launch availability for duplicate safety.

Fetched capacity is different from a failed or ambiguous start. The coordinator
returns after durable Registry enqueue and reports Fetched as deferred. A
Registry wake reserves capacity and only then opens the response. The gateway
persists a lease before that open; the Registry commits
`fetched-call-armed { attempt, since, armedAt, leaseId }` before using the exact
lease. A pre-fetch `busy` becomes
`fetched-capacity-wait { attempt, retryAt }`. The wake alarm reopens that exact
request. A later `busy` re-defers it, a browser id binds it, and ambiguity
quarantines it. No Promise waiter owns retry state across MV3 suspension.
Header/idle staging is bounded to 25 seconds; total staging is bounded to four
minutes.

## Observation and retry

Chrome `downloads.onChanged` and exact `downloads.search` rows drive browser
state. `aria2.tellStatus` drives aria2 state, including progress and terminal
`complete`, `error`, or `removed` status. Browser interruptions may enter bounded
retry with a refreshed URL. Fetched retries stay Fetched. aria2 starts are
at-most-once at the RPC boundary.

On boot the Registry decodes or migrates first. Prepared rows stay inert. It
resumes v4 ready states, quarantines unsafe legacy or armed launches,
reconciles browser rows, polls retained aria2 profiles, re-arms absolute timers,
replays `terminal-pending`, then opens start/message handling.

`transfer-registry-work-plan.ts` is the pure scheduling policy. One exhaustive
phase switch produces exact work fences, deadlines, and the next durable wake.
The Registry derives local timers, the MV3 alarm, and due dispatch from that
same plan. Active work keys suppress duplicate drives. Drivers re-check the
exact phase, profile, token, or staging record inside the serialized lane before
any side effect. Boot normalization runs before planning. Before every durable
write that exposes planned work, Registry first creates a conservative durable
alarm lease; the exact post-write plan may refine it. Armed and live-coordinator
phases retain a periodic watch lease. Its handler never repeats the external
call. If a worker died, boot quarantine alone resolves that uncertainty.

Sweep work also carries durable `{ receiptId, clearSeedId }` ownership. Boot
keeps Sweep starts, retries, and terminal projection behind a barrier until
receipt repair confirms Registry ownership, exact receipt acknowledgements
commit, Clear recovery finishes, and cloud admission replays for prepared
intents. Only then does boot permit and release them. Already-acknowledged
receipts resume from Registry proof; receipt presence is not required.

## Terminal projection

A terminal observation persists before fan-out. Its idempotent projector updates
metrics, history, sync, backlink, saved status, and budget. Fetched Blob leases
release only after terminal projection is durable. Noncritical UI broadcasting
cannot wedge cleanup.

Clear is separate and stricter: it requires terminal **browser** evidence, a
Chrome `downloadId`, and the later Settle probe proving the file still exists.
aria2 media is terminally observed but never enters Clear because its GID is
not a Chrome download id.

## Shared fetched path

`FetchedTransferGateway` is the sole background owner of Fetched Blob leases and
the offscreen mint/revoke boundary. `CaptureExporter` delivers through this same
gateway. Capture export never owns a second offscreen lease or direct Blob path.

## Verification

- strict v4 codec, v3/v2 migration, uniqueness, and corruption rejection;
- intent-before-start and one armed `addUri` call;
- ambiguous aria2 calls never re-add;
- browser and aria2 terminal recovery across restart;
- Fetched retry mode and lease release;
- terminal projection replay without duplicate history, sync, Clear, or budget;
  Clear History snapshots terminal-pending projection ids so old replay cannot
  cross its durable reset fence;
- Clear rejects aria2 media and requires the exact browser `downloadId`.
