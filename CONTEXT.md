# CONTEXT — X Media Downloader

Domain glossary. Definitions only — no implementation detail. When code or specs
use these words, they mean exactly this.

## Core nouns

- **Media Item** — one downloadable piece of media (a _photo_, _video_, or _GIF_)
  belonging to a Post. The atomic unit of a download.
- **Media Key** — an adapter-local Media Item identity. It reconciles references
  to the same detected asset within that adapter; it is not a download identity.
- **Post** — one platform post. **Tweet** names an X Post. X carries at most four
  mixed media attachments.
- **Thread** — a chain of X Tweets by the same author in one conversation. The
  largest unit a single **Bulk** action grabs.
- **Handle** — the author's `@username`. Used for grouping and filenames.
- **Variant** — one of several encodings X offers for a video (differing
  bitrate/resolution). The highest-bitrate MP4 variant is the one kept.
- **Original quality** — the largest available rendition: `name=orig` for a
  photo, the highest-bitrate MP4 for a video.
- **Settings** — the durable choices and connection state that govern capture,
  saving, clearing, cloud behavior, and the interface. One Settings change
  applies to the extension as a whole, not to one view.

## Actions & flows

- **Bulk** — downloading every Media Item in one Post or X Thread in one user action.
- **Quick Grab** — the fastest path: hold a modifier (Option/Alt by default) and the
  single media item under the cursor downloads itself at Original quality after a short
  dwell. Resolves one hovered `<img>` to one Media Item; fires each item at most
  once per modifier press (the guard against a cursor sweep mass-downloading a grid).
