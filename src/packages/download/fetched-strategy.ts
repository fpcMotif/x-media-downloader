import { Effect } from 'effect'
import { DownloadError, OffscreenSaveError } from './lib/errors'
import { errorReason } from '@/packages/kernel/error'
import { bindFetch } from '@/packages/kernel/fetch'
import { cdnMatchPatternsForAllAdapters } from '@/core/adapters/registry'
import type { DownloadStrategy, SaveRequest } from './strategy'

/** Every registered adapter's CDN match pattern (docs/adr/0019), requested at
 *  runtime when Fetched is enabled (ADR-0003). */
export const FETCHED_HOST_PATTERNS = cdnMatchPatternsForAllAdapters()

export const FETCHED_PERMISSIONS = ['offscreen'] as const

/**
 * Above this body size the SW must NOT buffer the whole response: Fetched reads
 * the full body into a `Uint8Array` and then `Array.from`s it across the message
 * boundary to the offscreen doc (several multiples of the file size resident at
 * once), so a large video would OOM the worker. Over-cap payloads fall back to
 * the Direct strategy, which streams straight to disk with zero SW buffering.
 */
export const MAX_FETCHED_BYTES = 96 * 1024 * 1024 // 96 MiB

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
    /** Declared body size from `content-length`, or null when absent/unparseable. */
    readonly contentLength: number | null
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

/** The MIME base of a content-type header (everything before the first `;`), trimmed. */
export function mimeBase(ct: string | null): string {
  return ct?.split(';', 1)[0]?.trim() ?? ''
}

/** Accept image/video payloads and lenient octet-stream; reject HTML/JSON error pages. */
export function isAllowedContentType(contentType: string | null): boolean {
  if (contentType === null) return false
  const base = mimeBase(contentType).toLowerCase()
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
  /**
   * Fallback for payloads too large to safely buffer in the SW (browser streams
   * them to disk). When omitted the size cap is not enforced — every payload
   * takes the buffered path (used by the existing unit tests).
   */
  readonly direct?: DownloadStrategy
  readonly maxBytes?: number
}): DownloadStrategy {
  const { permissions, fetch: fetchPort, offscreen, direct } = opts
  const maxBytes = opts.maxBytes ?? MAX_FETCHED_BYTES
  return {
    save: (req: SaveRequest) =>
      Effect.gen(function* () {
        const granted = yield* Effect.tryPromise({
          try: () => ensureFetchedPermissions(permissions),
          catch: (cause) => new DownloadError({ id: req.id, reason: String(cause) }),
        })
        if (!granted) {
          return yield* new DownloadError({ id: req.id, reason: 'fetched permissions denied' })
        }

        const response = yield* Effect.tryPromise({
          try: () => fetchPort.fetch(req.url),
          catch: (cause) => new DownloadError({ id: req.id, reason: String(cause) }),
        })

        if (!response.ok) {
          return yield* new DownloadError({
            id: req.id,
            reason: `fetch failed: HTTP ${response.status}`,
          })
        }

        if (!isAllowedContentType(response.contentType)) {
          return yield* new DownloadError({
            id: req.id,
            reason: `disallowed content-type: ${response.contentType ?? 'none'}`,
          })
        }

        // Size guard (OOM): a declared length over the cap — or a video with no
        // declared length at all — must not be buffered in the SW. Hand it to
        // Direct, which streams to disk. Images keep the Fetched verification
        // path: they're bounded and twimg sends their content-length.
        if (direct !== undefined) {
          const len = response.contentLength
          const overCap = len !== null && len > maxBytes
          const unsizedVideo =
            len === null && mimeBase(response.contentType).toLowerCase().startsWith('video/')
          if (overCap || unsizedVideo) return yield* direct.save(req)
        }

        const bytes = yield* Effect.tryPromise({
          try: () => response.bytes(),
          catch: (cause) => new DownloadError({ id: req.id, reason: String(cause) }),
        })

        // Belt-and-suspenders: a missing or under-reported content-length could
        // still hand us an over-cap body — prefer Direct over Array.from-messaging
        // it across to the offscreen document.
        if (direct !== undefined && bytes.length > maxBytes) return yield* direct.save(req)

        const mimeType = mimeBase(response.contentType) || 'application/octet-stream'

        // Acquire the offscreen document only once we are committed to saving.
        // `ensureDocument` increments the offscreen refcount that `closeDocument`
        // decrements; the try/finally guarantees exactly one close per ensure on
        // every exit (success, a rejected saveBlob, or a rejected ensureDocument).
        // An early return above never touched the refcount, so an error before this
        // point can no longer leak a permanently-open document.
        const downloadId = yield* Effect.tryPromise({
          try: () =>
            (async () => {
              try {
                await offscreen.ensureDocument()
                return await offscreen.saveBlob({ bytes, mimeType, filename: req.filename })
              } finally {
                await offscreen.closeDocument().catch(() => {})
              }
            })(),
          catch: (cause) => {
            const reason = cause instanceof Error ? cause : String(cause)
            return new DownloadError({ id: req.id, reason: errorReason(reason) })
          },
        })

        return { kind: 'browser' as const, id: downloadId }
      }),
  }
}

