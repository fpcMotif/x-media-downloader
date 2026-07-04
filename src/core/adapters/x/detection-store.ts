import type { MediaItem } from '../../schema'
import { mediaKeyFromUrl } from './dom'
import { videoTweetsNeedingRecovery } from './index'

/**
 * The twimg media keys an item can be matched by: its resolved `url` and its
 * `previewUrl` (a video's poster), de-duplicated. A hovered `<img>`/poster maps
 * back to its MediaItem through one of these.
 */
export function keysForItem(item: MediaItem): string[] {
  const keys = new Set<string>()
  const primary = mediaKeyFromUrl(item.url)
  const preview = item.previewUrl ? mediaKeyFromUrl(item.previewUrl) : null
  if (primary) keys.add(primary)
  if (preview) keys.add(preview)
  return [...keys]
}

/**
 * The page's Detected Media Set (CONTEXT.md): every Media Item found on the
 * current page plus how each was obtained, behind one object. Owns the dual index
 * — by `id` (the download/count identity) and by media key (hover resolution) —
 * the recovered-key provenance, and the per-tweet recovery-attempt guard, so the
 * overlay holds one store instead of four loose maps. Pure of `chrome.*`/timers;
 * `needsRecovery` reads the DOM (happy-dom-testable, like the rest of the adapter).
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
  /** How many Media Items are detected (the Bulk count). */
  readonly count: number
  /** Drop everything — items, keys, recovered-key provenance, and attempts. */
  clear(): void
}

export function makeDetectionStore(): DetectionStore {
  const byId = new Map<string, MediaItem>()
  const byKey = new Map<string, MediaItem>()
  const recoveredKeys = new Set<string>()
  const attempted = new Set<string>()

  const addDetected = (items: ReadonlyArray<MediaItem>): MediaItem[] => {
    const added: MediaItem[] = []
    for (const item of items) {
      const keys = keysForItem(item)
      // A video the tee re-surfaces after we recovered it (different id scheme)
      // would otherwise be counted twice — suppress by recovered key.
      if (keys.some((k) => recoveredKeys.has(k))) continue
      if (!byId.has(item.id)) added.push(item)
      byId.set(item.id, item)
      for (const key of keys) byKey.set(key, item)
    }
    return added
  }

  const addRecovered = (items: ReadonlyArray<MediaItem>): MediaItem[] => {
    const added: MediaItem[] = []
    for (const item of items) {
      // Photos are always DOM-detectable (different id scheme) — re-adding here
      // would double-count; only video/GIF need recovery.
      if (item.type === 'photo') continue
      const keys = keysForItem(item)
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
    needsRecovery: (root) => videoTweetsNeedingRecovery(root, new Set(byKey.keys())),
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
    get count() {
      return byId.size
    },
    clear: () => {
      byId.clear()
      byKey.clear()
      recoveredKeys.clear()
      attempted.clear()
    },
  }
}
