import { Effect } from 'effect'
import { DownloadError } from '../errors'
import type { DownloadStrategy, SaveRequest } from './strategy'

/** twimg CDN match patterns requested at runtime when Fetched is enabled (ADR-0003). */
export const FETCHED_HOST_PATTERNS = [
  'https://pbs.twimg.com/*',
  'https://video.twimg.com/*',
] as const

export const FETCHED_PERMISSIONS = ['offscreen'] as const

/** Port over `chrome.permissions` for unit tests. */
export interface PermissionsPort {
  readonly contains: (req: {
    readonly permissions?: ReadonlyArray<string>
    readonly origins?: ReadonlyArray<string>
  }) => Promise<boolean>
  readonly request: (req: {
    readonly permissions?: ReadonlyArray<string>
    readonly origins?: ReadonlyArray<string>
  }) => Promise<boolean>
}

/** Port over `fetch()` for unit tests. */
export interface FetchPort {
  readonly fetch: (url: string) => Promise<{
    readonly ok: boolean
    readonly status: number
    readonly contentType: string | null
    readonly bytes: () => Promise<Uint8Array>
  }>
}

/** Port over the offscreen document lifecycle + blob save path. */
export interface OffscreenPort {
  readonly ensureDocument: () => Promise<void>
  readonly saveBlob: (opts: {
    readonly bytes: Uint8Array
    readonly mimeType: string
    readonly filename: string
  }) => Promise<number>
  readonly closeDocument: () => Promise<void>
}

/** Accept image/video payloads and lenient octet-stream; reject HTML/JSON error pages. */
export function isAllowedContentType(contentType: string | null): boolean {
  if (contentType === null) return false
  const base = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (base === 'application/octet-stream') return true
  if (base.startsWith('image/') || base.startsWith('video/')) return true
  return false
}

/** Ensure Fetched-mode optional permissions are granted before any CDN fetch. */
export async function ensureFetchedPermissions(port: PermissionsPort): Promise<boolean> {
  const req = {
    permissions: [...FETCHED_PERMISSIONS],
    origins: [...FETCHED_HOST_PATTERNS],
  }
  if (await port.contains(req)) return true
  return port.request(req)
}

/**
 * Fetched strategy (opt-in, ADR-0003): fetch bytes in the SW, verify content-type,
 * then save via an offscreen document that can call `URL.createObjectURL`.
 */
export function makeFetchedStrategy(opts: {
  readonly permissions: PermissionsPort
  readonly fetch: FetchPort
  readonly offscreen: OffscreenPort
}): DownloadStrategy {
  const { permissions, fetch: fetchPort, offscreen } = opts
  return {
    save: (req: SaveRequest) =>
      Effect.gen(function* () {
        const granted = yield* Effect.tryPromise({
          try: () => ensureFetchedPermissions(permissions),
          catch: (cause) => new DownloadError({ id: req.id, reason: String(cause) }),
        })
        if (!granted) {
          return yield* Effect.fail(
            new DownloadError({ id: req.id, reason: 'fetched permissions denied' }),
          )
        }

        yield* Effect.tryPromise({
          try: () => offscreen.ensureDocument(),
          catch: (cause) => new DownloadError({ id: req.id, reason: String(cause) }),
        })

        const response = yield* Effect.tryPromise({
          try: () => fetchPort.fetch(req.url),
          catch: (cause) => new DownloadError({ id: req.id, reason: String(cause) }),
        })

        if (!response.ok) {
          return yield* Effect.fail(
            new DownloadError({
              id: req.id,
              reason: `fetch failed: HTTP ${response.status}`,
            }),
          )
        }

        if (!isAllowedContentType(response.contentType)) {
          return yield* Effect.fail(
            new DownloadError({
              id: req.id,
              reason: `disallowed content-type: ${response.contentType ?? 'none'}`,
            }),
          )
        }

        const bytes = yield* Effect.tryPromise({
          try: () => response.bytes(),
          catch: (cause) => new DownloadError({ id: req.id, reason: String(cause) }),
        })

        const mimeType = response.contentType?.split(';', 1)[0]?.trim() ?? 'application/octet-stream'

        const downloadId = yield* Effect.tryPromise({
          try: () =>
            offscreen.saveBlob({ bytes, mimeType, filename: req.filename }).finally(() =>
              offscreen.closeDocument().catch(() => {}),
            ),
          catch: (cause) => new DownloadError({ id: req.id, reason: String(cause) }),
        })

        return { kind: 'browser' as const, id: downloadId }
      }),
  }
}

/** Chrome permissions port for production wiring. */
export function makePermissionsPort(): PermissionsPort {
  const req = {
    permissions: ['offscreen'] as Browser.runtime.ManifestPermission[],
    origins: [...FETCHED_HOST_PATTERNS],
  }
  return {
    contains: () => browser.permissions.contains(req),
    request: () => browser.permissions.request(req),
  }
}

/** Fetch port backed by the extension service worker's `fetch`. */
export function makeFetchPort(fetchImpl: typeof fetch): FetchPort {
  return {
    fetch: async (url) => {
      const res = await fetchImpl(url)
      return {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type'),
        bytes: async () => new Uint8Array(await res.arrayBuffer()),
      }
    },
  }
}

const OFFSCREEN_PATH = '/offscreen.html'
const OFFSCREEN_JUSTIFICATION =
  'Verify downloaded media bytes and create blob URLs for chrome.downloads'

let offscreenOpening: Promise<void> | null = null

/** Offscreen port backed by chrome.offscreen + runtime messaging. */
export function makeOffscreenPort(): OffscreenPort {
  return {
    ensureDocument: async () => {
      if (await browser.offscreen.hasDocument()) return
      if (offscreenOpening) return offscreenOpening
      offscreenOpening = browser.offscreen
        .createDocument({
          url: browser.runtime.getURL(OFFSCREEN_PATH),
          reasons: ['BLOBS'],
          justification: OFFSCREEN_JUSTIFICATION,
        })
        .finally(() => {
          offscreenOpening = null
        })
      return offscreenOpening
    },
    saveBlob: async ({ bytes, mimeType, filename }) => {
      const res = (await browser.runtime.sendMessage({
        _tag: 'OffscreenSaveRequest',
        bytes: Array.from(bytes),
        mimeType,
        filename,
      })) as { downloadId?: number; error?: string }
      if (typeof res.downloadId !== 'number') {
        throw new Error(res.error ?? 'offscreen save failed')
      }
      return res.downloadId
    },
    closeDocument: async () => {
      if (await browser.offscreen.hasDocument()) await browser.offscreen.closeDocument()
    },
  }
}
