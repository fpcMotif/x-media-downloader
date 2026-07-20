import { describe, expect, it } from 'vitest'
import {
  applyEnqueueOutcomeEffects,
  applyOutcomeEffects,
  type EnqueueOutcomeEffectPorts,
  type OutcomeEffectPorts,
} from './outcome-effects'
import { decideEnqueueOutcome, decideTerminalOutcome } from '../core/download/terminal-outcome'
import { emptyMetrics } from '../core/download/metrics'
import { emptyTracker, trackTransfer } from '../core/download/transfer-tracker'

const outcome = (kind: 'complete' | 'failed') =>
  decideTerminalOutcome(
    {
      transfers: trackTransfer(emptyTracker, {
        id: 'm1',
        downloadId: 7,
        tweetId: 't1',
        startedAt: 0,
      }),
      metrics: emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 }),
    },
    'm1',
    kind,
    1_000,
    'device-1',
    { tweetId: 't1', downloadId: 7 },
  )

describe('applyOutcomeEffects', () => {
  it('keeps Clear before transfer flush, then flushes before Sync and History', async () => {
    const calls: string[] = []
    const ports: OutcomeEffectPorts = {
      recordClearComplete: () => calls.push('clear:complete'),
      recordClearFailure: () => calls.push('clear:failed'),
      setTransfers: () => calls.push('state:transfers'),
      setMetrics: () => calls.push('state:metrics'),
      flushTransfers: async () => {
        calls.push('flush')
      },
      reportBacklink: () => calls.push('backlink'),
      recordSync: () => calls.push('sync'),
      recordHistory: () => calls.push('history'),
      markPostSaved: () => calls.push('saved:post'),
      bumpBudget: () => calls.push('budget'),
      markMediaSaved: () => calls.push('saved:media'),
      persistSnapshot: async () => {
        calls.push('snapshot')
      },
    }

    await applyOutcomeEffects(outcome('complete'), ports, 1_000)

    expect(calls).toEqual([
      'clear:complete',
      'state:transfers',
      'state:metrics',
      'flush',
      'backlink',
      'sync',
      'history',
      'saved:post',
      'budget',
      'saved:media',
      'snapshot',
    ])
  })

  it('applies a failed Clear notice and skips completion-only effects', async () => {
    const calls: string[] = []
    const ports: OutcomeEffectPorts = {
      recordClearComplete: () => calls.push('clear:complete'),
      recordClearFailure: () => calls.push('clear:failed'),
      setTransfers: () => {},
      setMetrics: () => {},
      flushTransfers: async () => {},
      reportBacklink: () => {},
      recordSync: () => {},
      recordHistory: () => {},
      markPostSaved: () => calls.push('saved:post'),
      bumpBudget: () => calls.push('budget'),
      markMediaSaved: () => calls.push('saved:media'),
      persistSnapshot: async () => {},
    }

    await applyOutcomeEffects(outcome('failed'), ports, 1_000)

    expect(calls).toEqual(['clear:failed'])
  })
})

describe('applyEnqueueOutcomeEffects', () => {
  it('applies aria2 Saved marks and budget at hand-off', () => {
    const calls: string[] = []
    const ports: EnqueueOutcomeEffectPorts = {
      setMetrics: () => calls.push('state:metrics'),
      recordSyncEvent: () => calls.push('sync'),
      recordHistoryAction: () => calls.push('history'),
      markPostSaved: () => calls.push('saved:post'),
      bumpBudget: () => calls.push('budget'),
      markMediaSaved: () => calls.push('saved:media'),
    }
    const effects = decideEnqueueOutcome({
      metrics: emptyMetrics({ total: 1, concurrencyCap: 1, startedAt: 0 }),
      id: 'm1',
      outcome: 'complete',
      now: 1_000,
      deviceId: 'device-1',
      tweetId: 't1',
    })

    applyEnqueueOutcomeEffects(effects, ports)

    expect(calls).toEqual([
      'state:metrics',
      'sync',
      'history',
      'saved:post',
      'budget',
      'saved:media',
    ])
  })
})
