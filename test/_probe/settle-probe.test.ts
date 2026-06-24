import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { Schema } from 'effect'
import { makeClearCoordinator, type ClearCoordinatorDeps } from '../../src/background/clear-coordinator'
import { Settings as SettingsSchema, type Settings } from '../../src/core/schema'

const baseSettings = Schema.decodeUnknownSync(SettingsSchema)({})
const settings = (over: Partial<Settings>): Settings => ({ ...baseSettings, ...over })
const CLEAR_ON: Settings = settings({ clearOnSave: true, autoUnbookmarkOnSave: true })
const mountedFlip = { mounted: true, results: [{ scope: 'bookmark' as const, ok: true }] }

describe('PROBE: does the harness actually drive the path?', () => {
  beforeEach(() => { fakeBrowser.reset(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('negative (undefined probe): the settle closure MUST run and reach the gate', async () => {
    const probeCalls: number[] = []
    const traceStages: string[] = []
    const sendClearToTabs = vi.fn(async () => mountedFlip)
    const deps: ClearCoordinatorDeps = {
      queueError: () => () => {},
      getSettings: async () => CLEAR_ON,
      trace: (stage: string) => { traceStages.push(stage) },
      sendClearToTabs,
      settleProbe: async (id: number) => { probeCalls.push(id); return undefined },
    }
    const c = makeClearCoordinator(deps)
    c.seedClearLedger(new Map([['T', ['m0']]]), ['bookmark'], 'hook')
    c.recordClearComplete('T', 'm0', 123)
    await vi.runAllTimersAsync()
    // PROVE the closure ran: probe was called, and the settle trace fired.
    console.log('PROBE CALLS:', probeCalls)
    console.log('TRACE STAGES:', traceStages)
    console.log('sendClearToTabs calls:', sendClearToTabs.mock.calls.length)
    expect(probeCalls).toEqual([123])               // settle closure executed
    expect(traceStages).toContain('clear-settle')   // reached decideSettle + reduce
    expect(sendClearToTabs).not.toHaveBeenCalled()  // gate held closed
  })
})
