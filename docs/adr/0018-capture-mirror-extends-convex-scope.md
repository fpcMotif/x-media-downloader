# ADR-0018 — Capture mirror extends the Convex scope to tweet text

- **Status:** Accepted (2026-06-27)
- **Extends:** [ADR-0009](0009-convex-cloud-control-plane.md) (Convex as an opt-in
  cloud control plane — _metadata only, never bytes_). This ADR is the deliberate,
  bounded widening of that scope.
- **Spec:** Tweet Harvest "Capture" design, §11 (Privacy & posture),
  `docs/superpowers/specs/2026-06-27-tweet-harvest-capture-design.md`.

## Context

ADR-0009 established a hard posture for the Convex sidecar: it mirrors **media
download metadata only — never bytes, captures, or auth**. That wording is stated
in three places — the `core/sync/events.ts` header, the `cloudSyncEnabled` comment
in `core/schema/index.ts`, and ADR-0009 itself — and it is enforced structurally by
the `SyncEvent` schema (CDN URLs + tweet/handle/type provenance only; `data:`
captures and auth headers have no field to land in).

The Tweet Harvest "Capture" feature harvests tweet **text** (and the thread/reply
tree, plus link/quote metadata) off the GraphQL tee into a local store, with an
**opt-in Convex mirror** (`recordCaptures` mutation → `tweet_captures` table). Tweet
text is _content_, not media provenance. Mirroring it therefore puts content into
Convex for the first time and **extends** the documented scope. The original posture
sentence — read literally — would forbid this, so the change must be recorded rather
than silently broadened.

Two things must be true for this to stay honest:

- the extension is **bounded** — text/threads + link metadata only, with media bytes,
  media captures, and auth still structurally and deliberately out; and
- it is **separately consented** — a user enabling media `cloudSyncEnabled` does not
  thereby ship their tweet text to Convex.

## Decision

**Extend the Convex scope to tweet text, behind its own opt-in, with the rest of the
posture unchanged.**

1. **Scope extension (bounded).** The capture mirror carries `tweetId`,
   `conversationId`, optional reply id, handle, expanded text, optional creation time and
   links, source rank, and capture time. It excludes `rawText`, media references,
   quote/retweet ids, media bytes, media captures, auth headers, and tokens. The bound is
   the `tweet_captures` row shape.

2. **Its own opt-in (`captureMirrorEnabled`, default OFF).** Mirroring rides a
   dedicated toggle, independent of media `cloudSyncEnabled`. Enabling media cloud sync
   never mirrors tweet text, and enabling the capture mirror never changes the media
   posture. Both default OFF.

3. **Local capture never implies mirroring.** `captureEnabled` (local harvest) and
   `captureMirrorEnabled` (Convex mirror) are separate gates. Harvesting to the local
   store sends nothing to Convex until the mirror is also explicitly enabled.

   Mirror admission is fixed when the local batch is accepted. Enabling the mirror
   later does not enqueue older local-only batches. Erasing the local Capture Archive
   also purges pending mirror work, but does not delete copies already sent to Convex.

   The local archive is authoritative. It commits records before the admitted outbox
   batch. A worker death or tab teardown in that exact gap leaves local-only records
   and no reply; the live producer retries the idempotent batch. There is no
   retroactive backfill: later consent cannot prove consent for an older local batch.

4. **The whole feature is default OFF.** With `captureEnabled=false` nothing is
   harvested, stored, or mirrored. The local-first, no-telemetry-by-default product
   posture holds for any user
   who does not opt in.

5. **Re-scope the three posture comments to media.** The "metadata only — never bytes,
   captures, or auth" wording in `core/sync/events.ts`, `core/schema/index.ts`
   (`cloudSyncEnabled`), and ADR-0009 is re-read as describing the **media** mirror
   specifically, each pointing here for the tweet-text extension.

## Consequences

- **The posture is now two-scoped, both opt-in.** Media mirror (ADR-0009): metadata
  only, never bytes/captures/auth, gated by `cloudSyncEnabled`. Capture mirror (this
  ADR): tweet text + link metadata, never media bytes/captures/auth, gated by
  `captureMirrorEnabled`. Neither implies the other.
- **Content enters Convex for the first time — by explicit consent only.** Tweet text
  is content. A user must turn on capture _and_ its mirror to put any of it in Convex;
  the default-OFF master gate keeps the pipeline dormant otherwise.
- **The "never media bytes through Convex" claim is unchanged.** This extension touches
  text, not media; ADR-0009's and ADR-0013's byte posture is untouched.
- **Honest disclosure required.** Any UI that says "metadata only" while the capture
  mirror is enabled would overstate the posture; the settings copy distinguishes the
  media mirror from the capture mirror.

## Delivery contract

- Admission is all-or-none. The outbox holds at most 2,000 pending records and 4 MiB.
  It never evicts pending work. `CaptureStored.mirror` is `not-requested`, `accepted`,
  or `unavailable`; `unavailable` still stores locally, then makes the content script
  drop that batch and warn.
- The v2 outbox has an opaque generation. Normal writers reject corruption. Explicit
  Erase may replace corrupt state with a fresh UUID epoch, purge pending work, then erase
  the local archive. Content stamps buffered work with that epoch at intake. The Archive
  rejects stale work before local or mirror writes. Clear broadcasts a wake; live tabs
  pause new stamping and use one-flight canonical pulls with capped retry backoff. A
  terminal stale receipt advances the producer and drops old-epoch work; it never
  relabels it. Sent Convex rows remain.
- Each admitted item binds its normalized deployment. Destination plus event id dedupes.
  Replacement uses source rank, then the record's `capturedAt`; admission time only
  schedules the retry. Thus rich cannot degrade to thin and an old retry cannot become
  newer in the pending or Convex copy.
  A same-URL secret rotation drains with the current secret; device rotation drains with
  the immutable admitted device id. Disable or URL rotation blocks pending work. Legacy
  unbound work remains unsendable. Every remote batch rereads Settings and needs a
  confirmed watchdog. It rereads Settings again after arming that watchdog and before
  mutation. Persisted future retry deadlines rebase to bounded backoff after wall-clock
  rollback. Only eligible work schedules the alarm.
- Backend ingress accepts at most 64 records and 4 MiB of capture rows per request.
