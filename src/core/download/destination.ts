import { renderFilename } from './filename'
import type { MediaItem } from '../schema'

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
  const meta: Record<string, unknown> = {
    handle: item.handle,
    tweetId: item.tweetId,
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
      id: `${opts.item.id}.json`,
      url: sidecarDataUrl(buildSidecar(opts.item, opts.ctx)),
      filename: sidecarFilename(filename),
    },
  ]
}
