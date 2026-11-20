import { describe, expect, it } from 'vitest'
import type { ReconcileRow } from '@/packages/download/transfer-tracker'
import { makeTransferCorrelation, type TransferCorrelation } from './transfer-correlation'

const STUCK_AFTER_MS = 12_000

interface Harness {
  readonly correlation: TransferCorrelation
  readonly settled: string[]
  readonly rows: Map<number, ReconcileRow>
  readonly retryOwned: Set<string>
  readonly clock: { now: number }
  readonly searchGate: { release: (() => void) | null }
}

const harness = (options: { readonly holdSearch?: boolean } = {}): Harness => {
  const settled: string[] = []
  const rows = new Map<number, ReconcileRow>()
  const retryOwned = new Set<string>()
  const clock = { now: 100_000 }
  const searchGate: Harness['searchGate'] = { release: null }
  const correlation: TransferCorrelation = makeTransferCorrelation({
    search: async (downloadId) => {
      if (options.holdSearch)
        await new Promise<void>((resolve) => {
          searchGate.release = resolve
        })
      return rows.get(downloadId)
    },
    retryOwns: (id) => retryOwned.has(id),
    complete: async (id, downloadId) => {
      correlation.release(downloadId)
      settled.push(`complete:${id}:${downloadId}`)
    },
    fail: async (id, downloadId) => {
      correlation.release(downloadId)
      settled.push(`failed:${id}:${downloadId}`)
    },
    trace: () => {},
    now: () => clock.now,
  })
  return { correlation, settled, rows, retryOwned, clock, searchGate }
}

describe('transfer correlation', () => {
  it('settles a transfer whose terminal event was missed once it outlives the stuck window', async () => {
    const h = harness()
    h.correlation.register(7, 'media-a', h.clock.now)
    h.rows.set(7, { state: 'complete', exists: true })

    h.clock.now += STUCK_AFTER_MS - 1
    await h.correlation.reconcile({ minAgeMs: STUCK_AFTER_MS })
    expect(h.settled).toEqual([])

    h.clock.now += 1
    await h.correlation.reconcile({ minAgeMs: STUCK_AFTER_MS })
    expect(h.settled).toEqual(['complete:media-a:7'])
    expect(h.correlation.size()).toBe(0)
  })

  it('settles a transfer that finished before its id was registered', async () => {
    const h = harness()
    // The browser finished download 3 while the batch was still starting.
    h.rows.set(3, { state: 'complete', exists: true })
    h.rows.set(4, { state: 'in_progress' })
    h.correlation.register(3, 'fast', h.clock.now)
    h.correlation.register(4, 'slow', h.clock.now)

    const summary = await h.correlation.reconcile({ minAgeMs: 0, only: [3, 4] })

    expect(h.settled).toEqual(['complete:fast:3'])
    expect(summary.inProgress).toBe(1)
    expect(h.correlation.requestFor(4)).toBe('slow')
  })

  it('fails an interrupted transfer and a completed one whose file is gone', async () => {
    const h = harness()
    h.rows.set(1, { state: 'interrupted' })
    h.rows.set(2, { state: 'complete', exists: false })
    h.correlation.register(1, 'cut', h.clock.now)
    h.correlation.register(2, 'deleted', h.clock.now)

    await h.correlation.reconcile({ minAgeMs: 0 })

    expect(h.settled.toSorted()).toEqual(['failed:cut:1', 'failed:deleted:2'])
  })

  it('leaves a purged record, a retry-owned id, and an unlisted id alone', async () => {
    const h = harness()
    h.correlation.register(1, 'purged', h.clock.now)
    h.rows.set(2, { state: 'interrupted' })
    h.correlation.register(2, 'retrying', h.clock.now)
    h.retryOwned.add('retrying')
    h.rows.set(3, { state: 'complete', exists: true })
    h.correlation.register(3, 'unlisted', h.clock.now)

    const summary = await h.correlation.reconcile({ minAgeMs: 0, only: [1, 2] })

    expect(h.settled).toEqual([])
    expect(summary.inProgress).toBe(0)
    expect(h.correlation.size()).toBe(3)
  })

  it('does not settle twice when onChanged settles during the search', async () => {
    const h = harness({ holdSearch: true })
    h.rows.set(9, { state: 'complete', exists: true })
    h.correlation.register(9, 'raced', h.clock.now)

    const pending = h.correlation.reconcile({ minAgeMs: 0 })
    // The live onChanged terminal settles the id while the search is in flight.
    h.correlation.release(9)
    h.searchGate.release?.()
    await pending

    expect(h.settled).toEqual([])
  })

  it('does not settle a re-keyed download id under its previous request', async () => {
    const h = harness({ holdSearch: true })
    h.rows.set(9, { state: 'complete', exists: true })
    h.correlation.register(9, 'first', h.clock.now)

    const pending = h.correlation.reconcile({ minAgeMs: 0 })
    h.correlation.register(9, 'second', h.clock.now)
    h.searchGate.release?.()
    await pending

    expect(h.settled).toEqual([])
    expect(h.correlation.requestFor(9)).toBe('second')
  })
})