/** Chrome permissions port for production wiring. */
export function makePermissionsPort(): PermissionsPort {
  const permissions: Browser.runtime.ManifestPermission[] = ['offscreen']
  const req = { permissions, origins: [...FETCHED_HOST_PATTERNS] }
  return {
    contains: () => browser.permissions.contains(req),
    request: () => browser.permissions.request(req),
  }
}

/** Fetch port backed by the extension service worker's `fetch`. */
export function makeFetchPort(fetchImpl: typeof fetch): FetchPort {
  // Detach the bare global fetch or the MV3 SW rejects it with "Illegal invocation" (see bindFetch).
  const doFetch = bindFetch(fetchImpl)
  return {
    fetch: async (url) => {
      const res = await doFetch(url)
      const rawLen = res.headers.get('content-length')
      const parsedLen = rawLen === null ? Number.NaN : Number(rawLen)
      return {
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('content-type'),
        contentLength: Number.isFinite(parsedLen) ? parsedLen : null,
        bytes: async () => new Uint8Array(await res.arrayBuffer()),
      }
    },
  }
}

const OFFSCREEN_PATH = '/offscreen.html'
const OFFSCREEN_JUSTIFICATION =
  'Verify downloaded media bytes and create blob URLs for chrome.downloads'

let offscreenOpening: Promise<void> | null = null
// Saves sharing the single offscreen document. The default download concurrency
// is 3, so a multi-photo tweet fires several `save()`s at once, each ending in
// `closeDocument()`. Without this refcount the first to finish tears the document
// down while the others are mid `saveBlob`, and their messages land on a closed
// document ("offscreen save failed"). Close only once the last save settles.
let offscreenSaves = 0

/** The client-side mirror of the offscreen document's `OffscreenSaveRequest`
 *  (src/entrypoints/offscreen/main.ts) — kept in sync by hand since the two
 *  sides of a `runtime.sendMessage` cannot literally share a type. */
interface OffscreenSaveRequestMessage {
  readonly _tag: 'OffscreenSaveRequest'
  readonly bytes: ReadonlyArray<number>
  readonly mimeType: string
  readonly filename: string
}

/** The offscreen document's reply to {@link OffscreenSaveRequestMessage}. */
interface OffscreenSaveReply {
  readonly downloadId?: number
  readonly error?: string
}

/** Narrow a reply to one that actually carries the completed download's id. */
function hasDownloadId(res: OffscreenSaveReply): res is { downloadId: number } {
  return typeof res.downloadId === 'number'
}

/** Offscreen port backed by chrome.offscreen + runtime messaging. */
export function makeOffscreenPort(): OffscreenPort {
  return {
    ensureDocument: async () => {
      offscreenSaves += 1
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
      const res = await browser.runtime.sendMessage<
        OffscreenSaveRequestMessage,
        OffscreenSaveReply
      >({
        _tag: 'OffscreenSaveRequest',
        bytes: Array.from(bytes),
        mimeType,
        filename,
      })
      if (!hasDownloadId(res)) {
        throw new OffscreenSaveError({ message: res.error ?? 'offscreen save failed' })
      }
      return res.downloadId
    },
    closeDocument: async () => {
      offscreenSaves = Math.max(0, offscreenSaves - 1)
      if (offscreenSaves > 0) return
      if (await browser.offscreen.hasDocument()) await browser.offscreen.closeDocument()
    },
  }
}
