import { Layer } from 'effect'
import { makeFetchServiceLive, type FetchService } from '@/packages/kernel/fetch-service'
import { withStallTimeout, withTotalTimeout } from '@/packages/kernel/fetch-timeout'
import { makeSourceFetchLive, type SourceFetch } from './lib/source-fetch'
import { FolderCacheLive, type FolderCache } from './lib/folder-cache'

const PROVIDER_FETCH_TIMEOUT_MS = 300_000
const SOURCE_HEADERS_TIMEOUT_MS = 30_000
const SOURCE_IDLE_TIMEOUT_MS = 60_000

/**
 * The services the cloud byte path reads from `R`.
 *
 * @see ADR-0017
 */
export type CloudServices = FetchService | SourceFetch | FolderCache

/**
 * The shared service graph, built once per SW life. `fetchImpl` is injected once
 * (the SW's single fetch capability); the `FolderCache` `Ref` is created once and
 * persists for the runtime's life.
 */
export const makeCloudServicesLive = (fetchImpl: typeof fetch): Layer.Layer<CloudServices> =>
  Layer.mergeAll(
    makeFetchServiceLive(withTotalTimeout(fetchImpl, PROVIDER_FETCH_TIMEOUT_MS)),
    makeSourceFetchLive(
      withStallTimeout(fetchImpl, SOURCE_HEADERS_TIMEOUT_MS, SOURCE_IDLE_TIMEOUT_MS),
    ),
    FolderCacheLive,
  )
