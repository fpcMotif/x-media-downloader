import { decodeMediaItem, MAX_MEDIA_POST_ID_LENGTH, type MediaItem } from '../schema/media'

/** Maximum Posts retained by one page epoch. Eviction always removes a whole Post. */
export const MAX_DETECTED_POSTS = 256

/** Maximum Media Items one Source Adapter may retain for one Post. */
export const MAX_DETECTED_ITEMS_PER_POST = 64

/** A Post has one canonical shortcode; bounded aliases tolerate transient envelopes. */
export const MAX_POST_CODE_ALIASES = 4

/** Meta shortcodes are currently tiny; leave room for future opaque identifiers. */
export const MAX_POST_CODE_LENGTH = 128

/** Recovery is once per Post and bounded per route epoch. */
export const MAX_RECOVERY_ATTEMPTS_PER_PAGE = 256

const isBoundedPostIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_MEDIA_POST_ID_LENGTH

const isBoundedPostCode = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_POST_CODE_LENGTH

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

export interface DetectionDelta {
  readonly added: number
  readonly updated: number
  readonly changed: boolean
}

/**
 * The page's Detected Media Set (CONTEXT.md). `byId` is authoritative; every
 * hover and post-video key is a replaceable projection. The store is synchronous
 * and platform-neutral so pointer paths remain constant-time.
 */
export interface DetectionStore {
  /** Reconcile Passive-capture or rendered items. Latest metadata wins by id. */
  reconcileDetected(items: ReadonlyArray<MediaItem>): DetectionDelta
  /** Admit only absent Recovery videos. Passive detection may replace them later. */
  reconcileRecovered(items: ReadonlyArray<MediaItem>): DetectionDelta
  /** Claim a tweet for one recovery fetch; false if already attempted. */
  markAttempted(tweetId: string): boolean
  /** Release a claim when the extension send failed before Recovery replied. */
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
   * `reconcileDetected` — whichever runs first, the post-video key converges
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
  /** Drop every item, projection, code link, and Recovery claim. */
  clear(): void
}

function sameMediaItem(left: MediaItem, right: MediaItem): boolean {
  return (
    left.id === right.id &&
    left.platform === right.platform &&
    left.postId === right.postId &&
    left.author === right.author &&
    left.type === right.type &&
    left.url === right.url &&
    left.previewUrl === right.previewUrl &&
    left.ext === right.ext &&
    left.index === right.index &&
    left.width === right.width &&
    left.height === right.height &&
    left.bitrate === right.bitrate
  )
}

