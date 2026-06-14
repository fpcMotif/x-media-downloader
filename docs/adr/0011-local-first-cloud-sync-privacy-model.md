# ADR-0011 — Local-first privacy model for optional cloud sync

- **Status:** Proposed (2026-06-14)

## Context

PRODUCT.md positions the extension as *"a **local-only** Chrome extension … without handing their
account data or media URLs to a remote downloader"*, with principles *"Keep privacy visible through
restraint: local-only, minimal permissions, no telemetry."* CONTEXT.md adds that the project
*"never uses the official [X] API"* and is passive/policy-safe.

The requested feature — syncing original media links into Convex and copying media to the user's
clouds — is, by construction, **not local-only**: links (and for some media, bytes) leave the
device for a remote backend and third-party providers. Shipping it under an unqualified "local-only"
promise would be dishonest. The security and product critics both flagged that the disclosure, as
first drafted, understated the data flow (Convex *egresses bytes* to a third party in pipe mode) and
that catalog metadata (`handle + tweetId + timestamps` per saved item) is a de-anonymizing
behavioral profile, not "modest."

## Decision

- **Reframe the promise** from *"local-only"* to **"local-first; optional, user-controlled cloud
  sync, off by default."** The default install behaves exactly as today; nothing leaves the device
  until the user opts in.
- **Layered, honest consent.** A master `cloudSyncEnabled` toggle gates the feature behind a
  prominent, plain-language data-flow disclosure. **Each destination connection is its own consent
  gate** with provider-specific copy: what is sent (bytes, not just links), where it lands, under
  whose account/terms, what scope was granted, and that **already-uploaded objects are not removed
  by disconnect.** Enabling sync is not consent to send media to a specific provider.
- **No vendor-hosted default.** `cloudConvexUrl` ships empty; the user pastes their own deployment.
  A hosted-by-vendor Convex must never masquerade as "your own backend"; if ever offered it needs
  its own distinct, louder disclosure.
- **Catalog metadata is sensitive.** Minimize stored fields, default a TTL on catalog rows, and
  disclose that a saved-media catalog (who/when) is retained server-side. Do not ship copy calling
  this "modest."
- **User owns deletion.** A visible "Disconnect & wipe" (`deleteMyData`) purges
  catalog/jobs/connections; provider grants are revoked *before* the row is deleted, and a failed
  revoke is surfaced as `revoke-failed` rather than reported as clean success.
- **No telemetry.** No analytics tables; the catalog is opt-in cargo the user explicitly chose.

## Consequences

- The marketing/store copy and any in-product privacy text must change in lockstep with the build;
  the disclosure UI is load-bearing, not decoration.
- The feature can be trustworthy, but only if the per-destination consent gate and the
  metadata-sensitivity treatment ship *with* the first connectable provider — not later.
- A self-hosted, single-user deployment is the cleanest fit for the promise; multi-tenant hosting
  raises the bar (see ADR-0013 auth tiers).

## Alternatives considered

- **Keep "local-only" absolute; gate sync behind a separate build/flavor.** Cleanest for the
  promise, but fragments the product and the user explicitly asked for sync in the main extension.
  Rejected in favor of the local-first reframe + opt-in.
- **Single global consent (enabling sync = consent for all providers).** Rejected: connecting a
  destination is the irreversible privacy event and needs its own gate.
- **Treat catalog metadata as low-sensitivity public URLs.** Rejected: it is a behavioral profile,
  and protected-account media URLs are not reliably public.
