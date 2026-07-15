import type { MediaItem } from '../schema'

/**
 * Derives the stable media key a URL resolves to on the active platform, or
 * `null` if the URL isn't a grabbable media preview — `PlatformAdapter.mediaKeyFromUrl`'s
 * own signature (see `core/adapters/types.ts`). Injected here rather than
 * imported, because this module used to hardcode X's own `mediaKeyFromUrl`
 * (from `x/dom.ts`): for an Instagram/Threads MediaItem (a `cdninstagram.com`
 * url), that always returned `null`, so `byKey` never got an entry for any
 * non-X item — tee-detected Instagram/Threads media could never be found by
 * hover lookup at all, a real bug found via live testing, not a hypothetical.
 */
export type MediaKeyDeriver = (url: string) => string | null

/**
 * The media keys an item can be matched by: its resolved `url` and its
 * `previewUrl` (a video's poster), de-duplicated, via the ACTIVE platform's
 * own key-derivation rule. A hovered `<img>`/poster maps back to its MediaItem
 * through one of these.
 */
export function keysForItem(item: MediaItem, mediaKeyFromUrl: MediaKeyDeriver): string[] {
  const keys = new Set<string>()
  const primary = mediaKeyFromUrl(item.url)
  const preview = item.previewUrl ? mediaKeyFromUrl(item.previewUrl) : null
  if (primary) keys.add(primary)
  if (preview) keys.add(preview)
  return [...keys]
}

/**
 * The whole-post grab payload: the hovered `item` unioned with every already-
 * detected item of its post (`store.valuesForTweet(postId)`), de-duped by id
 * with the hovered item first. Guarantees at least the hovered item, so a post
 * the tee hasn't fully captured yet still grabs what's known.
 */
export function postGrabItems(item: MediaItem, postItems: readonly MediaItem[]): MediaItem[] {
  const byId = new Map<string, MediaItem>()
  byId.set(item.id, item)
  for (const it of postItems) if (!byId.has(it.id)) byId.set(it.id, it)
  return [...byId.values()]
}

/** The post-level hover key for a single-video post, keyed by a DOM-walked
 *  shortcode (`post:code:{code}`). Exported so adapters' `postKeyFromVideoElement`
 *  can derive the identical string from a DOM-walked shortcode without
 *  importing store internals — this is the ONLY key shape a DOM caller can
 *  ever query with, since a DOM walk only ever yields a shortcode, never the
 *  tee's raw `postId`. Namespaced separately from the store's internal
 *  postId-keyed entry (see `postVideoKeyById` below) so an accidental string
 *  collision between an unrelated post's raw `postId`/`pk` and another post's
 *  shortcode can never cause one to silently overwrite the other. */
export function postVideoKey(code: string): string {
  return `post:code:${code}`
}

/** The store's internal post-level hover key, keyed by the tee's own
 *  `postId` (`post:id:{postId}`) — never queried by a DOM caller (nothing
 *  DOM-side ever has the raw postId), kept namespaced apart from
 *  `postVideoKey`'s code-keyed space purely as defense-in-depth. Exported
 *  (test-only consumer today) so tests can assert on the postId-keyed
 *  entry directly rather than reaching into `byKey` some other way. */
export function postVideoKeyById(postId: string): string {
  return `post:id:${postId}`
}

/** NEW: the post-level hover key for slide `index` of a multi-video (or
 *  mixed) carousel post, keyed by DOM-walked shortcode. `index` is the
 *  ABSOLUTE per-post `MediaItem.index` for platforms that can supply one
 *  (Instagram). Kept alongside (never replacing) `postVideoKey`: a post with
 *  exactly one video registers BOTH the no-index and the `index:0` indexed
 *  form (see `syncPostVideoKey`), so a caller that always derives an indexed
 *  key works uniformly regardless of video count, while a caller still
 *  querying the bare no-index key keeps working too. */
