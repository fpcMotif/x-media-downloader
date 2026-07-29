# ADR-0003 — Dual Download Strategy: Direct default, Fetched opt-in

- **Status:** Accepted (2026-06-07)

## Context

The Resolver already yields **Original-quality** URLs, so download quality does
not depend on how bytes reach disk. Two strategies exist:

- **Direct** — hand the URL to `chrome.downloads.download()`. The browser fetches
  it (cookies attached, page-CORS bypassed). Needs only the `downloads` permission.
- **Fetched** — `fetch()` the bytes in the SW, require an allowed response
  `Content-Type`, and enforce a 15 MiB limit. It does not hash or inspect file
  bytes. The SW alone calls `chrome.downloads.download()`. An **offscreen
  document** (the `offscreen` permission) turns bounded chunks into a Blob URL;
  it supports only `chrome.runtime`.

## Decision

Ship **both** in v1 behind a `Download Strategy` seam. **Direct is the default**.
The bounded Capture exporter also needs the offscreen Blob sink, so `offscreen`
is required. **Fetched is opt-in**: flipping the toggle requests only the CDN
origins at runtime and routes bytes through the shared offscreen document.

Fetched accepts at most 15 MiB raw bytes. The worker streams the body through a
single gateway in chunks no larger than 256 KiB. A session-scoped durable lease
survives service-worker recycle and holds each Blob URL until Chrome reports
`complete` or final `interrupted`; browser restart clears session storage, while
the local Transfer Registry survives it. Boot reconciles typed owners and exact
browser handles and retains ambiguous hand-offs. Fetched rejects
a declared or streamed over-cap body with: `Fetched supports files up to 15 MiB.
Choose Direct for this file.` It never silently changes strategy. UI surfaces
request optional access inside a user gesture; the worker only checks it.

## Consequences

- Default install includes `offscreen` for bounded Capture exports, but no CDN
  host warning.
- Bulk Capture archives split between JSONL records into independently valid
  15 MiB parts. The gateway retains at most four live parts; later parts wait for
  terminal cleanup, so the working-set bound does not cap archive size.
- Fetched adds real complexity (offscreen doc + byte shuffling) but only when a
  user opts in to response-type checking and bounded byte staging.
- Fetched GETs use Media Fetch: exact-CDN validation, the gateway AbortSignal,
  and redirect rejection. Direct hands a validated initial URL to Chrome; Chrome
  owns any later redirect.
- Registry `fetched-prepared` is inert intent. Its durable admission permit
  produces Registry `ready`. Gateway Blob Lease `ready` is a distinct
  post-finalize checkpoint. The path is:
  `Registry fetched-prepared → Registry ready → lease reserved/staging → stream → lease ready → SW download → lease active`.
  Header/idle staging is capped at 25 seconds and total staging at four minutes.
  Terminal state revokes, then closes only when the durable lease store is empty.
- Presence uses `runtime.getContexts()` on Chrome 116+ and the service worker's
  `clients.matchAll()` on Chrome 109–115. `offscreen.hasDocument()` is not used.
- Manifest declares `offscreen` as required and CDN origins as optional.

## Alternatives considered

- **Direct only** — no response-type check or extension-managed byte staging.
- **Fetched only** — forces offscreen + CDN permissions on every user.
- **base64 data-URI** instead of offscreen — ~64 MB cap, memory-heavy for video.
