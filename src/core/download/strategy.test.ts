import { describe, it, expect } from 'vitest'
import { Effect, Exit } from 'effect'
import { makeDirectStrategy, type DownloadsPort, type SaveRequest } from './strategy'

const req: SaveRequest = {
  id: 'm1',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  filename: 'alice/1_0.jpg',
}

describe('DirectStrategy', () => {
  it('fires a download with url + filename + uniquify and returns a browser handle', async () => {
    const calls: Array<{ url: string; filename: string; conflictAction: string }> = []
    const downloads: DownloadsPort = {
      download: async (opts) => {
        calls.push(opts)
        return 7
      },
    }
    const handle = await Effect.runPromise(makeDirectStrategy(downloads).save(req))
    expect(handle).toEqual({ kind: 'browser', id: 7 })
    expect(calls[0]).toEqual({
      url: req.url,
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
    const exit = await Effect.runPromiseExit(makeDirectStrategy(downloads).save(req))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
