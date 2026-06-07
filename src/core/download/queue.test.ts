import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import type { MediaItem } from '../schema'
import type { DownloadStrategy } from './strategy'
import { DownloadError } from '../errors'
import { makeDownloadQueueCore } from './queue'

const mk = (id: string): MediaItem => ({
  id,
  tweetId: '1',
  handle: 'alice',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${id}.jpg?name=orig`,
  ext: 'jpg',
  index: 0,
})

describe('DownloadQueue core', () => {
  it('saves every item and reports completed/total', async () => {
    const saved: string[] = []
    const strategy: DownloadStrategy = {
      save: (_item, filename) =>
        Effect.sync(() => {
          saved.push(filename)
          return 1
        }),
    }
    const queue = makeDownloadQueueCore({ strategy, concurrency: 3 })
    const res = await Effect.runPromise(queue.enqueue([mk('a'), mk('b')], (i) => `${i.id}.jpg`))
    expect(res).toEqual({ completed: 2, total: 2, failed: 0 })
    expect(saved.toSorted()).toEqual(['a.jpg', 'b.jpg'])
  })

  it('never exceeds the configured concurrency', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const strategy: DownloadStrategy = {
      save: () =>
        Effect.gen(function* () {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          yield* Effect.sleep('10 millis')
          inFlight--
          return 1
        }),
    }
    const queue = makeDownloadQueueCore({ strategy, concurrency: 2 })
    const items = ['a', 'b', 'c', 'd', 'e'].map(mk)
    await Effect.runPromise(queue.enqueue(items, (i) => `${i.id}.jpg`))
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('retries a transient failure and ultimately succeeds', async () => {
    let attempts = 0
    const strategy: DownloadStrategy = {
      save: () =>
        Effect.suspend(() => {
          attempts++
          return attempts < 3
            ? Effect.fail(new DownloadError({ id: 'x', reason: 'transient' }))
            : Effect.succeed(1)
        }),
    }
    const queue = makeDownloadQueueCore({ strategy, concurrency: 1, retries: 3 })
    const res = await Effect.runPromise(queue.enqueue([mk('a')], (i) => `${i.id}.jpg`))
    expect(res.completed).toBe(1)
    expect(attempts).toBe(3)
  })
})
