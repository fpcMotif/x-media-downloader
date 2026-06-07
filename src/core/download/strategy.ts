import { Effect } from 'effect'
import type { MediaItem } from '../schema'
import { DownloadError } from '../errors'

/** Minimal port over `chrome.downloads.download` so strategies stay unit-testable. */
export interface DownloadsPort {
  readonly download: (opts: {
    readonly url: string
    readonly filename: string
    readonly conflictAction: 'uniquify'
  }) => Promise<number>
}

/** How bytes reach disk (ADR-0003). Returns the browser download id. */
export interface DownloadStrategy {
  readonly save: (item: MediaItem, filename: string) => Effect.Effect<number, DownloadError>
}

/**
 * Direct strategy (default): hand the Original-quality URL to the browser's
 * download manager. Needs only the `downloads` permission.
 */
export function makeDirectStrategy(downloads: DownloadsPort): DownloadStrategy {
  return {
    save: (item, filename) =>
      Effect.tryPromise({
        try: () => downloads.download({ url: item.url, filename, conflictAction: 'uniquify' }),
        catch: (cause) => new DownloadError({ id: item.id, reason: String(cause) }),
      }),
  }
}
