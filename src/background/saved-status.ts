/**
 * Background coordinator for the cross-device "Saved" status (B+C). Bridges
 * `SavedStatusRequest` messages from the overlay to the local-first `SavedIndex`
 * and feeds it every local completion. The index seed (from the durable download
 * history) and the `queryConvex` binding (gated on sync config) are owned by the
 * background entrypoint and injected here, so this stays a pure, testable shell.
 */
import type { SavedStatusRequest, SavedStatusResponse } from '../core/schema'
import type { SavedIndex, QueryConvex } from '../core/sync/saved-index'

export interface SavedStatusCoordinator {
  /** Answer an overlay sweep: which of these tweetIds are already downloaded. */
  readonly handle: (req: SavedStatusRequest) => Promise<SavedStatusResponse>
  /** A local download for `tweetId` completed — light it up immediately. */
  readonly onCompleted: (tweetId: string) => void
}

export function makeSavedStatusCoordinator(deps: {
  readonly index: SavedIndex
  readonly queryConvex: QueryConvex
}): SavedStatusCoordinator {
  return {
    handle: async (req) => {
      const saved = await deps.index.resolve([...req.tweetIds], deps.queryConvex)
      return { _tag: 'SavedStatusResponse', saved }
    },
    onCompleted: (tweetId) => deps.index.markSaved(tweetId),
  }
}