export function postVideoKeyIndexed(code: string, index: number): string {
  return `post:code:${code}:${index}`
}

/** Sibling of {@link postVideoKeyIndexed}, keyed by the tee's own `postId`
 *  instead of a DOM-walked shortcode — same posture as `postVideoKeyById`
 *  vs `postVideoKey`. */
export function postVideoKeyByIdIndexed(postId: string, index: number): string {
  return `post:id:${postId}:${index}`
}

/** NEW: Threads-only. A hover key that names "the Nth video encountered SO
 *  FAR while walking this specific container's mounted video elements in DOM
 *  order," NOT a stable absolute post-index — see the Threads adapter's
 *  `postKeyFromVideoElement` for how it's derived and why. Registered as an
 *  always-present alias for every registered video (index 0 included)
 *  regardless of platform — the store doesn't need an `if (threads)` branch;
 *  only Threads' resolver ever queries it. Deliberately NOT a general
 *  primitive: this is a documented degraded-precision fallback for a
 *  platform that can only supply a window-relative slide position, not an
 *  absolute post-wide index. */
export function postVideoKeyByDomSlot(code: string, domSlot: number): string {
  return `post:code:${code}:slot:${domSlot}`
}

/**
 * The page's Detected Media Set (CONTEXT.md): every Media Item found on the
 * current page plus how each was obtained, behind one object. Owns the dual index
 * — by `id` (the download/count identity) and by media key (hover resolution) —
 * the recovered-key provenance, and the per-tweet recovery-attempt guard, so the
 * overlay holds one store instead of four loose maps. Pure of `chrome.*`/timers;
 * `needsRecovery` reads the DOM (happy-dom-testable, like the rest of the adapter).
 *
 * Shared across platforms (moved out of `core/adapters/x/` — this store itself
 * has no X-specific logic once `mediaKeyFromUrl` and `findMediaNeedingRecovery`
 * are injected). Recovery is a capability, not a platform branch: an adapter
 * that supplies `findMediaNeedingRecovery` (X's syndication pass) gets a
 * DOM-walked recovery scan; one that omits it (Instagram/Threads — no no-auth
 * public fallback exists) makes `needsRecovery` a constant `[]` with no DOM
 * walk, so the overlay needs no platform-string guard at the
 * `recoverMissingVideos` call site.
 */
export interface DetectionStore {
  /** Add Passive-capture / DOM items; returns the newly-added (deduped by id),
   *  skipping any media already recovered from syndication (different id scheme). */
  addDetected(items: ReadonlyArray<MediaItem>): MediaItem[]
  /** Add syndication-recovered items; only the DOM-invisible kinds (video/GIF)
   *  whose key the tee/DOM doesn't already know. Records their keys as recovered. */
  addRecovered(items: ReadonlyArray<MediaItem>): MediaItem[]
  /** Tweet ids whose rendered video the store hasn't captured (for Recovery). */
  needsRecovery(root: ParentNode): string[]
  /** Claim a tweet for one recovery fetch; false if already attempted. */
  markAttempted(tweetId: string): boolean
  /** Release a recovery claim so a transient failure can retry. */
  unmarkAttempted(tweetId: string): void
  /** The Media Item a hovered media key resolves to. */
  resolve(key: string): MediaItem | undefined
  /** Read-only media-key → item index, for the hover resolvers that take a Map. */
  keyIndex(): ReadonlyMap<string, MediaItem>
  /** The Media Item for a download/request id. */
  get(id: string): MediaItem | undefined
  /** Every detected Media Item, in first-seen order. */
  values(): MediaItem[]
  /** Detected Media Items belonging to one tweet. */
  valuesForTweet(tweetId: string): MediaItem[]
  /** Every media-key the by-key index holds for one post (url, poster, and
   *  `post:…` video keys alike) — the whole-post grab marks all of these. */
  keysForTweet(tweetId: string): string[]
  /**
   * Register postId <-> DOM-shortcode linkage (Instagram/Threads only — see
   * `PlatformAdapter.extractPostCodes`) so a DOM-derived shortcode (which
   * never carries the tee's own `postId`, e.g. Instagram's numeric `pk` vs
   * its `/p/{code}/` shortcode) can still resolve the same `post:{...}`
   * lookup key `postKeyFromVideoElement` computes from the DOM alone. A
   * no-op-safe call for a postId that never gets a video registered (the key
   * simply never appears in `keyIndex()`). Order-independent relative to
   * `addDetected` — whichever runs first, the post-video key still converges
   * once both have run.
   */
  registerPostCode(postId: string, code: string): void
  /**
   * The tee's own `postId` for a DOM-derived post shortcode — the inverse of
   * {@link registerPostCode}'s linkage — or `undefined` if no tracked response
   * has linked that `code` yet. Lets a whole-post grab resolve every media item
   * of the hovered post from its DOM shortcode even when the hovered media's own
   * url key never matched a tee item (Instagram/Threads photos, whose rendered
   * `<img>` basename can differ from the tee's captured basename).
   */
  postIdForCode(code: string): string | undefined
  /** How many Media Items are detected (the Bulk count). */
  readonly count: number
  /** Drop everything — items, keys, recovered-key provenance, and attempts. */
  clear(): void
}

