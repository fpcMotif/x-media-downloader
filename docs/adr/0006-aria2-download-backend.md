# ADR-0006 — Download backend: Direct default, aria2 opt-in

- **Status:** Accepted (2026-06-08)

## Context

The Resolver yields Original-quality CDN URLs, so download quality is
backend-independent (ADR-0003). What differs between backends is _who fetches the
bytes_, and the memory/speed/resumability profile that follows:

- **Direct** (`chrome.downloads.download`) — the browser streams to disk outside
  extension JS (~0 ext memory), one connection per file; our queue parallelizes
  _files_. Zero setup. Cookies auto-attach; page-CORS bypassed.
- **Fetched** (offscreen Blob) — holds roughly the file size in extension memory;
  risky for video. It checks the HTTP response type and enforces a 15 MiB limit
  before handing a Blob URL to Chrome (ADR-0003).
- **aria2 local** — a user-run `aria2c` daemon owns the bytes (~0 browser memory),
  does multi-connection segmented transfers (large-video win), and supports robust
  resume + an arbitrary `--dir`. Costs the user an install + a running daemon.

The media URLs are public CDN (pbs/video.twimg) — aria2 can fetch them without X
auth, so no cookie forwarding is needed for in-scope media.

## Decision

Keep **Direct** as the zero-setup default. Add **aria2** as an **opt-in**
`Aria2Strategy` behind the existing `DownloadStrategy` seam
(`core/download/aria2.ts`), driven over **JSON-RPC** (`aria2.addUri`):

- The seam was widened to `save(req: SaveRequest) → Effect<DownloadHandle, …>`
  where `DownloadHandle = { kind: 'browser'; id } | { kind: 'aria2'; gid }`,
  decoupling _how bytes reach disk_ from the `MediaItem` domain object.
- `makeAria2RpcPort` POSTs `aria2.addUri([url], { dir?, out, split,
max-connection-per-server })` with an optional `token:<secret>` param to the
  configured RPC URL (default `http://localhost:6800/jsonrpc`).
- `http://localhost/*` is an **optional** host permission — requested only when a
  user enables aria2. The lean default install stays `downloads` + `storage` +
  x/twitter hosts.

## Consequences

- Default users get a warning-minimal install and a working downloader.
- Power users get fast/resumable large-video downloads to any directory.
- aria2 health/availability is the user's responsibility. A pre-call failure is a
  start failure; an armed-call failure is quarantined rather than retried, because
  `addUri` may already have started the transfer.
- The worker validates the initial media URL before `addUri`. aria2 owns the
  network request and any redirect after that hand-off.
- Selecting aria2 in the popup requests the `http://localhost/*` optional host
  permission via a user gesture (`aria2OriginPattern` → `permissions.request`),
  surfacing a "Grant localhost access" prompt rather than failing silently.
- **Unverified claim:** the large-video speedup is asserted from aria2's segmented
  model, **not yet measured**. A Direct-vs-aria2(`split=8`) benchmark on a known
  large video remains before the speed claim ships in user-facing copy.
- Native-messaging-host integration (vs JSON-RPC) is deferred; RPC is the lower
  install-friction path and was chosen for v1.

## Amendment (2026-07-22) — durable aria2 observation

`addUri` is a start call, not completion. The Transfer Registry v4 persists
`aria2-prepared` with the GID, connection profile, and call options. Clear and
cloud admission then commit its `aria2-ready` permit. The Registry commits
`aria2-call-armed` immediately before its one
allowed `addUri` RPC, then polls `tellStatus` to project terminal success or
failure. An ambiguous RPC is quarantined, never repeated. aria2 media has no Chrome
download id, so Clear-after-download remains unavailable for it.

## Alternatives considered

- **Direct only** — no fast/resumable path, no arbitrary `--dir`.
- **aria2 via native messaging host** — more robust, but a host manifest +
  helper-binary install is heavier; revisit if RPC reachability proves fragile.
- **Always-on aria2** — forces a daemon install on every user; rejected.
