import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../../core/schema'
import { mediaRequestId } from '../../core/download/request-identity'
import {
  makeClearExpect,
  sendTrackedBatches,
  type ClearExpect,
  type TrackedStart,
} from './tracked-download'

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

const started: TrackedStart = { _tag: 'started' }

describe('tracked Download batches', () => {
  it('uses canonical request identity for full-post Clear prerequisites', () => {
    const reservedPrefix = item('xmd:v1:reserved', '1')

    expect(makeClearExpect([reservedPrefix], () => [reservedPrefix])).toEqual([
      {
        tweetId: '1',
        requestIds: [mediaRequestId(reservedPrefix)],
      },
    ])
    expect(mediaRequestId(reservedPrefix)).not.toBe(reservedPrefix.id)
  })

  it('sends whole post batches in order and filters clear expectations by batch', async () => {
    const leading = Array.from({ length: 63 }, (_, n) => item(`a-${n}`, `${n}`))
    const tail = [item('tail-0', 'tail'), item('tail-1', 'tail')]
    const clearExpect: ClearExpect = [
      { tweetId: '1', requestIds: ['1', 'not-sent-yet'] },
      { tweetId: 'tail', requestIds: ['tail-0', 'tail-1', 'later'] },
    ]
    const sendOne = vi.fn<() => Promise<TrackedStart>>(async () => started)

    await expect(
      sendTrackedBatches({ items: [...leading, ...tail], clearExpect, sendOne }),
    ).resolves.toEqual(started)
    expect(sendOne).toHaveBeenCalledTimes(2)
    expect(sendOne).toHaveBeenNthCalledWith(1, leading, [clearExpect[0]])
    expect(sendOne).toHaveBeenNthCalledWith(2, tail, [clearExpect[1]])
  })

  it.each([
    [
      'duplicate clear post',
      [item('a', '1')],
      [
        { tweetId: '1', requestIds: ['a'] },
        { tweetId: '1', requestIds: ['b'] },
      ],
    ],
    ['duplicate clear id', [item('a', '1')], [{ tweetId: '1', requestIds: ['a', 'a'] }]],
    ['clear post absent from items', [item('a', '1')], [{ tweetId: '2', requestIds: ['missing'] }]],
    ['duplicate Download item', [item('a', '1'), item('a', '2')], undefined],
  ] as const)('rejects local %s without sending', async (_name, items, clearExpect) => {
    const sendOne = vi.fn<() => Promise<TrackedStart>>(async () => started)

    await expect(sendTrackedBatches({ items, clearExpect, sendOne })).resolves.toMatchObject({
      _tag: 'local-invalid',
    })
    expect(sendOne).not.toHaveBeenCalled()
  })

  it('continues after a partial batch but stops on a transport failure', async () => {
    const leading = Array.from({ length: 64 }, (_, n) => item(`a-${n}`, `${n}`))
    const tail = item('tail', 'tail')
    const sendOne = vi
      .fn<(items: ReadonlyArray<MediaItem>, clearExpect?: ClearExpect) => Promise<TrackedStart>>()
      .mockResolvedValueOnce({ _tag: 'partial' })
      .mockResolvedValueOnce({ _tag: 'transport' })

    await expect(sendTrackedBatches({ items: [...leading, tail], sendOne })).resolves.toEqual({
      _tag: 'transport',
    })
    expect(sendOne).toHaveBeenCalledTimes(2)
  })

  it('reports partial when every later batch started', async () => {
    const leading = Array.from({ length: 64 }, (_, n) => item(`a-${n}`, `${n}`))
    const sendOne = vi
      .fn<(items: ReadonlyArray<MediaItem>, clearExpect?: ClearExpect) => Promise<TrackedStart>>()
      .mockResolvedValueOnce({ _tag: 'partial' })
      .mockResolvedValueOnce(started)

    await expect(
      sendTrackedBatches({ items: [...leading, item('tail', 'tail')], sendOne }),
    ).resolves.toEqual({
      _tag: 'partial',
    })
  })

  it('reports a local partial after sending later valid posts', async () => {
    const malformed = {
      ...item('bad', 'bad-post'),
      url: `https://pbs.twimg.com/media/${'x'.repeat(16 * 1024)}`,
    }
    const later = item('later', 'later-post')
    const sendOne = vi.fn<() => Promise<TrackedStart>>(async () => started)

    await expect(sendTrackedBatches({ items: [malformed, later], sendOne })).resolves.toEqual({
      _tag: 'partial',
      localInvalid: [{ reason: 'invalid-media-item', value: 'bad-post', postId: 'bad-post' }],
    })
    expect(sendOne).toHaveBeenCalledOnce()
    expect(sendOne).toHaveBeenCalledWith([later], undefined)
  })

  it('reports local invalid when no Media Item can be sent', async () => {
    const malformed = {
      ...item('bad', 'bad-post'),
      url: `https://pbs.twimg.com/media/${'x'.repeat(16 * 1024)}`,
    }
    const sendOne = vi.fn<() => Promise<TrackedStart>>(async () => started)

    await expect(sendTrackedBatches({ items: [malformed], sendOne })).resolves.toEqual({
      _tag: 'local-invalid',
      reason: 'invalid-media-item',
      value: 'bad-post',
    })
    expect(sendOne).not.toHaveBeenCalled()
  })

  it.each([
    { _tag: 'context' },
    { _tag: 'unclaimed' },
    { _tag: 'transport' },
    { _tag: 'invalid-reply' },
  ] as const)('stops later batches on %s', async (outcome) => {
    const leading = Array.from({ length: 64 }, (_, n) => item(`a-${n}`, `${n}`))
    const sendOne = vi.fn<() => Promise<TrackedStart>>(async () => outcome)

    await expect(
      sendTrackedBatches({ items: [...leading, item('tail', 'tail')], sendOne }),
    ).resolves.toEqual(outcome)
    expect(sendOne).toHaveBeenCalledOnce()
  })

  it('finishes an empty Download locally', async () => {
    const sendOne = vi.fn<() => Promise<TrackedStart>>(async () => started)

    await expect(sendTrackedBatches({ items: [], sendOne })).resolves.toEqual(started)
    expect(sendOne).not.toHaveBeenCalled()
  })
})
