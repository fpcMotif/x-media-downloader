import { describe, expect, it, vi } from 'vitest'
import { SWEEP_HANDOFF_ALARM, reconcileSweepHandoffWake } from './sweep-handoff-wake'

describe('Sweep handoff durable wake', () => {
  it('arms an MV3 alarm while a receipt still fences repair', async () => {
    const create = vi.fn<(name: string, when: number) => Promise<void>>(async () => {})
    await reconcileSweepHandoffWake({
      wake: { create, clear: async () => {} },
      pendingReceipts: true,
      pendingRegistryStarts: false,
      now: 100,
      report: () => {},
    })
    expect(create).toHaveBeenCalledWith(SWEEP_HANDOFF_ALARM, 30_100)
  })

  it('clears the alarm after repair retires every receipt', async () => {
    const clear = vi.fn<(name: string) => Promise<void>>(async () => {})
    await reconcileSweepHandoffWake({
      wake: { create: async () => {}, clear },
      pendingReceipts: false,
      pendingRegistryStarts: false,
      now: 100,
      report: () => {},
    })
    expect(clear).toHaveBeenCalledWith(SWEEP_HANDOFF_ALARM)
  })

  it('keeps the alarm after receipts are acked but Registry admission is pending', async () => {
    const create = vi.fn<(name: string, when: number) => Promise<void>>(async () => {})
    await reconcileSweepHandoffWake({
      wake: { create, clear: async () => {} },
      pendingReceipts: false,
      pendingRegistryStarts: true,
      now: 100,
      report: () => {},
    })
    expect(create).toHaveBeenCalledWith(SWEEP_HANDOFF_ALARM, 30_100)
  })
})
