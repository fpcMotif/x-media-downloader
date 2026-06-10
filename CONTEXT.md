# CONTEXT — X Media Downloader

Domain glossary. Definitions only — no implementation detail. When code or specs
use these words, they mean exactly this.

## Core nouns

- **Media Item** — one downloadable piece of media (a *photo*, *video*, or *GIF*)
  belonging to a Tweet. The atomic unit of a download.
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
  single photo under the cursor downloads itself at Original quality after a short
  dwell. Resolves one hovered `<img>` to one Media Item; fires each photo at most
  once per modifier press (the guard against a cursor sweep mass-downloading a grid).
- **Passive capture** — obtaining media references *solely* from data the user's
  own browsing already fetched (X's own responses + the rendered DOM). Issues
  **no** extra network requests. The default, policy-safe path.
- **Capture** — a single X response (JSON) observed during Passive capture.
  Always **untrusted** until validated.
- **Auth fallback** — an opt-in, default-**off** escalation that replays exactly
  one authenticated request to reach Media Items not yet loaded. **Not** passive;
  never enumerates a profile.

## Components (by responsibility, not implementation)

- **Source Adapter** — turns a site's page + Captures into Media Items. X is the
  only adapter today; the seam exists so others could be added.
- **Resolver** — normalizes raw media references into Original-quality Media Items
  (photo upgrade, Variant selection, de-duplication).
- **Download Queue** — saves Media Items to disk: rate-limited, resilient to
  interruption and to the browser pausing background work.
- **Download Strategy** — *how* bytes reach disk, independent of the Media Item.
  **Direct** = hand the URL to the browser's downloader. **Fetched** = retrieve the
  bytes first to verify or repackage them. **aria2** = hand the URL to a user-run
  aria2c daemon over JSON-RPC for fast/resumable transfers to an arbitrary dir.
  Direct is the default; Fetched and aria2 are opt-in. A strategy consumes a
  **Save Request** (`id` + `url` + relative `filename`) and returns a **Download
  Handle** (a browser download id, or an aria2 gid).
- **Sidecar** — an optional `.json` file saved next to a Media Item recording its
  provenance (author, url, tweetId, type). Opt-in; rides the same download path as
  a `data:` URL (no extra permissions).
- **Selection** — the user's current pick of Media Items, built by grabbing a
  single item, a whole Tweet, or a whole Thread. Resolving a Selection re-indexes
  each Tweet's chosen items contiguously from 0 (so naming stays gap-free).
- **Metrics / Snapshot** — download-efficiency monitoring. **Metrics** is a pure
  reducer over timestamped byte samples + state transitions; a **Snapshot** is its
  projection (throughput, ETA, completed/failed/retry counts, concurrency
  utilization) that the Popup polls.
- **Overlay** — the in-page controls that appear on hover over a media element
  (the fast path).
- **Popup** — the toolbar panel: Download Queue manager + Settings + Monitor (the
  manager path).

## Boundaries (what these are NOT)

- **`pbs.twimg.com` / `video.twimg.com`** are X's public **media CDNs**, not X's
  official developer API. This project never uses the official API.
- **`host_permissions`** is a *Chrome* grant to this extension, unrelated to any
  X API authorization.
