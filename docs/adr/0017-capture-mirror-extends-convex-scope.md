# ADR-0017 — Capture mirror extends the Convex scope to tweet text

- **Status:** Accepted (2026-06-27)
- **Extends:** [ADR-0009](0009-convex-cloud-control-plane.md) (Convex as an opt-in
  cloud control plane — *metadata only, never bytes*). This ADR is the deliberate,
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
text is *content*, not media provenance. Mirroring it therefore puts content into
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

1. **Scope extension (bounded).** The capture mirror may carry tweet **text**, the
   conversation/reply tree, and **link/quote metadata** (the harvested `TweetRecord`).
   Everything else stays excluded as before: **never media bytes, never media captures
   (the sidecar `data:` URLs / screenshots), never auth headers or tokens.** The bound
   is the `tweet_captures` row shape — there is no field for bytes, captures, or auth.

2. **Its own opt-in (`captureMirrorEnabled`, default OFF).** Mirroring rides a
   dedicated toggle, independent of media `cloudSyncEnabled`. Enabling media cloud sync
   never mirrors tweet text, and enabling the capture mirror never changes the media
   posture. Both default OFF.

3. **Local capture never implies mirroring.** `captureEnabled` (local harvest) and
   `captureMirrorEnabled` (Convex mirror) are separate gates. Harvesting to the local
   store sends nothing to Convex until the mirror is also explicitly enabled.

4. **The whole feature is default OFF.** With `captureEnabled=false` nothing is
   harvested, stored, or mirrored. The local-only product promise holds for any user
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
  is content. A user must turn on capture *and* its mirror to put any of it in Convex;
  the default-OFF master gate keeps the pipeline dormant otherwise.
- **The "never media bytes through Convex" claim is unchanged.** This extension touches
  text, not media; ADR-0009's and ADR-0013's byte posture is untouched.
- **Honest disclosure required.** Any UI that says "metadata only" while the capture
  mirror is enabled would overstate the posture; the settings copy distinguishes the
  media mirror from the capture mirror.
