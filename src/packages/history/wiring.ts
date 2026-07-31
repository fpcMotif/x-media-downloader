import type { MediaItem, Settings } from '@/packages/schema'
import { recordFromMediaItem } from './record'
import { upsert, applyTransition, type DownloadStore } from './store'

/** A queued or terminal action the background derives at the same points it builds Sync Events. */
export type HistoryAction =
  | { kind: 'queued'; item: MediaItem; filename: string; at: number }
  | {
      kind: 'completed' | 'failed'
      requestId: string
      at: number
      bytes?: { received: number; total: number }
    }

/** A Save Request id maps to a real Media Item (false for sidecar `<id>.json`). */
export function isMirrorableRequest(requestId: string, hasMediaItem: boolean): boolean {
  return hasMediaItem && !requestId.endsWith('.json')
}

/**
 * Fold a queued/terminal action into the local download store, gated by
 * `downloadHistoryEnabled` (orthogonal to Cloud Sync). The queued record reuses
 * `recordFromMediaItem`, so its media payload matches the queued Sync Event —
 * and therefore Convex `media_state` — by construction.
 */
export function planHistory(
  store: DownloadStore,
  settings: Settings,
  action: HistoryAction,
): DownloadStore {
  if (!settings.downloadHistoryEnabled) return store
  if (action.kind === 'queued') {
    if (!isMirrorableRequest(action.item.id, true)) return store
    return upsert(store, recordFromMediaItem(action.item, action.filename, action.at))
  }
  return applyTransition(store, action.requestId, action.kind, action.at, action.bytes)
}
