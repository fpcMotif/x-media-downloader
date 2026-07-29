# X Media Downloader — Design Spec

- **Date:** 2026-06-07
- **Status:** Draft (awaiting user approval)
- **Working name:** X Media Downloader (`x-media-downloader`) — _overridable_

## 1. Overview

A Manifest V3 Chrome extension that lets a logged-in user download the media
(images, videos, GIFs) from an X (Twitter) tweet or thread — individually or in
bulk — through a minimalist, fast, extensible interface. TypeScript strict,
Effect-TS for the core, built test-first (TDD).

### Goals

- Download all media in a tweet, and optionally its whole thread, in one action.
- Original quality: images at `name=orig`, videos at the highest-bitrate MP4.
- Swift UX: in-page hover controls (zero context switch) **and** a popup queue/manager.
- Minimalist, well-designed, extensible UI; flexible filename templating.
- Stay within X policy by default (no scraping / no endpoint enumeration).
- Local-first with no telemetry by default; remote features are separate opt-ins.

### Non-goals (YAGNI, this version)

- Auto-scrolling or enumerating a whole profile's media tab (declined: scope is tweet+thread).
- ZIP bundling (deferred to v2 — extensibility hook left in place).
- Non-X sources (the adapter seam exists, but only `XAdapter` ships).
- Firefox/Safari ports (WXT keeps them cheap later; not targeted now).

## 2. Policy & Compliance Posture _(load-bearing)_

