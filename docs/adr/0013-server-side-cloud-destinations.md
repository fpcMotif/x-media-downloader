# ADR-0013 — Server-side cloud destinations, byte path, and provider phasing

- **Status:** Proposed (2026-06-14)

## Context

The user chose **server-side uploads**: the extension reports a media link; Convex actions push to
the user's clouds so provider secrets/OAuth tokens never touch the extension bundle. Destinations
requested: AWS S3 + Cloudflare R2, Dropbox, Google Photos, Apple iCloud.

Two hard realities constrain the design:

1. **Memory:** Convex actions cannot buffer large video (V8 64 MiB / Node 512 MiB), and Twitter
   video is 20–512 MB. A single byte path cannot serve both photos and video.
2. **External shipping gates:** Google Photos `photoslibrary.appendonly` is a sensitive scope
   requiring OAuth verification + likely a **CASA security assessment** (~$500–$4,500/yr, weeks of
   lead time, needs a published privacy policy + verified domain + demo); Dropbox apps cap at **50
   users** until Production approval. S3/R2 have **no** review. iCloud has **no server upload API**
   at all (CloudKit reaches only an app-owned container).

The presign path the memory limit forces introduced three blockers (manifest host-permission
contradiction, an SSRF/integrity bypass via `confirmUpload`, and allow-list-vs-redirect conflict)
that this ADR resolves.

## Decision

- **One provider-adapter contract** (in Convex), to remote storage what `DownloadStrategy` is to
  disk: `{ provider, isConfigured, upload(mediaRef, conn), presignPut(mediaRef, conn) }`. **S3 and
  R2 share one SigV4 code path** (`@aws-sdk/client-s3` + presigner); the only fork is
  `endpoint`/`region` (R2: `https://<acct>.r2.cloudflarestorage.com`, `region:"auto"`).
- **Two byte modes, routed at enqueue and correctable after a HEAD probe:**
  - **`pipe`** (photo/GIF < `PIPE_MAX_BYTES ≈ 8 MB`): bytes transit a Node action
    (`fetch(pbs.twimg) → provider`). `pbs.twimg.com` is cookieless, so a server fetch is reliable.
    A 403/410 → honest `skipped` + `sourceGone`.
  - **`presign`** (video / large): Convex mints a presigned upload; the **extension streams
    twimg→cloud directly**, because (a) it keeps large bytes out of Convex, and (b) the extension
    carries the live X session/referer that `video.twimg.com` (signed, `?tag=`-gated, redirecting)
    requires. **Honest asymmetry: photo fetch is server-side; video fetch is client-side.** The
    server-side promise holds for *credential custody and upload authorization* (Convex signs every
    PUT; the extension never holds a long-lived cloud credential).
- **Presign-path hardening (resolving the three blockers):**
  - Request the specific upload origin as a **runtime `optional_host_permissions`** at connect time
    (lead with R2 — stable enumerable host; S3 path-style/single-region for enumerability). Do
    **not** claim "zero upload host permissions."
  - Use a **presigned POST with policy conditions** (pinned `Content-Type`, `content-length-range`,
    single server-chosen key) — never a bare PUT with a client-chosen key. Stream from the
    **background SW only** (never the content script). Convex **verifies out-of-band** (`HeadObject`)
    before marking `uploaded`; `confirmUpload` is a hint, not the authority.
  - **SSRF guard:** exact-host allow-list (`pbs.twimg.com`, `video.twimg.com`) with manual,
    per-hop-revalidated redirect handling (bounded) + RFC-1918/link-local/metadata IP blocking at
    the socket level; validate **every** url-typed field (`url` *and* `previewUrl`).
- **OAuth = Pattern B** (Convex `httpAction` is the redirect URI;
  `https://<dep>.convex.site/oauth/:provider/callback`). The code→token exchange runs server-side
  with the server-held client secret; the **refresh token is born server-side and AES-GCM-sealed**
  into `cloudConnections` — it never touches the extension, so the extension needs **no provider
  host permissions** for OAuth. Tier-2 (real per-user OAuth identity) is **required and
  code-enforced** before any `cloudConnections` row can be created; a `device`-issuer (Tier-1)
  subject is rejected at connect.
- **Apple iCloud is not built.** No public upload API exists; the only honest path is a manual
  Apple Shortcuts hand-off that depends on an R2/S3 staging object. **No iCloud adapter and no
  iCloud UI row this cycle**; documented in "Out of scope / why," revisited only on real demand
  after R2 mirroring ships, modeled as a dependent destination of an S3/R2 staging bucket.
- **Phasing by shipping gate** (not code effort): **Phase 1** catalog (+ optional Convex-storage
  copy); **Phase 2a** S3/R2 (no review — first); **Phase 2b** Dropbox (App-folder; start production
  approval the day OAuth works); **Phase 3** Google Photos, gated on a prerequisite task
  (privacy policy + verified domain + CASA budget). The external-review lead time is a **visible
  dependency** in the plan, not an afterthought.

## Consequences

- The strongest, simplest first slice (S3/R2) is also the one with no external gatekeeper — a solo
  engineer controls it end to end.
- "Saved" means *confirmed at the destination* (out-of-band verify), fixing the hand-off blind spot.
- The design honestly carries one new optional host permission per connected bucket origin, and one
  honest asymmetry (server fetch for photos, client fetch for video).
- iCloud users get a documented manual path, not a fake "iCloud sync."

## Alternatives considered

- **Pipe everything through Convex (incl. video).** Rejected: OOMs in V8, fragile + double-egress
  in Node, risks the 10-min wall clock; and a cold server fetch of `video.twimg.com` is unreliable.
- **Presign with a bare PUT + trust `confirmUpload`.** Rejected: lets a compromised content script
  exfiltrate to the user's bucket and assert false success — the integrity blocker.
- **Client-side OAuth (`launchWebAuthFlow`) handing tokens to Convex.** Rejected in favor of
  Pattern B so the refresh token is never in the extension; `launchWebAuthFlow` remains an option
  only to *open* the consent URL.
- **iCloud via CloudKit app container.** Rejected: writes to an app-owned container the user can't
  see in their own iCloud — a "sync" that isn't, violating "trustworthy."
- **All five providers in one phase.** Rejected: hides weeks-long external review inside a single
  sprint and over-weights the popup into the forbidden "heavy dashboard."
