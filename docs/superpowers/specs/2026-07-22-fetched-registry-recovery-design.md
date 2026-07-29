# Fetched handoff recovery

**Date:** 2026-07-22
**Status:** Implemented

## Failure

The Fetched gateway persists a unique Blob URL before calling
`chrome.downloads.download`. The Transfer Registry binds Chrome's returned id
after the gateway returns. A worker can die between those steps.

Before this change, the gateway recovered the id from the Blob URL, but the
registry did not consume it. The registry kept a handleless ambiguous row. A
later terminal event could then release the Blob without terminal projection,
Clear, history, sync, or budget.

## Ownership

- **Transfer Registry:** transfer intent, launch identity, browser-handle
  correlation, terminal evidence, projection, and retry.
- **Fetched gateway:** response bytes, offscreen Blob state, unique Blob URL,
  and its lifetime.
- **Capture exporter:** export intent. It uses the gateway but never enters the
  Transfer Registry.

The gateway may report evidence. It never decides a media transfer outcome.
The registry may claim a recovered transfer handle. It never owns Blob bytes.

## Lease identity

Fetched lease store v3 replaces the untyped `requestId` with one owner and
retains terminal cleanup facts:

```ts
type FetchedLeaseOwner =
  | {
      tag: 'transfer'
      requestId: string
      projectionId: string
      attempt: number
      since: number
      priorDownloadId?: number
    }
  | { tag: 'capture'; exportId: string }
  | { tag: 'legacy-unknown' }
```

`projectionId` separates a forgotten request from a later save of the same
media. `attempt`, `since`, and `priorDownloadId` identify the exact initial or
retry launch. New code cannot create `legacy-unknown`; migration uses it because
v1 cannot prove ownership.

## Checkpoints

```text
registry launching committed
  -> gateway staging committed
  -> Blob finalized; ready committed
  -> one Chrome handoff attempted
  -> active committed best-effort
  -> registry browser handle committed
```

`staging` proves Chrome was not called. `ready` means Chrome may have accepted
the download. A rejected or lost handoff reply is therefore ambiguous. It is
never retried and the ready lease is retained.

## Capacity and liveness

The gateway admits at most four leases. A fifth Transfer start returns typed
`busy` before its lazy `open(signal)` fetch runs; the registry records its
durable retry. A later Capture part may call `awaitCaptureReservation`: it
waits only in memory for a capacity revision, then still makes one durable
reservation. Staging uses a 25-second no-progress timeout and a four-minute
absolute cap; both abort the fetch signal, cancel the reader, and release the
pre-handoff reservation. Lease mutations use a short lane. Fetch, reader,
offscreen, Chrome, and terminal-release calls never occupy that lane.

Terminal Capture and autonomous-transfer cleanup writes a v3 `terminal` lease
with `cleanup`, `downloadId`, and `terminalAt`. Its one-shot alarm is armed
before that fact is persisted and before every boot or alarm revoke attempt.
If arming fails, no cleanup attempt runs and Fetched boot remains unavailable.
The alarm may outlive cleanup; that is harmless.

The Registry may prove a retained `projector` lease orphaned or superseded.
That path first arms the alarm, then durably promotes `cleanup` to
`autonomous`, then revokes. Cleanup ownership never moves in reverse.

## Boot observation

The gateway strictly decodes its bounded store, cleans only provably safe
Capture state, and reports transfer evidence without discarding it:

```ts
type FetchedBootObservation =
  | { tag: 'staging'; leaseId: string; owner: TransferOwner }
  | {
      tag: 'matched'
      leaseId: string
      owner: TransferOwner
      downloadId: number
      terminal: boolean
      terminalState?: 'complete' | 'interrupted'
    }
  | {
      tag: 'unknown'
      leaseId: string
      reason: 'no-url-match' | 'many-url-matches' | 'missing-id' | 'search-failed' | 'legacy-owner'
    }
```

The registry consumes observations before quarantining launches:

- matching `staging`: persist initial start failure or reschedule an exact
  retry; only then acknowledge safe Blob cleanup;
- matching live handle: persist the exact browser bind; normal probing records
  and projects a later terminal row;
- matching terminal handle: persist `terminal-pending` with its exact terminal
  state, then project it without an active-probe gap;
- only the terminal projector releases a transfer Blob, after Clear, history,
  sync, and budget durable sinks complete;
- a staging owner or phase mismatch: discard the staging lease. Its durable
  checkpoint precedes both offscreen handoff and `chrome.downloads.download`, so
  it cannot own a live browser transfer;
- a ready or active owner or phase mismatch: retain both records as ambiguous;
- an already bound exact handle is an idempotent match.

A retry recovery rejects its old `priorDownloadId` as the new handle.

## Lease rules

| Owner and state                      | Observation      | Disposal authority                       |
| ------------------------------------ | ---------------- | ---------------------------------------- |
| transfer staging, exact owner        | no Chrome call   | gateway, after registry commits recovery |
| transfer staging, orphan or mismatch | no Chrome call   | gateway discards the orphan lease        |
| transfer ready, one exact row        | recovered handle | terminal projector                       |
| transfer active, exact row           | recovered handle | terminal projector                       |
| transfer ready, zero/many/error      | ambiguous        | explicit recovery only                   |
| transfer active, missing/error       | ambiguous        | explicit recovery only                   |
| capture staging                      | no Chrome call   | gateway                                  |
| capture or autonomous terminal       | terminal         | gateway alarm, armed before each attempt |
| capture ambiguous                    | unknown          | explicit recovery only                   |
| legacy v1                            | unknown owner    | explicit recovery only                   |

Discard happens before durable lease removal. A failed discard retains the row.

## Fault domains

Fetched inspection isolates ordinary per-lease cleanup failures. Corrupt store
data or a terminal-cleanup alarm that cannot arm makes Fetched unavailable;
Direct, settings, UI, and Clear remain available. If the Transfer Registry is
corrupt, new transfers and Clear reconciliation fail closed; Capture and
unrelated UI remain available. Transfer-owned leases remain untouched while
registry truth is unavailable.

## Limits

Direct downloads still have an unrecoverable Chrome-accept-to-registry-bind
window because they have no durable unique lookup key. They remain ambiguous
and require explicit user recovery. This design makes no broader atomicity
claim.

## Proof

- crashes after `ready`, Chrome acceptance, active promotion, and before
  registry bind;
- live and terminal exact matches bind before any release;
- boot terminal evidence enters `terminal-pending` before projection, never an
  active probe;
- zero/many/search-failed matches retain the lease and never retry Chrome;
- a post-ready handoff rejection becomes ambiguous, not start-failed;
- retry launch identity and old-handle exclusion;
- Capture cleanup never calls the registry;
- terminal cleanup alarm is durable before its terminal fact and every cleanup
  attempt;
- v1 and corrupt stores stay read-only;
- registry and gateway corruption do not brick unrelated handlers.
