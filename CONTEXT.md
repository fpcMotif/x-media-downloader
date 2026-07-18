# CONTEXT — X Media Downloader

Domain glossary. Definitions only — no implementation detail. When code or specs
use these words, they mean exactly this.

## Core nouns

- **Media Item** — one downloadable piece of media (a _photo_, _video_, or _GIF_)
  belonging to a Tweet. The atomic unit of a download.
- **Media Key** — the stable identity of a piece of media, derived from its CDN
  URL and shared by every reference to it (the rendered image, the poster frame of
  a video, the resolved download). Two references with the same Media Key **are**
  the same media — the basis for de-duplication.
- **Tweet** — a single X post. Carries up to four photos, **or** one video,
  **or** one GIF.
- **Thread** — a chain of Tweets by the same author in one conversation. The
  largest unit a single **Bulk** action grabs.
- **Handle** — the author's `@username`. Used for grouping and filenames.
- **Variant** — one of several encodings X offers for a video (differing
  bitrate/resolution). The highest-bitrate MP4 variant is the one kept.
- **Original quality** — the largest available rendition: `name=orig` for a
  photo, the highest-bitrate MP4 for a video.

## Actions & flows

- **Bulk** — downloading every Media Item in a Tweet or Thread in one user action.
- **Quick Grab** — the fastest path: hold a modifier (Option/Alt by default) and the
  single media item under the cursor downloads itself at Original quality after a short
  dwell. Resolves one hovered `<img>` to one Media Item; fires each item at most
  once per modifier press (the guard against a cursor sweep mass-downloading a grid).
- **Passive capture** — obtaining media references _solely_ from data the user's
  own browsing already fetched (X's own responses + the rendered DOM). Issues
  **no** extra network requests. The default, policy-safe path.
- **Capture** — a single X response (JSON) observed during Passive capture.
  Always **untrusted** until validated.
- **Auth fallback** — an opt-in, default-**off** escalation that replays exactly
  one authenticated request to reach Media Items not yet loaded. **Not** passive;
  never enumerates a profile.
- **Recovery** — actively re-requesting a single Media Item that Passive capture
  failed to observe, from X's public embed endpoint — **without** authentication
  or credential replay (distinct from Auth fallback). The one sanctioned exception
  to Passive capture; fires only for a media element visibly on the page whose
  reference was never captured (typically a video behind an SPA cache hit).

## Components (by responsibility, not implementation)

- **Source Adapter** — turns a site's page + Captures into Media Items. Three
  Source Adapters exist today (X, Instagram, Threads), registered in the
  platform registry (`ALL_ADAPTERS`, `src/core/adapters/registry.ts`); the
  registry's `hostMatch` drives both content scripts' `matches`.
- **Resolver** — normalizes raw media references into Original-quality Media Items
  (photo upgrade, Variant selection, de-duplication).
- **Download Queue** — saves Media Items to disk: rate-limited, resilient to
  interruption and to the browser pausing background work.
- **Download Strategy** — _how_ bytes reach disk, independent of the Media Item.
  **Direct** = hand the URL to the browser's downloader. **Fetched** = retrieve the
  bytes first to verify or repackage them. **aria2** = hand the URL to a user-run
  aria2c daemon over JSON-RPC for fast/resumable transfers to an arbitrary dir.
  Direct is the default; Fetched and aria2 are opt-in. A strategy consumes a
  **Save Request** (`id` + `url` + relative `filename`) and returns a **Download
  Handle** (a browser download id, or an aria2 gid).
- **Terminal Outcome** — what a browser **Download Handle** finally resolves to
  after hand-off: `complete` (bytes landed on disk) or `failed` (interrupted /
  gone). The single point from which one download's result fans out to every
  durable record of it — the **Metrics / Snapshot**, **Download History**, the
  `completed` / `failed` **Sync Event**, and the badge correction the **Overlay**
  shows. An aria2 hand-off has no Terminal Outcome — it is terminal the moment it
  is handed off.
- **Retry Scheduler** — the owner of an interrupted browser transfer's second
  chance. A **Download Handle** that ends `interrupted` for a transient reason
  (network / server / file-transient) is re-tried with exponential backoff
  (2s/4s/8s, capped) rather than failed; a non-retryable reason (user-cancelled,
  forbidden, disk-full) fails at once. The retry *decision* — whether, how long,
  and the CDN-url refresh before re-firing — is pure (`core/download`
  interrupt-retry), folding the **Transfer Tracker** and **Metrics** transitions
  into its result exactly as **Terminal Outcome** does. The Retry Scheduler is its
  effectful shell (`src/core/download/retry-queue.ts`'s `makeRetryQueue`): it
  holds the in-flight retry queue (durable across SW recycle, ADR-0005) and the
  timer wheel behind its own injected **Clock Port** and **Download Port**,
  applying the pure result's intents. A retry that exhausts its attempts hands off
  to the **Terminal Outcome** as `failed`. It owns the boot tie-break with the
  **Transfer Tracker** — an id it owns (`ownedIds`) is reconciled by it alone,
  never double-driven.
- **Clock Port** — the injected timer seam (`schedule(fn, ms): CancelHandle`), so
  scheduled work runs against a fake clock in tests instead of `vi.useFakeTimers()`.
  Realized by the **Drain**'s Clock in `core/clear` (`scroll-drain.ts` /
  `list-clear.ts`) and, as of `src/core/download/retry-queue.ts`, by the **Retry
  Scheduler**'s own minimal port (a deliberately different shape from the Drain's
  `{ sleep, after }` Clock — retry-specific, not shared), and by **Settle**'s
  confirm-window timer (`SettleClock` in `clear-session.ts`, injected via
  `deps.clock`; its tests drive a hand-rolled fake clock in the `retry-plan.ts`
  idiom). The one scheduled-work holdout still on a raw timer is the
  stuck-download watchdog's `setInterval` in `entrypoints/background.ts` — kept
  inline by decision (round-7 review: no duplication, defense-in-depth exists;
  extraction judged uniformity polish). The temporal sibling of the **Settle
  Port**: this one *schedules* work, that one *observes* a download's bytes.