export function makeDetectionStore(deps: {
  readonly mediaKeyFromUrl: MediaKeyDeriver
  /** Optional recovery scan — `PlatformAdapter.findMediaNeedingRecovery`'s own
   *  signature. Absent (IG/Threads: no public no-auth fallback exists) ⇒
   *  `needsRecovery` is a constant `[]` with NO DOM walk. */
  readonly findMediaNeedingRecovery?: (
    root: ParentNode,
    detectedKeys: ReadonlySet<string>,
  ) => string[]
}): DetectionStore {
  const byId = new Map<string, MediaItem>()
  const byKey = new Map<string, MediaItem>()
  const recoveredKeys = new Set<string>()
  const attempted = new Set<string>()
  // Video MediaItems seen so far, grouped by postId, keyed by each video's OWN
  // per-post `MediaItem.index` (not itemId) — index doubles as both the map's
  // dedup key (a post's own slide occupies exactly one index) and the exact
  // quantity `postKeyFromVideoElement` needs to produce a key for. A post
  // whose tee-parsed items skip an index (e.g. index 1 is a photo, not a
  // video) is fine — the map simply has no entry there, same as today's Map
  // already tolerates gaps in itemId-space.
  const videosByPost = new Map<string, Map<number, MediaItem>>() // postId -> (index -> item)
  const codeToPostId = new Map<string, string>() // DOM shortcode -> tee postId
  // Which indexed/dom-slot keys this store last registered for a postId, so a
  // re-sync (a video superseded/removed) can precisely clear stale entries
  // instead of a blind sweep.
  const registeredIndicesByPost = new Map<string, Set<number>>()

  const syncPostVideoKey = (postId: string): void => {
    const videos = videosByPost.get(postId)
    const count = videos?.size ?? 0
    const single = count === 1 ? [...videos!.values()][0]! : null
    const idKey = postVideoKeyById(postId)
    const codesForPost = [...codeToPostId].filter(([, p]) => p === postId).map(([c]) => c)

    if (single) byKey.set(idKey, single)
    else byKey.delete(idKey)
    for (const code of codesForPost) {
      const codeKey = postVideoKey(code)
      if (single) byKey.set(codeKey, single)
      else byKey.delete(codeKey)
    }

    // Indexed + dom-slot keys: clear whatever this postId previously
    // registered, then re-add for every currently-known video (count===1
    // included, so a caller that always derives an indexed key works
    // uniformly regardless of video count).
    const prevIndices = registeredIndicesByPost.get(postId) ?? new Set<number>()
    for (const index of prevIndices) {
      byKey.delete(postVideoKeyByIdIndexed(postId, index))
      byKey.delete(postVideoKeyByDomSlot(postId, index))
      for (const code of codesForPost) {
        byKey.delete(postVideoKeyIndexed(code, index))
        byKey.delete(postVideoKeyByDomSlot(code, index))
      }
    }
    const nextIndices = new Set<number>()
    for (const [index, item] of videos ?? []) {
      byKey.set(postVideoKeyByIdIndexed(postId, index), item)
      byKey.set(postVideoKeyByDomSlot(postId, index), item)
      for (const code of codesForPost) {
        byKey.set(postVideoKeyIndexed(code, index), item)
        byKey.set(postVideoKeyByDomSlot(code, index), item)
      }
      nextIndices.add(index)
    }
    registeredIndicesByPost.set(postId, nextIndices)
  }

  const addDetected = (items: ReadonlyArray<MediaItem>): MediaItem[] => {
    const added: MediaItem[] = []
    const touchedPosts = new Set<string>()
    for (const item of items) {
      const keys = keysForItem(item, deps.mediaKeyFromUrl)
      // A video the tee re-surfaces after we recovered it (different id scheme)
      // would otherwise be counted twice — suppress by recovered key.
      if (keys.some((k) => recoveredKeys.has(k))) continue
      if (!byId.has(item.id)) added.push(item)
      byId.set(item.id, item)
      for (const key of keys) byKey.set(key, item)
      if (item.type === 'video') {
        let videos = videosByPost.get(item.postId)
        if (!videos) {
          videos = new Map()
          videosByPost.set(item.postId, videos)
        }
        videos.set(item.index, item)
        touchedPosts.add(item.postId)
      }
    }
    for (const postId of touchedPosts) syncPostVideoKey(postId)
    return added
  }

  const addRecovered = (items: ReadonlyArray<MediaItem>): MediaItem[] => {
    const added: MediaItem[] = []
    for (const item of items) {
      // Photos are always DOM-detectable (different id scheme) — re-adding here
      // would double-count; only video/GIF need recovery.
      if (item.type === 'photo') continue
      const keys = keysForItem(item, deps.mediaKeyFromUrl)
      // Already known to the tee or DOM → nothing to recover.
      if (keys.some((k) => byKey.has(k))) continue
      added.push(item)
      byId.set(item.id, item)
      for (const key of keys) {
        byKey.set(key, item)
        recoveredKeys.add(key)
      }
    }
    return added
  }

  return {
    addDetected,
    addRecovered,
    needsRecovery: (root) => deps.findMediaNeedingRecovery?.(root, new Set(byKey.keys())) ?? [],
    markAttempted: (tweetId) => {
      if (attempted.has(tweetId)) return false
      attempted.add(tweetId)
      return true
    },
    unmarkAttempted: (tweetId) => {
      attempted.delete(tweetId)
    },
    resolve: (key) => byKey.get(key),
    keyIndex: () => byKey,
    get: (id) => byId.get(id),
    values: () => [...byId.values()],
    valuesForTweet: (tweetId) => [...byId.values()].filter((i) => i.postId === tweetId),
    keysForTweet: (tweetId) => {
      const out: string[] = []
      for (const [key, item] of byKey) if (item.postId === tweetId) out.push(key)
      return out
    },
    registerPostCode: (postId, code) => {
      codeToPostId.set(code, postId)
      syncPostVideoKey(postId) // re-sync NOW in case the video(s) were already
      // added before the code linkage arrived (order-independent)
    },
    postIdForCode: (code) => codeToPostId.get(code),
    get count() {
      return byId.size
    },
    clear: () => {
      byId.clear()
      byKey.clear()
      recoveredKeys.clear()
      attempted.clear()
      videosByPost.clear()
      codeToPostId.clear()
      registeredIndicesByPost.clear()
    },
  }
}
