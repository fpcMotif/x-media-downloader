import { describe, it, expect } from 'vitest'
import { Effect } from 'effect'
import { makeCloudServicesLive } from './cloud-services'
import { FetchService } from '../fetch-service'
import { SourceFetch } from './source-fetch'
import { FolderCache } from './folder-cache'

describe('makeCloudServicesLive', () => {
  it('builds one layer that provides FetchService, SourceFetch, and FolderCache', async () => {
    const fetchImpl = (async () => new Response('ok')) as typeof fetch
    // Provide the merged graph to an Effect that reads all three services from R —
    // the SW-life cloud runtime reads exactly these (ADR-0017).
    const present = await Effect.runPromise(
      Effect.gen(function* () {
        const fetchSvc = yield* FetchService
        const source = yield* SourceFetch
        const cache = yield* FolderCache
        return fetchSvc !== undefined && source !== undefined && cache !== undefined
      }).pipe(Effect.provide(makeCloudServicesLive(fetchImpl))),
    )
    expect(present).toBe(true)
  })
})
