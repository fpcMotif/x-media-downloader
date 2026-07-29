import type { MessageReadinessDomain } from './message-readiness'
import type { BackgroundMessageListener } from './message-router'
import {
  makeBackgroundReadiness,
  type BackgroundReadiness,
  type BackgroundReadinessDomain,
  type Readiness,
} from './readiness'

export type { BackgroundReadinessDomain } from './readiness'

export interface BackgroundAlarm {
  readonly name: string
}

export interface BackgroundListenerPorts {
  readonly addAlarmListener: (listener: (alarm: BackgroundAlarm) => void) => void
  readonly addDownloadChangedListener: (
    listener: (delta: Browser.downloads.DownloadDelta) => void,
  ) => void
  readonly addStartupListener: (listener: () => void) => void
  readonly addMessageListener: (listener: BackgroundMessageListener) => void
}

export interface BackgroundRetryAlarm {
  readonly name: string
  readonly arm: () => Promise<void>
}

export interface BackgroundAlarmOwner {
  readonly names: ReadonlyArray<string>
  readonly domain: BackgroundReadinessDomain
  readonly wake: () => void | Promise<void>
  /** Preserves this consumed event until its readiness and wake both succeed. */
  readonly retry: BackgroundRetryAlarm
}

export interface BackgroundBoot {
  readonly base: () => Promise<void>
  readonly fetched: () => Promise<void>
  readonly transfer: () => Promise<void>
  readonly clear: (startupObserved: boolean) => Promise<void>
  readonly cloud: () => Promise<void>
  readonly trace: (domain: BackgroundReadinessDomain, reason: string) => void
}

const starting = (domain: BackgroundReadinessDomain): Promise<Readiness> =>
  Promise.resolve({
    tag: 'unavailable',
    failure: 'retryable',
    reason: `${domain} is starting`,
  })

const readinessDomains: ReadonlyArray<BackgroundReadinessDomain> = [
  'base',
  'fetched',
  'transfer',
  'clear',
  'cloud',
]

const isRetryable = (
  state: Readiness,
): state is Extract<Readiness, { readonly tag: 'unavailable' }> =>
  state.tag === 'unavailable' && state.failure === 'retryable'

