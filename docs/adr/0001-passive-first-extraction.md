# ADR-0001 — Passive-first extraction

- **Status:** Accepted (2026-06-07)

## Context

We must obtain X Media Item URLs without scraping or violating X's ToS. In
Manifest V3, `webRequest`/`declarativeNetRequest` **cannot read response bodies**
(grounding §c), so the network layer can't hand us X's GraphQL JSON. X's official
API is key-gated, rate-limited, and paid. We want minimal permissions and a clean
policy posture.

## Decision

The path is **Passive capture**: a `world:"MAIN"` content script at
`document_start` tees the platform's own `fetch`/`XHR` JSON and reads the rendered
DOM, issuing **no** extra requests. Bulk is scoped to a Post or X Thread.

The tee retains at most **8 MiB UTF-8** per response. It checks a trustworthy
`Content-Length` first, then caps streamed fetch clones and XHR text before
emitting. It drops malformed, non-text, or oversized bodies. The page retains
the original fetch `Response` and all native XHR behavior.

X video recovery is separately governed by ADR-0015. It makes one bounded,
unauthenticated request to X's public syndication endpoint only for visibly mounted,
tee-missed video.

## Consequences

- Clean policy posture; passive detection needs no `cookies` or `webRequest`.
- Bulk is limited to media the user has loaded. ADR-0015's recovery is the narrow
  X-video exception.

## Alternatives considered

- **Read bodies via `webRequest`** — impossible in MV3.
- **Official X API** — keys, cost, ToS friction; defeats "local, no-account".
- **Aggressive GraphQL enumeration** — strong scraping/ban risk; rejected.
