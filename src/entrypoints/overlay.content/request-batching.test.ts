import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../../core/schema'
import {
  MAX_DOWNLOAD_ITEMS_PER_REQUEST,
  MAX_SAVED_TWEET_IDS_PER_REQUEST,
  MAX_SWEEP_MEDIA_PER_REQUEST,
  MAX_SWEEP_POSTS_PER_REQUEST,
  MAX_X_MEDIA_PER_SWEEP_POST,
} from '../../core/wire/limits'
import {
  partitionDownloadItems,
  requestSavedStatusBatches,
  partitionSavedTweetIds,
  partitionSweepPosts,
} from './request-batching'

const item = (id: string, postId: string): MediaItem => ({
  id,
  postId,
  platform: 'x',
  author: 'alice',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${id}`,
  ext: 'jpg',
  index: 0,
})

describe('request batching', () => {
  it('uses the approved producer limits', () => {
    expect(MAX_DOWNLOAD_ITEMS_PER_REQUEST).toBe(64)
    expect(MAX_SAVED_TWEET_IDS_PER_REQUEST).toBe(100)
    expect(MAX_SWEEP_POSTS_PER_REQUEST).toBe(16)
    expect(MAX_X_MEDIA_PER_SWEEP_POST).toBe(4)
    expect(MAX_SWEEP_MEDIA_PER_REQUEST).toBe(64)
  })

  it('partitions Downloads by whole post, retaining first-seen post and item order', () => {
    const leading = Array.from({ length: 63 }, (_, n) => item(`a-${n}`, `${n}`))
    const tail = [item('b-0', 'tail'), item('b-1', 'tail')]

    expect(partitionDownloadItems([...leading, ...tail])).toEqual({
      _tag: 'success',
      batches: [leading, tail],
      rejected: [],
    })
  })

  it('rejects one malformed post locally and keeps later valid post batches', () => {
    const malformed = item('bad', 'bad-post')
    Object.defineProperty(malformed, 'url', {
      enumerable: true,
      get: () => {
        throw new Error('producer must not invoke page accessors')
      },
    })
    const samePost = item('same-post', 'bad-post')
    const later = item('later', 'later-post')

    expect(partitionDownloadItems([malformed, samePost, later])).toEqual({
      _tag: 'success',
      batches: [[later]],
      rejected: [{ reason: 'invalid-media-item', value: 'bad-post', postId: 'bad-post' }],
    })
  })

  it('rejects an oversize Media Item before send without poisoning later posts', () => {
    const oversize = {
      ...item('oversize', 'oversize-post'),
      url: `https://pbs.twimg.com/media/${'x'.repeat(16 * 1024)}`,
    }
    const later = item('later', 'later-post')

    expect(partitionDownloadItems([oversize, later])).toEqual({
      _tag: 'success',
      batches: [[later]],
      rejected: [{ reason: 'invalid-media-item', value: 'oversize-post', postId: 'oversize-post' }],
    })
  })

  it('keeps equal adapter-local keys separate across platforms', () => {
    const x = item('shared', 'same-post')
    const instagram = { ...item('shared', 'same-post'), platform: 'instagram' as const }

    expect(partitionDownloadItems([x, instagram])).toEqual({
      _tag: 'success',
      batches: [[x, instagram]],
      rejected: [],
    })
  })

  it.each([
    ['duplicate item id', [item('same', '1'), item('same', '2')], 'duplicate-item-id'],
    [
      'oversized post',
      Array.from({ length: 65 }, (_, n) => item(`oversized-${n}`, '1')),
      'download-post-too-large',
    ],
  ] as const)('rejects Download %s', (_name, items, reason) => {
    expect(partitionDownloadItems(items)).toMatchObject({ _tag: 'failure', reason })
  })

  it('partitions Sweeps by post and total-media caps, retaining order', () => {
    const posts = Array.from({ length: 17 }, (_entry, n) => ({
      tweetId: `${n + 1}`,
      items: Array.from({ length: 4 }, (_unusedItem, itemIndex) =>
        item(`${n}-${itemIndex}`, `${n + 1}`),
      ),
    }))

    expect(partitionSweepPosts(posts)).toEqual({
      _tag: 'success',
      batches: [posts.slice(0, 16), posts.slice(16)],
    })
  })

  it.each([
    [
      'duplicate tweet id',
      [
        { tweetId: '1', items: [item('a', '1')] },
        { tweetId: '1', items: [item('b', '1')] },
      ],
      'duplicate-sweep-tweet-id',
    ],
    ['cross-post item', [{ tweetId: '1', items: [item('a', '2')] }], 'sweep-item-post-mismatch'],
    ['empty post', [{ tweetId: '1', items: [] }], 'empty-sweep-post'],
    [
      'too many media in one post',
      [
        {
          tweetId: '1',
          items: Array.from({ length: 5 }, (_, n) => item(`${n}`, '1')),
        },
      ],
      'sweep-post-too-large',
    ],
    [
      'duplicate item id',
      [
        { tweetId: '1', items: [item('same', '1')] },
        { tweetId: '2', items: [item('same', '2')] },
      ],
      'duplicate-item-id',
    ],
  ] as const)('rejects Sweep %s', (_name, posts, reason) => {
    expect(partitionSweepPosts(posts)).toMatchObject({ _tag: 'failure', reason })
  })

  it('partitions unique Saved snowflakes by 100', () => {
    const ids = Array.from({ length: 101 }, (_, n) => `${n + 1}`)

    expect(partitionSavedTweetIds(ids)).toEqual({
      _tag: 'success',
      batches: [ids.slice(0, 100), ids.slice(100)],
    })
  })

  it('unions only exact unique Saved-status replies from each batch', async () => {
    const ids = Array.from({ length: 201 }, (_, n) => `${n + 1}`)
    const send = vi
      .fn<(batch: ReadonlyArray<string>) => Promise<ReadonlyArray<string> | undefined>>()
      .mockResolvedValueOnce(['1', '2'])
      .mockResolvedValueOnce(['101', '101'])
      .mockResolvedValueOnce(['outside'])

    await expect(requestSavedStatusBatches(ids, send)).resolves.toEqual(['1', '2'])
    expect(send).toHaveBeenCalledWith(ids.slice(0, 100))
    expect(send).toHaveBeenCalledWith(ids.slice(100, 200))
    expect(send).toHaveBeenCalledWith(ids.slice(200))
  })

  it.each([
    ['duplicate id', ['1', '1'], 'duplicate-saved-tweet-id'],
    ['non-snowflake', ['1', 'nope'], 'invalid-saved-tweet-id'],
    ['too long', ['123456789012345678901'], 'invalid-saved-tweet-id'],
  ] as const)('rejects Saved %s', (_name, ids, reason) => {
    expect(partitionSavedTweetIds(ids)).toMatchObject({ _tag: 'failure', reason })
  })
})
