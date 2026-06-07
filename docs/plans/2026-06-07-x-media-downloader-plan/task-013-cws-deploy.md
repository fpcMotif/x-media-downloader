# Task 013 — Chrome Web Store deploy prerequisites

**type:** config
**depends-on:** ["012-wire-e2e-impl"]

> Follows docs/research/2026-06-07-grounding.md §9.15. Required even though the
> extension is local-only and ships no telemetry.

## Steps

1. Write a privacy policy (local-only, no data collection, no remote code) and
   host it at a public URL.
2. Complete the CWS **Privacy Practices** tab + **Limited Use** certification;
   justify each permission (`downloads`, `storage`, host perms).
3. Single-purpose listing: "Download X (Twitter) media you can view, at original
   quality. Local-only, no scraping." Generic name/icon (no X marks) for
   IP/impersonation review.
4. `wxt zip` to produce the upload artifact.

## Verification

- `wxt zip` produces a valid MV3 package; manifest permissions match the grounding doc.
- Listing draft passes the Privacy Practices + single-purpose self-check.
