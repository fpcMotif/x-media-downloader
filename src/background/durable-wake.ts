/** Browser-alarm seam for restart-safe background work. */
export interface DurableWakePort {
  create(name: string, when: number): Promise<void>
  clear(name: string): Promise<void>
}

/** Chrome 120+ permits alarms no sooner than 30 seconds. This watchdog leaves
 * one future wake durable while an MV3 service worker awaits remote I/O. */
export const DURABLE_SIDE_EFFECT_WATCHDOG_MS = 30_000

/** Live MV3 alarm binding. Listeners remain in the entrypoint. */
export const defaultDurableWakePort = (): DurableWakePort => ({
  create: (name, when) => browser.alarms.create(name, { when }),
  clear: (name) => browser.alarms.clear(name).then(() => undefined),
})

/** Reconcile the one durable wake without undoing already-persisted work on an
 * alarm API failure. */
export const reconcileDurableWake = async (
  wake: DurableWakePort,
  name: string,
  when: number | undefined,
  report: (error: unknown) => void,
): Promise<void> => {
  try {
    if (when === undefined) await wake.clear(name)
    else await wake.create(name, when)
  } catch (error) {
    try {
      report(error)
    } catch {
      /* diagnostics cannot roll back durable work */
    }
  }
}

/** Replace any already-due wake before remote I/O can consume it. Alarm failures
 * are reported, but durable state remains authoritative. */
export const armDurableSideEffectWatchdog = (
  wake: DurableWakePort,
  name: string,
  now: number,
  report: (error: unknown) => void,
): Promise<void> => reconcileDurableWake(wake, name, now + DURABLE_SIDE_EFFECT_WATCHDOG_MS, report)
