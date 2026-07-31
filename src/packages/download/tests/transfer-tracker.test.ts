import { describe, it, expect } from 'vitest'
import {
  classifyTransfer,
  emptyTracker,
  partitionOwnership,
  planBootReconcile,
  reconcile,
  settleTransfer,
  trackTransfer,
  type ReconcileRow,
  type TrackedTransfer,
} from '../transfer-tracker'

const t = (
  id: string,
  downloadId: number,
  extra: Partial<TrackedTransfer> = {},
): TrackedTransfer => ({
  id,
  downloadId,
  startedAt: 1000,
  ...extra,
})

describe('trackTransfer', () => {
  it('adds a transfer to the ledger', () => {
    const s = trackTransfer(emptyTracker, t('a', 1))
    expect(s.transfers).toEqual([t('a', 1)])
  })

  it('is idempotent on id — a re-track (e.g. a retry with a new downloadId) replaces, never duplicates', () => {
    const once = trackTransfer(emptyTracker, t('a', 1))
    const twice = trackTransfer(once, t('a', 9))
    expect(twice.transfers).toEqual([t('a', 9)])
  })

  it('does not mutate the input state', () => {
    const next = trackTransfer(emptyTracker, t('a', 1))
    expect(emptyTracker.transfers).toEqual([])
    expect(next).not.toBe(emptyTracker)
  })
})

describe('settleTransfer', () => {
  it('removes a transfer by id', () => {
    const s = trackTransfer(trackTransfer(emptyTracker, t('a', 1)), t('b', 2))
    expect(settleTransfer(s, 'a').transfers).toEqual([t('b', 2)])
  })

  it('returns the same reference when the id is unknown (idempotent settle)', () => {
    const s = trackTransfer(emptyTracker, t('a', 1))
    expect(settleTransfer(s, 'missing')).toBe(s)
  })
})

describe('classifyTransfer (per-row verdict)', () => {
  it('a complete row whose file still exists is the only confirmed success', () => {
    expect(classifyTransfer({ state: 'complete' })).toBe('complete')
    expect(classifyTransfer({ state: 'complete', exists: true })).toBe('complete')
  })

  it('a complete row whose file was deleted is a failure, not a success', () => {
    expect(classifyTransfer({ state: 'complete', exists: false })).toBe('failed')
  })

  it('an interrupted row is a failure', () => {
    expect(classifyTransfer({ state: 'interrupted' })).toBe('failed')
  })

  it('an in-progress (or stateless) row is still running', () => {
    expect(classifyTransfer({ state: 'in_progress' })).toBe('in-progress')
    expect(classifyTransfer({})).toBe('in-progress')
  })

  it('a purged record (no row) is unknown — neither confirmed landed nor failed', () => {
    expect(classifyTransfer(undefined)).toBe('unknown')
  })
})

describe('reconcile (ADR-0002 reconcile-against-downloads.search on SW restart)', () => {
  it('classifies every tracked transfer and keeps only the still-running ones', () => {
    const s = [t('done', 1), t('dead', 2), t('live', 3), t('gone', 4), t('purged', 5)].reduce(
      trackTransfer,
      emptyTracker,
    )
    const rows = new Map<number, ReconcileRow>([
      [1, { state: 'complete', exists: true }],
      [2, { state: 'interrupted' }],
      [3, { state: 'in_progress' }],
      [4, { state: 'complete', exists: false }],
      // downloadId 5 has no row — its record was purged while the SW was dead
    ])
    const r = reconcile(s, rows)
    expect(r.complete.map((x) => x.id)).toEqual(['done'])
    expect(r.failed.map((x) => x.id).toSorted()).toEqual(['dead', 'gone'])
    expect(r.inProgress.map((x) => x.id)).toEqual(['live'])
    expect(r.unknown.map((x) => x.id)).toEqual(['purged'])
  })

  it('on an empty ledger reconcile is a no-op', () => {
    const r = reconcile(emptyTracker, new Map())
    expect(r.complete).toEqual([])
    expect(r.failed).toEqual([])
    expect(r.inProgress).toEqual([])
    expect(r.unknown).toEqual([])
  })
})

describe('partitionOwnership (dual-ledger tie-break)', () => {
  it('defers ids the retry queue owns; reconcile owns the rest', () => {
    const { owned, deferred } = partitionOwnership(
      [t('a', 1), t('b', 2), t('c', 3)],
      new Set(['b']),
    )
    expect(owned.map((x) => x.id)).toEqual(['a', 'c'])
    expect(deferred.map((x) => x.id)).toEqual(['b'])
  })

  it('with no retry-owned ids, every transfer is owned by reconcile', () => {
    const { owned, deferred } = partitionOwnership([t('a', 1)], new Set())
    expect(owned.map((x) => x.id)).toEqual(['a'])
    expect(deferred).toEqual([])
  })
})

describe('planBootReconcile (boot reconcile decision)', () => {
  it('surfaces terminals, retains throws, merges concurrent starts, traces only true purges', () => {
    const persisted = {
      transfers: [
        t('done', 1),
        t('dead', 2),
        t('live', 3),
        t('gone', 4),
        t('purged', 5),
        t('retryOwned', 6),
        t('threw', 7),
      ],
    }
    const rows = new Map<number, ReconcileRow>([
      [1, { state: 'complete', exists: true }],
      [2, { state: 'interrupted' }],
      [3, { state: 'in_progress' }],
      [4, { state: 'complete', exists: false }],
      // 5 purged (no row); 6 retry-owned (never searched); 7 search threw (no row)
    ])
    const live = { transfers: [...persisted.transfers, t('conc', 8)] }
    const plan = planBootReconcile({
      persisted,
      retryOwnedIds: new Set(['retryOwned']),
      rowByDownloadId: rows,
      threwDownloadIds: new Set([7]),
      live,
    })
    expect(plan.toComplete.map((x) => x.id)).toEqual(['done'])
    expect(plan.toFail.map((x) => x.id).toSorted()).toEqual(['dead', 'gone'])
    // a transient throw is retained as in-flight, not abandoned…
    expect(plan.reSeed.map((x) => x.id).toSorted()).toEqual(['live', 'threw'])
    // …and excluded from the purge trace, unlike the truly-gone record
    expect(plan.unknownToTrace.map((x) => x.id)).toEqual(['purged'])
    // a concurrently-started transfer is merged back, never evicted
    expect(plan.nextState.transfers.map((x) => x.id).toSorted()).toEqual(['conc', 'live', 'threw'])
  })

  it('never drives a retry-owned transfer terminal or re-seeds it (the contract, encoded)', () => {
    const persisted = { transfers: [t('shared', 1)] }
    const plan = planBootReconcile({
      persisted,
      retryOwnedIds: new Set(['shared']),
      rowByDownloadId: new Map([[1, { state: 'complete', exists: true }]]),
      threwDownloadIds: new Set(),
      live: persisted,
    })
    expect(plan.toComplete).toEqual([])
    expect(plan.reSeed).toEqual([])
    expect(plan.nextState.transfers).toEqual([])
  })
})