- **Passive capture** — obtaining media references _solely_ from data the user's
  own browsing already fetched (the current platform's responses + rendered DOM). Issues
  **no** extra network requests. The default, policy-safe path.
- **Raw Capture** — one X JSON response observed during Passive capture. Always
  **untrusted** until validated.
- **Tweet Record** — one validated, normalized post stored in the durable local
  Capture archive (`xmd-capture`). Raw Captures are inputs; Tweet Records are
  archive facts.
- **Capture Archive** — one device's durable local collection of Tweet Records.
  It is the authority: it commits local records before admitted Capture Mirror
  work. A worker death or tab teardown in that exact gap leaves a local-only row
  and withholds the producer reply; the live producer retries the idempotent batch.
  The producer stamps each buffered record with the current durable erase epoch.
  The Archive rejects an old epoch before either durable sink. Clear broadcasts a
  wake; live tabs pause new stamping, use one-flight canonical pulls with capped
  retry backoff, then resume.
  Reads skip an unreadable row without hiding healthy neighbors. A later canonical
  capture of the same Tweet replaces that row. Erase removes all physical rows.
  Erasing purges pending mirror work, then this archive. Copies already sent to
  Convex remain.
- **Capture Mirror Admission** — the immutable consent and device identity
  attached when an all-or-none batch enters the Capture Archive. The outbox holds
  at most 2,000 pending records and 4 MiB. Admission never evicts existing work.
  Later enabling cannot backfill an older local-only batch because its consent is
  unknown.
- **Capture Mirror Outbox** — v2 pending Capture Mirror work. Its generation is
  opaque; normal writers reject corrupt state. Explicit **Erase** may replace
  corrupt state with a fresh UUID epoch, purge pending work, then erase the local
  archive. Pending merges use the Archive's rank-then-`capturedAt` law; admission
  time only schedules delivery. Before each remote mutation, the worker arms a
  watchdog, then rereads consent, destination, and credentials. Persisted retry
  deadlines rebase after wall-clock rollback. The shortened alarm is armed before
  its deadline is persisted. Legacy unbound pending work is retained but unsendable.
- **CaptureStored** — the local acceptance receipt. Its `mirror` result is
  `not-requested`, `accepted`, or `unavailable`. `unavailable` means the local
  batch was stored but could not enter the mirror outbox; the content script drops
  that local-success batch and warns. Every terminal receipt carries the current
  epoch; a stale receipt drops old-epoch buffered work without relabeling it.
- **Recovery** — actively re-requesting a single Media Item that Passive capture
  failed to observe, from X's public syndication endpoint — without authentication
  or credential replay. The one sanctioned exception to Passive capture; fires only
  for a media element visibly on the page whose
  reference was never captured (typically a video behind an SPA cache hit).
- **Settings Recovery** — the Options-only decision for corrupt, malformed, or
  unsupported durable Settings. Until resolved, the extension keeps the raw value
  untouched, uses Direct for local saves, and pauses Cloud Sync, Cloud upload,
  Clear, and Capture Mirror. **Repair** keeps valid known Settings and defaults
  invalid ones; **Reset** replaces all Settings with defaults. Both require a
  fresh fingerprint confirmation.

## Modules (by responsibility, not implementation)

- **Platform Descriptor** — data-only platform identity: platform tag, page
  match patterns, CDN rules, and exact URL matcher. The Platform Catalog owns
  the three descriptors (X, Instagram, Threads). Manifest, worker, offscreen,
  Popup, and Options code may depend on this catalog without loading DOM logic.
- **Source Adapter** — turns one platform's captured responses and rendered DOM
  into Media Items. It is composed from that platform's descriptor and owns response
  admission/parsing, DOM detection, hover resolution, and optional Recovery.
  Only the MAIN and ISOLATED content scripts load the behavior registry.
- **Resolver** — normalizes raw media references into Original-quality Media Items
  (photo upgrade, Variant selection, de-duplication).
- **Start Queue** — bounds concurrent strategy start calls. The Transfer Registry
  owns durable transfer truth.
- **Download Strategy** — _how_ bytes reach disk, independent of the Media Item.
  **Direct** = hand the URL to the browser's downloader. **Fetched** = retrieve the
  bytes first, checks the HTTP response type, and streams files up to 15 MiB
  (one SW gateway uses 256 KiB chunks, holds durable Blob leases through terminal
  download state, and owns the browser hand-off while the offscreen document only
  mints/revokes Blob URLs). Capture exports reuse that gateway. Bulk archives split
  between JSONL records into 15 MiB parts; later parts wait for the four-lease
  working set to free capacity. Registry `ready` means no response has opened;
  Gateway Blob Lease `ready` means a Blob URL is finalized. Header/idle staging
  is capped at 25 seconds and total staging at four minutes. One module owns every typed Transfer or Capture
  lease. It does not hash or inspect file bytes. **aria2** =
  hand the URL to a user-run
  aria2c daemon over JSON-RPC for fast/resumable transfers to an arbitrary dir.
  Direct is the default; Fetched and aria2 are opt-in. A strategy consumes a
  **Save Request** (a global media artifact id + `url` + relative `filename`) and returns a **Download
  Handle** (a browser download id, or an aria2 gid).
- **Sidecar Request ID** — the distinct global artifact id of one optional metadata
  sidecar. It never derives from a filename suffix.
- **Media Fetch** — the sole worker-owned GET/HEAD path for media bytes and
  metadata. It accepts only a registered CDN URL, preserves the caller's abort
  signal, and rejects redirects. The caller owns any returned final response
  body. Direct and aria2 do not use Media Fetch: Chrome or the daemon owns their
  network path after the worker validates the initial URL.
- **Terminal Outcome** — the observed end state of a browser handle or aria2 GID:
  `complete` or `failed`. Browser evidence comes from Chrome; aria2 evidence comes
  from `tellStatus`. `complete` is terminal evidence, not proof that a browser file
  still exists. Only the later **Settle** probe can authorize Clear. Terminal
  projection owns ordered durable sinks: Clear (browser evidence only), Fetched
  lease release, Download History, Sync, and Budget. Metrics and Overlay correction
  follow as best-effort projections. Only browser transfers have a Chrome download
  id, so only they can enter the Clear-after-download path.
- **Transfer Registry** — the durable local v4 owner of browser and aria2
  transfer intent, identity correlation, retries, observations, and terminal
  projection. Initial work is `*-prepared` until Clear and cloud admission
  commit. The durable permit moves it to `direct-ready`, Fetched `ready`, or
  `aria2-ready`. Boot ignores prepared work and resumes ready work. Each armed
  phase commits immediately before its one external start call. Old v3 launching
  phases remain uncertain. It never guesses whether an ambiguous launch ran.
  Every durable state that needs work has an alarm lease before its write commits;
  armed/live phases renew a watch that never repeats their external call. Boot
  alone quarantines an interrupted call.
  The Start Queue only bounds Direct and aria2 start calls; Fetched returns
  deferred after durable enqueue and starts from a Registry wake.
- **Clock Port** — an injected time seam. The Transfer Registry uses
  `src/background/transfer-registry.ts` for browser probes, retries, and projection
  deadlines. Clear uses `src/background/clear-state-store.ts` through its
  completion and destructive-drive modules. Tests supply deterministic clocks;
  the real adapters alone use timers and alarms. The temporal sibling is the
  **Settle Port**: Clock schedules work; Settle observes a download's bytes.
- **Settle** — the confirmation that a browser **Download Handle**'s recorded
  `complete` truly landed on disk. After a short window the byte is re-probed
  (`chrome.downloads.search`, behind the **Settle Port**) so a late
  post-`complete` interrupt is caught first. The sole gate on the irreversible
  **Clear** (the opt-in auto un-bookmark / un-like on save): a download that
  cannot be confirmed landed is a _late interrupt_, never a Settle, so the Clear
  never fires on bytes that never arrived. The verdict is pure (`core/clear`);
  the **Settle Port** is its injected probe seam — real `chrome.downloads.search`
  in the service worker, a fixture row in tests.
- **Sweep** (“One by one”) — a user-requested batch over detected media in the
  currently mounted Likes or Bookmarks posts. It waits for a durable Clear seed
  before claiming each Worklist row. Exact Registry ownership commits before
  receipt acknowledgement. Starts, retries, and terminal projection remain
  blocked until boot repair opens the confirmed barrier. It never scrolls or queues a later DOM click.
  Scrolling and rerunning discovers more posts.
- **Visibility Pulse** — the bounded list of mounted X Tweet ids sent when X
  virtualizes new articles into view. The background retries already-durable,
  Truly Complete Clears only for those exact ids and that sender tab.
- **Sidecar** — an optional `.json` file saved next to a Media Item recording its
  provenance (author, URL, post id, type). Opt-in; rides the same download path as
  a `data:` URL (no extra permissions).
- **Detected Media Set** — the collection of Media Items found on the current
  page, de-duplicated by Media Key, with its current hover aliases, post
  membership, and bounded Recovery claims. A later Passive observation replaces
  Recovery metadata. The set drives the **Bulk** count and every **Selection**.
- **Selection** — the user's current pick of Media Items, built by grabbing a
  single item, a whole Post, or a whole X Thread. Resolving a Selection re-indexes
  each Post's chosen items contiguously from 0 (so naming stays gap-free).
- **Metrics / Snapshot** — download-efficiency monitoring. **Metrics** is a pure
  reducer over timestamped byte samples + state transitions; a **Snapshot** is its
  projection (throughput, ETA, completed/failed/retry counts, concurrency
  utilization) that the Popup polls.
- **Overlay** — the in-page controls that appear on hover over a media element
  (the fast path).
- **Popup** — the toolbar panel: Start Queue manager + Settings + Monitor (the
  manager path).
- **Cloud Provider** — a record describing Google Drive or Dropbox identity:
  display label, OAuth config, host patterns, Settings-field layout, and
  token-revocation recipe. The Cloud Provider Session owns connection state,
  token refresh, and one explicit dispatch to the Drive or Dropbox byte
  adapter; Drive alone resolves a root folder. The registry is keyed by provider
  id. The remote-path sibling of the **Download Strategy** seam.
- **Cloud Ownership Transition** — durable intent to replace or disconnect one
  Cloud Provider owner. It pauses that provider's admissions and retries. The
  new Settings owner commits the transition and discards the prior owner's
  work; the old owner aborts it without data loss. Reconnecting the same owner
  keeps its work. Any third owner leaves the transition blocked. A user-requested
  reconnect or disconnect recovers it by discarding that provider's ambiguous
  work before recording the new intent.
- **Cloud Sync** — opt-in (default **off**) mirroring of download-state metadata
  into a user-supplied Convex deployment. It never carries media bytes, Raw
  Captures, or credentials. **Capture Mirror** is a separate opt-in that mirrors
  validated Tweet Record text and link metadata, never media bytes or auth data
  (ADR-0018).
- **Sync Event** — one append-only Cloud Sync state transition
  (`queued`/`completed`/`failed`) for a Save Request, carrying a deterministic
  idempotency id and, for `queued`, the Media Item's provenance.
- **Sync Outbox** — the local queue of not-yet-delivered Sync Events; drains FIFO
  in small batches with exponential backoff, so downloads never depend on
  connectivity to the cloud.
- **Clear Worklist Projection Outbox** — the bounded `xmd-clear` IDB queue that
  bridges atomic Clear facts to the separate `storage.local` Worklist. It
  coalesces by post and scope, persists the Worklist first, then exact-acks. A
  recurring alarm is established before any producer commit or Clear click.
- **Download Record** — the durable local record of one Save Request's outcome:
  its Original-quality media URL (the original link), filename, status
  (`queued` / `completed` / `failed`), Media Item provenance (Handle, Post,
  type), and timestamps. Keyed by the Save Request — the local-first counterpart
  of a Cloud Sync `media_state` row, carrying the same provenance by construction.
- **Download History** — the durable, bounded, **local** collection of Download
  Records the Popup shows. **Opt-in** (off by default). Survives service-worker
  recycling and browser restart — unlike the **Snapshot**, which is ephemeral and
  live. Independent of **Cloud Sync**, which mirrors the same outcomes remotely
  only when separately enabled. Clear snapshots the Transfer Registry's exact
  terminal-pending projection ids into a durable reset fence. Their later replay
  cannot restore erased rows or Saved indexes; a later terminal identity may appear.

## Boundaries (what these are NOT)

- **`pbs.twimg.com` / `video.twimg.com`** are X's public **media CDNs**, not X's
  official developer API. This project never uses the official API.
- **`host_permissions`** is a _Chrome_ grant to this extension, unrelated to any
  X API authorization.
