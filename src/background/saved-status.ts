/**
 * Background coordinator for the cross-device "Saved" status (B+C). Bridges
 * `SavedStatusRequest` messages from the overlay to the local-first `SavedIndex`
 * and feeds it every local completion. The index seed (from the durable download
 * history) and the `queryConvex` binding (gated on sync config) are owned by the
 * background entrypoint and injected here, so this stays a pure, testable shell.
 *
 * The reply is INSTANT: it carries only the locally-known subset and never waits
 * on (or fails because of) the ~300ms Convex round-trip — measured against the
 * live deployment, the RTT dwarfs the query's execution, so blocking the reply
 * on it delayed every chip by the network. The backstop refresh runs behind the
 * reply; late cross-device hits are pushed through `notifyFresh` (broadcast to
 * the overlays as `SavedStatusUpdate`), so they still land without re-sweeping.
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
  /** Push late cross-device hits to the overlays (fire-and-forget). */
  readonly notifyFresh?: (saved: ReadonlyArray<string>) => void
}): SavedStatusCoordinator {
  return {
    handle: async (req) => {
      const ids = [...req.tweetIds]
      // Fire the backstop behind the reply. `refresh` never rejects and
      // coalesces concurrent sweeps, so a scroll burst costs one query.
      void deps.index.refresh(ids, deps.queryConvex).then((fresh) => {
        if (fresh.length > 0) deps.notifyFresh?.(fresh)
        return undefined
      })
      return { _tag: 'SavedStatusResponse', saved: deps.index.known(ids) }
    },
    onCompleted: (tweetId) => deps.index.markSaved(tweetId),
  }
}
