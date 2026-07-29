import {
  DURABLE_SIDE_EFFECT_WATCHDOG_MS,
  reconcileDurableWake,
  type DurableWakePort,
} from './durable-wake'

export const SWEEP_HANDOFF_ALARM = 'xmd-sweep-handoff-repair'

/** Strict arm: callers must not create or mutate a repair receipt without it. */
export const armSweepHandoffWatchdog = async (input: {
  readonly wake: DurableWakePort
  readonly now: number
}): Promise<void> =>
  await input.wake.create(SWEEP_HANDOFF_ALARM, input.now + DURABLE_SIDE_EFFECT_WATCHDOG_MS)

/** Keeps ambiguous cross-store Sweep handoffs live across an otherwise idle MV3 worker. */
export const reconcileSweepHandoffWake = async (input: {
  readonly wake: DurableWakePort
  readonly pendingReceipts: boolean
  /** Receipts may already be acked while Registry still awaits admission/release. */
  readonly pendingRegistryStarts: boolean
  readonly now: number
  readonly report: (error: unknown) => void
}): Promise<void> =>
  await reconcileDurableWake(
    input.wake,
    SWEEP_HANDOFF_ALARM,
    input.pendingReceipts || input.pendingRegistryStarts ? input.now + 30_000 : undefined,
    input.report,
  )
