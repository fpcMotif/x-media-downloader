# ADR-0016 — Media-key identity for Media Items

- **Status:** Accepted (2026-06-21)

## Context

A `MediaItem.id` is the adapter-local **Media Key**. It de-duplicates the
**Detected Media Set** and keys the launcher count (`store.count`). Global media
and sidecar save artifacts use distinct Save Request IDs. This ADR records the
earlier X Media Key decision. At the time, `id` was assigned **three different ways**
depending on which path produced the item:

- the tee / Resolver → `legacy.media[].id_str` (X's numeric media id),
- the DOM resolver (`resolveImageElement`) → `` `${tweetId}-${index}` ``,
- an anchor-less quote card → the bare media key.

So the **same** photo seen by both the tee and the DOM scan got two different ids
and was counted (and could be queued) **twice** — a suspected double-count the
syndication-recovery review surfaced. The recovery path (ADR-0015) papered over
the video case with a `recoveredKeys` guard, but the underlying identity was
incoherent.

This change rides the **DetectionStore** extraction (the overlay's detection
containers consolidated behind one synchronous store). The store made identity
the single thing left to fix.

## Decision

**Identify every X Media Item by its X Media Key** (CONTEXT.md): the basename of
the **resolved url** (the `/media/` photo or the chosen MP4), the same value
`mediaKeyFromUrl` derives for X hover matching. Media Keys remain adapter-local;
Instagram and Threads own their identity derivation.

- `resolveTweetMedia` (tee / syndication) and `resolveImageElement` (DOM) both set
  `id = basenameId(url)` — `id_str` and `${tweetId}-${index}` are gone. The same
  media now yields the same id from any path.
- `postId` and `index` remain fields on the item. The filename engine uses them,
  never `id`; legacy `{tweetId}` remains an alias for `{postId}`. Filenames are
  unchanged.
- The grain is **pure media key**, not a `${tweetId}:${mediaKey}` composite.
- DetectionStore replacement is transactional: it removes every URL, poster,
  post-membership, and post-video alias owned by the prior form before filing the
  latest item. Passive capture may replace Recovery metadata; Recovery never
  replaces a known asset.

This was safe to change because production code did not parse the prior id scheme.
Global request identity is now explicit: `mediaRequestId(item)` and
`sidecarRequestId(item)` produce injective, versioned artifact IDs. Ordinary
non-reserved X Media Keys retain their raw form only for persisted compatibility.
No consumer infers artifact kind from a `.json` suffix.

## Consequences

- The tee-vs-DOM double-count is **gone**: same media → same id → counted once,
  queued once (a regression test pins each: `resolver.test.ts` and
  `xadapter.test.ts` assert tee and DOM agree on `id`).
- A global media Save Request ID stays unique per distinct media (the store
  collapses duplicates before admission, so no colliding requests reach correlation).
- X identity is coherent across its detection paths. The obsolete
  `recoveredKeys` guard is removed because it blocked later Passive metadata and
  post ownership.

## Known limitations (the accepted trade-off)

- **The same image in two different tweets on one page now collapses to one item
  and downloads once**, filed under whichever tweet surfaced it **last**
  (last-writer wins on `tweetId`/`index`). Previously each tweet got its own copy.
  Sweep / clear-on-save for that media then key off the last-writer tweet. This is
  the deliberate cost of pure-media-key identity.

## Alternatives considered

- **`${tweetId}:${mediaKey}` composite** — fixes the double-count (same tweet, same
  media → one) _without_ the cross-tweet collapse, and keeps per-tweet copies. A
  more surgical change. Rejected in favor of the simpler pure key: cross-tweet
  duplication is rare, and one identity axis is easier to reason about than two.
- **Keep the dual id/key model, just de-dup the count** — leaves the incoherent
  identity in place (download/sidecar/correlation still see two ids for one media);
  treats the symptom, not the cause.
