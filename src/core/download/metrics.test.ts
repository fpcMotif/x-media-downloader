import { describe, it, expect } from 'vitest'
import {
  emptyMetrics,
  recordSample,
  recordOutcome,
  recordRetry,
  snapshot,
  samplesFromSearch,
  outcomeFromState,
  extendTotal,
} from './metrics'

describe('emptyMetrics + snapshot', () => {
  it('projects a zeroed snapshot with no etaSeconds key', () => {
    const s = emptyMetrics({ total: 3, concurrencyCap: 2, startedAt: 1000 })
    const snap = snapshot(s, 1000)
    expect(snap).toEqual({
      total: 3,
      completed: 0,
      failed: 0,
      active: 0,
      retries: 0,
      concurrencyCap: 2,
      bytesReceived: 0,
      bytesTotal: 0,
      throughputBps: 0,
      elapsedMs: 0,
    })
    expect(snap).not.toHaveProperty('etaSeconds')
  })

  it('elapsedMs = now - startedAt', () => {
    const s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 1000 })
    expect(snapshot(s, 4000).elapsedMs).toBe(3000)
  })
})

describe('recordSample', () => {
  it('aggregates a single item across two samples with throughput + eta', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 0, totalBytes: 2_000_000, t: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 1_000_000, totalBytes: 2_000_000, t: 1000 })
    const snap = snapshot(s, 1000)
    expect(snap.bytesReceived).toBe(1_000_000)
    expect(snap.bytesTotal).toBe(2_000_000)
    expect(snap.throughputBps).toBe(1_000_000)
    expect(snap.etaSeconds).toBe(1)
    expect(snap.active).toBe(1)
  })

  it('replaces the latest values for the same id', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 500, totalBytes: 1000, t: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 750, totalBytes: 1000, t: 100 })
    const snap = snapshot(s, 100)
    expect(snap.bytesReceived).toBe(750)
    expect(snap.bytesTotal).toBe(1000)
  })

  it('guards unknown totalBytes (-1): counts received but not total, omits eta', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 1234, totalBytes: -1, t: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 5678, totalBytes: -1, t: 1000 })
    const snap = snapshot(s, 1000)
    expect(snap.bytesReceived).toBe(5678)
    expect(snap.bytesTotal).toBe(0)
    expect(snap).not.toHaveProperty('etaSeconds')
  })

  it('guards unknown totalBytes (0): excluded from bytesTotal', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 10, totalBytes: 0, t: 0 })
    expect(snapshot(s, 0).bytesTotal).toBe(0)
  })

  it('aggregates bytesReceived and bytesTotal across two items', () => {
    let s = emptyMetrics({ total: 2, concurrencyCap: 2, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 100, totalBytes: 1000, t: 0 })
    s = recordSample(s, { id: 'b', bytesReceived: 200, totalBytes: 3000, t: 0 })
    const snap = snapshot(s, 0)
    expect(snap.bytesReceived).toBe(300)
    expect(snap.bytesTotal).toBe(4000)
    expect(snap.active).toBe(2)
  })

  it('throughput is 0 with a single timeline point', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 100, totalBytes: 1000, t: 0 })
    expect(snapshot(s, 0).throughputBps).toBe(0)
  })

  it('uses the earliest point as ref when nothing precedes the window', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 0, totalBytes: 4000, t: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 2000, totalBytes: 4000, t: 2000 })
    // window W=5000 > 2000 span, so ref = earliest point (t=0, agg=0)
    const snap = snapshot(s, 2000)
    expect(snap.throughputBps).toBe(1000)
  })

  it('never reports a negative throughput (decreasing or out-of-order samples)', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 5000, totalBytes: 8000, t: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 1000, totalBytes: 8000, t: 1000 })
    expect(snapshot(s, 1000).throughputBps).toBe(0)
  })

  it('uses a windowed ref point when older points exist', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 0, totalBytes: 100_000, t: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 1000, totalBytes: 100_000, t: 1000 })
    s = recordSample(s, { id: 'a', bytesReceived: 8000, totalBytes: 100_000, t: 8000 })
    // now=8000, window start = 3000; most recent point with t<=3000 is t=1000 (agg 1000)
    // (8000 - 1000) / ((8000 - 1000)/1000) = 7000 / 7 = 1000
    expect(snapshot(s, 8000).throughputBps).toBe(1000)
  })
})

