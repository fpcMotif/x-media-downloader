# Detected Media Set reconciliation design

**Date:** 2026-07-18

**Status:** Accepted for implementation

## Problem

ADR-0016 makes `MediaItem.id` the canonical Media Key and requires the latest
observation to own post metadata. The store updates `byId`, but only adds to its
derived indexes. When one id moves between posts, old URL, poster, and post-video
aliases can still resolve the old item. Old post bookkeeping also survives.

`recoveredKeys` causes the opposite error. Recovery can block a later Passive
observation of the same media forever, despite ADR-0016 making both paths share
one identity.

The shared store also imports X's DOM recovery detector even though
`PlatformAdapter.findMediaNeedingRecovery` is the existing platform seam.

## Chosen module

Keep the current synchronous `DetectionStore`. Make replacement one exact index
transaction.

```ts
interface DetectionDelta {
  readonly added: number
  readonly updated: number
  readonly changed: boolean
}

interface DetectionStore {
  reconcileDetected(items: ReadonlyArray<MediaItem>): DetectionDelta
  reconcileRecovered(items: ReadonlyArray<MediaItem>): DetectionDelta
  // Existing semantic queries, Recovery claims, code linkage, count, and clear.
}
```

`byId` remains authoritative. These reverse indexes make every projection
deletable:

- `keysById`: every direct or derived hover alias currently owned by an id.
- `videosByPost`: current video id at each post index.
- `derivedKeysByPost`: exact post-video aliases emitted by the last post sync.
- `postByCode` and `codesByPost`: the two directions of shortcode linkage.

A replacement detaches the prior item's aliases and video position, installs
the new item, then rebuilds derived aliases for only the old and new posts.
Alias assignment also removes the alias from any displaced owner's reverse
set. Existing `Map` insertion order preserves first-seen ordering.

The store stays free of DOM lookup, async Recovery, UI tokens, and caches.
`keyIndex()` and `resolve()` remain constant-time hover paths.

## Invariants

1. One id owns one current `MediaItem` and one current post.
2. `byKey[key]` exists exactly when its current owner records that key.
3. Replacing an item removes every alias and video position owned by its prior
   form before indexing its new form.
4. Post-video aliases are a projection of current videos and current codes.
5. Rebinding a code removes every alias derived for its old post before adding
   aliases for its new post.
6. Passive or rendered detection may replace Recovery metadata. Recovery never
   replaces a known item and never admits photos.
7. Recovery stays once per post per page. A failed extension send re-arms because
   no Recovery reply arrived; endpoint and body failures remain claimed per
   ADR-0015.
8. `clear()` clears all authoritative, reverse, derived, and claim state.
9. No reconciliation scans the whole Detected Media Set.

## Adapter boundary

Remove `DetectionStore.needsRecovery`. The overlay calls the active adapter's
optional `findMediaNeedingRecovery` port with the current key set. This keeps X
DOM knowledge inside the X adapter and skips the scan on platforms with no
Recovery port.

ADR-0016 remains the producer contract: a real adapter emits `MediaItem.id` from
the resolved media key. The store does not preserve obsolete alternate request
id schemes.

## Rejected designs

- **Large detection aggregate:** moving DOM fallback, async Recovery, cache,
  UI-token, and change-event policy into this store grows it from 317 to 621
  lines, rebuilds every index, and adds a stale recycled-element cache. The
  boundary gets wider internally and slower on pointer paths.
- **Remove only the old video slot:** leaves stale URL/poster aliases and code
  rebinds unfixed.
- **Treat each capture as a full snapshot:** tee responses and rendered scans
  are partial. Snapshot replacement would delete valid SPA accumulation.
- **Keep `recoveredKeys`:** preserves a pre-ADR dual-id workaround and blocks
  later authoritative metadata.

## Verification

- Move one video id between posts. Old media and post aliases vanish; the new
  aliases resolve the new item; count stays one.
- Replace an item's poster. The old poster no longer resolves.
- Recover a video, then observe the same canonical id passively. Metadata and
  post membership update; count stays one.
- Move a video out of a two-video post. Bare and indexed aliases converge.
- Rebind one shortcode between posts. No old indexed or slot alias survives.
- Clear. No item, alias, code, video, or Recovery claim survives.
- Prove the overlay uses the adapter Recovery seam.
- Run focused tests, Effect diagnostics, full check, build, and live extension
  checks on X, Instagram, and Threads.
