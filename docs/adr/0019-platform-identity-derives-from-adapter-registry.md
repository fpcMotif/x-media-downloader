# ADR-0019 — Platform identity derives from a data-only catalog

- **Status:** Accepted (2026-07-05); amended (2026-07-28)
- **Builds on:** the multi-platform Source Adapter design
  (`docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md`).

## Context

Platform page origins and CDN hosts once had several owners: WXT config, sender
authorization, tab fan-out, Popup gates, and Source Adapters. They drifted. One
drift blocked all Instagram and Threads content-script messages. Another made
Terminal Outcome correction query X tabs only.

The first fix made the behavior registry (`ALL_ADAPTERS`) the source of every
platform fact. That removed duplicate lists but crossed a worse context seam:
WXT config, the background worker, offscreen, and Popup imported a registry whose
transitive closure contained every response parser and DOM adapter. The old ADR
claimed that closure had no browser globals. Production bundles disproved it.

Platform identity and platform behavior have different consumers. They need
different modules.

## Decision

`src/core/adapters/catalog.ts` is the sole platform identity module. Each
`PlatformDescriptor` contains:

- platform tag;
- HTTPS page match patterns;
- CDN host rules;
- an exact, pure URL matcher.

`PLATFORM_CATALOG` registers X, Instagram, and Threads descriptors. It owns all
host and CDN lists. Its runtime import closure contains no behavior adapter or
DOM global.

`src/core/adapters/registry.ts` is content behavior only. Each
`PlatformAdapter` is composed from one descriptor and adds response admission,
response parsing, DOM detection, hover resolution, and optional Recovery. The
behavior map is exhaustive over
the `Platform` union and ordered by `PLATFORM_CATALOG`.

Imports follow the execution context:

- WXT config, sender authorization, media URL policy, Fetched permissions, tab
  fan-out, Popup, and Options use the catalog.
- MAIN-world tee and ISOLATED overlay use the behavior registry. Their manifest
  matches still come from the catalog.
- No non-content module imports the behavior registry.

Clear remains explicitly X-only through `adapter.platform === 'x'`. A capability
field would describe one implementation, so it has not earned a seam.

## Verification

- Catalog tests pin page, origin, and CDN derivations.
- A runtime-import closure test proves `catalog.ts` does not load behavior or DOM
  modules.
- A consumer test rejects behavior-registry imports from non-content contexts.
- A production-build test discovers emitted chunks from the manifest and HTML.
  It proves worker, Popup, and offscreen closures exclude platform DOM behavior.
  Chunk hashes are never pinned.
- Registry tests prove each behavior adapter's identity fields come from its
  catalog descriptor.

## Consequences

- Adding a platform requires one descriptor and one behavior adapter entry.
  Type checking and registry tests reject a missing behavior entry.
- Host and CDN facts still have one owner. Manifest permissions, sender
  authorization, tab queries, URL policy, and optional permissions derive from
  the catalog.
- Content-script matches, required page permissions, sender origins, URL
  matching, and tab queries share one HTTPS-only reachability rule.
- Non-content bundles no longer carry platform DOM parsers.
- Content hot paths still select one behavior adapter at boot and close over it.

## Alternatives considered

- **Keep the behavior registry as the universal source.** Rejected. It couples
  Node, worker, offscreen, and UI contexts to DOM behavior and bloats their
  bundles.
- **Copy descriptor facts into a second registry.** Rejected. It restores the
  drift this ADR exists to prevent.
- **Add capability flags now.** Rejected. One Clear implementation is not a real
  adapter seam.
