import { Layer } from 'effect'
import { makeFetchServiceLive, type FetchService } from '@/packages/kernel/fetch-service'
import { makeSourceFetchLive, type SourceFetch } from './lib/source-fetch'
import { FolderCacheLive, type FolderCache } from './lib/folder-cache'

/** The services the cloud byte path reads from `R` (ADR-0017). */
export type CloudServices = FetchService | SourceFetch | FolderCache

/**
 * The shared service graph, built once per SW life. `fetchImpl` is injected once
 * (the SW's single fetch capability); the `FolderCache` `Ref` is created once and
 * persists for the runtime's life.
 */
export const makeCloudServicesLive = (fetchImpl: typeof fetch): Layer.Layer<CloudServices> =>
  Layer.mergeAll(makeFetchServiceLive(fetchImpl), makeSourceFetchLive(fetchImpl), FolderCacheLive)
