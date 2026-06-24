/**
 * Transfer Tracker — the durable record of browser downloads in flight, from the
 * `Download Handle` (a `chrome.downloads` id) to a terminal outcome.
 *
 * The background SW correlates a browser `downloadId` back to its request id with
 * an in-memory map, but that map dies with the worker (ADR-0002: MV3 recycles the
 * SW after ~30s idle). A download that COMPLETES or FAILS while the worker is dead
 * is then lost — no metric, no history, no badge correction. This module persists
 * the in-flight set so it survives the recycle, and reconciles it against
 * `downloads.search` on restart to recover the outcomes that landed in the gap.
 *
 * Pure (no `chrome.*`, no timers, injected clock) — the background entrypoint owns
 * the I/O (search, storage, messaging) and feeds rows in. aria2 hand-offs are
 * terminal at enqueue (ADR-0006) and never enter this ledger; only browser
 * transfers, which surface terminal state via `downloads.onChanged`/`search`, do.
 */

/** One browser transfer tracked from start to terminal outcome. */
export interface TrackedTransfer {
  /** `SaveRequest.id` — equals the source `MediaItem.id` for the media file. */
  readonly id: string
  /** The `chrome.downloads` id (the current `Download Handle`; a retry re-keys it). */
  readonly downloadId: number
  /** Tweet provenance for the clear-on-complete ledger (absent for sidecar rows). */
  readonly tweetId?: string
  readonly startedAt: number
}

export interface TrackerState {
  readonly transfers: ReadonlyArray<TrackedTransfer>
}

export const emptyTracker: TrackerState = { transfers: [] }

/**
 * Register a started browser transfer. Idempotent on `id`: a re-track for the
 * same request (an interrupt retry that obtained a fresh `downloadId`) REPLACES
 * the prior entry rather than duplicating it.
 */
export function trackTransfer(state: TrackerState, transfer: TrackedTransfer): TrackerState {
  const others = state.transfers.filter((x) => x.id !== transfer.id)
  return { transfers: [...others, transfer] }
}

/** Drop a transfer once it reaches a terminal outcome. Idempotent: an unknown id
 *  returns the same reference, so a late duplicate settle is a cheap no-op. */
export function settleTransfer(state: TrackerState, id: string): TrackerState {
  if (!state.transfers.some((x) => x.id === id)) return state
  return { transfers: state.transfers.filter((x) => x.id !== id) }
}

/** Terminal verdict for a tracked transfer reconciled against its search row. */
export type ReconcileVerdict = 'complete' | 'failed' | 'in-progress' | 'unknown'

/** The fields of a `chrome.downloads.search` row this module reasons about. */
export interface ReconcileRow {
  readonly state?: string
  readonly exists?: boolean
}

/**
 * Classify one tracked transfer from its `downloads.search` row (or its absence).
 * Mirrors the byte-landed check the clear-on-complete settle path uses: a
 * `complete` row is a success ONLY if its file still exists on disk. A purged
 * record (no row) is `unknown` — the worker can neither confirm it landed nor that
 * it failed, so the caller must not fabricate an outcome for it.
 */
export function classifyTransfer(row: ReconcileRow | undefined): ReconcileVerdict {
  if (row === undefined) return 'unknown'
  if (row.state === 'complete') return row.exists === false ? 'failed' : 'complete'
  if (row.state === 'interrupted') return 'failed'
  return 'in-progress'
}

export interface ReconcileResult {
  readonly complete: ReadonlyArray<TrackedTransfer>
  readonly failed: ReadonlyArray<TrackedTransfer>
  readonly inProgress: ReadonlyArray<TrackedTransfer>
  readonly unknown: ReadonlyArray<TrackedTransfer>
}

/**
 * Reconcile the persisted ledger against the current `downloads.search` rows
 * (keyed by `downloadId`) on worker restart (ADR-0002). Terminal transfers are
 * partitioned so the caller can surface the outcomes that landed while the SW was
 * dead and re-seed the ones still in progress.
 */
