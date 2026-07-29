import { Effect } from 'effect'
import { assertAllowedMediaUrl } from '../core/media-url-policy'
import { DownloadError } from '../core/errors'
import type { BrowserTransferMode } from '../core/download/transfer-mode'
import type { FetchedTransferGateway } from '../core/download/fetched-transfer-contract'
import type { FetchedTransferOwner } from '../core/download/fetched-transfer-contract'
import {
  makeFetchedStrategy,
  type FetchPort,
  type PermissionsPort,
} from '../core/download/fetched-strategy'
import type { DownloadsPort, SaveRequest } from '../core/download/strategy'

export interface InterruptRetryStarter {
  readonly reserveFetched: (
    request: SaveRequest,
    owner: FetchedTransferOwner,
  ) => Promise<
    | { readonly tag: 'reserved'; readonly leaseId: string }
    | { readonly tag: 'busy' }
    | { readonly tag: 'ambiguous' }
    | { readonly tag: 'failed' }
  >
  readonly startReservedFetched: (
    request: SaveRequest,
    owner: FetchedTransferOwner,
    leaseId: string,
  ) => Promise<
    | { readonly tag: 'started'; readonly downloadId: number }
    | { readonly tag: 'ambiguous' }
    | { readonly tag: 'failed' }
  >
  readonly start: (
    mode: BrowserTransferMode,
    request: SaveRequest,
    fetchedOwner: FetchedTransferOwner,
  ) => Promise<
    | { readonly tag: 'started'; readonly downloadId: number }
    | { readonly tag: 'ambiguous' }
    | { readonly tag: 'busy' }
    | { readonly tag: 'failed' }
  >
}

/** Restarts owned media only. Fetched never falls back to Direct. */
export function makeInterruptRetryStarter(opts: {
  readonly download: DownloadsPort['download']
  readonly permissions: PermissionsPort
  readonly fetch: FetchPort
  readonly gateway: FetchedTransferGateway
  /** Validates every persisted, migrated, or refreshed retry URL before egress. */
  readonly validateMediaUrl?: (url: string) => unknown
}): InterruptRetryStarter {
  const validate = (request: SaveRequest): boolean => {
    try {
      ;(opts.validateMediaUrl ?? assertAllowedMediaUrl)(request.url)
      return true
    } catch {
      return false
    }
  }
  const startFetched = async (
    request: SaveRequest,
    fetchedOwner: FetchedTransferOwner,
    leaseId?: string,
  ): Promise<
    | { readonly tag: 'started'; readonly downloadId: number }
    | { readonly tag: 'ambiguous' }
    | { readonly tag: 'busy' }
    | { readonly tag: 'failed' }
  > => {
    let handle
    try {
      handle = await Effect.runPromise(
        makeFetchedStrategy({
          permissions: opts.permissions,
          fetch: opts.fetch,
          gateway: opts.gateway,
          ownerFor: () => fetchedOwner,
          ...(leaseId === undefined ? {} : { leaseFor: () => leaseId }),
        }).save(request),
      )
    } catch (error) {
      if (error instanceof DownloadError && error.certainty === 'ambiguous-handoff')
        return { tag: 'ambiguous' }
      if (error instanceof DownloadError && error.certainty === 'deferred-capacity')
        return { tag: 'busy' }
      return { tag: 'failed' }
    }
    if (handle.kind !== 'browser') return { tag: 'failed' }
    return { tag: 'started', downloadId: handle.id }
  }
  return {
    reserveFetched: async (request, owner) => {
      if (!validate(request)) return { tag: 'failed' }
      const result = await opts.gateway.reserve(owner)
      if (result.kind === 'reserved') return { tag: 'reserved', leaseId: result.leaseId }
      if (result.kind === 'busy') return { tag: 'busy' }
      if (result.kind === 'owner-duplicate') return { tag: 'ambiguous' }
      return { tag: 'failed' }
    },
    startReservedFetched: async (request, owner, leaseId) => {
      if (!validate(request)) return { tag: 'failed' }
      const result = await startFetched(request, owner, leaseId)
      return result.tag === 'busy' ? { tag: 'failed' } : result
    },
    start: async (mode, request, fetchedOwner) => {
      if (!validate(request)) return { tag: 'failed' }
      if (mode === 'direct')
        return {
          tag: 'started',
          downloadId: await opts.download({
            url: request.url,
            filename: request.filename,
            conflictAction: 'uniquify',
          }),
        }
      return startFetched(request, fetchedOwner)
    },
  }
}
