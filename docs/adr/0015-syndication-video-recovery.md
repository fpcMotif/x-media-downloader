# ADR-0015 — Syndication fallback: recover tee-missed videos

- **Status:** Accepted (2026-06-20)

## Context

Media detection has two paths with **asymmetric type coverage**:

- The **passive GraphQL tee** (ADR-0001) copies X's own `TweetDetail` /
  timeline responses and resolves photos **and** videos/GIFs (the MP4 url lives
  only in `extended_entities.media[].video_info`).
- The **DOM fallback** (`detectRenderedImageElements`) reads rendered `<img>`
  under `pbs.twimg.com/media/` — **photos only**. A `<video>` has a `blob:`
  `currentSrc` and its poster lives under `…_video_thumb…` (not `/media/`), so a
  video is **structurally invisible** to the DOM scan.

When the tee never sees a tweet — an **SPA cache hit** (X serves a clicked-into
tweet from its in-memory store with no network request), a **lazy-loaded reply**,
or a render that beat the `document_start` patch — detection falls back to the
DOM. The sibling photos are still counted; the video is silently dropped. A
"video + 3 photos" tweet reads as **3**, and the video is neither counted nor
downloadable (its MP4 url never reached the extension). This was the reported
bug on a single-video tweet whose count showed only its photo siblings.

The MP4 url cannot be derived from the DOM. The only no-auth source is X's public
embed endpoint, `cdn.syndication.twimg.com/tweet-result`, which returns the MP4
variants (and a computed embed token, react-tweet's formula) for any public tweet.

## Decision

Add a **syndication fallback** that recovers a tee-missed video on demand.

- **Pure module** (`core/adapters/x/syndication.ts`): `isTweetId` (digits guard),
  `syndicationToken` (canonical embed token), `syndicationUrl` (builds the
  `tweet-result` URL or `null` for a non-id), and `parseSyndicationTweet` — which
  maps the endpoint's flat top-level `mediaDetails[]` (already the `RawMedia`
  shape) through the existing `resolveTweetMedia` (highest-bitrate MP4,
  `name=orig` photos). Unit-tested to 100%.
- **DOM detector** (`videoTweetsNeedingRecovery`, `core/adapters/x/index.ts`):
  returns the tweet ids whose rendered video player has a poster media-key absent
  from the already-detected keys. A teed video contributes its poster key (its
  `previewUrl`), so it is correctly skipped; de-duplicated by tweet id.
- **Background fetch** (`background/syndication-recovery.ts`): a
  `RecoverTweetMediaRequest { tweetId }` handler accepts only a 1–20 digit
  snowflake, builds the fixed URL, and streams at most 64 KiB of UTF-8 JSON in
  the service worker (which holds the host permission, so CORS — the endpoint
  allows only `platform.twitter.com` — does not apply). `Content-Length` rejects
  known oversize responses; the stream count catches a missing or lying header;
  cancellation stops the reader. Any invalid, failed, cancelled, or oversize
  response becomes the stable tag-only `RecoverTweetMediaResponse`. The content
  script parses a present body. Nothing page-supplied beyond the validated id
  steers the fetch, so there is no SSRF surface.
- **Overlay wiring** (`overlay.content`): the rendered-media scan calls
  `recoverMissingVideos`, which fires one request per flagged tweet id (an
  `recoveryAttempted` set bounds it to once per page session) and folds the
  recovered video into the detected set via `reconcileRecovered` — **video/GIF
  only**, key-deduped, so a DOM-detectable photo is never re-added. ADR-0016 now
  gives Passive capture and Recovery one Media Key identity: Recovery inserts
  only an absent asset, while a later Passive observation replaces its metadata
  without changing the count.
  A bounded `settleRenderedScan` (two short timers) re-scans after mount /
  locationchange so an async-mounted player is caught without a scroll.

### Bounded scope (decisions, deliberately)

- **Active fetch, not passive** — this is a deliberate, narrow deviation from
  ADR-0001's "the tee issues no requests of its own." It fires **only** for a
  video we provably failed to capture, to one read-only X-owned host. The tee
  stays passive; recovery is a separate, explicit path.
- **Required host permission** — `cdn.syndication.twimg.com/*` is added to
  required (not optional) `host_permissions` so the count is correct out of the
  box; it is read-only and narrow, alongside the already-required `x.com`.
- **Background-proxied** — content-script fetch from `x.com` is CORS-blocked by
  the endpoint; the SW with host permission is the only path that works.
- **Videos/GIFs only** — photos are always DOM-recoverable and carry a different
  id scheme, so recovery deliberately ignores them.
- **64 KiB response cap** — the current real endpoint fixture is 3,053 bytes;
  64 KiB matches the existing export-fragment budget, leaves more than 21×
  headroom, and stays well below the 256 KiB Capture-record budget. The endpoint
  returns metadata for at most four X media attachments, never media bytes.

## Consequences

- A tee-missed video is **counted and downloadable** (its MP4), closing the
  "video + N photos → N" undercount. The hover/Quick-Grab and "Download all"
  paths see it because its poster key now maps to the recovered item.
- One extra network request per genuinely-missed video per page session; zero
  when the tee already captured the tweet (the common case).
- New pure test surfaces (`syndication`, `videoTweetsNeedingRecovery`).

## Known limitations

- **Quoted-tweet videos** attribute to the outer article's id, so the outer
  tweet's syndication is fetched — it lacks the quoted video, which stays
  uncounted (the tee normally covers quoted media via `quoted_status_result`).
- A transient syndication failure (e.g. 429) is not retried within the page
  session; "Find new media" clears `recoveryAttempted` to retry.
- Recovery rides the rendered-media scan (mount / scroll / locationchange +
  settle timers), not a persistent observer, to avoid cost on X's churn — so a
  player that mounts long after those, with no scroll, is caught only on the next
  scan.

## Alternatives considered

- **Auth-replay `TweetResultByRestId`** (ADR-0001's fallback design) — recovers
  via X's authenticated GraphQL, but the bearer/csrf capture-and-replay machinery
  is unbuilt; syndication needs none.
- **DOM-detect the video without its MP4** — would fix the count but leave it
  un-downloadable (no url), misleading the user.
- **Persistent MutationObserver for players** — instant recovery, but a standing
  cost on X's constant timeline mutation; the bounded settle-scan is sufficient.
