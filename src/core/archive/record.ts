import { renderFilename } from '../download/filename'
import type {
  ArchiveLinkScope,
  ArchiveSource,
  ArchiveTweetResult,
  MediaItem,
  TweetCapture,
} from '../schema'
import { selectLinks } from './links'

/** Options the history record honours; both come from Settings. */
export interface RecordOptions {
  readonly includeText: boolean
  readonly linkScope: ArchiveLinkScope
}

/** The tweet's canonical permalink (`/i/web/` form when the author is unknown). */
export function tweetUrl(capture: Pick<TweetCapture, 'tweetId' | 'handle'>): string {
  const path = capture.handle === '' ? 'i/web' : capture.handle
  return `https://x.com/${path}/status/${capture.tweetId}`
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `20260611-142233-k3x9q1` — sortable, collision-safe enough for one browser. */
export function makeSessionId(
  now: number,
  rand: string = Math.random().toString(36).slice(2, 8),
): string {
  const d = new Date(now)
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  return `${date}-${time}-${rand}`
}

/**
 * Where the tweet's history record lands: the same directory the filename
 * template puts the tweet's media in, as `{tweetId}.tweet.json`. A tweet with
 * no media (a text-only bookmark of, say, an arXiv link) probes the template
 * with a synthetic item so it still lands in the author's directory.
 */
export function tweetRecordFilename(template: string, capture: TweetCapture): string {
  const probe: MediaItem = capture.media[0] ?? {
    id: capture.tweetId,
    tweetId: capture.tweetId,
    handle: capture.handle,
    type: 'photo',
    url: '',
    ext: 'json',
    index: 0,
  }
  const rendered = renderFilename(template, probe)
  const slash = rendered.lastIndexOf('/')
  const dir = slash >= 0 ? rendered.slice(0, slash + 1) : ''
  return `${dir}${capture.tweetId}.tweet.json`
}

/**
 * The per-tweet history record: provenance that outlives the bookmark/like it
 * came from. Text and links appear only as the options allow; media entries
 * carry the relative filename each item was saved under.
 */
export function buildTweetRecord(opts: {
  readonly capture: TweetCapture
  readonly source: ArchiveSource
  readonly sessionId: string
  readonly archivedAt: string
  readonly template: string
  readonly options: RecordOptions
}): Record<string, unknown> {
  const { capture, options } = opts
  const links = selectLinks(capture.links, options.linkScope)
  return {
    tweetId: capture.tweetId,
    handle: capture.handle,
    url: tweetUrl(capture),
    source: opts.source,
    sessionId: opts.sessionId,
    archivedAt: opts.archivedAt,
    ...(capture.createdAt !== undefined ? { createdAt: capture.createdAt } : {}),
    ...(options.includeText && capture.text !== undefined ? { text: capture.text } : {}),
    ...(options.linkScope !== 'none' ? { links } : {}),
    media: capture.media.map((item) => ({
      id: item.id,
      type: item.type,
      url: item.url,
      filename: renderFilename(opts.template, item),
    })),
  }
}

/**
 * The session manifest — the durable mark of one archive run: which tweets it
 * saved (or found already saved), with the options in force. Written once per
 * run that processed at least one new tweet.
 */
export function buildSessionManifest(opts: {
  readonly sessionId: string
  readonly source: ArchiveSource
  readonly archivedAt: string
  readonly options: RecordOptions
  readonly results: ReadonlyArray<ArchiveTweetResult>
}): Record<string, unknown> {
  const fresh = opts.results.filter((r) => !r.alreadyArchived)
  return {
    sessionId: opts.sessionId,
    source: opts.source,
    archivedAt: opts.archivedAt,
    options: { includeText: opts.options.includeText, linkScope: opts.options.linkScope },
    totals: {
      archived: fresh.filter((r) => r.ok).length,
      failed: fresh.filter((r) => !r.ok).length,
      alreadyArchived: opts.results.length - fresh.length,
    },
    tweets: opts.results.map((r) => ({
      tweetId: r.tweetId,
      ok: r.ok,
      completed: r.completed,
      total: r.total,
      alreadyArchived: r.alreadyArchived,
    })),
  }
}

/** Session manifests live together, outside any author directory. */
export function sessionManifestFilename(sessionId: string): string {
  return `x-archive/sessions/${sessionId}.json`
}
