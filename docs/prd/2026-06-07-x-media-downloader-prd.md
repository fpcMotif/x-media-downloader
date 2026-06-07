# PRD — X Media Downloader (v1)

- **Date:** 2026-06-07
- **Status:** Ready for implementation (TDD)
- **Triage:** ready-for-agent (local PRD — no tracker configured; publish on request)
- **Sources:** [spec](../superpowers/specs/2026-06-07-x-media-downloader-design.md) ·
  [grounding](../research/2026-06-07-grounding.md) · [CONTEXT.md](../../CONTEXT.md) ·
  [ADRs](../adr/) · [plan](../plans/2026-06-07-x-media-downloader-plan/_index.md)

## Problem Statement

When I'm browsing X (Twitter) and find a Tweet or Thread with photos or videos I
want to keep, saving them is tedious and lossy: right-click "save image" gives a
downscaled rendition (not Original quality), videos can't be saved at all without
a third-party site, and grabbing every Media Item in a Thread means dozens of
manual saves. The popular tools either demand sketchy permissions (cookies,
broad host access), funnel my media through remote servers, or scrape X in ways
that risk my account.

## Solution

A minimalist, local-only Chrome extension. While I browse X normally, the
extension passively notices the media the page already loaded and lets me save it
at Original quality — one Media Item, or every Media Item in a Tweet/Thread (Bulk)
— from an in-page Overlay or a Popup queue. Nothing leaves my machine; no account,
no remote server, no scraping. It asks for the bare minimum permissions and only
requests more if I opt into a power feature.

## User Stories

1. As an X user, I want to save a single photo from a Tweet at Original quality, so that I keep the full-resolution image rather than a downscaled one.
2. As an X user, I want to save a Tweet's video as the highest-bitrate MP4, so that I keep the best available quality.
3. As an X user, I want to save an animated GIF from a Tweet, so that I can reuse it.
4. As an X user, I want to grab all Media Items in a Tweet in one action, so that I don't save four photos one at a time.
5. As an X user, I want to grab all Media Items across a whole Thread, so that I capture a multi-post photo set at once.
6. As an X user, I want a subtle download control to appear when I hover a media element, so that saving is one click without leaving the page.
7. As an X user, I want a floating "grab all" control on a Tweet/Thread, so that Bulk is one click.
8. As an X user, I want the Overlay to stay out of my way until I hover, so that it doesn't clutter the timeline.
9. As an X user, I want a Popup that lists my active and recent downloads with progress, so that I can see what's happening.
10. As an X user, I want to retry a failed download from the Popup, so that a transient CDN error doesn't cost me the file.
11. As an X user, I want to cancel a queued download, so that I can stop a Bulk I started by mistake.
12. As an X user, I want to customize the filename pattern (handle, tweet id, index, ext, type, date), so that my saved files are organized the way I like.
13. As an X user, I want files grouped into per-handle subfolders by default, so that my Downloads folder stays tidy.
14. As an X user, I want a sensible default filename so I don't have to configure anything to start.
15. As an X user, I want to set how many downloads run at once, so that I can balance speed against hammering the CDN.
16. As an X user, I want the extension to retry with backoff on transient failures, so that large Bulk grabs complete reliably.
17. As an X user, I want a Bulk in progress to keep going even if the browser idles the extension, so that big grabs finish.
18. As an X user, I want my settings to persist across browser restarts, so that I configure the extension once.
19. As a privacy-conscious user, I want the queue and any captured data to be ephemeral, so that nothing sensitive lingers at rest.
20. As a privacy-conscious user, I want the extension to work entirely locally with no telemetry, so that my browsing isn't reported anywhere.
21. As a cautious user, I want the default install to request only `downloads`, `storage`, and X host access, so that I'm not granting broad permissions.
22. As a power user, I want an opt-in "Fetched" download mode that verifies/repackages bytes, so that I can guarantee correct file types when I need to.
23. As a power user, I want the extension to ask for the extra permissions Fetched mode needs only when I enable it, so that the default stays lean.
24. As a power user, I want an opt-in Auth fallback to grab Thread media that hasn't loaded yet, so that I can capture long Threads completely.
25. As a cautious user, I want the Auth fallback off by default, so that the extension never makes extra requests unless I ask.
26. As an X user, I want the extension to respect light/dark mode, so that it matches my environment.
27. As a keyboard user, I want the controls to be operable without a mouse, so that the UX is accessible.
28. As an X user on either domain, I want it to work on both `x.com` and `twitter.com`, so that it keeps working through the rebrand.
29. As an X user on a single-page navigation, I want the Overlay to re-appear after I navigate between Tweets, so that it doesn't break on the SPA.
30. As an X user, I want duplicate Media Items de-duplicated, so that I don't save the same image twice in a Bulk.
31. As an X user, I want a clear filename even when the handle contains odd characters, so that downloads never fail on a bad path.
32. As a user, I want failed and interrupted downloads distinguished (e.g. server-forbidden vs network timeout), so that retries are sensible.
33. As a Chrome Web Store reviewer, I want a clear single-purpose listing + privacy policy, so that the extension passes review.

## Implementation Decisions

