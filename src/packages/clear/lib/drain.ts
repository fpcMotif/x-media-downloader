/**
 * Pending-clear queue for the auto-scroll drain. X virtualizes the timeline (~30
 * articles in the DOM at once; a post scrolled past is removed entirely), so a
 * clear that fires ~seconds after its download settles usually can't find its post
 * mounted — `findArticle` returns null and the clear is dropped. Rather than drop,
 * the not-mounted clears land here; the overlay then scrolls the list to surface
 * each post and clears it as it mounts. This module is the pure bookkeeping — the
 * scroll loop + DOM reads live in the content script.
 */
import type { ClearScope } from '@/packages/schema'

export interface PendingClear {
  readonly scopes: ClearScope[]
  readonly allLists: boolean
}

/** tweetId → the clear waiting for that post to scroll into the DOM. */
export type DrainQueue = Map<string, PendingClear>

export const makeDrainQueue = (): DrainQueue => new Map()

/** Queue (or re-queue) a not-mounted clear. A re-add UNIONS scopes and ORs allLists
 *  — a second settle for the same tweet must never SHRINK the pending work (e.g. a
 *  later like-only request must not drop a previously-queued bookmark). */
export function addPending(
  queue: DrainQueue,
  tweetId: string,
  scopes: ReadonlyArray<ClearScope>,
  allLists: boolean,
): void {
  const cur = queue.get(tweetId)
  if (cur === undefined) {
    queue.set(tweetId, { scopes: [...scopes], allLists })
    return
  }
  queue.set(tweetId, {
    scopes: [...new Set([...cur.scopes, ...scopes])],
    allLists: cur.allLists || allLists,
  })
}

/** The queued tweetIds that are mounted RIGHT NOW — the ones a drain step can clear
 *  this pass. Intersection of the queue with the live article ids. */
export function readyToClear(queue: DrainQueue, mountedTweetIds: Iterable<string>): string[] {
  const out: string[] = []
  for (const id of mountedTweetIds) if (queue.has(id)) out.push(id)
  return out
}
