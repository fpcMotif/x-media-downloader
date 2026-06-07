# ADR-0003 — Dual Download Strategy: Direct default, Fetched opt-in

- **Status:** Accepted (2026-06-07)

## Context

The Resolver already yields **Original-quality** URLs, so download quality does
not depend on how bytes reach disk. Two strategies exist:

- **Direct** — hand the URL to `chrome.downloads.download()`. The browser fetches
  it (cookies attached, page-CORS bypassed). Needs only the `downloads` permission.
- **Fetched** — `fetch()` the bytes in the SW to verify content-type / hash /
  repackage. Requires twimg CDN `host_permissions`, **and** — because an MV3
  service worker has no `URL.createObjectURL` — an **offscreen document** (the
  `offscreen` permission) to turn the blob into a downloadable URL (grounding;
  verified against Chrome docs).

## Decision

Ship **both** in v1 behind a `Download Strategy` seam. **Direct is the default**
(lean install: `downloads` + `x.com`/`twitter.com` only). **Fetched is opt-in**:
flipping the toggle requests `offscreen` + twimg CDN via **optional** permissions
at runtime and routes bytes through an offscreen document.

## Consequences

- Default install stays minimal — no offscreen, no CDN host warning.
- Fetched adds real complexity (offscreen doc + byte shuffling) but only when a
  user opts in to byte-verify/repackage.
- Manifest must declare twimg CDN + `offscreen` as **optional** permissions.

## Alternatives considered

- **Direct only** — no byte inspection/repackage ever.
- **Fetched only** — forces offscreen + CDN permissions on every user.
- **base64 data-URI** instead of offscreen — ~64 MB cap, memory-heavy for video.
