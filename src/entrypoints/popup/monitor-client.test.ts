import { describe, expect, it } from 'vitest'
import { didClearMonitor, monitorSnapshotFromReply } from './monitor-client'

const snapshot = {
  total: 1,
  completed: 0,
  failed: 0,
  active: 1,
  retries: 0,
  concurrencyCap: 1,
  bytesReceived: 0,
  bytesTotal: 0,
  throughputBps: 0,
  elapsedMs: 0,
}

describe('monitor popup replies', () => {
  it('accepts only an exact bounded snapshot', () => {
    expect(monitorSnapshotFromReply(snapshot)).toEqual(snapshot)
    expect(monitorSnapshotFromReply({ ...snapshot, extra: true })).toBeNull()
    expect(monitorSnapshotFromReply({ ...snapshot, active: Number.NaN })).toBeNull()
  })

  it('clears only after an exact successful reset receipt', () => {
    const receipt = {
      _tag: 'ClearDownloadMonitorResponse',
      ok: true,
      active: 0,
      clearedMetrics: true,
      clearedLocks: 0,
    }
    expect(didClearMonitor(receipt)).toBe(true)
    expect(didClearMonitor({ ...receipt, extra: true })).toBe(false)
    expect(didClearMonitor({ ...receipt, clearedMetrics: false })).toBe(false)
    expect(didClearMonitor({ ...receipt, active: 1 })).toBe(false)
  })
})
