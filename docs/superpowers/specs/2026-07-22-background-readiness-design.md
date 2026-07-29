# Background readiness fault domains

**Date:** 2026-07-22
**Status:** Implemented

## Failure

Before this change, one global `bootReady` gated every alarm, download event,
and message. A corrupt Transfer Registry therefore blocked settings, Capture,
history, cloud, and every UI surface. A transfer-owned corrupt record must fail
transfers closed; it must not brick unrelated features.

## Readiness graph

```text
baseReady
  ├─ fetchedReady ──┐
  │                 ├─ transferReady ── clearReady
  └─ cloudReady
```

- **baseReady:** trusted-context storage access, best-effort saved-index seed,
  and non-destructive Clear Worklist projection replay.
- **fetchedReady:** inspect/reconcile the Fetched lease store. It returns an
  available or unavailable result; it does not reject global startup.
- **transferReady:** decode/migrate the Transfer Registry, consume Fetched
  recovery evidence, restore telemetry correlation, and re-arm transfer wakes.
  Corruption is retained read-only and reported as unavailable.
- **clearReady:** only after transfer recovery. Open/migrate `xmd-clear`, restore
  exact handle ownership, reconcile the Completion Ledger, complete any startup
  claim, then adopt external state. If transfer truth is unavailable,
  destructive Clear remains fail-closed.
- **cloudReady:** resume cloud owners. Failure is traced within this domain.

Settings watches register synchronously with the other MV3 listeners. Their
effects wait for `baseReady`; Settings reads and writes also route through
`baseReady`. There is no separate Settings boot owner.

No readiness promise is silently ignored. Each domain resolves to a typed
available/unavailable state or catches and traces its own failure.

## Retry ownership

One global one-shot alarm owns autonomous readiness recovery. Any initially
retryable domain arms it. When it fires, it retries every domain; the readiness
graph deduplicates shared prerequisites. It rearms while any domain remains
retryable. Permanent failure does not loop. This alarm never runs a business
wake.

Each business alarm owns a distinct one-shot retry alarm. If readiness blocks
the consumed event, or its wake fails, that retry alarm retains the event. It
retries the exact domain, then the exact wake. It rearms until both succeed, but
stops on permanent readiness failure. Alarm names have one owner.

An observed browser startup is also retained. Successful Clear recovery consumes
it before any Clear-owned wake. A failed startup wake uses the global alarm for
another bounded attempt.

## Routing

| Event or message                                 | Required domain                                     |
| ------------------------------------------------ | --------------------------------------------------- |
| settings, budget, metrics, history, saved status | base                                                |
| Capture write/summary/clear                      | base                                                |
| Capture export                                   | fetched                                             |
| media DownloadRequest                            | transfer                                            |
| transfer alarm                                   | transfer                                            |
| download terminal                                | fetched Capture cleanup, then transfer if available |
| Clear sweep/visibility/safety/startup            | clear                                               |
| Clear Worklist projection alarm                  | base                                                |
| sync/capture/cloud alarms                        | their owner only                                    |
| cloud connect/status/retry/backfill              | cloud owner, not transfer                           |

The message router selects readiness by tag. It never awaits one blanket
barrier. An unavailable domain returns an explicit stable failure reply.

## Safety

- Registry failure never resets or overwrites its store.
- Clear reconciliation never runs without registry ownership. Otherwise a
  missing retry set could clear a still-running post.
- Worklist projection replay may run at base readiness. It only reads the Clear
  outbox, writes tracked Worklist scopes, and exact-acks. It never adopts a
  session, probes transfers, reads policy, locates a tab, or drives Clear.
- Transfer-owned Fetched leases stay intact while registry truth is unavailable.
- Capture-owned terminal leases may release through the gateway without the
  registry.
- Direct/UI/Capture remain usable when Fetched is corrupt. Fetched starts fail
  closed.
- Listeners still register synchronously before asynchronous boot starts.

## Proof

- corrupt registry: Settings read/update, budget, metrics, history, Capture,
  sync/capture alarms still work; Download returns transfer unavailable;
- Clear reconcile, safety wake, and startup do not run under registry failure;
- Clear Worklist projections still replay under registry failure;
- corrupt Fetched store: Direct works; Fetched and Capture export report
  unavailable; unrelated handlers work;
- terminal Capture lease releases while registry is unavailable;
- terminal transfer lease remains while registry is unavailable;
- failures in cloud do not block transfer or local UI;
- each alarm awaits only its owner;
- retryable boot recovers without waiting for another business event;
- readiness recovery never invents or duplicates a business wake.
