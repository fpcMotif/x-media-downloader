import { renderFilename } from '../download/filename'
import { sidecarDataUrl, type PlannedDownload } from '../download/destination'
import { filterLinks, type ArchivedLink, type LinkMode } from './links'
import type { TweetCandidate } from './capture'
import type { MediaItem } from '../schema'

/**
 * The per-tweet archive record (ADR-0010): a durable JSON sibling of the saved
 * media that records the tweet itself — url, author, text, and classified
 * outbound links (esp. scholarly: arXiv, DOI, Springer, …). Rides the same
 * `data:`-URL download path as the sidecar (ADR-0007), so no new permissions.
 */

export interface ArchiveOptions {
  readonly includeText: boolean
  readonly linkMode: LinkMode
}

export interface ArchiveRecord {
  readonly tweetId: string
  readonly handle: string
  readonly tweetUrl: string
  readonly source: TweetCandidate['source']
  readonly savedAt: string
  readonly createdAt?: string
  readonly text?: string
  readonly links?: ReadonlyArray<ArchivedLink>
  readonly media: ReadonlyArray<{
    readonly index: number
    readonly type: MediaItem['type']
    readonly url: string
  }>
}

/** Canonical permalink; an author-less tweet uses X's `/i/web/status/` form. */
export function tweetUrlFor(handle: string, tweetId: string): string {
  return handle === ''
    ? `https://x.com/i/web/status/${tweetId}`
    : `https://x.com/${handle}/status/${tweetId}`
}

/** Build the archive record for a candidate under the chosen options. */
export function buildArchiveRecord(
  c: TweetCandidate,
  opts: ArchiveOptions,
  savedAtIso: string,
): ArchiveRecord {
  return {
    tweetId: c.tweetId,
    handle: c.handle,
    tweetUrl: tweetUrlFor(c.handle, c.tweetId),
    source: c.source,
    savedAt: savedAtIso,
    ...(c.createdAt !== undefined ? { createdAt: c.createdAt } : {}),
    ...(opts.includeText ? { text: c.text } : {}),
    ...(opts.linkMode !== 'none' ? { links: filterLinks(c.links, opts.linkMode) } : {}),
    media: c.items.map((m) => ({ index: m.index, type: m.type, url: m.url })),
  }
}

/**
 * Where the record file lands: render the user's media template against a
 * synthetic photo item for this tweet, then replace the basename with
 * `{tweetId}_tweet.json`, preserving the rendered directory.
 */
export function archiveRecordFilename(template: string, c: TweetCandidate): string {
  const synthetic: MediaItem = {
    id: c.tweetId,
    tweetId: c.tweetId,
    handle: c.handle,
    type: 'photo',
    url: '',
    ext: 'json',
    index: 0,
  }
  const rendered = renderFilename(template, synthetic)
  const slash = rendered.lastIndexOf('/')
  const dir = slash >= 0 ? rendered.slice(0, slash + 1) : ''
  return `${dir}${c.tweetId}_tweet.json`
}

/** Plan the record as one download routed through the `data:`-URL path. */
export function planArchiveRecord(
  template: string,
  c: TweetCandidate,
  opts: ArchiveOptions,
  savedAtIso: string,
): PlannedDownload {
  return {
    id: `archive:${c.tweetId}`,
    url: sidecarDataUrl(buildArchiveRecord(c, opts, savedAtIso)),
    filename: archiveRecordFilename(template, c),
  }
}