describe('recordOutcome', () => {
  it('complete moves an active item to completed', () => {
    let s = emptyMetrics({ total: 2, concurrencyCap: 2, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 100, totalBytes: 1000, t: 0 })
    s = recordSample(s, { id: 'b', bytesReceived: 100, totalBytes: 1000, t: 0 })
    expect(snapshot(s, 0).active).toBe(2)
    s = recordOutcome(s, 'a', 'complete', 100)
    const snap = snapshot(s, 100)
    expect(snap.completed).toBe(1)
    expect(snap.active).toBe(1)
    expect(snap.failed).toBe(0)
  })

  it('failed increments failed and removes from active', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 100, totalBytes: 1000, t: 0 })
    s = recordOutcome(s, 'a', 'failed', 50)
    const snap = snapshot(s, 50)
    expect(snap.failed).toBe(1)
    expect(snap.active).toBe(0)
    expect(snap.completed).toBe(0)
  })

  it('is idempotent: a repeat outcome for the same id does not double-count', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s = recordOutcome(s, 'a', 'complete', 0)
    s = recordOutcome(s, 'a', 'complete', 0)
    s = recordOutcome(s, 'a', 'failed', 0)
    const snap = snapshot(s, 0)
    expect(snap.completed).toBe(1)
    expect(snap.failed).toBe(0)
  })
})

describe('extendTotal', () => {
  it('grows total + raises cap while preserving prior progress', () => {
    let s = emptyMetrics({ total: 1, concurrencyCap: 2, startedAt: 0 })
    s = recordSample(s, { id: 'a', bytesReceived: 500, totalBytes: 1000, t: 0 })
    s = extendTotal(s, 2, 4)
    const snap = snapshot(s, 0)
    expect(snap.total).toBe(3)
    expect(snap.concurrencyCap).toBe(4)
    expect(snap.bytesReceived).toBe(500)
    expect(snap.active).toBe(1)
  })

  it('does not lower an already-higher cap', () => {
    const s = extendTotal(emptyMetrics({ total: 1, concurrencyCap: 8, startedAt: 0 }), 1, 3)
    expect(snapshot(s, 0).concurrencyCap).toBe(8)
  })
})

describe('recordRetry', () => {
  it('increments retries across two retries on same/different ids', () => {
    let s = emptyMetrics({ total: 2, concurrencyCap: 2, startedAt: 0 })
    s = recordRetry(s, 'a')
    s = recordRetry(s, 'b')
    expect(snapshot(s, 0).retries).toBe(2)
    s = recordRetry(s, 'a')
    expect(snapshot(s, 0).retries).toBe(3)
  })
})

describe('samplesFromSearch', () => {
  it('re-keys known downloadIds to request ids and skips unknown rows', () => {
    const map = new Map<number, string>([
      [10, 'a'],
      [11, 'b'],
    ])
    const rows = [
      { id: 10, bytesReceived: 100, totalBytes: 1000 },
      { id: 11, bytesReceived: 200, totalBytes: 2000 },
      { id: 99, bytesReceived: 5, totalBytes: 5 },
    ]
    expect(samplesFromSearch(rows, map, 500)).toEqual([
      { id: 'a', bytesReceived: 100, totalBytes: 1000, t: 500 },
      { id: 'b', bytesReceived: 200, totalBytes: 2000, t: 500 },
    ])
  })

  it('feeds the reducer end-to-end (search rows → samples → snapshot)', () => {
    const map = new Map<number, string>([[10, 'a']])
    let s = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    for (const sample of samplesFromSearch(
      [{ id: 10, bytesReceived: 0, totalBytes: 2000 }],
      map,
      0,
    ))
      s = recordSample(s, sample)
    for (const sample of samplesFromSearch(
      [{ id: 10, bytesReceived: 1000, totalBytes: 2000 }],
      map,
      1000,
    ))
      s = recordSample(s, sample)
    const snap = snapshot(s, 1000)
    expect(snap.bytesReceived).toBe(1000)
    expect(snap.throughputBps).toBe(1000)
  })
})

