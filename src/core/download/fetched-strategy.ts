import { Effect } from 'effect'
import {
  type ByteSource,
  type FetchedTransferGateway,
  MAX_FETCHED_BYTES,
} from './fetched-transfer-contract'
import { cdnMatchPatternsForAllPlatforms } from '../adapters/catalog'
import { errorReason } from '../error'
import { DownloadError } from '../errors'
import { makeMediaFetchPort } from '../media-url-policy'
import type { DownloadStrategy, SaveRequest } from './strategy'

export const FETCHED_HOST_PATTERNS = cdnMatchPatternsForAllPlatforms()
export { MAX_FETCHED_BYTES }
export const FETCHED_SIZE_LIMIT_REASON =
  'Fetched supports files up to 15 MiB. Choose Direct for this file.'
export const FETCHED_ACCESS_MISSING_REASON = 'Fetched access is missing. Select Fetched again.'

export type PermissionRequest = Parameters<typeof browser.permissions.request>[0]

export interface PermissionsPort {
  readonly contains: (req: PermissionRequest) => Promise<boolean>
}

/** UI-only promise boundary; browser callback overloads stay outside the core. */
export interface PermissionRequestPort {
  readonly request: (request: PermissionRequest) => Promise<boolean>
}

export interface FetchPort {
  readonly fetch: (
    url: string,
    signal?: AbortSignal,
  ) => Promise<{
    readonly ok: boolean
    readonly status: number
    readonly contentType: string | null
    readonly contentLength: number | null
    readonly body: ByteSource | null
  }>
}

export function mimeBase(contentType: string | null): string {
  return contentType?.split(';', 1)[0]?.trim() ?? ''
}

export function isAllowedContentType(contentType: string | null): boolean {
  const base = mimeBase(contentType).toLowerCase()
  return (
    base === 'application/octet-stream' || base.startsWith('image/') || base.startsWith('video/')
  )
}

const fetchedPermissionRequest = (): PermissionRequest => ({
  origins: [...FETCHED_HOST_PATTERNS],
})

const cancelBody = async (body: ByteSource | null): Promise<void> => {
  if (body !== null) await body.cancel().catch(() => {})
}

/** Prompts for every optional permission Fetched mode needs. */
export const requestFetchedAccess = (permissions: PermissionRequestPort): Promise<boolean> =>
  permissions.request({
    origins: [...FETCHED_HOST_PATTERNS],
  })

/** Worker policy: only check. UI owns gesture-bound permission requests. */
export function makeFetchedStrategy(opts: {
  readonly permissions: PermissionsPort
  readonly fetch: FetchPort
  readonly gateway: FetchedTransferGateway
  readonly ownerFor: (
    request: SaveRequest,
  ) => import('./fetched-transfer-contract').FetchedTransferOwner
  /** Exact lease durably armed by the launch owner before `save`. */
  readonly leaseFor?: (request: SaveRequest) => string | undefined
}): DownloadStrategy {
  return {
    save: (request: SaveRequest) =>
      Effect.gen(function* () {
        const granted = yield* Effect.tryPromise({
          try: () => opts.permissions.contains(fetchedPermissionRequest()),
          catch: (cause) => new DownloadError({ id: request.id, reason: errorReason(cause) }),
        })
        if (!granted)
          return yield* new DownloadError({
            id: request.id,
            reason: FETCHED_ACCESS_MISSING_REASON,
          })
        const owner = opts.ownerFor(request)
        const leaseId = opts.leaseFor?.(request)
        const start = {
          owner,
          filename: request.filename,
          open: async (signal?: AbortSignal) => {
            const response = await opts.fetch.fetch(request.url, signal)
            if (!response.ok) {
              await cancelBody(response.body)
              throw new Error(`fetch failed: HTTP ${response.status}`)
            }
            if (!isAllowedContentType(response.contentType)) {
              await cancelBody(response.body)
              throw new Error(`disallowed content-type: ${response.contentType ?? 'none'}`)
            }
            if (response.contentLength !== null && response.contentLength > MAX_FETCHED_BYTES) {
              await cancelBody(response.body)
              throw new Error(FETCHED_SIZE_LIMIT_REASON)
            }
            if (response.body === null) throw new Error('fetched response has no body')
            return {
              mimeType: mimeBase(response.contentType) || 'application/octet-stream',
              body: response.body,
            }
          },
        }
        const result = yield* Effect.tryPromise({
          try: () =>
            leaseId === undefined
              ? opts.gateway.start(start)
              : opts.gateway.startReserved({ ...start, leaseId }),
          catch: (cause) => new DownloadError({ id: request.id, reason: errorReason(cause) }),
        })
        if (result.kind === 'too-large')
          return yield* new DownloadError({
            id: request.id,
            reason: FETCHED_SIZE_LIMIT_REASON,
          })
        if (result.kind === 'busy')
          return yield* new DownloadError({
            id: request.id,
            reason: 'Fetched capacity is full. This download is queued.',
            retryable: false,
            certainty: 'deferred-capacity',
          })
        if (result.kind === 'owner-duplicate')
          return yield* new DownloadError({
            id: request.id,
            reason: 'Fetched transfer is already pending.',
            retryable: false,
            certainty: 'ambiguous-handoff',
          })
        if (result.kind === 'unavailable')
          return yield* new DownloadError({
            id: request.id,
            reason: 'Fetched recovery is unavailable.',
            retryable: false,
          })
        if (result.kind === 'handoff-ambiguous')
          return yield* new DownloadError({
            id: request.id,
            reason: 'fetched handoff is ambiguous',
            retryable: false,
            certainty: 'ambiguous-handoff',
          })
        return { kind: 'browser' as const, id: result.downloadId }
      }),
  }
}

export function makePermissionsPort(): PermissionsPort {
  const request = fetchedPermissionRequest()
  return { contains: () => browser.permissions.contains(request) }
}

export function makeFetchPort(fetchImpl: typeof fetch): FetchPort {
  const media = makeMediaFetchPort(fetchImpl)
  return {
    fetch: async (url, signal) => {
      const response = await media.fetch(url, signal === undefined ? undefined : { signal })
      const rawLength = response.headers.get('content-length')
      const parsedLength = rawLength === null ? Number.NaN : Number(rawLength)
      const reader = response.body?.getReader()
      return {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get('content-type'),
        contentLength:
          Number.isSafeInteger(parsedLength) && parsedLength >= 0 ? parsedLength : null,
        body:
          reader === undefined
            ? null
            : {
                read: async () => {
                  const next = await reader.read()
                  return next.done ? { done: true } : { done: false, value: next.value }
                },
                cancel: () => reader.cancel(),
              },
      }
    },
  }
}