/** Register every MV3 listener synchronously, then begin the independent boot graph. */
export function registerBackgroundLifecycle(deps: {
  readonly listeners: BackgroundListenerPorts
  readonly boot: BackgroundBoot
  readonly makeMessageListener: (
    waitFor: (domain: MessageReadinessDomain) => Promise<Readiness>,
  ) => BackgroundMessageListener
  /** One global one-shot alarm for autonomous readiness recovery. */
  readonly bootRetry: BackgroundRetryAlarm
  readonly alarms: ReadonlyArray<BackgroundAlarmOwner>
  readonly downloads: {
    readonly releaseCaptureTerminal: (downloadId: number) => Promise<void>
    readonly onTransferChanged: (delta: Browser.downloads.DownloadDelta) => Promise<void>
  }
  readonly clear: {
    readonly onBrowserStartup: () => Promise<void>
  }
  readonly trace: (stage: string, error: unknown) => void
}): BackgroundReadiness {
  let startupObserved = false
  let startupConsumed = false
  let consumingStartup: Promise<void> | undefined
  let readiness: BackgroundReadiness | undefined
  let bootRetryArmed = false
  let bootRetryCycle: Promise<void> | undefined
  const armedOwnerRetries = new Set<string>()
  const ownerRetryCycles = new Map<string, Promise<void>>()
  const waitFor = (domain: BackgroundReadinessDomain): Promise<Readiness> =>
    readiness?.[domain] ?? starting(domain)
  const consumeObservedStartup = async (state: Readiness): Promise<void> => {
    if (!startupObserved || startupConsumed || state.tag !== 'available') return
    if (consumingStartup !== undefined) return await consumingStartup
    const running = Promise.resolve()
      .then(async () => await deps.clear.onBrowserStartup())
      .then(() => {
        startupConsumed = true
        return undefined
      })
    consumingStartup = running
    try {
      await running
    } finally {
      if (consumingStartup === running) consumingStartup = undefined
    }
  }

  const ownerByAlarm = new Map<string, BackgroundAlarmOwner>()
  const ownerByRetryAlarm = new Map<string, BackgroundAlarmOwner>()
  const claimedAlarmNames = new Set([deps.bootRetry.name])
  for (const owner of deps.alarms) {
    for (const name of [...owner.names, owner.retry.name]) {
      if (claimedAlarmNames.has(name))
        throw new Error(`Background alarm name has multiple owners: ${name}`)
      claimedAlarmNames.add(name)
    }
    for (const name of owner.names) ownerByAlarm.set(name, owner)
    ownerByRetryAlarm.set(owner.retry.name, owner)
  }

  const armBootRetry = async (): Promise<void> => {
    if (bootRetryArmed) return
    bootRetryArmed = true
    try {
      await deps.bootRetry.arm()
    } catch (error) {
      bootRetryArmed = false
      deps.trace('readiness-retry-arm-failed', error)
    }
  }
  const armOwnerRetry = async (owner: BackgroundAlarmOwner): Promise<void> => {
    if (armedOwnerRetries.has(owner.retry.name)) return
    armedOwnerRetries.add(owner.retry.name)
    try {
      await owner.retry.arm()
    } catch (error) {
      armedOwnerRetries.delete(owner.retry.name)
      deps.trace('alarm-retry-arm-failed', error)
    }
  }
  const runOwnerWake = async (
    owner: BackgroundAlarmOwner,
    retryReadiness: boolean,
  ): Promise<void> => {
    const current = await waitFor(owner.domain)
    const state =
      retryReadiness && isRetryable(current)
        ? await (readiness?.retry(owner.domain) ?? Promise.resolve(current))
        : current
    if (state.tag === 'unavailable') {
      if (state.failure === 'retryable') await armOwnerRetry(owner)
      return
    }
    if (owner.domain === 'clear') await consumeObservedStartup(state)
    await owner.wake()
  }
  const launchOwnerWake = (
    owner: BackgroundAlarmOwner,
    retryReadiness: boolean,
    failureStage: string,
  ): void => {
    void runOwnerWake(owner, retryReadiness).catch(async (error) => {
      deps.trace(failureStage, error)
      await armOwnerRetry(owner)
    })
  }
  const launchOwnerRetry = (owner: BackgroundAlarmOwner): void => {
    const name = owner.retry.name
    armedOwnerRetries.delete(name)
    if (ownerRetryCycles.has(name)) return
    let guarded!: Promise<void>
    guarded = runOwnerWake(owner, true)
      .catch(async (error) => {
        deps.trace('alarm-boot-retry-failed', error)
        await armOwnerRetry(owner)
      })
      .finally(() => {
        if (ownerRetryCycles.get(name) === guarded) ownerRetryCycles.delete(name)
      })
    ownerRetryCycles.set(name, guarded)
    void guarded
  }
  const runBootRetry = async (): Promise<void> => {
    const current = readiness
    if (current === undefined) {
      await armBootRetry()
      return
    }
    const states = await Promise.all(readinessDomains.map((domain) => current.retry(domain)))
    const clearState = states[readinessDomains.indexOf('clear')]
    if (clearState?.tag === 'available') await consumeObservedStartup(clearState)
    if (
      states.some(isRetryable) ||
      (clearState?.tag === 'available' && startupObserved && !startupConsumed)
    )
      await armBootRetry()
  }
  const launchBootRetry = (): void => {
    bootRetryArmed = false
    if (bootRetryCycle !== undefined) return
    let guarded!: Promise<void>
    guarded = runBootRetry()
      .catch(async (error) => {
        deps.trace('readiness-boot-retry-failed', error)
        await armBootRetry()
      })
      .finally(() => {
        if (bootRetryCycle === guarded) bootRetryCycle = undefined
      })
    bootRetryCycle = guarded
    void guarded
  }

  deps.listeners.addAlarmListener((alarm) => {
    if (alarm.name === deps.bootRetry.name) {
      launchBootRetry()
      return
    }
    const retryOwner = ownerByRetryAlarm.get(alarm.name)
    if (retryOwner !== undefined) {
      launchOwnerRetry(retryOwner)
      return
    }
    const owner = ownerByAlarm.get(alarm.name)
    if (owner === undefined) return
    launchOwnerWake(owner, false, 'alarm-failed')
  })

  deps.listeners.addDownloadChangedListener((delta) => {
    // The two owners share a Chrome event, not readiness or latency. Starting
    // both branches now prevents a stuck offscreen cleanup from delaying durable
    // transfer projection.
    void (async () => {
      if (
        (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') &&
        (await waitFor('fetched')).tag === 'available'
      )
        await deps.downloads.releaseCaptureTerminal(delta.id)
    })().catch((error) => deps.trace('capture-lease-release-failed', error))
    void (async () => {
      if ((await waitFor('transfer')).tag === 'available')
        await deps.downloads.onTransferChanged(delta)
    })().catch((error) => deps.trace('download-change-failed', error))
  })

  deps.listeners.addStartupListener(() => {
    startupObserved = true
    void waitFor('clear')
      .then(consumeObservedStartup)
      .catch(async (error) => {
        deps.trace('browser-startup-failed', error)
        await armBootRetry()
      })
  })

  deps.listeners.addMessageListener(deps.makeMessageListener(waitFor))

  readiness = makeBackgroundReadiness({
    base: deps.boot.base,
    fetched: deps.boot.fetched,
    transfer: deps.boot.transfer,
    clear: () => deps.boot.clear(startupObserved),
    cloud: deps.boot.cloud,
    trace: deps.boot.trace,
  })
  for (const domain of readinessDomains) {
    const initial = readiness[domain]
    void initial
      .then(async (state) => {
        if (!isRetryable(state)) return undefined
        const latest = await readiness?.[domain]
        if (latest !== undefined && isRetryable(latest)) await armBootRetry()
        return undefined
      })
      .catch((error) => deps.trace('readiness-observation-failed', error))
  }
  return readiness
}
