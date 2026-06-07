import { describe, it, expect } from 'vitest'
import { Effect, Exit } from 'effect'
import type { MediaItem } from '../schema'
import { makeDirectStrategy, type DownloadsPort } from './strategy'

const item: MediaItem = {
  id: 'm1',
  tweetId: '1',
  handle: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  ext: 'jpg',
  index: 0,
}

describe('DirectStrategy', () => {
  it('fires a download with url + filename + uniquify and returns the id', async () => {
    const calls: Array<{ url: string; filename: string; conflictAction: string }> = []
    const downloads: DownloadsPort = {
      download: async (opts) => {
        calls.push(opts)
        return 7
      },
    }
    const id = await Effect.runPromise(makeDirectStrategy(downloads).save(item, 'alice/1_0.jpg'))
    expect(id).toBe(7)
    expect(calls[0]).toEqual({
      url: item.url,
      filename: 'alice/1_0.jpg',
      conflictAction: 'uniquify',
    })
  })

  it('maps a download failure to a DownloadError', async () => {
    const downloads: DownloadsPort = {
      download: async () => {
        throw new Error('boom')
      },
    }
    const exit = await Effect.runPromiseExit(makeDirectStrategy(downloads).save(item, 'f.jpg'))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
