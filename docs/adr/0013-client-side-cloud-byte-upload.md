# ADR-0013 — Client-side OAuth byte upload to Google Drive & Dropbox

- **Status:** Accepted (2026-06-19)
- **Supersedes (amends):** the *server-side* byte-path direction sketched on branch `feat/convex-cloud-destinations` (its ADR-0013). That branch's ADR-0011–0014 share numbers with main's bookmarks ADRs (0011/0012) and durable-history work — a known collision (see handoff 2026-06-19). **This file is main's authoritative ADR-0013** and the live decision for the shipped byte path.
- **Builds on:** [ADR-0009](0009-convex-cloud-control-plane.md) (Convex control plane), [ADR-0003](0003-dual-download-strategy.md) (Fetched strategy / offscreen), [ADR-0006](0006-aria2-download-backend.md) (fetch-injected RPC ports).

## Context

Today the extension mirrors only **metadata** (CDN URLs + provenance) to Convex (ADR-0009 Phase 1). Phase 3 — long deferred — is the **byte-transfer layer**: upload the real photo/MP4 bytes of downloaded media to the user's own **Google Drive** and **Dropbox**.

Two hard constraints decide the architecture:

1. **Video memory wall.** X video is 20–512 MB. Convex actions cannot buffer that (V8 64 MiB / Node 512 MiB). A server-side relay (Convex fetches twimg → pushes to provider) **cannot serve video** without a separate worker, and even then bytes would transit our infrastructure — against ADR-0009's "never bytes through Convex" posture.
2. **Drive + Dropbox both have clean client-side OAuth.** The extension already runs a service-worker `fetch` against twimg (the Fetched strategy, ADR-0003). It can fetch the bytes and upload them to the provider directly, with no server in the byte path.

The byte source is also already understood: `makeFetchPort` (`src/core/download/fetched-strategy.ts`) and the SSRF guard `guardedFetch` (`src/core/sync/url-guard.ts`, landed on main, commit 3548bda) fetch twimg media from the SW with an exact-host allow-list and per-hop redirect revalidation. `guardedFetch` returns a `Response` whose `body` is a `ReadableStream` — so bytes can be **streamed**, never fully buffered.

## Decision

**Client-side OAuth (PKCE) byte upload. Bytes go extension → provider directly; Convex stays a control-plane job ledger only.**

### 1. Byte path — stream, never buffer

A dedicated module tree `src/core/cloud/` (kept out of the shipped `src/core/sync/` per the cloud-destinations reconciliation):

- The SW fetches twimg bytes via `guardedFetch` (SSRF allow-list + redirect revalidation) and **streams** the `Response.body` to the provider:
  - small media (Content-Length ≤ `SIMPLE_MAX` = 8 MiB) is buffered once and sent in a single request;
  - large/unknown-size media is streamed in fixed chunks read from the body reader — **never holding the whole file in SW memory**. This sidesteps the same 512 MB wall on the client that killed the server-side design.
