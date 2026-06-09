import type { MediaItem } from '../../schema'
import type { Registry } from '../../selection'

/**
 * Extract the stable media key from a twimg URL — the final path segment without
 * its extension. A rendered `<img>` on the page and a detected MediaItem's
 * resolved `url` share this key, so hovering a DOM element can be matched back to
 * its MediaItem. Returns null for anything that isn't a twimg media URL.
 */
export function mediaKeyFromUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!u.hostname.endsWith('twimg.com')) return null
  const base = u.pathname.slice(u.pathname.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const key = dot >= 0 ? base.slice(0, dot) : base
  return key.length > 0 ? key : null
}

/**
 * Group flat detected items into a per-tweet Registry (for the selection model),
 * de-duplicated by id, preserving first-seen order of both tweets and items.
 */
export function groupByTweet(items: ReadonlyArray<MediaItem>): Registry {
  const order: string[] = []
  const groups = new Map<string, MediaItem[]>()
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) continue
    seen.add(item.id)
    let group = groups.get(item.tweetId)
    if (group === undefined) {
      group = []
      groups.set(item.tweetId, group)
      order.push(item.tweetId)
    }
    group.push(item)
  }
  return order.map((tweetId) => ({ tweetId, items: groups.get(tweetId)! }))
}
