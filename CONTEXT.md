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
- **Download Strategy** — *how* bytes reach disk. **Direct** = hand the URL to the
  browser's downloader. **Fetched** = retrieve the bytes first to verify or
  repackage them. Direct is the default; Fetched is opt-in.
- **Overlay** — the in-page controls that appear on hover over a media element
  (the fast path).
- **Popup** — the toolbar panel: Download Queue manager + Settings (the manager path).

## Boundaries (what these are NOT)

- **`pbs.twimg.com` / `video.twimg.com`** are X's public **media CDNs**, not X's
  official developer API. This project never uses the official API.
- **`host_permissions`** is a *Chrome* grant to this extension, unrelated to any
  X API authorization.
