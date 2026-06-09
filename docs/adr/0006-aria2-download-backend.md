# ADR-0006 — Download backend: Direct default, aria2 opt-in

- **Status:** Accepted (2026-06-08)

## Context

The Resolver yields Original-quality CDN URLs, so download quality is
backend-independent (ADR-0003). What differs between backends is *who fetches the
bytes*, and the memory/speed/resumability profile that follows:

- **Direct** (`chrome.downloads.download`) — the browser streams to disk outside
  extension JS (~0 ext memory), one connection per file; our queue parallelizes
  *files*. Zero setup. Cookies auto-attach; page-CORS bypassed.
- **Fetched** (offscreen blob) — holds ~filesize in memory; risky for video. Only
  useful for byte verify/repackage (ADR-0003). Not built yet.
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
  decoupling *how bytes reach disk* from the `MediaItem` domain object.
- `makeAria2RpcPort` POSTs `aria2.addUri([url], { dir?, out, split,
  max-connection-per-server })` with an optional `token:<secret>` param to the
  configured RPC URL (default `http://localhost:6800/jsonrpc`).
- `http://localhost/*` is an **optional** host permission — requested only when a
  user enables aria2. The lean default install stays `downloads` + `storage` +
  x/twitter hosts.

## Consequences

- Default users get a warning-minimal install and a working downloader.
- Power users get fast/resumable large-video downloads to any directory.
- aria2 health/availability is the user's responsibility; a failed RPC maps to a
  `DownloadError` and the queue's retry/fail accounting handles it.
- Selecting aria2 in the popup requests the `http://localhost/*` optional host
  permission via a user gesture (`aria2OriginPattern` → `permissions.request`),
  surfacing a "Grant localhost access" prompt rather than failing silently.
- **Unverified claim:** the large-video speedup is asserted from aria2's segmented
  model, **not yet measured**. A Direct-vs-aria2(`split=8`) benchmark on a known
  large video remains before the speed claim ships in user-facing copy.
- Native-messaging-host integration (vs JSON-RPC) is deferred; RPC is the lower
  install-friction path and was chosen for v1.

## Alternatives considered

- **Direct only** — no fast/resumable path, no arbitrary `--dir`.
- **aria2 via native messaging host** — more robust, but a host manifest +
  helper-binary install is heavier; revisit if RPC reachability proves fragile.
- **Always-on aria2** — forces a daemon install on every user; rejected.
