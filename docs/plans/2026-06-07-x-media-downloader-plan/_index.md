# Implementation Plan — X Media Downloader

- **Design:** [../../specs/2026-06-07-x-media-downloader-design.md](../specs/2026-06-07-x-media-downloader-design.md)
- **Date:** 2026-06-07
- **Approach:** Test-first (red→green→refactor) per task. Effect-TS core is framework/chrome-agnostic and unit-tested with test layers; chrome APIs faked via WXT `fakeBrowser`.

> ⚠️ **Authoritative API grounding:** [../../research/2026-06-07-grounding.md](../../research/2026-06-07-grounding.md)
> supersedes any Effect-v3 idioms in these task files. The installed stack is
> **Effect 4.0.0-beta.78** (no `Effect.Service` / `optionalWith` /
> `decodeUnknownEither`; use `Context.Service` + `Layer`, `withDecodingDefaultKey`,
> `decodeUnknownResult`/`SchemaError`) + **WXT 0.20.26**. Follow the grounding doc
> for all API specifics.

## Context

Greenfield MV3 Chrome extension to download X (Twitter) tweet/thread media in
bulk at original quality, with a minimalist in-page + popup UX. Built on WXT +
Bun + Preact + Tailwind v4, with an Effect-TS core. The core (schema, resolver,
adapter, queue, settings, messaging, filename engine) carries the policy-sensitive
and correctness-critical logic, so it is driven test-first against fixtures.
Integration/UI tasks (MAIN-world tee, overlays, popup, wiring) follow once the
core is green.

Policy posture is load-bearing: the default path only reads media URLs from the
page's own teed responses + DOM (no extra requests, no `<all_urls>`/`cookies`).
See design §2.

## Execution Plan

```yaml
tasks:
  - id: "001"
    subject: "Scaffold WXT + Bun + Preact + Tailwind + Vitest + Effect (strict TS)"
    slug: "scaffold"
    type: "setup"
    depends-on: []
  - id: "002"
    subject: "Effect Schema models — MediaItem, Settings, Message (test)"
    slug: "schema-test"
    type: "test"
    depends-on: ["001"]
  - id: "002"
    subject: "Effect Schema models — MediaItem, Settings, Message (impl)"
    slug: "schema-impl"
    type: "impl"
    depends-on: ["002-schema-test"]
  - id: "003"
    subject: "MediaResolver — orig upgrade, max-bitrate variant, dedupe (test)"
    slug: "resolver-test"
    type: "test"
    depends-on: ["002-schema-impl"]
  - id: "003"
    subject: "MediaResolver impl"
    slug: "resolver-impl"
    type: "impl"
    depends-on: ["003-resolver-test"]
  - id: "004"
    subject: "XAdapter.detectMedia over teed JSON + DOM (test)"
    slug: "xadapter-test"
    type: "test"
    depends-on: ["003-resolver-impl"]
  - id: "004"
    subject: "XAdapter impl"
    slug: "xadapter-impl"
    type: "impl"
    depends-on: ["004-xadapter-test"]
  - id: "005"
    subject: "Filename template engine — tokens + sanitization (test)"
    slug: "filename-test"
    type: "test"
    depends-on: ["002-schema-impl"]
  - id: "005"
    subject: "Filename template engine impl"
    slug: "filename-impl"
    type: "impl"
    depends-on: ["005-filename-test"]
  - id: "006"
    subject: "SettingsService over chrome.storage — defaults + validation (test)"
    slug: "settings-test"
    type: "test"
    depends-on: ["002-schema-impl"]
  - id: "006"
    subject: "SettingsService impl"
    slug: "settings-impl"
    type: "impl"
    depends-on: ["006-settings-test"]
  - id: "007"
    subject: "DownloadQueue — semaphore concurrency, retry/backoff, progress (test)"
    slug: "download-queue-test"
    type: "test"
    depends-on: ["005-filename-impl"]
  - id: "007"
    subject: "DownloadQueue impl"
    slug: "download-queue-impl"
    type: "impl"
    depends-on: ["007-download-queue-test"]
  - id: "008"
    subject: "Typed Messaging RPC across contexts (test)"
    slug: "messaging-test"
    type: "test"
    depends-on: ["002-schema-impl"]
  - id: "008"
    subject: "Messaging impl"
    slug: "messaging-impl"
    type: "impl"
    depends-on: ["008-messaging-test"]
  - id: "009"
    subject: "MAIN-world fetch/XHR tee — parse + post (test)"
    slug: "inject-tee-test"
    type: "test"
    depends-on: ["003-resolver-impl"]
  - id: "009"
    subject: "MAIN-world tee impl"
    slug: "inject-tee-impl"
    type: "impl"
    depends-on: ["009-inject-tee-test"]
  - id: "010"
    subject: "Content overlays — Preact hover controls + grab-all pill (impl)"
    slug: "content-overlays-impl"
    type: "impl"
    depends-on: ["004-xadapter-impl", "008-messaging-impl", "009-inject-tee-impl"]
  - id: "011"
    subject: "Popup — queue manager + settings UI (impl)"
    slug: "popup-impl"
    type: "impl"
    depends-on: ["006-settings-impl", "007-download-queue-impl", "008-messaging-impl"]
  - id: "012"
    subject: "Background wiring + load-unpacked smoke + polish (impl)"
    slug: "wire-e2e-impl"
    type: "impl"
    depends-on: ["010-content-overlays-impl", "011-popup-impl"]
  - id: "013"
    subject: "Chrome Web Store deploy prerequisites"
    slug: "cws-deploy"
    type: "config"
    depends-on: ["012-wire-e2e-impl"]
  - id: "014"
    subject: "Download Strategy seam + Fetched (offscreen) path"
    slug: "download-strategy-impl"
    type: "impl"
    depends-on: ["007-download-queue-impl"]
```

