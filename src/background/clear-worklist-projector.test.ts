import { describe, expect, it, vi } from 'vitest'
import { makeClearWorklistProjector } from './clear-worklist-projector'
import type { ClearStateStore } from './clear-state-store'
import type { ClearCoordinatorTrace } from './clear-state-store'
import type { StoredClearWorklistProjection } from './clear-worklist-projection'

const row: StoredClearWorklistProjection = {
  version: 1,
  revision: 1,
  tweetId: '1',
  scope: 'bookmark',
  state: 'downloaded',
  at: 10,
}

const harness = () => {
  let rows: StoredClearWorklistProjection[] = [row]
  const order: string[] = []
  const store: Pick<ClearStateStore, 'listWorklistProjections' | 'ackWorklistProjection'> = {
    listWorklistProjections: vi.fn<ClearStateStore['listWorklistProjections']>(async () => {
      order.push('list')
      return rows
    }),
    ackWorklistProjection: vi.fn<ClearStateStore['ackWorklistProjection']>(async (expected) => {
      order.push('ack')
      rows = rows.filter(
        (item) =>
          item.tweetId !== expected.tweetId ||
          item.scope !== expected.scope ||
          item.revision !== expected.revision,
      )
      return 'acked'
    }),
  }
  const sink = vi.fn<(projection: StoredClearWorklistProjection) => Promise<void>>(async () => {
    order.push('sink')
  })
  const ensureWake = vi.fn<() => Promise<void>>(async () => {
    order.push('wake')
  })
  const trace = vi.fn<(stage: string, context?: ClearCoordinatorTrace) => void>()
  const projector = makeClearWorklistProjector({
    store,
    sink,
    ensureWake,
    trace,
  })
  return { projector, store, sink, ensureWake, trace, order, rows: () => rows }
}

describe('Clear Worklist projector', () => {
  it('persists the sink before exact ack', async () => {
    const h = harness()

    await h.projector.drain()

    expect(h.order).toEqual(['list', 'wake', 'sink', 'ack'])
    expect(h.rows()).toEqual([])
  })

  it('retains and replays a row after sink failure', async () => {
    const h = harness()
    h.sink.mockRejectedValueOnce(new Error('storage down'))

    await h.projector.drain()
    expect(h.rows()).toEqual([row])
    expect(h.store.ackWorklistProjection).not.toHaveBeenCalled()

    await h.projector.drain()
    expect(h.rows()).toEqual([])
    expect(h.sink).toHaveBeenCalledTimes(2)
    expect(h.trace).toHaveBeenCalledWith(
      'clear-projection-error',
      expect.objectContaining({ tweetId: '1' }),
    )
  })

  it('replays an idempotent sink write when exact ack fails', async () => {
    const h = harness()
    const ack = vi.mocked(h.store.ackWorklistProjection)
    const persistAck = ack.getMockImplementation()!
    ack.mockRejectedValueOnce(new Error('ack down')).mockImplementation(persistAck)

    await h.projector.drain()
    expect(h.rows()).toEqual([row])

    await h.projector.drain()
    expect(h.sink).toHaveBeenCalledTimes(2)
    expect(h.rows()).toEqual([])
  })

  it('retains a row after an outbox read failure', async () => {
    const h = harness()
    vi.mocked(h.store.listWorklistProjections).mockRejectedValueOnce(new Error('idb down'))

    await h.projector.drain()

    expect(h.sink).not.toHaveBeenCalled()
    expect(h.rows()).toEqual([row])
  })

  it('retains a row when no recurring wake can be established', async () => {
    const h = harness()
    h.ensureWake.mockRejectedValueOnce(new Error('alarms down'))

    await h.projector.drain()

    expect(h.sink).not.toHaveBeenCalled()
    expect(h.rows()).toEqual([row])
    expect(h.trace).toHaveBeenCalledWith(
      'clear-projection-wake-error',
      expect.objectContaining({ detail: 'alarms down' }),
    )
  })

  it('does nothing when no rows remain', async () => {
    const h = harness()
    await h.store.ackWorklistProjection(row)
    h.order.length = 0

    await h.projector.drain()

    expect(h.order).toEqual(['list'])
  })

  it('immediately drains a newer row when exact ack reports stale', async () => {
    const h = harness()
    const newer = { ...row, revision: 2, state: 'cleared' as const, at: 11 }
    vi.mocked(h.store.ackWorklistProjection)
      .mockImplementationOnce(async () => {
        h.order.push('stale')
        return 'stale'
      })
      .mockImplementationOnce(async () => {
        h.order.push('ack')
        return 'acked'
      })
    vi.mocked(h.store.listWorklistProjections)
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([newer])

    await h.projector.drain()

    expect(h.sink).toHaveBeenNthCalledWith(1, row)
    expect(h.sink).toHaveBeenNthCalledWith(2, newer)
  })
})
