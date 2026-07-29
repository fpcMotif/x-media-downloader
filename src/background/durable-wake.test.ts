import { describe, expect, it, vi } from 'vitest'
import {
  armDurableSideEffectWatchdog,
  DURABLE_SIDE_EFFECT_WATCHDOG_MS,
  reconcileDurableWake,
  type DurableWakePort,
} from './durable-wake'

const wake = (): DurableWakePort => ({
  create: vi.fn<DurableWakePort['create']>(async () => {}),
  clear: vi.fn<DurableWakePort['clear']>(async () => {}),
})

describe('durable wake', () => {
  it('arms a future side-effect watchdog', async () => {
    const port = wake()
    await armDurableSideEffectWatchdog(port, 'work', 1000, () => {})
    expect(port.create).toHaveBeenCalledWith('work', 1000 + DURABLE_SIDE_EFFECT_WATCHDOG_MS)
  })

  it('contains alarm and diagnostic failures after durable work commits', async () => {
    const alarmError = new Error('alarms unavailable')
    const port: DurableWakePort = {
      create: async () => {
        throw alarmError
      },
      clear: async () => {},
    }
    const report = vi.fn<(error: unknown) => void>(() => {
      throw new Error('observer failed')
    })

    await expect(reconcileDurableWake(port, 'work', 1000, report)).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledWith(alarmError)
  })
})
