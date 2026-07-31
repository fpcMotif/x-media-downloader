import { renderFilename } from './filename'
import type { MediaItem } from '@/packages/schema'

/** One concrete download to hand to `chrome.downloads.download`. */
export interface PlannedDownload {
  readonly id: string
  readonly url: string
  readonly filename: string
}

/** Extra provenance for the sidecar that the MediaItem itself doesn't carry. */
export interface SidecarContext {
  readonly tweetUrl?: string
  readonly capturedAt?: string
}

/**
 * The request-id suffix `planDownloads` reserves for generated sidecars. Lives
 * here, next to the code that mints `${item.id}.json`, so the reservation and
 * the guard enforcing it can never drift apart.
 */
export const SIDECAR_ID_SUFFIX = '.json'

/** A page-supplied id the download path cannot safely key on. */
export interface RejectedMediaItemId {
  readonly itemId: string
  readonly reason: 'reserved sidecar id' | 'duplicate id in batch'
}

/**
 * Fail-closed id boundary, the sibling of the URL guard: MediaItems arrive from
 * a content script reading a page we don't control, and every downstream map is
 * keyed by `item.id` — `inFlight`, `requestMetaById`, `session:transfers`,
 * `local:downloadHistory`.
 *
 * Two ids are unusable:
 * - one ending in {@link SIDECAR_ID_SUFFIX}, because `planDownloads` mints the
 *   sidecar for item `Y` as `Y.json`. A page-supplied item literally called
 *   `Y.json` collides with it, and whichever download settles first resolves
 *   the other's entry — a real media file marked done by a metadata blob;
 * - one repeated inside a single batch, because `inFlight.add` and
 *   `requestMetaById.set` would silently collapse the pair and one completion
 *   would settle both.
 *
 * Partitions rather than rejecting the whole batch, matching
 * `partitionAllowedMediaItems`: a Quick-Grab-all over a carousel should still
 * save its good slides and report the rest.
 */
export function partitionUsableIds(items: ReadonlyArray<MediaItem>): {
  readonly allowed: MediaItem[]
  readonly rejected: RejectedMediaItemId[]
} {
  const allowed: MediaItem[] = []
  const rejected: RejectedMediaItemId[] = []
  const seen = new Set<string>()

  for (const item of items) {
    if (item.id.endsWith(SIDECAR_ID_SUFFIX)) {
      rejected.push({ itemId: item.id, reason: 'reserved sidecar id' })
    } else if (seen.has(item.id)) {
      rejected.push({ itemId: item.id, reason: 'duplicate id in batch' })
    } else {
      seen.add(item.id)
      allowed.push(item)
    }
  }
  return { allowed, rejected }
}

/**
 * Turn a media filename into its `.json` sidecar sibling: replace the last
 * extension, or append `.json` when there is none. Subfolders are preserved.
 */
export function sidecarFilename(mediaFilename: string): string {
  const slash = mediaFilename.lastIndexOf('/')
  const dot = mediaFilename.lastIndexOf('.')
  return dot > slash ? `${mediaFilename.slice(0, dot)}.json` : `${mediaFilename}.json`
}

/** Plain metadata object for the sidecar; ctx fields are added only when present. */
export function buildSidecar(item: MediaItem, ctx?: SidecarContext): Record<string, unknown> {
  // Sidecar JSON keys deliberately stay `handle`/`tweetId` — this is a
  // user-visible file format existing X users may already parse; only the
  // in-memory MediaItem field names generalized (ADR: multi-platform design).
  const meta: Record<string, unknown> = {
    handle: item.author,
    tweetId: item.postId,
    type: item.type,
    index: item.index,
    url: item.url,
  }
  if (ctx?.tweetUrl !== undefined) meta.tweetUrl = ctx.tweetUrl
  if (ctx?.capturedAt !== undefined) meta.capturedAt = ctx.capturedAt
  return meta
}

/**
 * Encode metadata as a `data:` URL routed through the same downloads path —
 * no host permissions needed. The payload round-trips via `decodeURIComponent`.
 */
export function sidecarDataUrl(meta: unknown): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(meta, null, 2))}`
}

/**
 * Expand a MediaItem into the downloads to perform: always the media file, plus
 * an optional `.json` sidecar sibling carrying its metadata.
 */
export function planDownloads(opts: {
  readonly template: string
  readonly item: MediaItem
  readonly sidecar: boolean
  readonly date?: string
  readonly ctx?: SidecarContext
}): ReadonlyArray<PlannedDownload> {
  const filename = renderFilename(opts.template, opts.item, opts.date)
  const media: PlannedDownload = { id: opts.item.id, url: opts.item.url, filename }
  if (!opts.sidecar) return [media]
  return [
    media,
    {
      id: `${opts.item.id}${SIDECAR_ID_SUFFIX}`,
      url: sidecarDataUrl(buildSidecar(opts.item, opts.ctx)),
      filename: sidecarFilename(filename),
    },
  ]
}
