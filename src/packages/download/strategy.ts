import { Effect } from 'effect'
import { DownloadError } from './lib/errors'
import type { Settings } from '@/packages/schema'

/**
 * Display metadata for the three download strategies — the single source of truth
 * shared by the popup's compact mode toggle and the options Downloads panel, so
 * the label/hint copy can never drift between the two surfaces.
 */
export const DOWNLOAD_MODES = [
  {
    value: 'direct',
    label: 'Direct',
    hint: 'Chrome downloads the file directly — the safest default.',
  },
  { value: 'fetched', label: 'Fetched', hint: 'Fetches and verifies each file before saving.' },
  { value: 'aria2', label: 'aria2', hint: 'Hands the download to a local aria2 JSON-RPC engine.' },
] as const satisfies ReadonlyArray<{
  readonly value: Settings['downloadStrategy']
  readonly label: string
  readonly hint: string
}>

/**
 * One unit of work for a strategy: a URL to fetch + a relative filename to write.
 * Decoupled from `MediaItem` so non-media artifacts (e.g. sidecar metadata as a
 * `data:` URL) flow through the same seam (ADR-0003: a strategy is *how bytes
 * reach disk*, independent of the media domain object).
 */
export interface SaveRequest {
  readonly id: string
  readonly url: string
  readonly filename: string
}

/** The opaque receipt a strategy returns once a transfer has started. */
export type DownloadHandle =
  | { readonly kind: 'browser'; readonly id: number }
  | { readonly kind: 'aria2'; readonly gid: string }

/** Minimal port over `chrome.downloads.download` so strategies stay unit-testable. */
export interface DownloadsPort {
  readonly download: (opts: {
    readonly url: string
    readonly filename: string
    readonly conflictAction: 'uniquify'
  }) => Promise<number>
}

/** How bytes reach disk (ADR-0003). Returns the started transfer's handle. */
export interface DownloadStrategy {
  readonly save: (req: SaveRequest) => Effect.Effect<DownloadHandle, DownloadError>
}

/**
 * Direct strategy (default): hand the Original-quality URL to the browser's
 * download manager. Needs only the `downloads` permission.
 */
export function makeDirectStrategy(downloads: DownloadsPort): DownloadStrategy {
  return {
    save: (req) =>
      Effect.tryPromise({
        try: () =>
          downloads.download({ url: req.url, filename: req.filename, conflictAction: 'uniquify' }),
        catch: (cause) => new DownloadError({ id: req.id, reason: String(cause) }),
      }).pipe(Effect.map((id) => ({ kind: 'browser' as const, id }))),
  }
}

/**
 * Route `data:` URLs (sidecar metadata) to the browser strategy — an external
 * daemon like aria2 only speaks network schemes and would fail every sidecar.
 * Everything else goes to `primary`.
 */
export function makeSchemeRoutingStrategy(
  primary: DownloadStrategy,
  dataUrls: DownloadStrategy,
): DownloadStrategy {
  return {
    save: (req) => (req.url.startsWith('data:') ? dataUrls.save(req) : primary.save(req)),
  }
}
