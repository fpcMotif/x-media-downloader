# Convex Link Catalog + Cloud Destinations — Design Spec

- **Date:** 2026-06-14
- **Status:** Approved — core architecture adopted as canonical (2026-06-14 session); §9 sign-offs resolved. Supersedes the
  earlier auto-generated "Convex catalog + cloud mirror backup" draft committed in `36a0d7a`.
- **Decisions:** ADR-0011 (local-first privacy reframe), ADR-0012 (Convex catalog + sync seam),
  ADR-0013 (server-side cloud destinations, byte path, provider phasing).
- **Source:** 13-agent design pass (5 grounding · 5 design · 3 adversarial critics), 2026-06-14.
- **Builds on (Phase 1):** the shipped Convex metadata mirror + durable local history on branch
  `claude/elegant-franklin-g4ofol` (its ADR-0009/0010). **Open reconciliation:** that mirror uses
  `sync_events`/`media_state` + an Outbox; this spec's `catalogItems`/`syncItems` are a second
  design of the same seam and must be unified with it **when Phase 1 lands** (settle during
  implementation — out of scope for this design cycle).

## 1. Overview

An **opt-in, off-by-default** capability that lets a user defend grabbed X media against
link-rot and copy it into their own cloud storage. It layers on the existing passive
download pipeline without changing it.

Two layered features:

1. **Catalog sync** — the original media link + metadata for items the user chose to grab is
   upserted into a **Convex** backend (deduped by `MediaItem.id`), giving a durable record and
   per-item status. This is the part the user named first: *"sync the media original links into
   Convex."*
2. **Cloud Destinations** — optionally, the media bytes are copied to the user's own
   **Cloudflare R2 / AWS S3**, **Dropbox**, or **Google Photos**. **Apple iCloud** has no
   third-party upload API and is handled as a documented hand-off, not a build target (§7, ADR-0013).

