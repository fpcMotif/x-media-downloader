import { describe, expect, it } from 'vitest'
import { decideTerminalOutcome, type OutcomeState } from './terminal-outcome'
import { emptyMetrics, recordOutcome, type MetricsState } from './metrics'
import { emptyTracker, trackTransfer, type TrackerState } from './transfer-tracker'
import { syncEventId } from '../sync/events'

const DEVICE = 'device-1'
const NOW = 1_000

const trackerWith = (id: string): TrackerState =>
  trackTransfer(emptyTracker, { id, downloadId: 7, tweetId: 't1', startedAt: 0 })

const metrics = (): MetricsState => emptyMetrics({ total: 1, concurrencyCap: 3, startedAt: 0 })

const stateWith = (id: string): OutcomeState => ({ transfers: trackerWith(id), metrics: metrics() })

describe('decideTerminalOutcome', () => {
  it('settles the transfer, counts a completion, and emits sync/history/backlink', () => {
    const fx = decideTerminalOutcome(stateWith('m1'), 'm1', 'complete', NOW, DEVICE)

    expect(fx.transfers.transfers).toEqual([])
    expect(fx.metrics?.completed).toBe(1)
    expect(fx.metrics?.failed).toBe(0)
    expect(fx.metrics?.outcomes.has('m1')).toBe(true)
    expect(fx.syncEvents).toEqual([
      {
        eventId: syncEventId(DEVICE, 'm1', 'completed'),
        kind: 'completed',
        requestId: 'm1',
        deviceId: DEVICE,
        at: NOW,
      },
    ])
    expect(fx.historyActions).toEqual([{ kind: 'completed', requestId: 'm1', at: NOW }])
    expect(fx.backlink).toEqual({
      _tag: 'TransferOutcome',
      requestId: 'm1',
      outcome: 'complete',
      at: NOW,
    })
    expect(fx.persistSnapshot).toBe(true)
  })

  it('maps a failed outcome to the failed kind across every sink', () => {
    const fx = decideTerminalOutcome(stateWith('m2'), 'm2', 'failed', NOW, DEVICE)

    expect(fx.metrics?.failed).toBe(1)
    expect(fx.metrics?.completed).toBe(0)
    expect(fx.syncEvents[0]?.kind).toBe('failed')
    expect(fx.syncEvents[0]?.eventId).toBe(syncEventId(DEVICE, 'm2', 'failed'))
    expect(fx.historyActions).toEqual([{ kind: 'failed', requestId: 'm2', at: NOW }])
    expect(fx.backlink).toEqual({
      _tag: 'TransferOutcome',
      requestId: 'm2',
      outcome: 'failed',
      at: NOW,
    })
  })

  it('excludes sidecar .json from sync and backlink, but still settles + records history', () => {
    const state: OutcomeState = { transfers: emptyTracker, metrics: metrics() }
    const fx = decideTerminalOutcome(state, 'm3.json', 'complete', NOW, DEVICE)

    expect(fx.syncEvents).toEqual([])
    expect(fx.backlink).toBeNull()
    // The history transition still runs (a no-op downstream for an unqueued id),
    // and the tracker settle is a no-op for an id that was never tracked.
    expect(fx.historyActions).toEqual([{ kind: 'completed', requestId: 'm3.json', at: NOW }])
    expect(fx.transfers).toBe(state.transfers)
  })

  it('passes through a null metrics accumulator (post-recycle) without a delta', () => {
    const state: OutcomeState = { transfers: trackerWith('m4'), metrics: null }
    const fx = decideTerminalOutcome(state, 'm4', 'complete', NOW, DEVICE)

    expect(fx.metrics).toBeNull()
    expect(fx.transfers.transfers).toEqual([])
    expect(fx.syncEvents).toHaveLength(1)
    expect(fx.backlink).not.toBeNull()
  })

  it('is idempotent: a duplicate onChanged terminal neither re-settles nor double-counts', () => {
    const first = decideTerminalOutcome(stateWith('m5'), 'm5', 'complete', NOW, DEVICE)
    const second = decideTerminalOutcome(
      { transfers: first.transfers, metrics: first.metrics },
      'm5',
      'complete',
      NOW + 50,
      DEVICE,
    )

    // settleTransfer / recordOutcome return the same reference on a no-op.
    expect(second.transfers).toBe(first.transfers)
    expect(second.metrics).toBe(first.metrics)
    expect(second.metrics?.completed).toBe(1)
  })

  it('does not mutate the input state', () => {
    const state = stateWith('m6')
    const before = recordOutcome(metrics(), 'x', 'complete', NOW).completed
    decideTerminalOutcome(state, 'm6', 'complete', NOW, DEVICE)

    expect(state.transfers.transfers).toHaveLength(1)
    expect(state.metrics?.completed).toBe(0)
    expect(before).toBe(1) // recordOutcome sanity: the reducer it composes does count
  })
})
