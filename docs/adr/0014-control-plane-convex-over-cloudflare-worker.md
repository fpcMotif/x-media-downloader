# ADR-0014 — Cloud control plane is Convex, not a Cloudflare Worker + D1

- **Status:** Accepted (2026-06-14)

## Context

During the parallel build of the cloud-destinations byte layer, the effort forked into two
incompatible backend architectures for the *same* job (orchestrating media uploads to the user's
clouds):

1. **Convex control plane** — the documented and shipped direction. Phase-1 metadata mirror is
   already landed on `main` (`sync_events`/`media_state` + Outbox, `src/core/sync/{events,outbox,convex}.ts`),
   ADR-0009 (`convex-cloud-control-plane`), and the whole `2026-06-14-cloud-destinations-plan` (presign
   everything, `cloudConnections`/`uploadJobs`, server-side signing, `HeadObject` verify).
2. **Cloudflare Worker + D1** — an alternative that emerged on `claude/cloud-item-tracking-r2-cache`
   and `claude/affectionate-planck-k58s6r`. It **deletes** the Convex backend (`backend/convex/*`,
   `src/core/sync/{convex,events,outbox}.ts`) and replaces it with `worker/src/index.ts` +
   `worker/schema.sql` (D1) + `worker/wrangler.toml` and a REST `/jobs/:id` API, with extension code
   re-pointed at `src/core/cloud/` talking to the Worker.

These cannot coexist. Left unresolved, the swarm would keep building two backends, and the second
would keep deleting the first's shipped mirror.

## Decision

**The cloud control plane is Convex.** This reaffirms ADR-0009 and keeps the shipped Phase-1 mirror as
the foundation. The Cloudflare Worker + D1 approach is **rejected as an abandoned experiment**:

- Do **not** continue `worker/`-based work. Branches `claude/cloud-item-tracking-r2-cache` and
  `claude/affectionate-planck-k58s6r` are not to be merged; their `worker/` + `src/core/cloud/`
  (Worker client) code is superseded by the Convex plan.
- All cloud-destinations work proceeds against `backend/convex/` + the `src/core/cloud/` module as
  defined in `A0-reconciliation.md` and the cloud-destinations plan (reuse `media_state`, add
  `cloudConnections` + `uploadJobs`, presign everything, identity Option B).

Rationale: the metadata mirror is already shipped on `main` and is the catalog the user asked for;
ADR-0009's "metadata only, never bytes" model and the reactive popup status both lean on Convex;
re-platforming onto a Worker + D1 throws away shipped, tested code for no decided product gain. If a
Worker is ever wanted, it would be a *destination/edge helper*, not a replacement control plane —
that is a future ADR, not this fork.

## Consequences

- The `worker/` branches are dead-ends; their useful ideas (item-level outcome tracking, `/jobs/:id`
  cleanup) should be re-expressed as Convex `uploadJobs` semantics if needed, not as a separate D1 API.
- `feat/convex-cloud-destinations` still needs the A0 blocking rebase onto `main` (`bbdad24`) before
  the byte layer can build on `backend/` + `src/core/sync/`.
- No code is moved or deleted by this ADR; it records the direction so parallel agents converge.
- The pure, backend-agnostic extension work (A4 SSRF guard on `feat/ssrf-guard`; the validated
  sync state-machine in `study/cloud-sync-prototype/`) survives regardless and can land on Convex.