## Task File References

- [Task 001: Scaffold](./task-001-scaffold.md)
- [Task 002: Schema (test)](./task-002-schema-test.md) · [Schema (impl)](./task-002-schema-impl.md)
- [Task 003: Resolver (test)](./task-003-resolver-test.md) · [Resolver (impl)](./task-003-resolver-impl.md)
- [Task 004: XAdapter (test)](./task-004-xadapter-test.md) · [XAdapter (impl)](./task-004-xadapter-impl.md)
- [Task 005: Filename (test)](./task-005-filename-test.md) · [Filename (impl)](./task-005-filename-impl.md)
- [Task 006: Settings (test)](./task-006-settings-test.md) · [Settings (impl)](./task-006-settings-impl.md)
- [Task 007: DownloadQueue (test)](./task-007-download-queue-test.md) · [DownloadQueue (impl)](./task-007-download-queue-impl.md)
- [Task 008: Messaging (test)](./task-008-messaging-test.md) · [Messaging (impl)](./task-008-messaging-impl.md)
- [Task 009: Inject tee (test)](./task-009-inject-tee-test.md) · [Inject tee (impl)](./task-009-inject-tee-impl.md)
- [Task 010: Content overlays](./task-010-content-overlays-impl.md)
- [Task 011: Popup](./task-011-popup-impl.md)
- [Task 012: Wire e2e](./task-012-wire-e2e-impl.md)
- [Task 013: CWS deploy](./task-013-cws-deploy.md)
- [Task 014: Download Strategy](./task-014-download-strategy-impl.md)

## BDD Coverage

| Design requirement | Task(s) |
|---|---|
| Photo orig-quality upgrade + fallback chain | 003 |
| Video/GIF max-bitrate variant | 003 |
| Detect media from teed JSON + DOM | 004, 009 |
| Dedupe media | 003 |
| Filename templating + sanitization | 005 |
| Settings persistence + defaults + validation | 006 |
| Rate-limited concurrent downloads + retry | 007 |
| Typed cross-context messaging | 008 |
| Passive MAIN-world tee (no extra requests) | 009 |
| In-page overlays + grab-all (swift UX) | 010 |
| Popup queue manager + settings (manager UX) | 011 |
| End-to-end download of a tweet/thread | 012 |
| Download Strategy: Direct default + Fetched opt-in | 014 |

## Dependency Chain

```
001 scaffold
 ├─ 002 schema(test→impl)
 │   ├─ 003 resolver(test→impl) ─┬─ 004 xadapter(test→impl) ─┐
 │   │                            └─ 009 inject-tee(test→impl)┤
 │   ├─ 005 filename(test→impl) ── 007 download-queue(test→impl) ─┐
 │   ├─ 006 settings(test→impl) ───────────────────────────────┐ │
 │   └─ 008 messaging(test→impl) ──────────────────────────────┤ │
 │                                                              │ │
 010 content-overlays  ◄── 004, 008, 009                        │ │
 011 popup             ◄── 006, 007, 008  ◄────────────────────┘ │
 012 wire-e2e          ◄── 010, 011  ◄──────────────────────────┘
```

Parallelizable after 002-impl: the {003+004+009}, {005+007}, {006}, {008} chains
are independent until they converge at 010/011/012.
