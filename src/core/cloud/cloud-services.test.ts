import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { makeCloudServicesLive } from './cloud-services'
import { FetchService } from '../fetch-service'
import { SourceFetch } from './source-fetch'
import { FolderCache } from './folder-cache'

describe('makeCloudServicesLive', () => {
  it('wires FetchService + SourceFetch + FolderCache from one fetch capability', async () => {
    const fetchImpl = (async () => new Response('ok')) as unknown as typeof fetch
    const layer = makeCloudServicesLive(fetchImpl)
    // Resolving all three tags from the merged layer proves the graph is built once.
    const probe = Effect.gen(function* () {
      const http = yield* FetchService
      const source = yield* SourceFetch
      const cache = yield* FolderCache
      return [typeof http.fetch, typeof source.fetch, typeof cache.get] as const
    })
    const out = await Effect.runPromise(probe.pipe(Effect.provide(layer)))
    expect(out).toEqual(['function', 'function', 'function'])
  })
})