export function reconcile(
  state: TrackerState,
  rowByDownloadId: ReadonlyMap<number, ReconcileRow>,
): ReconcileResult {
  const complete: TrackedTransfer[] = []
  const failed: TrackedTransfer[] = []
  const inProgress: TrackedTransfer[] = []
  const unknown: TrackedTransfer[] = []
  for (const transfer of state.transfers) {
    switch (classifyTransfer(rowByDownloadId.get(transfer.downloadId))) {
      case 'complete':
        complete.push(transfer)
        break
      case 'failed':
        failed.push(transfer)
        break
      case 'in-progress':
        inProgress.push(transfer)
        break
      case 'unknown':
        unknown.push(transfer)
        break
    }
  }
  return { complete, failed, inProgress, unknown }
}

export interface OwnershipPartition {
  /** Reconcile owns these — search + drive to terminal on boot. */
  readonly owned: ReadonlyArray<TrackedTransfer>
  /** The interrupt-retry queue owns these — reconcile must NOT touch them. */
  readonly deferred: ReadonlyArray<TrackedTransfer>
}

/**
 * The dual-ledger tie-break, made explicit (ADR-0014). A crash can leave a request
 * id in BOTH the persisted transfer ledger AND the interrupt-retry queue. The retry
 * queue is authoritative for the ids it owns, so reconcile defers those — driving an
 * id to a terminal here while the retry path also re-fires it would double-record the
 * outcome. The boot entrypoint must populate `retryOwnedIds` (rehydrate the retry
 * queue) BEFORE calling this; passing the set as a required argument encodes that
 * ordering in the type instead of leaving it to a comment.
 */
export function partitionOwnership(
  transfers: ReadonlyArray<TrackedTransfer>,
  retryOwnedIds: ReadonlySet<string>,
): OwnershipPartition {
  const owned: TrackedTransfer[] = []
  const deferred: TrackedTransfer[] = []
  for (const t of transfers) {
    if (retryOwnedIds.has(t.id)) deferred.push(t)
    else owned.push(t)
  }
  return { owned, deferred }
}

/** The boot reconcile decision: what to drive terminal, the next ledger state, what
 *  to re-seed into the live correlation, and which purges to trace. Pure — the
 *  entrypoint performs the `downloads.search` I/O and executes this plan. */
export interface BootReconcilePlan {
  /** Landed while the worker was dead — surface success (metrics/history/sync/badge). */
  readonly toComplete: ReadonlyArray<TrackedTransfer>
  /** Interrupted/gone while dead — surface failure. */
  readonly toFail: ReadonlyArray<TrackedTransfer>
  /** The reconciled ledger: survivors still in flight + concurrently-started transfers. */
  readonly nextState: TrackerState
  /** Survivors to re-seed into the live `downloadId → id` correlation + in-flight set. */
  readonly reSeed: ReadonlyArray<TrackedTransfer>
  /** Truly-purged transfers (record gone, not a transient search throw) to trace. */
  readonly unknownToTrace: ReadonlyArray<TrackedTransfer>
}

/**
 * Plan the boot reconciliation in one pure step (ADR-0002/0014). Given the persisted
 * ledger, the retry-queue ownership set (the tie-break), the search rows, the
 * downloadIds whose search THREW (transient — retained, not purged), and the LIVE
 * ledger snapshot taken after the search (to merge transfers a concurrent
 * `handleDownload` started during the await), produce the terminals to surface, the
 * next ledger state, the survivors to re-seed, and the purges to trace.
 */
export function planBootReconcile(input: {
  readonly persisted: TrackerState
  readonly retryOwnedIds: ReadonlySet<string>
  readonly rowByDownloadId: ReadonlyMap<number, ReconcileRow>
  readonly threwDownloadIds: ReadonlySet<number>
  readonly live: TrackerState
}): BootReconcilePlan {
  const { owned } = partitionOwnership(input.persisted.transfers, input.retryOwnedIds)
  const result = reconcile({ transfers: owned }, input.rowByDownloadId)
  // A transient search throw classifies as `unknown` (no row), but the transfer is
  // retained as in-flight rather than abandoned, and excluded from the purge trace.
  const retained = owned.filter((t) => input.threwDownloadIds.has(t.downloadId))
  const persistedIds = new Set(input.persisted.transfers.map((t) => t.id))
  const concurrent = input.live.transfers.filter((t) => !persistedIds.has(t.id))
  const reSeed = [...result.inProgress, ...retained]
  return {
    toComplete: result.complete,
    toFail: result.failed,
    nextState: { transfers: [...reSeed, ...concurrent] },
    reSeed,
    unknownToTrace: result.unknown.filter((t) => !input.threwDownloadIds.has(t.downloadId)),
  }
}
