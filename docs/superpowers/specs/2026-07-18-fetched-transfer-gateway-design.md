# Fetched transfer gateway design

**Date:** 2026-07-18

**Status:** Superseded on 2026-07-22 by
[Fetched handoff recovery](2026-07-22-fetched-registry-recovery-design.md)

This document records the original v1 lease design. The current v2 store uses
typed Transfer/Capture owners. `ready` means Chrome may have accepted the
handoff; zero matches never prove otherwise. Transfer terminal cleanup belongs
to the Transfer Registry projector.

## Problem

Fetched mode crosses three lifetimes: the MV3 worker fetches, an offscreen
document owns Blob URLs, and Chrome owns the resulting download. A per-batch
offscreen port cannot coordinate concurrent batches. Revoking when
`downloads.download()` returns is also early: the API has started the download;
it has not reported a terminal.

The current byte path also calls `arrayBuffer()` before enforcing its cap, then
turns 15 MiB into one JSON number array. A missing or false `Content-Length` can
still exhaust the worker.

## Boundary

One background-owned `FetchedTransferGateway` owns:

- the single offscreen document;
- one serialized staging lane;
- the chunked runtime protocol;
- `session:fetchedBlobLeases`;
- terminal release and boot reconciliation.

`fetched-strategy.ts` owns only permission, response, MIME, and declared-size
policy. It delegates the body and browser handoff to the gateway. No caller may
construct another production gateway.

## Contract

```ts
interface FetchedTransferGateway {
  start(input: {
    requestId: string
    filename: string
    mimeType: string
    body: ByteSource
  }): Promise<{ kind: 'started'; downloadId: number } | { kind: 'too-large' }>

  releaseTerminal(downloadId: number): Promise<void>
  reconcileOnBoot(): Promise<void>
}

interface ByteSource {
  read(): Promise<{ done: boolean; value?: Uint8Array }>
  cancel(): Promise<void>
}
```

The staging lane caps expensive Fetched work at one across every request batch.
Browser downloads may overlap after handoff.

## Durable lease state

```ts
interface FetchedBlobLeaseStore {
  readonly version: 1
  readonly leases: Readonly<Record<string, FetchedBlobLease>>
}

type FetchedBlobLease =
  | {
      readonly leaseId: string
      readonly requestId: string
      readonly state: 'building'
      readonly phase: 'staging'
      readonly createdAt: number
    }
  | {
      readonly leaseId: string
      readonly requestId: string
      readonly state: 'ready'
      readonly objectUrl: string
      readonly createdAt: number
      readonly finalizedAt: number
    }
  | {
      readonly leaseId: string
      readonly requestId: string
      readonly state: 'active'
      readonly downloadId: number
      readonly createdAt: number
      readonly activatedAt: number
    }
```

The gateway is the only writer. Every mutation is a strict decode, pure change,
and awaited full write on one FIFO. Corruption fails safe: no new Fetched start
and no document close.

## Start protocol

1. Persist a `building` lease.
2. Ensure the offscreen document.
3. Begin the offscreen Blob under `leaseId`.
4. Read one body chunk. Reject a malformed chunk.
5. If cumulative bytes exceed 15 MiB, cancel the source and discard the Blob.
6. Send chunks of at most 256 KiB through exact runtime messages.
7. Finalize to a Blob URL.
8. Persist `ready { objectUrl }`.
9. Call `downloads.download()` in the worker.
10. Persist `active { downloadId }`.
11. Return the browser handle. Keep the URL and document alive.

Failure before a browser id cancels the source, discards the Blob, and removes
the lease. The `ready` write is before the Chrome side effect, so it is already
a durable terminal-cleanup handle. After Chrome returns an id, the gateway tries
to promote the row to `active` once. A failed promotion neither retries
`downloads.download()` nor wedges the staging lane: terminal release resolves
the exact Blob URL back to the browser id, then removes the `ready` row.
`createdAt` is the reservation time; `finalizedAt` and `activatedAt` record later
transitions.

A worker death between browser handoff and the `active` write leaves a durable
`ready` lease. Boot searches Chrome by that exact unique Blob URL, promotes one
match to `active`, then releases it if terminal. Zero matches prove the handoff
never happened (or is already gone), so boot discards the URL. More than one
match or a search error retains the row. New `building/staging` rows are always
pre-handoff, so boot safely discards them. Legacy v1 `building` rows are decoded
as `ambiguous` and retained: they may have crossed the old handoff gap.

## Offscreen protocol

- `OffscreenBlobBegin { leaseId, mimeType }`
- `OffscreenBlobAppend { leaseId, bytes }`
- `OffscreenBlobFinalize { leaseId }`
- `OffscreenBlobDiscard { leaseId }`
- `OffscreenBlobList`

Every request and reply is exact and tagged. Byte arrays contain only integers
from 0 through 255 and never exceed 256 KiB. The offscreen document stores Blob
parts by lease id. It exposes no downloads API and accepts only internal
extension senders without a tab.

## Terminal and boot

On browser `complete` or final `interrupted`:

1. Find the exact active lease by download id.
2. Revoke/discard its offscreen Blob.
3. Remove the durable lease.
4. Close the offscreen document only when the durable store is empty.

The whole release is serialized with staging. It is idempotent. A transient
revoke failure retains the lease. If the offscreen document is absent, its Blob
URLs are already gone; remove the leases without recreating it.

Boot loads the lease store and probes each active download id:

- in progress or search error: retain;
- complete, interrupted, deleted, or missing: release;
- ready: resolve by exact Blob URL; retain ambiguity.
- building/staging: discard; it is provably pre-handoff.
- legacy building: retain and trace as ambiguous.

## Permission policy

Chrome requires `permissions.request()` inside a user gesture. Popup and Options
therefore request `offscreen` and CDN origins before writing Fetched mode. Denial
keeps the prior mode and shows a failure notice.

The worker only checks `permissions.contains()`. Missing access fails with:

`Fetched access is missing. Select Fetched again.`

It never opens a permission prompt and never silently falls back to Direct.

## Rejected designs

- **Revoke after `downloads.download()` resolves:** start is not terminal.
- **Per-batch refcounts:** they cannot coordinate one shared offscreen document.
- **One process counter:** it is lost on worker recycle.
- **One 15 MiB number-array message:** legal near the 64 MiB wire cap but wastes
  far more heap before serialization.
- **`arrayBuffer()` then check:** a lying or absent length bypasses the cap.
- **Auto-revoke ambiguous building leases:** may abort a download whose id reply
  died with the worker.

## Verification

- One gateway and one document across concurrent Download requests.
- Acquire while terminal close waits never closes the new lease.
- URL remains through start and releases once on complete/interrupted.
- Failed pre-handoff checkpoints discard the lease; a returned id is never retried.
- A failed active write retains `ready`; terminal release and boot both recover
  that gap by exact Blob URL, without retrying Chrome or wedging the lane.
- Unknown and lying bodies stop at 15 MiB plus one chunk; reader is cancelled.
- Runtime chunks stay at or below 256 KiB and reject invalid bytes/keys/tags.
- Global staging concurrency never exceeds one.
- Boot retains active/search-error/ambiguous leases, resolves `ready`, clears
  safe staging rows, and releases terminals.
- Missing offscreen document makes release a safe durable cleanup.
- Popup and Options request access before the Settings write; denial preserves
  the prior mode.
- Full gates and live Chrome proof: small Fetched save, cap failure, concurrent
  batches, terminal release, and worker restart.

## Primary references

- [Chrome downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
- [Chrome offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)
- [Chrome permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)
- [Extension service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