describe('long feed batch polled for minutes (bounded timeline)', () => {
  // A 50-item feed sweep: the background poller calls recordSample on every tick
  // (~every 500ms) for minutes. Throughput only ever uses the rolling 5s window,
  // so points older than that window are dead weight — the timeline must not grow
  // without bound, but the recent-window throughput must stay exact.
  it('keeps recent-window throughput exact while the timeline stays bounded', () => {
    const POLL_MS = 500
    const DURATION_MS = 4 * 60 * 1000 // 4 minutes of polling
    const ticks = DURATION_MS / POLL_MS // 480 samples
    const RATE = 2_000_000 // 2 MB/s steady CDN throughput

    let s = emptyMetrics({ total: 1, concurrencyCap: 6, startedAt: 0 })
    for (let i = 0; i <= ticks; i++) {
      const t = i * POLL_MS
      const bytes = (RATE * t) / 1000
      s = recordSample(s, {
        id: 'feed-item',
        bytesReceived: bytes,
        totalBytes: 8_000_000_000,
        t,
      })
    }

    const now = ticks * POLL_MS
    // Steady 2 MB/s rate must still be reported exactly from the rolling window.
    expect(snapshot(s, now).throughputBps).toBe(RATE)
    // Memory/CPU must be bounded: the retained timeline cannot scale with the
    // number of polls — a 4-minute sweep at 500ms ticks must keep only a small
    // window's worth of points, not all ~480 of them.
    expect(s.timeline.length).toBeLessThan(ticks)
    expect(s.timeline.length).toBeLessThanOrEqual(20)
  })

  it('still windows correctly mid-sweep across two interleaved items', () => {
    const POLL_MS = 500
    let s = emptyMetrics({ total: 2, concurrencyCap: 6, startedAt: 0 })
    // Two concurrent feed items each climbing 1 MB/s — combined 2 MB/s.
    for (let i = 0; i <= 200; i++) {
      const t = i * POLL_MS
      s = recordSample(s, { id: 'a', bytesReceived: 1_000 * t, totalBytes: 50_000_000, t })
      s = recordSample(s, { id: 'b', bytesReceived: 1_000 * t, totalBytes: 50_000_000, t })
    }
    const now = 200 * POLL_MS
    expect(snapshot(s, now).throughputBps).toBe(2_000_000)
    expect(s.timeline.length).toBeLessThanOrEqual(40)
  })
})

describe('outcomeFromState', () => {
  it('maps complete + interrupted to terminal outcomes, in_progress to null', () => {
    expect(outcomeFromState('complete')).toBe('complete')
    expect(outcomeFromState('interrupted')).toBe('failed')
    expect(outcomeFromState('in_progress')).toBe(null)
    expect(outcomeFromState(undefined)).toBe(null)
  })
})

describe('immutability', () => {
  it('recordSample does not mutate the prior state snapshot', () => {
    const s0 = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    const before = snapshot(s0, 0)
    const s1 = recordSample(s0, { id: 'a', bytesReceived: 100, totalBytes: 1000, t: 0 })
    expect(snapshot(s0, 0)).toEqual(before)
    expect(snapshot(s1, 0).bytesReceived).toBe(100)
  })

  it('recordOutcome and recordRetry do not mutate the prior state', () => {
    let s0 = emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 })
    s0 = recordSample(s0, { id: 'a', bytesReceived: 100, totalBytes: 1000, t: 0 })
    const before = snapshot(s0, 0)
    recordOutcome(s0, 'a', 'complete', 0)
    recordRetry(s0, 'a')
    expect(snapshot(s0, 0)).toEqual(before)
  })
})
