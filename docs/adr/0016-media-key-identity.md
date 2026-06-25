# ADR-0016 — Media-key identity for Media Items

- **Status:** Accepted (2026-06-21)

## Context

A `MediaItem.id` is the unit of identity used to de-duplicate the **Detected
Media Set**, key the launcher count (`store.count`), correlate a download
(`SaveRequest.id` == `TransferOutcome.requestId`, ADR-0014), match an interrupt
retry, and name the `.json` sidecar. But `id` was assigned **three different ways**
depending on which path produced the item:

- the tee / Resolver → `legacy.media[].id_str` (X's numeric media id),
- the DOM resolver (`resolveImageElement`) → `` `${tweetId}-${index}` ``,
- an anchor-less quote card → the bare media key.

So the **same** photo seen by both the tee and the DOM scan got two different ids
and was counted (and could be queued) **twice** — a suspected double-count the
syndication-recovery review surfaced. The recovery path (ADR-0015) papered over
the video case with a `recoveredKeys` guard, but the underlying identity was
incoherent.

This change rides the **DetectionStore** extraction (the overlay's four detection
containers — `byId` / `byKey` / `recoveredKeys` / `recoveryAttempted` — consolidated
into `core/adapters/x/detection-store.ts`, behavior-preserving). The store made the
identity the single thing left to fix.

## Decision

**Identify every Media Item by its Media Key** (CONTEXT.md): the basename of the
**resolved url** (the `/media/` photo or the chosen MP4), the same value
`mediaKeyFromUrl` derives for hover matching.

- `resolveTweetMedia` (tee / syndication) and `resolveImageElement` (DOM) both set
  `id = basenameId(url)` — `id_str` and `${tweetId}-${index}` are gone. The same
  media now yields the same id from any path.
- `tweetId` and `index` remain fields on the item (the filename template uses them,
  `download/filename.ts` — never the id), so filenames are unchanged.
- The grain is **pure media key**, not a `${tweetId}:${mediaKey}` composite.

This was safe to change because **no production code parses the id scheme**:
`isMirrorableRequest` only checks `!endsWith('.json')`, nothing reconstructs a
tweetId from an id, and download↔outcome correlation only needs the id to be
*consistent*, which it now is. (Two test fixtures derived a tweetId via
`id.split('-')` — harmless no-ops on a dash-free media key.)

## Consequences

- The tee-vs-DOM double-count is **gone**: same media → same id → counted once,
  queued once (a regression test pins each: `resolver.test.ts` and
  `xadapter.test.ts` assert tee and DOM agree on `id`).
- `SaveRequest.id` stays unique per distinct media (the store collapses duplicates
  *before* the download queue, so no colliding requests reach correlation).
- Identity is now coherent across all detection paths, so the `recoveredKeys`
  belt-and-suspenders in the DetectionStore is redundant (kept, harmless).

## Known limitations (the accepted trade-off)

- **The same image in two different tweets on one page now collapses to one item
  and downloads once**, filed under whichever tweet surfaced it **last**
  (last-writer wins on `tweetId`/`index`). Previously each tweet got its own copy.
  Sweep / clear-on-save for that media then key off the last-writer tweet. This is
  the deliberate cost of pure-media-key identity.

## Alternatives considered

- **`${tweetId}:${mediaKey}` composite** — fixes the double-count (same tweet, same
  media → one) *without* the cross-tweet collapse, and keeps per-tweet copies. A
  more surgical change. Rejected in favor of the simpler pure key: cross-tweet
  duplication is rare, and one identity axis is easier to reason about than two.
- **Keep the dual id/key model, just de-dup the count** — leaves the incoherent
  identity in place (download/sidecar/correlation still see two ids for one media);
  treats the symptom, not the cause.
