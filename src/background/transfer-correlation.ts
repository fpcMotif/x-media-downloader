import { classifyTransfer, type ReconcileRow } from '@/packages/download/transfer-tracker'

export interface TransferCorrelationPorts {
  /** The `downloads.search` row for one download id; `undefined` when the record is purged. */
  readonly search: (downloadId: number) => Promise<ReconcileRow | undefined>
  readonly retryOwns: (requestId: string) => boolean
  readonly complete: (requestId: string, downloadId: number, now: number) => Promise<void>
  readonly fail: (requestId: string, downloadId: number, now: number) => Promise<void>
  readonly trace: (stage: string, entry: { itemId: string; detail: string }) => void
  readonly now: () => number
}

export interface ReconcileSummary {
  /** Transfers `downloads.search` still reports as downloading. */
  readonly inProgress: number
  readonly pollable: number
}

export interface TransferCorrelation {
  readonly register: (downloadId: number, requestId: string, startedAt: number) => void
  readonly requestFor: (downloadId: number) => string | undefined
  readonly startedAt: (downloadId: number) => number | undefined
  readonly release: (downloadId: number) => void
  readonly clear: () => void
  readonly size: () => number
  readonly requestIds: () => ReadonlyMap<number, string>
  readonly reconcile: (options: {
    readonly minAgeMs: number
    readonly only?: ReadonlyArray<number>
  }) => Promise<ReconcileSummary>
}

const QUIET_AFTER_PURGED_ROUNDS = 3

/**
 * Owns the in-memory `downloadId → request` correlation of browser transfers in
 * flight, and recovers a terminal state that `downloads.onChanged` never
 * delivered to a registered id.
 *
 * @remarks `reconcile` settles through `ports.complete` / `ports.fail` only what
 * `downloads.search` itself reports terminal. A transfer still downloading, a
 * purged record, a failed search, and an id the retry queue owns are left alone.
 * The caller's settle port must `release` the id before its first await, so a
 * concurrent `onChanged` terminal for the same id is not settled twice.
 *
 * @see ADR-0002
 */
export function makeTransferCorrelation(ports: TransferCorrelationPorts): TransferCorrelation {
  const requestByDownloadId = new Map<number, string>()
  const startedAtByDownloadId = new Map<number, number>()
  const pausedDownloadIds = new Set<number>()
  const purgedRoundsByDownloadId = new Map<number, number>()

  const forgetQuiet = (downloadId: number): void => {
    pausedDownloadIds.delete(downloadId)
    purgedRoundsByDownloadId.delete(downloadId)
  }

  const isQuiet = (downloadId: number): boolean =>
    pausedDownloadIds.has(downloadId) ||
    (purgedRoundsByDownloadId.get(downloadId) ?? 0) >= QUIET_AFTER_PURGED_ROUNDS

  const release = (downloadId: number): void => {
    requestByDownloadId.delete(downloadId)
    startedAtByDownloadId.delete(downloadId)
    forgetQuiet(downloadId)
  }

  const reconcileOne = async (downloadId: number, requestId: string): Promise<boolean> => {
    let row: ReconcileRow | undefined
    try {
      row = await ports.search(downloadId)
    } catch {
      return false
    }
    // A live onChanged may have settled it during the search.
    if (requestByDownloadId.get(downloadId) !== requestId) return false
    if (row === undefined) {
      purgedRoundsByDownloadId.set(downloadId, (purgedRoundsByDownloadId.get(downloadId) ?? 0) + 1)
    } else {
      purgedRoundsByDownloadId.delete(downloadId)
    }
    if (row?.paused === true && row.state !== 'complete' && row.state !== 'interrupted') {
      pausedDownloadIds.add(downloadId)
    } else {
      pausedDownloadIds.delete(downloadId)
    }
    const verdict = classifyTransfer(row)
    const now = ports.now()
    if (verdict === 'complete') {
      ports.trace('reconcile-stuck-complete', {
        itemId: requestId,
        detail: `downloadId ${downloadId}`,
      })
      await ports.complete(requestId, downloadId, now)
    } else if (verdict === 'failed') {
      ports.trace('reconcile-stuck-failed', {
        itemId: requestId,
        detail: `downloadId ${downloadId}`,
      })
      await ports.fail(requestId, downloadId, now)
    }
    return verdict === 'in-progress'
  }

  return {
    register: (downloadId, requestId, startedAt) => {
      requestByDownloadId.set(downloadId, requestId)
      startedAtByDownloadId.set(downloadId, startedAt)
      forgetQuiet(downloadId)
    },
    requestFor: (downloadId) => requestByDownloadId.get(downloadId),
    startedAt: (downloadId) => startedAtByDownloadId.get(downloadId),
    release,
    clear: () => {
      requestByDownloadId.clear()
      startedAtByDownloadId.clear()
      pausedDownloadIds.clear()
      purgedRoundsByDownloadId.clear()
    },
    size: () => requestByDownloadId.size,
    requestIds: () => requestByDownloadId,
    reconcile: async ({ minAgeMs, only }) => {
      const now = ports.now()
      const wanted = only === undefined ? null : new Set(only)
      // Snapshot first: the settle ports release entries mid-loop.
      const due = [...requestByDownloadId.entries()].filter(
        ([downloadId, requestId]) =>
          (wanted === null || wanted.has(downloadId)) &&
          !ports.retryOwns(requestId) &&
          now - (startedAtByDownloadId.get(downloadId) ?? now) >= minAgeMs,
      )
      const stillDownloading = await Promise.all(
        due.map(([downloadId, requestId]) => reconcileOne(downloadId, requestId)),
      )
      const pollable = [...requestByDownloadId.keys()].filter(
        (downloadId) => !isQuiet(downloadId),
      ).length
      return { inProgress: stillDownloading.filter(Boolean).length, pollable }
    },
  }
}
