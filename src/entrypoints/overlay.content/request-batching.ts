import { decodeMediaItem, MAX_MEDIA_POST_ID_LENGTH, type MediaItem } from '../../core/schema/media'
import { mediaRequestId } from '../../core/download/request-identity'
import {
  MAX_DOWNLOAD_ITEMS_PER_REQUEST,
  MAX_SAVED_TWEET_IDS_PER_REQUEST,
  MAX_SWEEP_MEDIA_PER_REQUEST,
  MAX_SWEEP_POSTS_PER_REQUEST,
  MAX_X_MEDIA_PER_SWEEP_POST,
} from '../../core/wire/limits'

export type RequestBatchingFailureReason =
  | 'duplicate-item-id'
  | 'download-post-too-large'
  | 'duplicate-sweep-tweet-id'
  | 'sweep-item-post-mismatch'
  | 'empty-sweep-post'
  | 'sweep-post-too-large'
  | 'duplicate-saved-tweet-id'
  | 'invalid-saved-tweet-id'
  | 'invalid-media-item'

export interface RequestBatchingFailure {
  readonly reason: RequestBatchingFailureReason
  readonly value: string
}

type RequestBatchingFailureResult = RequestBatchingFailure & {
  readonly _tag: 'failure'
}

export type RequestBatchingResult<A> =
  | { readonly _tag: 'success'; readonly batches: ReadonlyArray<ReadonlyArray<A>> }
  | RequestBatchingFailureResult

export interface RejectedMediaItem extends RequestBatchingFailure {
  readonly reason: 'invalid-media-item'
  readonly postId?: string
}

export type DownloadBatchingResult =
  | {
      readonly _tag: 'success'
      readonly batches: ReadonlyArray<ReadonlyArray<MediaItem>>
      readonly rejected: ReadonlyArray<RejectedMediaItem>
    }
  | RequestBatchingFailureResult

export interface SweepBatchPost {
  readonly tweetId: string
  readonly items: ReadonlyArray<MediaItem>
}

const success = <A>(batches: A[][]): RequestBatchingResult<A> => ({
  _tag: 'success',
  batches,
})

const failure = (
  reason: RequestBatchingFailureReason,
  value: string,
): RequestBatchingFailureResult => ({
  _tag: 'failure',
  reason,
  value,
})

const readBoundedPostId = (value: unknown): string | undefined => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const descriptor = Object.getOwnPropertyDescriptor(value, 'postId')
    return descriptor !== undefined &&
      descriptor.enumerable &&
      'value' in descriptor &&
      typeof descriptor.value === 'string' &&
      descriptor.value.length > 0 &&
      descriptor.value.length <= MAX_MEDIA_POST_ID_LENGTH
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

/** Partition Downloads on post boundaries. The input may interleave posts; output
 * groups each post at its first appearance and preserves its Media Item order. */
export const partitionDownloadItems = (items: ReadonlyArray<MediaItem>): DownloadBatchingResult => {
  const decodedItems: MediaItem[] = []
  const rejected: RejectedMediaItem[] = []
  const rejectedPosts = new Set<string>()
  for (const [index, raw] of items.entries()) {
    const item = decodeMediaItem(raw)
    if (item !== undefined) {
      decodedItems.push(item)
      continue
    }
    const postId = readBoundedPostId(raw)
    if (postId !== undefined) rejectedPosts.add(postId)
    rejected.push({
      reason: 'invalid-media-item',
      value: postId ?? `item[${index}]`,
      ...(postId === undefined ? {} : { postId }),
    })
  }

  const ids = new Set<string>()
  const byPost = new Map<string, MediaItem[]>()
  for (const item of decodedItems) {
    if (rejectedPosts.has(item.postId)) continue
    const requestId = mediaRequestId(item)
    if (ids.has(requestId)) return failure('duplicate-item-id', requestId)
    ids.add(requestId)
    const postKey = `${item.platform}:${item.postId}`
    const group = byPost.get(postKey) ?? []
    group.push(item)
    if (group.length > MAX_DOWNLOAD_ITEMS_PER_REQUEST)
      return failure('download-post-too-large', item.postId)
    byPost.set(postKey, group)
  }

  const batches: MediaItem[][] = []
  let current: MediaItem[] = []
  for (const group of byPost.values()) {
    if (current.length > 0 && current.length + group.length > MAX_DOWNLOAD_ITEMS_PER_REQUEST) {
      batches.push(current)
      current = []
    }
    current.push(...group)
  }
  if (current.length > 0) batches.push(current)
  return { _tag: 'success', batches, rejected }
}

