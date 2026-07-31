import { describe, expect, it } from 'vitest'
import { decideEnqueueOutcome, decideTerminalOutcome, type OutcomeState } from '../terminal-outcome'
import { emptyMetrics, recordOutcome, recordSample, type MetricsState } from '../metrics'
import { emptyTracker, trackTransfer, type TrackerState } from '../transfer-tracker'
import { syncEventId } from '@/packages/sync/events'

const DEVICE = 'device-1'
const NOW = 1_000

const trackerWith = (id: string): TrackerState =>
  trackTransfer(emptyTracker, { id, downloadId: 7, tweetId: 't1', startedAt: 0 })

const metrics = (): MetricsState => emptyMetrics({ total: 1, concurrencyCap: 3, startedAt: 0 })

const stateWith = (id: string): OutcomeState => ({ transfers: trackerWith(id), metrics: metrics() })

describe('decideTerminalOutcome', () => {
  it('settles the transfer, counts a completion, and emits sync/history/backlink', () => {
    const state = stateWith('m1')
    const fx = decideTerminalOutcome(
      {
        ...state,
        metrics: recordSample(state.metrics!, {
          id: 'm1',
          bytesReceived: 400,
          totalBytes: 500,
          t: NOW - 1,
        }),
      },
      'm1',
      'complete',
      NOW,
      DEVICE,
      { tweetId: 't1', downloadId: 7 },
    )

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
    expect(fx.clearNotice).toEqual({
      outcome: 'complete',
      tweetId: 't1',
      requestId: 'm1',
      downloadId: 7,
    })
    expect(fx.postSavedMark).toEqual({ tweetId: 't1' })
    expect(fx.mediaSavedMark).toEqual({ requestId: 'm1' })
    expect(fx.budgetBump).toEqual({ bytes: 500, count: 1 })
    expect(fx.persistSnapshot).toBe(true)
  })

  it('budgets bytesReceived when the transfer size was unknown (totalBytes 0)', () => {
    const state = stateWith('m1b')
    const fx = decideTerminalOutcome(
      {
        ...state,
        metrics: recordSample(state.metrics!, {
          id: 'm1b',
          bytesReceived: 400,
          totalBytes: 0,
          t: NOW - 1,
        }),
      },
      'm1b',
      'complete',
      NOW,
      DEVICE,
      { tweetId: 't1', downloadId: 7 },
    )

    expect(fx.budgetBump).toEqual({ bytes: 400, count: 1 })
  })

  it('maps a failed outcome to the failed kind across every sink', () => {
    const fx = decideTerminalOutcome(stateWith('m2'), 'm2', 'failed', NOW, DEVICE, {
      tweetId: 't1',
      downloadId: 7,
    })

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
    expect(fx.clearNotice).toEqual({ outcome: 'failed', tweetId: 't1', requestId: 'm2' })
    expect(fx.postSavedMark).toBeNull()
    expect(fx.mediaSavedMark).toBeNull()
    expect(fx.budgetBump).toBeNull()
  })

  it('excludes sidecar .json from sync and backlink, but still settles + records history', () => {
    const state: OutcomeState = { transfers: emptyTracker, metrics: metrics() }
    const fx = decideTerminalOutcome(state, 'm3.json', 'complete', NOW, DEVICE, {
      tweetId: 't1',
      downloadId: 7,
    })

    expect(fx.syncEvents).toEqual([])
    expect(fx.backlink).toBeNull()
    // The history transition still runs (a no-op downstream for an unqueued id),
    // and the tracker settle is a no-op for an id that was never tracked.
    expect(fx.historyActions).toEqual([{ kind: 'completed', requestId: 'm3.json', at: NOW }])
    expect(fx.transfers).toBe(state.transfers)
    expect(fx.clearNotice).toBeNull()
    expect(fx.postSavedMark).toBeNull()
    expect(fx.mediaSavedMark).toBeNull()
    expect(fx.budgetBump).toBeNull()
  })

  it('without a Tweet emits no Clear, post-Saved, or budget intent', () => {
    const fx = decideTerminalOutcome(stateWith('m-no-post'), 'm-no-post', 'complete', NOW, DEVICE, {
      downloadId: 7,
    })

    expect(fx.clearNotice).toBeNull()
    expect(fx.postSavedMark).toBeNull()
    expect(fx.budgetBump).toBeNull()
    expect(fx.mediaSavedMark).toEqual({ requestId: 'm-no-post' })
  })

  it('passes through a null metrics accumulator (post-recycle) without a delta', () => {
    const state: OutcomeState = { transfers: trackerWith('m4'), metrics: null }
    const fx = decideTerminalOutcome(state, 'm4', 'complete', NOW, DEVICE, {
      tweetId: 't4',
      downloadId: 7,
    })

    expect(fx.metrics).toBeNull()
    expect(fx.transfers.transfers).toEqual([])
    expect(fx.syncEvents).toHaveLength(1)
    expect(fx.backlink).not.toBeNull()
    expect(fx.budgetBump).toEqual({ bytes: 0, count: 1 })
  })

  it('is idempotent: a duplicate onChanged terminal neither re-settles nor double-counts', () => {
    const first = decideTerminalOutcome(stateWith('m5'), 'm5', 'complete', NOW, DEVICE, {
      tweetId: 't5',
      downloadId: 7,
    })
    const second = decideTerminalOutcome(
      { transfers: first.transfers, metrics: first.metrics },
      'm5',
      'complete',
      NOW + 50,
      DEVICE,
      { tweetId: 't5', downloadId: 7 },
    )

    // settleTransfer / recordOutcome return the same reference on a no-op.
    expect(first.budgetBump).toEqual({ bytes: 0, count: 1 })
    expect(second.transfers).toBe(first.transfers)
    expect(second.metrics).toBe(first.metrics)
    expect(second.metrics?.completed).toBe(1)
    expect(second.budgetBump).toBeNull()
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

describe('decideEnqueueOutcome', () => {
  it('failed-to-start, non-sidecar: emits the failed sync event + history action', () => {
    const fx = decideEnqueueOutcome({
      metrics: metrics(),
      id: 'e1',
      outcome: 'failed',
      now: NOW,
      deviceId: DEVICE,
      tweetId: 't1',
    })

    expect(fx.syncEvent).toEqual({
      eventId: syncEventId(DEVICE, 'e1', 'failed'),
      kind: 'failed',
      requestId: 'e1',
      deviceId: DEVICE,
      at: NOW,
    })
    expect(fx.historyAction).toEqual({ kind: 'failed', requestId: 'e1', at: NOW })
    expect(fx.metrics.failed).toBe(1)
    expect(fx.postSavedMark).toBeNull()
    expect(fx.mediaSavedMark).toBeNull()
    expect(fx.budgetBump).toBeNull()
  })

  it('aria2 hand-off complete, non-sidecar: emits the completed sync event + history action', () => {
    const fx = decideEnqueueOutcome({
      metrics: metrics(),
      id: 'e2',
      outcome: 'complete',
      now: NOW,
      deviceId: DEVICE,
      tweetId: 't2',
      bytes: 1234,
    })

    expect(fx.syncEvent).toEqual({
      eventId: syncEventId(DEVICE, 'e2', 'completed'),
      kind: 'completed',
      requestId: 'e2',
      deviceId: DEVICE,
      at: NOW,
    })
    expect(fx.historyAction).toEqual({ kind: 'completed', requestId: 'e2', at: NOW })
    expect(fx.metrics.completed).toBe(1)
    expect(fx.postSavedMark).toEqual({ tweetId: 't2' })
    expect(fx.mediaSavedMark).toEqual({ requestId: 'e2' })
    expect(fx.budgetBump).toEqual({ bytes: 1234, count: 1 })
    expect('clearNotice' in fx).toBe(false)
  })

  it('failed-to-start sidecar: suppresses the sync event, still records history', () => {
    const fx = decideEnqueueOutcome({
      metrics: metrics(),
      id: 'e3.json',
      outcome: 'failed',
      now: NOW,
      deviceId: DEVICE,
    })

    expect(fx.syncEvent).toBeNull()
    expect(fx.historyAction).toEqual({ kind: 'failed', requestId: 'e3.json', at: NOW })
    expect(fx.postSavedMark).toBeNull()
    expect(fx.mediaSavedMark).toBeNull()
    expect(fx.budgetBump).toBeNull()
  })

  it('complete sidecar: suppresses the sync event, still records history', () => {
    const fx = decideEnqueueOutcome({
      metrics: metrics(),
      id: 'e4.json',
      outcome: 'complete',
      now: NOW,
      deviceId: DEVICE,
    })

    expect(fx.syncEvent).toBeNull()
    expect(fx.historyAction).toEqual({ kind: 'completed', requestId: 'e4.json', at: NOW })
    expect(fx.postSavedMark).toBeNull()
    expect(fx.mediaSavedMark).toBeNull()
    expect(fx.budgetBump).toBeNull()
  })

  it('has no backlink field, structurally — unlike decideTerminalOutcome', () => {
    const fx = decideEnqueueOutcome({
      metrics: metrics(),
      id: 'e5',
      outcome: 'complete',
      now: NOW,
      deviceId: DEVICE,
    })

    expect('backlink' in fx).toBe(false)
  })

  it('does not double-count an aria2 budget bump for a repeated id', () => {
    const first = decideEnqueueOutcome({
      metrics: metrics(),
      id: 'e6',
      outcome: 'complete',
      now: NOW,
      deviceId: DEVICE,
      tweetId: 't6',
    })
    const second = decideEnqueueOutcome({
      metrics: first.metrics,
      id: 'e6',
      outcome: 'complete',
      now: NOW + 1,
      deviceId: DEVICE,
      tweetId: 't6',
    })

    expect(second.metrics).toBe(first.metrics)
    expect(second.budgetBump).toBeNull()
  })
})