- **Settle** — the confirmation that a browser **Download Handle**'s recorded
  `complete` truly landed on disk. After a short window the byte is re-probed
  (`chrome.downloads.search`, behind the **Settle Port**) so a late
  post-`complete` interrupt is caught first. The sole gate on the irreversible
  **Clear** (the opt-in auto un-bookmark / un-like on save): a download that
  cannot be confirmed landed is a _late interrupt_, never a Settle, so the Clear
  never fires on bytes that never arrived. The verdict is pure (`core/clear`);
  the **Settle Port** is its injected probe seam — real `chrome.downloads.search`
  in the service worker, a fixture row in tests.
- **Drain** (Scroll Drain) — the recovery path for a **Clear** whose Tweet is not
  currently mounted. X virtualizes the timeline (only a small window of articles
  sits in the DOM at once), so a Clear firing seconds after its download settles
  often cannot find its post. Rather than drop it, the not-mounted Clear is queued;
  the Drain scrolls the Likes/Bookmarks list from the top to surface each pending
  post and fires its Clear as the post mounts, then restores the user's original
  scroll position. Bounded — it gives up after a budget of passes that surface
  nothing new. Runs only on a list page (Likes/Bookmarks), never the For You feed.
- **Sidecar** — an optional `.json` file saved next to a Media Item recording its
  provenance (author, url, tweetId, type). Opt-in; rides the same download path as
  a `data:` URL (no extra permissions).
- **Detected Media Set** — the collection of Media Items found on the current
  page, de-duplicated by Media Key, together with how each was obtained (Passive
  capture vs. Recovery). The basis for the **Bulk** count.
- **Metrics / Snapshot** — download-efficiency monitoring. **Metrics** is a pure
  reducer over timestamped byte samples + state transitions; a **Snapshot** is its
  projection (throughput, ETA, completed/failed/retry counts, concurrency
  utilization) that the Popup polls.
- **Overlay** — the in-page controls that appear on hover over a media element
  (the fast path).
- **Popup** — the toolbar panel: Download Queue manager + Settings + Monitor (the
  manager path).
- **Cloud Provider** — a record describing one cloud byte-upload destination
  (Google Drive, Dropbox): its OAuth config, host patterns, display label,
  Settings-field layout, token-revocation recipe, and a factory that builds its
  **Cloud Destination** (the provider-agnostic byte sink, ADR-0013). The single
  place provider identity is encoded — the upload orchestrator reads the record
  and never forks on the provider. The registry is keyed by provider id; two
  providers exist today. The remote-path sibling of the **Download Strategy**
  seam (Direct / Fetched / aria2).
- **Cloud Sync** — opt-in (default **off**) mirroring of download-state
  *metadata* into a user-supplied Convex deployment. Never carries media
  bytes, Captures, or credentials.
- **Sync Event** — one append-only Cloud Sync state transition
  (`queued`/`completed`/`failed`) for a Save Request, carrying a deterministic
  idempotency id and, for `queued`, the Media Item's provenance.
- **Outbox** — the local queue of not-yet-delivered Sync Events; drains FIFO
  in small batches with exponential backoff, so downloads never depend on
  connectivity to the cloud.
- **Download Record** — the durable local record of one Save Request's outcome:
  its Original-quality media URL (the original link), filename, status
  (`queued` / `completed` / `failed`), Media Item provenance (Handle, Tweet,
  type), and timestamps. Keyed by the Save Request — the local-first counterpart
  of a Cloud Sync `media_state` row, carrying the same provenance by construction.
- **Download History** — the durable, bounded, **local** collection of Download
  Records the Popup shows. **Opt-in** (off by default). Survives service-worker
  recycling and browser restart — unlike the **Snapshot**, which is ephemeral and
  live. Independent of **Cloud Sync**, which mirrors the same outcomes remotely
  only when separately enabled.

## Boundaries (what these are NOT)

- **`pbs.twimg.com` / `video.twimg.com`** are X's public **media CDNs**, not X's
  official developer API. This project never uses the official API.
- **`host_permissions`** is a _Chrome_ grant to this extension, unrelated to any
  X API authorization.