- This path is **independent of the download strategy** (direct / aria2 / Fetched) and of the broken offscreen save (the Fetched strategy's offscreen `chrome.downloads` bug, memory `pr9-fetched-offscreen-rework`). Cloud upload never touches the offscreen document.

### 2. Trigger — at queue time, in parallel with the local download

When a download is enqueued (`handleDownload`) and cloud upload is enabled + at least one provider is connected, one **UploadJob per (media item × connected provider)** is appended to a durable local ledger and a drain is kicked. Upload runs in parallel with the local download (both fetch twimg independently); a dead URL simply fails the job (→ `skipped`/`failed`) without affecting the local download. (Sharing the Fetched-strategy bytes to avoid the double fetch is a future optimization.)

### 3. Control plane — local ledger (source of truth) + best-effort Convex mirror

- **Local:** a pure reducer `src/core/cloud/upload-job.ts` (lifted from `feat/upload-job-ledger`): `pending → uploading → succeeded | failed → dead | skipped`, fencing-token leases, bounded retry with exponential backoff. Persisted to `local:cloudUploadJobs`, drained FIFO through a serialized chain — **mirroring the metadata outbox** (`src/core/sync/outbox.ts`) so the same idempotency + backoff invariants hold.
- **Convex (optional, gated on existing Cloud Sync config):** an `upload_jobs` table + `recordUploadJobs` mutation **mirroring `recordEvents`** (idempotent by `jobId`, same fail-closed `SYNC_SHARED_SECRET`). Best-effort, fire-and-forget; the local ledger is authoritative. Gives cross-device upload visibility without putting bytes anywhere near Convex.

### 4. OAuth — PKCE via `chrome.identity.launchWebAuthFlow`, run in the background SW

- `launchWebAuthFlow` (not `getAuthToken`: that is Google-only, profile-bound, no app-managed refresh token) with **PKCE** (`S256`) — no client secret can live in an extension bundle.
- Redirect URI = `chrome.identity.getRedirectURL()` → `https://<extension-id>.chromiumapp.org/`, surfaced read-only in the popup so the user registers it in the provider console.
- **Permission grant happens in the popup** (user gesture preserved), the **OAuth flow runs in the background SW** (survives the popup closing on focus loss). Tokens are written by the background — the single settings writer (ADR-0005).
- Access tokens are refreshed proactively (within 60 s of expiry, or on a 401) using the stored refresh token (`access_type=offline` + `prompt=consent` for Google; `token_access_type=offline` for Dropbox).

### 5. Providers

- **Google Drive** — scope **`https://www.googleapis.com/auth/drive`** (full Drive, per the product decision 2026-06-19). *Sensitive scope: a public Chrome Web Store release needs Google OAuth verification + likely a CASA assessment; fine for personal/dev use. The scope is a single constant — downgrading to the non-sensitive `drive.file` later is a one-line change.* Files land in a per-handle subfolder under an app root folder ("X Media Downloader"); folders are lookup-or-created (cached in memory). Resumable upload (`uploadType=resumable`, 256 KiB-multiple chunks) for large media; multipart (`uploadType=multipart`, sets name+parents) for small.
- **Dropbox** — scope **`files.content.write`**, **App-folder** access type (least privilege; paths relative to `Apps/<App>/`). `POST /2/files/upload` for ≤ 150 MB; `upload_session/{start,append_v2,finish}` (4 MiB-multiple chunks) for larger. *50-user Development cap until Production approval — irrelevant for personal use, a gate for public release.*

### 6. Settings & manifest

- New `Settings` keys (Effect Schema, `local:settings` blob, same as `aria2Secret`/`convexSyncSecret`): `cloudUploadEnabled` (master gate + disclosure) and per-provider client id + access/refresh token + expiry (+ Drive folder id, account label). Tokens stored plaintext in `storage.local` — same posture as the existing secrets; the profile's OS account is the trust boundary. (Encrypting at rest inside the same extension is obfuscation, not security; noted, not done.)
- Manifest: add `"identity"` to required `permissions` (`launchWebAuthFlow` needs it; not reliably grantable as optional). Provider API origins (`googleapis.com`, `oauth2.googleapis.com`, `*.dropboxapi.com`, `www.dropbox.com`) are **optional_host_permissions**, requested at connect time — consistent with the twimg / convex.cloud opt-in pattern.

## Consequences

- **Privacy posture strengthens.** Bytes never transit Convex or any server of ours; they go provider-native to the user's own account. The "Local-only / never bytes through Convex" claim holds.
- **Video works.** Streaming bounds SW memory regardless of file size.
- **Opt-in & honest.** Master toggle + per-provider connect; disconnect clears tokens. "Saved to cloud" reflects a real provider response, not a fire-and-forget guess.
- **Double fetch.** Until bytes are shared from the Fetched strategy, cloud upload re-fetches twimg in parallel with the local download (2× bandwidth per media).
- **Release gating, not code.** Full-Drive scope (verification/CASA) and Dropbox's 50-user cap block a *public* release, not personal use. Both are single-constant / console changes.
- **Token at-rest.** Refresh tokens live in `storage.local`. Acceptable per the established secret convention; a follow-up could move them to a sealed store.