The **uploads to clouds run server-side in Convex** (the user's locked decision): provider
secrets and OAuth tokens live only in Convex, never in the extension bundle.

### Goals

- A durable, deduped catalog of grabbed media links in Convex, surfaced as honest per-item status.
- Optional bring-your-own-cloud copies, with credentials that never touch the extension.
- Preserve the brand: *Fast, restrained, trustworthy.* Strictly opt-in; the local download path
  is untouched and the default experience is unchanged.
- Honest status that fixes the known hand-off blind spot ("saved" must mean *landed*, not *started*).

### Non-goals

- No change to passive capture or the local download default. Sync never fires for passively
  captured media the user didn't choose.
- No telemetry, no analytics tables, no cross-user reads.
- No turning the toolbar popup into a credential-management dashboard (PRODUCT.md anti-reference).
  Connection management lives on a separate options page (§6).
- iCloud is **not** a build target this cycle (§7).

## 2. The privacy tension (must be resolved first — ADR-0011)

PRODUCT.md today sells *"a **local-only** Chrome extension … without handing their account data
or media URLs to a remote downloader"* and *"Keep privacy visible through restraint: local-only,
minimal permissions, no telemetry."* CONTEXT.md adds the project *"never uses the official [X] API"*.

Catalog sync and cloud upload are, by construction, **not local-only**: links (and for some media,
bytes) leave the device for a remote backend and third-party clouds. This is reconciled — not
papered over — by ADR-0011:

- **Reframe** the promise from *"local-only"* to **"local-first; optional, user-controlled cloud
  sync, off by default."** The default install behaves exactly as today.
- **Strictly opt-in, layered consent:** a master toggle gates the feature; **each destination
  connection is its own consent gate** with provider-specific copy (what leaves, where it lands,
  under whose account/terms, what scope, and that already-uploaded objects are *not* removed by
  disconnect). Enabling sync is *not* consent to send media to Google.
- **Catalog metadata is treated as sensitive**, not "modest": `handle + tweetId + timestamps` per
  saved item is a behavioral profile. It is minimized, TTL'd by default, and disclosed.
- **User-owns-deletion:** a visible "Disconnect & wipe" purges catalog/jobs/tokens.

## 3. Architecture

```
  ┌──────────────────────────── EXTENSION (unchanged core) ─────────────────────────┐
  │  overlay/popup ──grab──▶ background SW ──(existing)──▶ browser download to disk   │
  │                                │                                                  │
  │                         [sync seam — opt-in, fail-closed, never blocks download]  │
  │                                │ on download COMPLETE (onChanged) or on-demand     │
  │                                ▼                                                   │
  │                         local:sync-queue (durable buffer; survives SW recycle)    │
  │                                │ flush                                            │
  │                         ConvexHttpClient.syncItems(items, connectionIds?)          │
  │                                │                  ▲ presign PUT for video (§5.3)   │
  └────────────────────────────────┼──────────────────┼───────────────────────────────┘
                                    ▼                  │
  ┌──────────────────────────────── CONVEX ───────────┼───────────────────────────────┐
  │  tables: users · catalogItems · cloudConnections · uploadJobs   (no media bytes)   │
  │  mutation syncItems → upsert catalog + enqueue one uploadJob per enabled connection │
  │  action  runJob ("use node"):                                                      │
  │     pipe   (photo/GIF <~8MB): fetch twimg → push to provider  (bytes transit here) │
  │     presign(video/large):     mint PUT URL → extension streams twimg→cloud direct ─┘
  │  httpAction /oauth/:provider/callback (Pattern B) · cron retry-sweeper             │
  │  destinations: R2 · S3 (one SigV4 path) · Dropbox · Google Photos                 │
  └────────────────────────────────────────────────────────────────────────────────────┘
                       ▲ reactive queries (live status, popup only — page context)
  popup status line / options-page connections ◀────────────────────────────────────────┘
```

Convex holds **metadata only**; media bytes never live in a Convex row (§5.1 limits). The local
download to disk is the user's primary copy and is never altered.

## 4. Convex backend

Full schema, function list, secrets model, auth, and the large-video decision are specified in
detail in **ADR-0012** and the appendix `convex/` file map. Summary:

- **Tables (all `userId`-scoped):** `users` (keyed by JWT `subject`), `catalogItems` (deduped by
  `(userId, mediaId)`), `cloudConnections` (per-user config + **AES-GCM-sealed** tokens — never
  read by any public query), `uploadJobs` (deduped by `idempotencyKey`, retry/backoff columns).
- **The one extension-facing write:** `syncItems(items, connectionIds?)` — idempotent catalog
  upsert + one job per enabled connection. Re-syncing the same item is a no-op write.
- **Function-kind discipline:** public mutations/queries never touch a secret; twimg fetch and
  provider uploads happen only in `"use node"` actions; status transitions are `internalMutation`s.
- **Retry:** a 1-min cron sweeps `failed` jobs on exponential backoff (index-driven, never
  `.filter()`); `MAX_ATTEMPTS ≈ 5` then `dead` (terminal, user action).
- **Idempotency, three guards:** one job per `idempotencyKey`; `runJob` early-returns on
  `succeeded`/`dead` **and takes a short `running` lease** (compare-and-set, closes the
  sweeper/resync double-fire window — critic C1/#6); provider-level (`S3 IfNoneMatch:"*"`,
  Dropbox autorename, Google upload-token).

## 5. The byte path (the load-bearing decision — ADR-0013)

Convex actions cannot buffer large video: **V8 action memory is 64 MiB, Node `"use node"` is
512 MiB**, action wall-clock 10 min, args/returns 16 MiB (Node action args 5 MiB). Twitter video
at original quality is commonly 20–80 MB and reaches X's 512 MB ceiling. So a single path cannot
serve both photos and video.

### 5.1 `pipe` mode — photos / GIFs (< ~8 MB)

Bytes transit a Convex Node action: `fetch(sourceUrl)` → push to provider SDK → mark `succeeded`.
Safe within memory. `pbs.twimg.com` photo URLs are served cookielessly, so a **server-side fetch
is reliable** for this class. A 403/410 marks the item `sourceGone` (honest skip, not a fake save).

### 5.2 `presign` mode — video / anything over `PIPE_MAX_BYTES`

Convex mints a **presigned PUT** (S3/R2: first-class; Dropbox: upload-session URL; Google Photos:
resumable upload URL) and the **extension streams twimg → cloud directly**. Chosen because:

- It keeps large bytes out of Convex compute/egress entirely.
- **The extension carries the live X session/referer that `video.twimg.com` needs.** Verified
  reality (critic C1/#2): video URLs carry a `?tag=` param that 403s, are signed/expiring, and
  redirect on the CDN — a cold server fetch is materially riskier than the prose first assumed.
  Letting the extension do the video fetch is *more* robust, not just a memory workaround.

This is the honest asymmetry to state in the spec: **photo/GIF fetch is server-side; video fetch
is client-side.** The "uploads run server-side" promise still holds for *where credentials live and
where the cloud PUT is authorized* — Convex signs every upload; the extension never holds a
long-lived cloud credential.

### 5.3 Three blockers this mode created, and their resolutions

The presign path is the riskiest part of the design. The critics found three real holes; the spec
adopts these fixes (ADR-0013):

1. **Manifest contradiction (C1/#1 — BLOCKER):** an MV3 service-worker `fetch` PUT to a cloud
   bucket *requires that host in permissions* — so "zero upload host permissions" and
   presign-from-extension are mutually exclusive. **Resolution:** request the specific upload
   origin as a **runtime `optional_host_permissions`** at destination-connect time (mirrors the
   existing aria2/offscreen opt-in). **Lead with R2** — `https://<acct>.r2.cloudflarestorage.com`
   is a *stable, enumerable* host; for S3 use path-style/single-region endpoints so the origin is
   enumerable too. State this honestly; do not claim zero host permissions.
2. **Integrity / SSRF bypass (C2/#1 — BLOCKER):** presign + `confirmUpload` let a compromised
   content script PUT arbitrary bytes to a fixed key and *assert* success. **Resolution:** use a
   **presigned POST with policy conditions** (pinned `Content-Type`, `content-length-range`, single
   server-chosen key) instead of a bare PUT; the streaming runs in the **background SW only** (never
   the content script, which lives in X's hostile context); and Convex **verifies out-of-band**
   (`HeadObject` on the key) before marking `uploaded` — `confirmUpload` is a hint, not the
   authority.
3. **SSRF allow-list vs twimg redirects (C1/#3, C2/#5):** exact-host allow-list
   (`pbs.twimg.com`, `video.twimg.com`) with **manual redirect handling that re-runs the full
   guard on every hop** (bounded), plus blocking RFC-1918/link-local/metadata IPs at the socket
   level. Validate **every** url-typed field that could be fetched (`url` *and* `previewUrl`).

## 6. Settings & UI

- **Schema (Effect Schema, all OFF by default, corrupt-recovery defaults):** `cloudSyncEnabled`
  (master), `syncTrigger` (`onDownload` | `onDemand` | `both`), `cloudConvexUrl` (**no default** —
  the user pastes their own deployment; a vendor-hosted default is forbidden by ADR-0011),
  `defaultDestinationIds: string[]`. Connection state lives in Convex, not settings.
- **Popup stays light:** one master toggle, the **load-bearing disclosure gate**, and a single
  quiet status line (e.g. *"Catalog: 412 items safe · 3 syncing"*). **No provider matrix, no
  Library grid, no new Monitor stats in the popup.** Per-item status reuses the existing badge
  states with two best-effort additions (`syncing`, `synced`).
- **Connections live on a separate options page** (`options_ui`): Connect/Disconnect per provider,
  OAuth buttons, per-destination enable, and the per-destination consent copy. Credential
  management is a sit-down task, not an in-flow tool — this keeps the popup as "precise tools, not
  a second app" (PRODUCT.md). Critic C3/#4.
- **Status is popup-driven, not pushed:** an MV3 SW cannot reliably push live status to an open
  overlay (it recycles ~30 s after work; the upload finishes server-side later). The popup holds a
  reactive Convex client while open and is the source of truth; the badge ends at `saved`/`syncing`
  and is reconciled lazily via `local:sync-mirror` (written by an alarm-woken poll, read by the
  overlay through `storage.watch`). No claim of real-time server→badge push. Critic C1/#5.

## 7. Apple iCloud — documented hand-off, not a build target

Confirmed by research (R2/R3) and both security and product critics: **there is no public API to
write a user's iCloud Photos or iCloud Drive from a server or extension.** CloudKit reaches only an
*app-owned* container (a backup the user can't see in their own iCloud — which would be a
trust-violating "iCloud sync" that isn't). The only honest path is a manual **Apple Shortcuts
hand-off** that (a) requires an already-connected R2/S3 to stage the object, (b) requires the user
on an Apple device, (c) is manual with no read-back.

**Decision (ADR-0013):** do **not** build iCloud this cycle and do **not** render an iCloud row in
the UI. Document it in "Out of scope / why," and revisit only on real demand *after* R2 mirroring
ships, as a derived/dependent destination of an S3/R2 staging bucket (with the staged URL's expiry
surfaced in the Shortcut). This removes the iCloud adapter, the CloudKit decision, and the
provider-dependency modeling for zero user-value loss.

## 8. Edge cases & failure model

- **MV3 SW death:** sync writes go through a durable `local:sync-queue`; flush triggers are
  download-complete and popup-open for the MVP (the `chrome.alarms` backstop + `online`-event flush
  are Phase 2 — and the `alarms` permission is added only when that ships, per "minimal permissions").
- **twimg expiry (the blind spot):** freshness budget on capture→fetch latency; classify
  `403-with-?tag` distinctly from `403-expired`; a HEAD probe before committing a pipe job; honest
  `skipped`/`sourceGone` rather than a false "saved."
- **Disconnect honesty:** revoke provider grant *first*, delete the row *second*; if revoke fails,
  mark `revoke-failed` rather than reporting clean success. The wipe dialog states plainly that
  *files already uploaded to your cloud remain there* with a deep link to the provider.
- **Object-key safety:** every key is namespaced under a server-controlled, per-user prefix the
  client cannot influence; re-sanitized for object-storage semantics (no leading `/`, normalized
  unicode, capped segments). `mediaId` is treated as opaque; resurrecting a dead job re-validates
  the URL through the SSRF guard.
- **Object layout & sidecar:** the server-derived key folders by `{handle}/{tweetId}/{file}` (a
  fixed server template, **not** client input — preserves the key-safety guarantee above), and an
  optional `{file}.json` provenance sidecar (tweet, handle, original `url`, type) is written as a
  sibling object. Mirrors the local Sidecar (ADR-0007); off by default.
- **Tier-1 auth is anonymous-data-only:** the catalog-only milestone may bootstrap a device JWT
  from a bundled `EXTENSION_SHARED_SECRET` (extractable). It is acceptable **only** for a
  single-tenant/self-hosted deployment, must run the SSRF allow-list + per-device quotas, and the
  server **enforces in code** that *no `cloudConnections` row can be created under a `device`
  issuer* — real per-user OAuth (Tier 2) is required before any cloud token is stored. Critic C2/#7.

## 9. Recommended phasing (for sign-off — ADR-0013)

Sequenced by **shipping gate**, not code effort, because Google Photos and Dropbox carry
weeks-long external review the engineer can't control.

- **Phase 0 — prototype (throwaway, `/prototype`):** fake in-memory provider; validate
  catalog → status → trigger *feel*.
- **Phase 1 — MVP (the only thing to commit now):** Convex backend + Tier-1 (self-host) or Convex
  Auth, `catalogItems` + `syncItems` (catalog **link** sync, deduped) + durable `local:sync-queue`
  + 3-state status (`pending`/`safe`/`failed`) in the popup + the disclosure gate + the PRODUCT.md
  local-first reframe. Optionally a **single zero-setup durable copy in Convex file storage** so
  link-rot is defended with no cloud account connected (this is the strongest first-run value — see
  §9 open question). **No** bring-your-own-cloud, **no** provider matrix, **no** video/presign path.
- **Phase 2a — S3/R2 bring-your-own:** the one provider class with *no* external review (user
  provisions SigV4 keys). Adds the presign/video path + SSRF allow-list + runtime host-permission +
  the options page.
- **Phase 2b — Dropbox:** App-folder scope; **kick off Dropbox production approval the day the
  OAuth flow works** (50-user cap until approved), in parallel.
- **Phase 3 — Google Photos (demand-gated):** `photoslibrary.appendonly`; gated on a prerequisite
  task — *published privacy policy + verified domain + CASA budget (~$500–$4,500/yr) approved* —
  as a visible dependency, not an afterthought. Plus Library view, retry sweeper hardening, and
  **backfill** — best-effort re-upload of already-cataloged history (some source URLs will have
  rotted → honest `sourceGone`, never a fake save).
- **Dropped:** iCloud (§7).

### Resolved (2026-06-14 session)

1. **Byte path / Convex storage → provider-as-durable.** Convex **never stores** bytes (no
   zero-setup Convex-storage copy). Photos *transit* a Convex action (`pipe`); video presigns +
   streams extension→cloud. This overrides the recommendation in item 1 below.
2. **iCloud → dropped** (document-only hand-off; no UI row). Reconciled from an earlier
   "stub-seam" instinct — there is no upload API to build a seam against.
3. **Connections UI → separate options page.**
4. **Auth → Convex Auth** from day one.

### Open decisions for the user (§9 sign-off) — superseded by "Resolved" above

1. **Byte path / Convex storage:** Phase-1 MVP = link-catalog only (as literally requested), **or**
   also store a zero-setup durable byte copy in Convex storage (stronger link-rot defense, a Convex
   storage bill, "we hold your bytes" liability)? *Recommendation: link-catalog + opt-in Convex
   storage copy, because link-rot defense with zero cloud setup is the strongest first-run value.*
2. **iCloud:** confirm dropping the build (document-only). *Recommendation: drop.*
3. **Connections UI:** confirm separate options page vs popup. *Recommendation: options page.*
4. **Auth:** Tier-1 device-secret for a self-hosted single-user deployment, or Convex Auth from
   day one (needed for any shared/multi-user deployment)? *Recommendation: Convex Auth from day one
   unless this is strictly your own private deployment.*

## 10. Testing

- **Vitest (pure units):** the sync state machine + 3-state status reducer; `idempotencyKey` /
  object-key derivation + sanitizer; the SSRF allow-list guard (allow pbs/video.twimg, reject
  redirects to non-allowlisted hosts, reject RFC-1918); settings schema additions incl.
  corrupt-recovery defaults; the `local:sync-queue` buffer (enqueue/flush/dedupe).
- **Convex:** function-level tests for `syncItems` idempotency (re-sync = no dup job), the
  lease/early-return guards, and the retry sweeper backoff selection.
- **Manual:** the disclosure + per-destination consent gates; reduced-motion; a real
  `ext_tw_video`/`ampl_video` URL through the presign path before claiming video works.
- **No change** to the existing passive/download test surface.

## 11. References

- Design pass transcript: workflow `wf_daa5b500-5d7` (13 agents), 2026-06-14.
- ADR-0011 / ADR-0012 / ADR-0013.
- Convex limits: docs.convex.dev/production/state/limits (verified in pass).
- Provider research (R2/R3): S3+R2 SigV4 sharing; Dropbox production approval; Google Photos
  `appendonly` post-March-2025 + CASA; iCloud no-server-API.