The default path never does anything X's ToS treats as scraping. Validated
against prior art (Media Harvest is explicitly "not a crawler"; it reads the
page's own tweet responses).

- **Passive layer (default).** A content script injects a script into the page's
  **MAIN world** that tees X's _own_ `fetch`/`XMLHttpRequest` JSON responses
  (`TweetDetail`, `TweetResultByRestId`, timeline entries). We **issue no extra
  network requests** in this mode — media URLs come only from data the user's
  own browsing already fetched, plus `<img>`/`<video>` already in the DOM.
  - Photo: rewrite `pbs.twimg.com/...&name=small` → `name=orig`, with the
    gallery-dl fallback chain `[orig, 4096x4096, large, medium, small]`.
  - Video/GIF: pick the max-bitrate entry from `video_info.variants[]`.
- **Recovery.** ADR-0015 permits one bounded, unauthenticated request to X's
  public syndication endpoint for a visibly mounted, tee-missed video. No
  authenticated replay or profile enumeration.
- **Guardrails.** Download-only of media the logged-in user can already see;
  per-CDN concurrency limit + backoff; never bypass protected/age-gated auth;
  no external network egress; no analytics.

## 3. Architecture (MV3, three contexts)

```
MAIN-world hook ──teed responses──► Content script ──typed RPC──► Background SW
  (fetch/XHR patch)                  (Preact overlays,            (DownloadQueue,
                                      media detection)             Settings, persist)
                                            ▲                            │
                                            └──── Popup (Preact) ◄────────┘
                                                (queue manager, settings)
```

- **MAIN-world hook** (declarative `world: "MAIN"` content script at
  `runAt: 'document_start'` — no `injectScript`, no `web_accessible_resources`):
  patches `XHR` (and `fetch` as hardening), bridges captured JSON to the ISOLATED
  content script via a document `CustomEvent`. Pure, no extension APIs.
- **Content script** (isolated world): runs `XAdapter` over teed JSON + DOM,
  renders Preact hover overlays, sends download requests to the background.
- **Background service worker**: owns `DownloadQueue`, `SettingsService`,
  persisted queue state; the only context that calls `chrome.downloads`.
- **Popup** (Preact): queue manager (progress/retry/cancel), recent downloads,
  settings editor.

**Tooling:** WXT (manifest-from-config, HMR, entrypoints) · Bun · Vite + Preact
preset · Tailwind v4 · Vitest + WXT `fakeBrowser`.

## 4. Core — Effect-TS services

Framework-free (`src/core/`), each an isolated `Context.Service` + explicit
`Layer` (Effect v4 — there is no `Effect.Service`/auto-`.Default`) with a test
layer. All boundary data validated with **Effect Schema**; errors are
`Data.TaggedError`.

- **`SourceAdapter`** — interface: `detectMedia(ctx) → Effect<MediaItem[], DetectError>`.
  X, Instagram, and Threads implement the same platform boundary.
- **`MediaResolver`** — teed JSON + DOM → validated `MediaItem[]`: original-photo
  selection, best video variant, and dedupe by the adapter's Media Key.
- **`DownloadQueue`** — `Effect.forEach` over a **Semaphore** (concurrency ~3) +
  `Schedule` exponential backoff retry for transient CDN failures; drives
  `chrome.downloads`. Emits progress events.
- **`SettingsService`** — `chrome.storage.local`, schema-validated; defaults.
- **`Messaging`** — typed tagged-union RPC across contexts (no stringly-typed
  messages); request/response + event channels.

### Data model (Effect Schema)

- `MediaItem`: `{ id, platform, postId, author, type: 'photo'|'video'|'gif', url, previewUrl?, ext, index, width?, height?, bitrate? }`
- `Settings`: `{ filenameTemplate, downloadConcurrency, downloadStrategy, theme }`
- `Message`: tagged union — `DetectRequest`, `MediaDetected`, `DownloadRequest`,
  `QueueUpdate`, `SettingsGet/Set`.

## 5. Download mechanism & filename templating

- **Download Strategy** (ADR-0003): _Direct_ (default) hands the Original-quality
  URL to `chrome.downloads.download` (`conflictAction: 'uniquify'`); _Fetched_
  (opt-in) checks the HTTP response type, caps the stream at 15 MiB, and builds a
  Blob URL through an offscreen document before the worker saves it. It does not
  hash or inspect file bytes. Both sit behind a seam in `core/download`.
- Default template: `{platform}/{tweetId}_{index}.{ext}` — editable in settings.
  Tokens: `{author} {postId} {platform} {index} {ext} {type} {date}`.
  `{handle}` and `{tweetId}` remain aliases for saved templates. A small pure
  token engine renders them.
- Bulk = enqueue every `MediaItem` from the tweet/thread through `DownloadQueue`
  (rate-limited, resumable).

## 6. UI / UX (Preact + Tailwind, minimalist)

- **In-page (swift path):** a subtle download glyph appears on hover over each
  media element; a floating pill offers "grab all in this tweet / thread".
  Injected via Preact into a Shadow DOM root to avoid X style bleed.
- **Popup (manager path):** live queue with per-item progress, retry, cancel;
  recent downloads; settings (filename template, concurrency, auth-fallback
  toggle, theme). Respects light/dark, keyboard-operable.

## 7. Permissions (intentionally minimal)

**Required:** `downloads`, `storage`; host perms `x.com`, `twitter.com` (content
script + tee). **No `<all_urls>`, no `cookies`, no `webRequest`, no `scripting`** —
the MAIN-world tee needs none of these. (Media Harvest requires `cookies`; we don't.)

**Optional (requested at runtime only when Download Strategy = Fetched, ADR-0003):**
`offscreen` + host perms `pbs.twimg.com`, `video.twimg.com`. The Direct default
needs none of these.

## 8. TDD strategy

Vitest, red→green→refactor. Chrome APIs via WXT `fakeBrowser`; Effect services
swapped for test layers; `TestClock` for queue/rate-limit timing.

- **Pure units:** photo URL upgrade + fallback chain; GraphQL-JSON → `MediaItem`
  parsing against real-shape fixtures (derived from gallery-dl's known shapes);
  filename template rendering; dedupe.
- **Service units:** `DownloadQueue` concurrency/retry/backoff; `SettingsService`
  schema validation + defaults; `Messaging` round-trips.
- **Optional later:** thin E2E smoke via the web-browser skill.

## 9. Repo shape

```
src/
  entrypoints/
    background/    # service worker: queue, settings
    content/       # isolated-world: adapter run + overlays
    inject/        # MAIN-world fetch/XHR tee
    popup/         # Preact queue manager + settings
  core/            # Effect, framework/chrome-agnostic
    adapters/  resolver/  download/  settings/  messaging/  schema/  errors/
  ui/              # Preact components (overlay/, popup/)
  test/fixtures/   # captured GraphQL JSON shapes
wxt.config.ts  vitest.config.ts
```

Core stays UI/chrome-agnostic → pure-unit-testable and reusable behind the adapter seam.

## 10. Prior art & references

- **EltonChou/TwitterMediaHarvest** (Media Harvest) — MV3 TS extension; "not a
  crawler," reads tweet responses, customizable filenames, original-size. Product
  - posture reference. (Uses `cookies`; we avoid it.)
- **mikf/gallery-dl** `gallery_dl/extractor/twitter.py` — canonical extraction:
  `name=orig` size fallback chain, max-bitrate variant. Resolver logic + fixture shapes.
- **rxliuli — "Intercepting network requests in Chrome extensions"** — MAIN-world
  `fetch`/`XHR` monkey-patch pattern. Passive-tee reference.
- **afkarxyz/Twitter-X-Media-Batch-Downloader** — gallery-dl-powered batch UX reference.
- **ChinaGodMan/UserScripts** — ZIP-bundling approach (v2 reference).
- **wxt.dev** — framework + unit-testing guide (`WxtVitest` + `fakeBrowser`).

## 11. Decisions taken (overridable)

- Name: `x-media-downloader`.
- Extraction: passive, with ADR-0015's bounded unauthenticated X-video recovery.
- Bulk scope: tweet + thread.
- UI: both in-page overlays and popup manager; Preact + Tailwind v4.
- Default filename: `{platform}/{tweetId}_{index}.{ext}`.
- ZIP + profile-tab enumeration: out of scope this version.
- Deployment: CWS requires a privacy-policy URL + Privacy Practices tab +
  Limited-Use certification. The product is local-first with no telemetry by
  default (task 013).

## 12. Milestones (detailed plan to follow via writing-plans)

1. Scaffold WXT + Bun + Preact + Tailwind + Vitest; strict TS; CI-less local checks.
2. Core schema + errors + `Messaging` (test-first).
3. `MediaResolver` + `XAdapter` against fixtures (test-first).
4. MAIN-world tee + content overlays.
5. `DownloadQueue` + `SettingsService` + filename engine.
6. Popup queue manager + settings.
7. Wire end-to-end; manual load-unpacked smoke; polish.
