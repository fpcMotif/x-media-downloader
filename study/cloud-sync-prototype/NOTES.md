# Prototype — Cloud Destinations sync state machine

**Throwaway.** Answers one question, then gets deleted or its `machine.ts` lifted into the real core.

## Question

Does the Convex Link Catalog + Cloud Destinations sync model
([spec](../../docs/superpowers/specs/2026-06-14-convex-cloud-backup-design.md),
ADR-0011/0012/0013) *feel right* when pushed through the cases that look fine on paper
but bite in practice?

Specifically:
- **Flexible trigger** — a master `cloudSync` gate (OFF by default), plus `syncTrigger`
  ∈ {`onDownload`, `onDemand`, `both`}. A finished download only auto-syncs when the trigger
  opts in; the on-demand **Back up** button is an explicit intent and always works while sync is
  on. The local download path is never blocked or altered.
- **Durable local:sync-queue** — a capture lands in a durable buffer first; only `flush`
  (= the single extension-facing `syncItems` write) turns it into catalog + jobs. The queue
  survives an MV3 service-worker recycle.
- **Idempotency** — re-capturing the same media, and re-enqueueing the same `(mediaId, provider)`,
  must not create duplicate catalog rows or jobs.
- **Presign everything** (§9 Resolved #1) — bytes never touch Convex; every job streams
  extension→cloud against a presigned target. There is no `pipe`/`presign` split anymore.
- **Lease / no double-fire** — a `running` job with a live lease cannot be claimed again; a job
  whose lease expired *can* be reclaimed (crash/recycle recovery).
- **"Saved" means landed** — success is only set after an out-of-band HEAD verify. A provider that
  reports OK but has no object (the `liar`) must end `failed`, never `succeeded`.
- **Honest link-rot** — a 403 from twimg (`expired` source) ends the job `skipped/sourceGone`,
  never a fake save.
- **Retry / backoff / dead** — transient failures back off exponentially and reach `dead` after
  `MAX_ATTEMPTS`.

## Run

```
bun run proto:cloud-sync       # or: bun study/cloud-sync-prototype/tui.ts
```

## How to drive it (suggested tour)

1. Start: `cloudSync=OFF`. `[d]` download → "ignored; download untouched". Press `[s]` to enable.
2. **Trigger feel** — `[m]` set `trigger=onDemand`. `[d]` download an item → it does **not** queue
   ("press [b] to back up"). `[b]` backup-now → it lands in `local:sync-queue`. Set `[m]` to
   `onDownload` and `[d]` → now it auto-queues. (`both` = either path.)
3. **Flush** — `[F]` drains the queue → `syncItems`: catalog upsert + one job per enabled
   destination (s3, r2). `[5-8]` toggle destinations first to change the fan-out.
4. **Idempotency** — `[b]` the focused item again, `[F]` again → catalog no-op + jobs deduped.
5. **Retry** — r2 defaults to `flaky`: `[A]` auto-step → r2's first attempt fails with backoff,
   s3 lands. `[t]` ticks +60s → `[A]` again → r2 lands → catalog rolls up to `safe`.
6. **Lease** — `[c]` claim a job (leave it `running`), `[f]` double-fire → REFUSED (lease held).
   `[k]` recycle the SW → the lease is released, queue intact → the job is reclaimable.
7. **Landed ≠ started** — `[1-4]` set a provider to `liar` → `[A]` → `failed` (HEAD verify caught
   the false success), never `succeeded`.
8. **Link-rot** — `[x]` mark the focused item's source `expired` → run → `skipped/sourceGone`.
9. **Dead** — set a provider `down`, step + tick repeatedly → it reaches `dead` at attempt 5.

## Where the keepable half goes

`machine.ts` is pure (no I/O) and is the liftable artifact → real home `src/core/sync/` (the
capture seam + durable queue + job ledger + lease/verify). `tui.ts` is the disposable shell —
delete it. Reconcile this job model with Phase-1's `media_state`/`sync_events` + Outbox when
Phase 1 lands (the spec's open reconciliation).

## Verdict (2026-06-14, validated via scenario sweep — confirm by hand before lifting)

**The model holds, including the flexible trigger the user asked for.** Sweep results:
- master gate OFF → download ignored, path untouched;
- `onDownload` auto-queues, `onDemand` skips the download but the button queues, `both` = either;
- `flush` = `syncItems` → +catalog, +one job per enabled destination;
- flaky → retry+backoff → land → rollup `safe`;
- re-capture + re-flush → +0 catalog, +0 jobs (idempotent);
- recycle mid-flight → lease released, queue + catalog/jobs intact (nothing lost);
- `liar`/`down` → `dead`; `expired` source → `sourceGone`. All as expected.

**Bug the earlier prototype surfaced (kept fixed):** `isClaimable` originally allowed only
`pending`/`failed`, so a `running` job whose **lease expired** could never be reclaimed — a job
crashed mid-upload would wedge forever. Fix: a `running` job is claimable again once
`leaseUntil <= now` (crash/recycle recovery), but never while the lease is live. Exactly the
"looks fine on paper" gap prototyping is for — and now exercised directly by `[k]` recycle.

**Changed since the first pass (to match the resolved spec):**
- Dropped the `pipe`/`presign` byte-mode split → **presign everything** (§9 Resolved #1).
- Added the master gate + `syncTrigger` seam (the user's "more flexible — on demand + backup
  button too" correction).
- Added the durable `local:sync-queue` + `flush(syncItems)` + SW `recycle`, so durability is
  something you can *feel*, not just assert.

Decisions confirmed for implementation:
- [x] flexible trigger reads naturally; on-demand button is independent of the auto setting
- [x] durable queue → single `syncItems` flush is a clean seam; survives recycle
- [x] idempotency key = `${mediaId}:${provider}`
- [x] lease + out-of-band verify are sufficient — no false "saved"; lease must cover crash-reclaim
- [x] `sourceGone` vs `failed` is a clean, honest distinction in the rollup

Open for the real build (not a prototype concern): wire the lease/verify into Convex's
`running`-lease compare-and-set + `HeadObject`; the presigned-POST policy + SSRF guard (§5.3);
reconcile this job model with Phase-1 `media_state`.