Built on **WXT 0.20** (MV3, manifest-from-config), **Bun**, **Preact + Tailwind v4**,
and an **Effect v4 (beta)** core (ADR-0004). Three contexts: a MAIN-world tee, an
ISOLATED content script, and a background service worker; plus a Popup.

**Modules (deep where possible):**
- **Resolver** — `resolveFromJson(json) → Effect<MediaItem[], DetectError>`, plus
  `upgradePhotoUrl` (orig + fallback chain) and `pickVideoVariant` (max-bitrate
  MP4). Pure, framework/chrome-free.
- **Source Adapter** — `detectMedia(ctx) → Effect<MediaItem[], DetectError>`;
  `XAdapter` resolves from Capture JSON, falling back to the DOM. The seam for
  future sites (ADR-0001).
- **Filename engine** — `render(template, item) → string`: token expansion +
  sanitization + a hard **relative-only** guard (no absolute/empty/`..`), because
  `chrome.downloads.download` throws otherwise.
- **Download Queue** — `enqueue(items)` + `snapshot`. Fire-and-track (ADR-0002):
  fires `chrome.downloads.download`, bounds in-flight starts with a `Semaphore`,
  drives progress/retry from a top-level `downloads.onChanged` listener, polls
  `downloads.search` for bytes, persists to `storage.session`, rehydrates on SW
  restart.
- **Download Strategy** — `save(item, filename) → Effect<number, DownloadError>`:
  *Direct* (default) vs *Fetched* (offscreen document + optional permissions),
  selected from Settings (ADR-0003).
- **Settings Service** — `get` / `set`, durable in `storage.local`, single-writer
  (background SW), observed via `storage.onChanged` (ADR-0005).
- **Messaging** — typed `send` / `onMessage` over `runtime` messaging; schema-
  validated; `onMessage` returns literal `true` for async replies; no-receiver is
  retryable, `SchemaError` is not.
- **Tee** — a declarative `world:"MAIN"` content script at `document_start` that
  patches `XHR` (and `fetch`) and bridges Captures to the ISOLATED script via a
  document `CustomEvent`; pure helpers `isGraphqlMediaUrl` + payload builder.

**Effect v4 specifics (grounding §f/§g):** services are `Context.Service` +
explicit `Layer` (no `Effect.Service`); errors are `Data.TaggedError`; schemas use
`Schema.Struct/Literals/Union` with `withDecodingDefaultKey`; decode via
`decodeUnknownResult` → `SchemaError`; concurrency via `Effect.forEach({concurrency})`
+ `Semaphore`; retry via `Schedule.exponential` + `recurs`.

**Data model:** `MediaItem { id, tweetId, handle, type: photo|video|gif, url, ext,
index, width?, height?, bitrate? }`; `Settings { filenameTemplate,
downloadConcurrency, authFallbackEnabled, downloadStrategy, theme }`; `Message`
tagged union (`DetectRequest`, `MediaDetected`, `DownloadRequest`, `QueueUpdate`,
`SettingsGet`, `SettingsSet`).

**Permissions:** required `downloads`, `storage`, hosts `x.com`/`twitter.com`;
optional (runtime-requested for Fetched) `offscreen` + `pbs/video.twimg.com`.

## Testing Decisions

**What makes a good test here:** assert external behavior through a module's public
interface, never its internals. The Effect core is framework/chrome-agnostic and
verified with test `Layer`s; Chrome APIs are faked with WXT `fakeBrowser`; time is
controlled with `TestClock` (`effect/testing`).

**Tested modules (test-first, red→green):** Schema (decode/defaults/reject),
Resolver (orig-upgrade + fallback chain, variant pick, dedupe), Source Adapter
(JSON + DOM fallback), Filename engine (tokens, sanitization, relative-only guard),
Settings Service (defaults, persistence, corrupt-recovery), Download Queue
(concurrency cap, retry/backoff, progress counts, **SW-restart rehydrate**),
Messaging (round-trip, `SchemaError` rejection, retryable no-receiver), Download
Strategy (Direct default; Fetched requests optional perms + offscreen), Tee helpers
(URL predicate, payload builder, original response intact).

**Lightly tested:** Overlay + Popup get component-level tests (render + handler
fires) plus a manual load-unpacked E2E (a tweet with 4 photos + 1 video → grab all
→ 5 files saved with templated names → popup reaches 5/5).

**Prior art:** the parsing/variant logic mirrors `gallery-dl`'s `twitter.py`; test
fixtures use real-shape X GraphQL JSON; the tee mirrors the production
TwitterMediaHarvest pattern (studied under `study/`).

## Out of Scope (v1)

- Auto-scrolling or enumerating a whole profile's media tab.
- ZIP bundling of a Bulk (extensibility hook left; deferred to v2).
- Non-X sources (the Source Adapter seam exists, but only `XAdapter` ships).
- Firefox/Safari ports (WXT keeps them cheap later).
- Persistent download history.

## Further Notes

- Policy posture is load-bearing (ADR-0001): the default path issues no extra
  requests; the Auth fallback is opt-in, default off, single-replay, never an
  enumerator.
- Effect v4 is a pinned beta (ADR-0004); re-verify the grounding snippets on any
  version bump.
- CWS publish (task 013) needs a privacy policy + Privacy Practices + Limited-Use
  certification even though we are local-only.
