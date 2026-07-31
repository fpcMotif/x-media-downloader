import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { Schema } from 'effect'
import { makeClearSession, type ClearSessionDeps } from '../../src/background/clear-session'
import { Settings as SettingsSchema, type Settings } from '@/packages/schema'

const baseSettings = Schema.decodeUnknownSync(SettingsSchema)({})
const settings = (over: Partial<Settings>): Settings => ({ ...baseSettings, ...over })
const CLEAR_ON: Settings = settings({ clearOnSave: true, autoUnbookmarkOnSave: true })
const mountedFlip = [{ scope: 'bookmark' as const, ok: true }]

describe('PROBE: does the harness actually drive the path?', () => {
  beforeEach(() => {
    fakeBrowser.reset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('negative (undefined probe): the settle closure MUST run and reach the gate', async () => {
    const probeCalls: number[] = []
    const traceStages: string[] = []
    const dispatchClear = vi.fn<ClearSessionDeps['dispatchClear']>(async () => mountedFlip)
    const deps: ClearSessionDeps = {
      queueError: () => () => {},
      getSettings: async () => CLEAR_ON,
      trace: (stage: string) => {
        traceStages.push(stage)
      },
      dispatchClear,
      resolveOriginScope: async () => undefined,
      settleProbe: async (id: number) => {
        probeCalls.push(id)
        return undefined
      },
    }
    const c = makeClearSession(deps)
    await c.seedLedger({
      decision: 'seed',
      byTweet: new Map([['T', ['m0']]]),
      scopes: ['bookmark'],
      origin: 'hook',
      unclearableCount: 0,
    })
    c.recordComplete('T', 'm0', 123)
    await vi.runAllTimersAsync()
    // PROVE the closure ran: probe was called, and the settle trace fired.
    console.log('PROBE CALLS:', probeCalls)
    console.log('TRACE STAGES:', traceStages)
    console.log('dispatchClear calls:', dispatchClear.mock.calls.length)
    expect(probeCalls).toEqual([123]) // settle closure executed
    expect(traceStages).toContain('clear-settle') // reached decideSettle + reduce
    expect(dispatchClear).not.toHaveBeenCalled() // gate held closed
  })
})
