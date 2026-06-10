import { describe, it, expect } from 'vitest'
import { Effect, Exit } from 'effect'
import {
  makeDirectStrategy,
  makeSchemeRoutingStrategy,
  type DownloadsPort,
  type DownloadStrategy,
  type SaveRequest,
} from './strategy'

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

const recording = (tag: string, calls: string[]): DownloadStrategy => ({
  save: (r) =>
    Effect.sync(() => {
      calls.push(`${tag}:${r.id}`)
      return { kind: 'browser' as const, id: 1 }
    }),
})

describe('makeSchemeRoutingStrategy', () => {
  it('routes data: URLs (sidecars) to the browser strategy and the rest to primary', async () => {
    const calls: string[] = []
    const strategy = makeSchemeRoutingStrategy(
      recording('aria2', calls),
      recording('direct', calls),
    )
    await Effect.runPromise(strategy.save(req))
    await Effect.runPromise(
      strategy.save({
        id: 'm1.json',
        url: 'data:application/json;charset=utf-8,%7B%7D',
        filename: 'alice/1_0.json',
      }),
    )
    expect(calls).toEqual(['aria2:m1', 'direct:m1.json'])
  })
})