export function makeDetectionStore(deps: {
  readonly mediaKeyFromUrl: MediaKeyDeriver
}): DetectionStore {
  const byId = new Map<string, MediaItem>()
  const byKey = new Map<string, MediaItem>()
  const keysById = new Map<string, Set<string>>()
  const attempted = new Set<string>()
  // A carousel slot has one occupant, regardless of media type. Video aliases
  // are a projection of this truth, never a second ownership model.
  const occupantsByPost = new Map<string, Map<number, string>>()
  const postByCode = new Map<string, string>()
  const codesByPost = new Map<string, Set<string>>()
  const derivedKeysByPost = new Map<string, Map<string, MediaItem>>()
  const postsByRecency = new Map<string, undefined>()

  const detachAlias = (key: string): void => {
    const owner = byKey.get(key)
    if (owner !== undefined) keysById.get(owner.id)?.delete(key)
    byKey.delete(key)
  }

  const setAlias = (key: string, item: MediaItem): void => {
    detachAlias(key)
    byKey.set(key, item)
    let owned = keysById.get(item.id)
    if (owned === undefined) {
      owned = new Set()
      keysById.set(item.id, owned)
    }
    owned.add(key)
  }

  const detachOwnedAliases = (id: string): void => {
    const owned = keysById.get(id)
    if (owned === undefined) return
    for (const key of owned) {
      if (byKey.get(key)?.id === id) byKey.delete(key)
    }
    keysById.delete(id)
  }

  const detachExpectedAlias = (key: string, expected: MediaItem): void => {
    if (byKey.get(key) !== expected) return
    keysById.get(expected.id)?.delete(key)
    byKey.delete(key)
  }

  const evictPost = (postId: string): void => {
    for (const [key, expected] of derivedKeysByPost.get(postId) ?? [])
      detachExpectedAlias(key, expected)
    derivedKeysByPost.delete(postId)

    for (const id of occupantsByPost.get(postId)?.values() ?? []) {
      detachOwnedAliases(id)
      if (byId.get(id)?.postId === postId) byId.delete(id)
    }
    occupantsByPost.delete(postId)

    for (const code of codesByPost.get(postId) ?? []) {
      if (postByCode.get(code) === postId) postByCode.delete(code)
    }
    codesByPost.delete(postId)
    postsByRecency.delete(postId)
  }

  const pruneEmptyPost = (postId: string): void => {
    if (occupantsByPost.has(postId) || codesByPost.has(postId)) return
    postsByRecency.delete(postId)
  }

  const admitPost = (postId: string, source: 'item' | 'metadata'): boolean => {
    if (postsByRecency.has(postId)) {
      postsByRecency.delete(postId)
      postsByRecency.set(postId, undefined)
      return true
    }
    if (postsByRecency.size === MAX_DETECTED_POSTS) {
      let eviction: string | undefined
      for (const candidate of postsByRecency.keys()) {
        if (source !== 'metadata' || !occupantsByPost.has(candidate)) {
          eviction = candidate
          break
        }
      }
      // Metadata never displaces actionable state. Recovery tombstones have
      // their own page budget and survive this transient Post-state eviction.
      if (eviction === undefined) return false
      evictPost(eviction)
    }
    postsByRecency.set(postId, undefined)
    return true
  }

  const detachOccupant = (item: MediaItem): void => {
    const occupants = occupantsByPost.get(item.postId)
    if (occupants?.get(item.index) !== item.id) return
    occupants.delete(item.index)
    if (occupants.size === 0) occupantsByPost.delete(item.postId)
  }

  const syncPostVideoKey = (postId: string): void => {
    for (const [key, expected] of derivedKeysByPost.get(postId) ?? [])
      detachExpectedAlias(key, expected)

    const next = new Map<string, MediaItem>()
    const add = (key: string, item: MediaItem): void => {
      setAlias(key, item)
      next.set(key, item)
    }
    const videos: Array<readonly [number, MediaItem]> = []
    for (const [index, id] of [...(occupantsByPost.get(postId) ?? [])].toSorted(
      ([left], [right]) => left - right,
    )) {
      const item = byId.get(id)
      if (item?.type === 'video' && item.postId === postId && item.index === index) {
        videos.push([index, item])
      }
    }
    const codes = codesByPost.get(postId) ?? []

    if (videos.length === 1) {
      const item = videos[0]![1]
      add(postVideoKeyById(postId), item)
      for (const code of codes) add(postVideoKey(code), item)
    }
    for (const [index, item] of videos) {
      add(postVideoKeyByIdIndexed(postId, index), item)
      for (const code of codes) {
        add(postVideoKeyIndexed(code, index), item)
        add(postVideoKeyByDomSlot(code, index), item)
      }
    }

    if (next.size === 0) derivedKeysByPost.delete(postId)
    else derivedKeysByPost.set(postId, next)
  }

  const canPlace = (item: MediaItem): boolean => {
    const occupants = occupantsByPost.get(item.postId)
    if (occupants === undefined || occupants.has(item.index)) return true
    const previous = byId.get(item.id)
    if (previous?.postId === item.postId) return true
    return occupants.size < MAX_DETECTED_ITEMS_PER_POST
  }

  const reusesDepartingPostCapacity = (item: MediaItem): boolean => {
    if (postsByRecency.has(item.postId) || postsByRecency.size < MAX_DETECTED_POSTS) return false
    const previous = byId.get(item.id)
    if (previous === undefined || previous.postId === item.postId) return false
    const occupants = occupantsByPost.get(previous.postId)
    return (
      postsByRecency.has(previous.postId) &&
      !codesByPost.has(previous.postId) &&
      occupants?.size === 1 &&
      occupants.get(previous.index) === previous.id
    )
  }

  const replace = (item: MediaItem): 'added' | 'updated' | 'unchanged' => {
    const previous = byId.get(item.id)
    if (previous !== undefined && sameMediaItem(previous, item)) return 'unchanged'

    const touchedPosts = new Set<string>()
    if (previous !== undefined) {
      detachOwnedAliases(previous.id)
      detachOccupant(previous)
      touchedPosts.add(previous.postId)
    }

    // A post slide is one logical media slot. Tee payloads can change the
    // media id for that slot; retain only its latest item. `detachOwnedAliases`
    // only removes aliases still owned by the evicted item, so a shared URL key
    // now owned by another live item survives.
    const replacedId = occupantsByPost.get(item.postId)?.get(item.index)
    if (replacedId !== undefined && replacedId !== item.id) {
      const replaced = byId.get(replacedId)
      if (replaced !== undefined) {
        detachOwnedAliases(replaced.id)
        detachOccupant(replaced)
        byId.delete(replaced.id)
        touchedPosts.add(replaced.postId)
      }
    }

    byId.set(item.id, item)
    keysById.set(item.id, new Set())
    for (const key of keysForItem(item, deps.mediaKeyFromUrl)) setAlias(key, item)
    let occupants = occupantsByPost.get(item.postId)
    if (occupants === undefined) {
      occupants = new Map()
      occupantsByPost.set(item.postId, occupants)
    }
    occupants.set(item.index, item.id)
    touchedPosts.add(item.postId)
    for (const postId of touchedPosts) {
      syncPostVideoKey(postId)
      pruneEmptyPost(postId)
    }
    return previous === undefined ? 'added' : 'updated'
  }

  const reconcile = (
    items: ReadonlyArray<MediaItem>,
    source: 'detected' | 'recovered',
  ): DetectionDelta => {
    let added = 0
    let updated = 0
    for (const rawItem of items) {
      // Source adapters are runtime boundaries, despite their TypeScript return
      // type. Decode before any capacity decision or map mutation.
      const item = decodeMediaItem(rawItem)
      if (item === undefined) continue
      if (source === 'recovered') {
        if (item.type === 'photo' || byId.has(item.id)) continue
        const keys = keysForItem(item, deps.mediaKeyFromUrl)
        if (keys.some((key) => byKey.has(key))) continue
        // Recovery is a gap-filler. Passive detection owns any occupied slide,
        // even when a tee response used a different id and URL.
        if (occupantsByPost.get(item.postId)?.has(item.index)) continue
      }
      if (!canPlace(item)) continue
      const reusesCapacity = reusesDepartingPostCapacity(item)
      if (!reusesCapacity && !admitPost(item.postId, 'item')) continue
      const result = replace(item)
      if (reusesCapacity) postsByRecency.set(item.postId, undefined)
      if (result === 'added') added += 1
      if (result === 'updated') updated += 1
    }
    return { added, updated, changed: added + updated > 0 }
  }

  return {
    reconcileDetected: (items) => reconcile(items, 'detected'),
    reconcileRecovered: (items) => reconcile(items, 'recovered'),
    markAttempted: (tweetId) => {
      if (!isBoundedPostIdentifier(tweetId)) return false
      if (attempted.has(tweetId)) return false
      if (attempted.size === MAX_RECOVERY_ATTEMPTS_PER_PAGE) return false
      attempted.add(tweetId)
      return true
    },
    unmarkAttempted: (tweetId) => {
      if (!isBoundedPostIdentifier(tweetId)) return
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
      if (!isBoundedPostIdentifier(postId) || !isBoundedPostCode(code)) return
      if (!admitPost(postId, 'metadata')) return
      const previousPost = postByCode.get(code)
      if (previousPost === postId) {
        syncPostVideoKey(postId)
        return
      }
      if (previousPost !== undefined) {
        postByCode.delete(code)
        const previousCodes = codesByPost.get(previousPost)
        previousCodes?.delete(code)
        if (previousCodes?.size === 0) codesByPost.delete(previousPost)
        syncPostVideoKey(previousPost)
        pruneEmptyPost(previousPost)
      }
      postByCode.set(code, postId)
      let codes = codesByPost.get(postId)
      if (codes === undefined) {
        codes = new Set()
        codesByPost.set(postId, codes)
      }
      if (codes.size === MAX_POST_CODE_ALIASES) {
        const oldest = codes.values().next().value
        if (oldest !== undefined) {
          codes.delete(oldest)
          if (postByCode.get(oldest) === postId) postByCode.delete(oldest)
        }
      }
      codes.add(code)
      syncPostVideoKey(postId)
    },
    postIdForCode: (code) => postByCode.get(code),
    get count() {
      return byId.size
    },
    clear: () => {
      byId.clear()
      byKey.clear()
      keysById.clear()
      attempted.clear()
      occupantsByPost.clear()
      postByCode.clear()
      codesByPost.clear()
      derivedKeysByPost.clear()
      postsByRecency.clear()
    },
  }
}