/** Partition Sweep posts without splitting a post. Reject data that cannot satisfy
 * the X per-post and per-request limits before it reaches the wire. */
export const partitionSweepPosts = (
  posts: ReadonlyArray<SweepBatchPost>,
): RequestBatchingResult<SweepBatchPost> => {
  const tweetIds = new Set<string>()
  const itemIds = new Set<string>()
  const batches: SweepBatchPost[][] = []
  let current: SweepBatchPost[] = []
  let currentMedia = 0

  for (const post of posts) {
    if (tweetIds.has(post.tweetId)) return failure('duplicate-sweep-tweet-id', post.tweetId)
    tweetIds.add(post.tweetId)
    if (post.items.length === 0) return failure('empty-sweep-post', post.tweetId)
    if (post.items.length > MAX_X_MEDIA_PER_SWEEP_POST)
      return failure('sweep-post-too-large', post.tweetId)
    for (const item of post.items) {
      if (item.postId !== post.tweetId) return failure('sweep-item-post-mismatch', item.id)
      const requestId = mediaRequestId(item)
      if (itemIds.has(requestId)) return failure('duplicate-item-id', requestId)
      itemIds.add(requestId)
    }
    if (
      current.length === MAX_SWEEP_POSTS_PER_REQUEST ||
      currentMedia + post.items.length > MAX_SWEEP_MEDIA_PER_REQUEST
    ) {
      batches.push(current)
      current = []
      currentMedia = 0
    }
    current.push(post)
    currentMedia += post.items.length
  }
  if (current.length > 0) batches.push(current)
  return success(batches)
}

/** Partition Saved-status probes after validating unique decimal X snowflakes. */
export const partitionSavedTweetIds = (
  tweetIds: ReadonlyArray<string>,
): RequestBatchingResult<string> => {
  const ids = new Set<string>()
  const batches: string[][] = []
  let current: string[] = []
  for (const tweetId of tweetIds) {
    if (!/^\d{1,20}$/u.test(tweetId)) return failure('invalid-saved-tweet-id', tweetId)
    if (ids.has(tweetId)) return failure('duplicate-saved-tweet-id', tweetId)
    ids.add(tweetId)
    if (current.length === MAX_SAVED_TWEET_IDS_PER_REQUEST) {
      batches.push(current)
      current = []
    }
    current.push(tweetId)
  }
  if (current.length > 0) batches.push(current)
  return success(batches)
}

/** Send every valid Saved-status batch. A malformed or failed reply contributes no
 * marks; one bad worker reply must not invalidate another batch's evidence. */
export const requestSavedStatusBatches = async (
  tweetIds: ReadonlyArray<string>,
  send: (batch: ReadonlyArray<string>) => Promise<unknown>,
): Promise<string[]> => {
  const partitioned = partitionSavedTweetIds(tweetIds)
  if (partitioned._tag === 'failure') return []
  const saved = new Set<string>()
  // oxlint-disable no-await-in-loop -- keep one runtime message in flight per tab.
  for (const batch of partitioned.batches) {
    try {
      const reply = await send(batch)
      if (!Array.isArray(reply) || !reply.every((id) => typeof id === 'string')) continue
      const requested = new Set(batch)
      const seen = new Set<string>()
      let valid = true
      for (const id of reply) {
        if (!requested.has(id) || seen.has(id)) {
          valid = false
          break
        }
        seen.add(id)
      }
      if (!valid) continue
      for (const id of seen) saved.add(id)
    } catch {
      continue
    }
  }
  // oxlint-enable no-await-in-loop
  return [...saved]
}
