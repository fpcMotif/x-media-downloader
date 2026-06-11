import { planDownloads, sidecarDataUrl, type PlannedDownload } from '../download/destination'
import type { ArchiveSource, ArchiveTweetResult, TweetCapture } from '../schema'
import {
  buildSessionManifest,
  buildTweetRecord,
  sessionManifestFilename,
  tweetRecordFilename,
  type RecordOptions,
} from './record'

/** One archived tweet in the durable index (`local:archiveIndex`). */
export interface ArchiveIndexEntry {
  readonly archivedAt: string
  readonly sessionId: string
  readonly media: number
}
export type ArchiveIndex = Record<string, ArchiveIndexEntry>

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Tolerate a corrupt stored index: keep only well-formed entries. */
export function coerceIndex(raw: unknown): ArchiveIndex {
  if (!isObj(raw)) return {}
  const out: ArchiveIndex = {}
  for (const [tweetId, entry] of Object.entries(raw)) {
    if (
      isObj(entry) &&
      typeof entry['archivedAt'] === 'string' &&
      typeof entry['sessionId'] === 'string' &&
      typeof entry['media'] === 'number'
    ) {
      out[tweetId] = {
        archivedAt: entry['archivedAt'],
        sessionId: entry['sessionId'],
        media: entry['media'],
      }
    }
  }
  return out
}

/** Index after a run: entries added for tweets newly archived OK this run. */
export function markArchived(
  index: ArchiveIndex,
  results: ReadonlyArray<ArchiveTweetResult>,
  sessionId: string,
  archivedAt: string,
): ArchiveIndex {
  const next = { ...index }
  for (const r of results) {
    if (r.ok && !r.alreadyArchived) {
      next[r.tweetId] = { archivedAt, sessionId, media: r.total }
    }
  }
  return next
}

/** One tweet's slice of the plan: the request ids whose outcomes decide `ok`. */
export interface PlannedTweet {
  readonly tweetId: string
  readonly requestIds: ReadonlyArray<string>
}

export interface ArchivePlan {
  readonly downloads: ReadonlyArray<PlannedDownload>
  readonly tweets: ReadonlyArray<PlannedTweet>
  /** Tweet ids skipped because the index already has them — the idempotency cut. */
  readonly skipped: ReadonlyArray<string>
}

export interface ArchivePlanOptions extends RecordOptions {
  readonly template: string
  readonly sidecar: boolean
}

/**
 * Expand an archive run into concrete downloads: every not-yet-archived tweet
 * gets its media (plus per-item sidecars when enabled) and one `.tweet.json`
 * history record. Tweets already in the index are skipped whole — re-running
 * the job after an interruption downloads nothing twice. Captures are
 * de-duplicated by tweetId within the request as well.
 */
export function planArchive(opts: {
  readonly tweets: ReadonlyArray<TweetCapture>
  readonly source: ArchiveSource
  readonly sessionId: string
  readonly archivedAt: string
  readonly index: ArchiveIndex
  readonly options: ArchivePlanOptions
}): ArchivePlan {
  const downloads: PlannedDownload[] = []
  const tweets: PlannedTweet[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const capture of opts.tweets) {
    if (seen.has(capture.tweetId)) continue
    seen.add(capture.tweetId)
    if (opts.index[capture.tweetId] !== undefined) {
      skipped.push(capture.tweetId)
      continue
    }
    const planned = capture.media.flatMap((item) =>
      planDownloads({ template: opts.options.template, item, sidecar: opts.options.sidecar }),
    )
    const record = buildTweetRecord({
      capture,
      source: opts.source,
      sessionId: opts.sessionId,
      archivedAt: opts.archivedAt,
      template: opts.options.template,
      options: opts.options,
    })
    planned.push({
      id: `${capture.tweetId}.tweet.json`,
      url: sidecarDataUrl(record),
      filename: tweetRecordFilename(opts.options.template, capture),
    })
    downloads.push(...planned)
    tweets.push({ tweetId: capture.tweetId, requestIds: planned.map((p) => p.id) })
  }
  return { downloads, tweets, skipped }
}

/** The manifest rides the same data-URL download path as sidecars. */
export function sessionManifestDownload(opts: {
  readonly sessionId: string
  readonly source: ArchiveSource
  readonly archivedAt: string
  readonly options: RecordOptions
  readonly results: ReadonlyArray<ArchiveTweetResult>
}): PlannedDownload {
  return {
    id: `session-${opts.sessionId}`,
    url: sidecarDataUrl(buildSessionManifest(opts)),
    filename: sessionManifestFilename(opts.sessionId),
  }
}
