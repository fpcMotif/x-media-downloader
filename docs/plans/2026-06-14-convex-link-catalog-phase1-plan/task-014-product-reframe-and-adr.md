# Task 014 — PRODUCT.md local-first reframe + ADR-0013

- **type:** docs
- **depends-on:** []
- **files:** `PRODUCT.md` (modify), `docs/adr/0013-server-side-cloud-destinations.md` (new)

## Objective

(a) Reframe `PRODUCT.md` from the current "local-only" promise to **"local-first; optional,
user-controlled cloud sync, off by default,"** per ADR-0011 — without overclaiming (catalog metadata
is sensitive; off by default; default install unchanged). (b) **Finalize ADR-0013** — it already
exists on disk as *Status: Proposed*; promote it to *Accepted* and confirm it records the byte-path
(presign-everything; bytes never touch Convex), provider phasing, and the iCloud-dropped decision.

This task is independent and can land at any point.

## BDD Scenario

```gherkin
Scenario: PRODUCT.md is reframed local-first
  Given PRODUCT.md currently promises "local-only"
  When the reframe lands
  Then it states "local-first; optional, user-controlled cloud sync, off by default"
  And it references ADR-0011

Scenario: ADR-0013 is finalized
  Given docs/adr/0013-server-side-cloud-destinations.md exists as Status: Proposed
  When the decision is ratified
  Then its Status is Accepted
  And it records presign-everything, provider phasing, and iCloud dropped
```

## Steps

1. Edit `PRODUCT.md`: replace the local-only language with the local-first framing; keep the
   restraint/minimal-permissions promise; note sync is opt-in and off by default.
2. Promote `docs/adr/0013-server-side-cloud-destinations.md` from *Proposed* to *Accepted*; confirm
   it covers: presign everything, credentials live in Convex only, provider phasing
   (R2/S3 → Dropbox → Google Photos), iCloud dropped (no public API). Add anything missing.

## Verification

- `rg -n "local-first" PRODUCT.md` and `rg -n "ADR-0011" PRODUCT.md` both match.
- `rg -n "Accepted" docs/adr/0013-server-side-cloud-destinations.md` matches, and the ADR records
  presign-everything + phasing + iCloud-dropped.
