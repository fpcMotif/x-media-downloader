import type { MediaItem } from '../../core/schema'
import { mediaRequestId } from '../../core/download/request-identity'
import {
  partitionDownloadItems,
  type RejectedMediaItem,
  type RequestBatchingFailureReason,
} from './request-batching'

export type ClearExpect = ReadonlyArray<{
  readonly tweetId: string
  readonly requestIds: ReadonlyArray<string>
}>

export const makeClearExpect = (
  items: ReadonlyArray<MediaItem>,
  valuesForTweet: (tweetId: string) => ReadonlyArray<MediaItem>,
): ClearExpect =>
  [...new Set(items.map((item) => item.postId))].map((tweetId) => ({
    tweetId,
    requestIds: valuesForTweet(tweetId).map(mediaRequestId),
  }))

export type LocalDownloadInvalidReason =
  | RequestBatchingFailureReason
  | 'duplicate-clear-expect-post'
  | 'duplicate-clear-expect-id'
  | 'clear-expect-post-absent'

/** The verified outcome of asking the background to start a Download batch. */
export type TrackedStart =
  | { readonly _tag: 'started' }
  | { readonly _tag: 'context' }
  | { readonly _tag: 'unclaimed' }
  | { readonly _tag: 'transport' }
  | { readonly _tag: 'invalid-reply' }
  | { readonly _tag: 'partial'; readonly localInvalid?: ReadonlyArray<RejectedMediaItem> }
  | {
      readonly _tag: 'local-invalid'
      readonly reason: LocalDownloadInvalidReason
      readonly value: string
    }

const localInvalid = (reason: LocalDownloadInvalidReason, value: string): TrackedStart => ({
  _tag: 'local-invalid',
  reason,
  value,
})

const validateClearExpect = (
  itemPosts: ReadonlySet<string>,
  clearExpect: ClearExpect | undefined,
): TrackedStart | undefined => {
  if (clearExpect === undefined) return undefined
  const posts = new Set<string>()
  const ids = new Set<string>()
  for (const expected of clearExpect) {
    if (posts.has(expected.tweetId))
      return localInvalid('duplicate-clear-expect-post', expected.tweetId)
    posts.add(expected.tweetId)
    if (!itemPosts.has(expected.tweetId))
      return localInvalid('clear-expect-post-absent', expected.tweetId)
    for (const id of expected.requestIds) {
      if (ids.has(id)) return localInvalid('duplicate-clear-expect-id', id)
      ids.add(id)
    }
  }
  return undefined
}

const clearExpectForBatch = (
  clearExpect: ClearExpect | undefined,
  items: ReadonlyArray<MediaItem>,
): ClearExpect | undefined => {
  if (clearExpect === undefined) return undefined
  const posts = new Set(items.map((item) => item.postId))
  const filtered = clearExpect.filter((expected) => posts.has(expected.tweetId))
  return filtered.length > 0 ? filtered : undefined
}

/** Partition a Download producer request, preserve whole posts, and keep later
 * batches moving after an admitted partial. Fatal delivery outcomes stop in order. */
export const sendTrackedBatches = async (deps: {
  readonly items: ReadonlyArray<MediaItem>
  readonly clearExpect?: ClearExpect | undefined
  readonly sendOne: (
    items: ReadonlyArray<MediaItem>,
    clearExpect?: ClearExpect,
  ) => Promise<TrackedStart>
}): Promise<TrackedStart> => {
  const partitioned = partitionDownloadItems(deps.items)
  if (partitioned._tag === 'failure') return localInvalid(partitioned.reason, partitioned.value)
  const acceptedItems = partitioned.batches.flat()
  const knownPosts = new Set(acceptedItems.map((item) => item.postId))
  for (const entry of partitioned.rejected) {
    if (entry.postId !== undefined) knownPosts.add(entry.postId)
  }
  const clearInvalid = validateClearExpect(knownPosts, deps.clearExpect)
  if (clearInvalid !== undefined) return clearInvalid
  if (partitioned.batches.length === 0 && partitioned.rejected.length > 0) {
    const first = partitioned.rejected[0]!
    return localInvalid(first.reason, first.value)
  }
  let partial = partitioned.rejected.length > 0
  // oxlint-disable no-await-in-loop -- later post batches must not overtake an earlier one.
  for (const batch of partitioned.batches) {
    let result: TrackedStart
    try {
      result = await deps.sendOne(batch, clearExpectForBatch(deps.clearExpect, batch))
    } catch {
      return { _tag: 'transport' }
    }
    if (result._tag === 'partial') {
      partial = true
      continue
    }
    if (result._tag !== 'started') return result
  }
  // oxlint-enable no-await-in-loop
  return partial
    ? {
        _tag: 'partial',
        ...(partitioned.rejected.length === 0 ? {} : { localInvalid: partitioned.rejected }),
      }
    : { _tag: 'started' }
}
