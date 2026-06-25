import type { MediaItem } from './schema'

/** A tweet's media bundled under its id and (optional) enclosing thread. */
export interface TweetGroup {
  readonly tweetId: string
  readonly threadId?: string
  readonly items: ReadonlyArray<MediaItem>
}

/** All detected tweets on the page, in DOM order. */
export type Registry = ReadonlyArray<TweetGroup>

/** The set of media ids the user has picked. */
export interface Selection {
  readonly ids: ReadonlySet<string>
}

/** A selection with nothing picked. */
export function emptySelection(): Selection {
  return { ids: new Set() }
}

/** Toggle one media id: present → removed, absent → added. Returns a new Selection. */
export function toggleMedia(sel: Selection, id: string): Selection {
  const ids = new Set(sel.ids)
  if (ids.has(id)) ids.delete(id)
  else ids.add(id)
  return { ids }
}

/** Add every media id of the matching tweet to the selection (union). */
export function selectTweet(sel: Selection, registry: Registry, tweetId: string): Selection {
  const ids = new Set(sel.ids)
  for (const group of registry) {
    if (group.tweetId !== tweetId) continue
    for (const item of group.items) ids.add(item.id)
  }
  return { ids }
}

/**
 * Add every media id across all tweets sharing `threadId` (union). A nullish
 * `threadId` selects nothing (it must not accidentally union all thread-less
 * tweets, whose `threadId` is `undefined`).
 */
export function selectThread(sel: Selection, registry: Registry, threadId: string): Selection {
  const ids = new Set(sel.ids)
  if (threadId == null) return { ids }
  for (const group of registry) {
    if (group.threadId !== threadId) continue
    for (const item of group.items) ids.add(item.id)
  }
  return { ids }
}

/**
 * Resolve a selection to ordered MediaItems. Walks the registry in order; within
 * each tweet, keeps the selected items in order and re-indexes them contiguously
 * from 0 (so naming stays `{tweetId}_{index}` with no gaps). Each tweet restarts
 * at 0; ids absent from the registry are dropped. A media id appearing in more
 * than one tweet (e.g. a quoted image) resolves at most once — the first
 * occurrence in registry order wins, so one pick is one download. Registry items
 * are not mutated.
 */
export function resolveSelection(registry: Registry, sel: Selection): MediaItem[] {
  const out: MediaItem[] = []
  const seen = new Set<string>()
  for (const group of registry) {
    let index = 0
    for (const item of group.items) {
      if (!sel.ids.has(item.id) || seen.has(item.id)) continue
      seen.add(item.id)
      out.push({ ...item, index })
      index += 1
    }
  }
  return out
}
