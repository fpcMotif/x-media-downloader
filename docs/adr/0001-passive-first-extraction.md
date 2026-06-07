# ADR-0001 — Passive-first extraction with opt-in authenticated fallback

- **Status:** Accepted (2026-06-07)

## Context

We must obtain X Media Item URLs without scraping or violating X's ToS. In
Manifest V3, `webRequest`/`declarativeNetRequest` **cannot read response bodies**
(grounding §c), so the network layer can't hand us X's GraphQL JSON. X's official
API is key-gated, rate-limited, and paid. We want minimal permissions and a clean
policy posture, while still letting power users reach media that isn't loaded yet.

## Decision

The **default** path is **Passive capture**: a `world:"MAIN"` content script at
`document_start` tees X's *own* `fetch`/`XHR` JSON and reads the rendered DOM,
issuing **no** extra requests. Bulk is scoped to a **Tweet + Thread**.

An **Auth fallback** (opt-in, default **off**) may replay **one** authenticated
request to reach Media Items not yet loaded. It never enumerates a profile's
media tab.

## Consequences

- Clean policy posture; the default install needs no `cookies`/`webRequest` and
  only `x.com`/`twitter.com` host access for the tee.
- Bulk is limited to what the user has actually loaded — unless they opt into the
  fallback.
- The fallback carries maintenance cost (bearer / csrf / `x-client-transaction-id`
  upkeep) and is isolated behind a flag so the passive path stays simple.

## Alternatives considered

- **Read bodies via `webRequest`** — impossible in MV3.
- **Official X API** — keys, cost, ToS friction; defeats "local, no-account".
- **Aggressive GraphQL enumeration** — strong scraping/ban risk; rejected.
