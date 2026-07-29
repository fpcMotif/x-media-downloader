import { describe, expect, it, vi } from 'vitest'
import type { BackgroundMessageListener } from './message-router'
import { PermanentBackgroundBootError } from './readiness'
import {
  registerBackgroundLifecycle,
  type BackgroundBoot,
  type BackgroundListenerPorts,
  type BackgroundRetryAlarm,
} from './runtime-lifecycle'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function listenerHarness(order: string[] = []) {
  let alarm!: Parameters<BackgroundListenerPorts['addAlarmListener']>[0]
  let download!: Parameters<BackgroundListenerPorts['addDownloadChangedListener']>[0]
  let startup!: Parameters<BackgroundListenerPorts['addStartupListener']>[0]
  let message!: BackgroundMessageListener
  const listeners: BackgroundListenerPorts = {
    addAlarmListener: (listener) => {
      order.push('register:alarm')
      alarm = listener
    },
    addDownloadChangedListener: (listener) => {
      order.push('register:download')
      download = listener
    },
    addStartupListener: (listener) => {
      order.push('register:startup')
      startup = listener
    },
    addMessageListener: (listener) => {
      order.push('register:message')
      message = listener
    },
  }
  return {
    listeners,
    alarm: () => alarm,
    download: () => download,
    startup: () => startup,
    message: () => message,
  }
}

function availableBoot(order: string[] = []): BackgroundBoot {
  return {
    base: async () => {
      order.push('boot:base')
    },
    fetched: async () => {},
    transfer: async () => {},
    clear: async () => {},
    cloud: async () => {},
    trace: () => {},
  }
}

const globalBootRetry = (arm: () => Promise<void> = async () => {}) => ({
  name: 'readiness:boot-retry',
  arm,
})

function register(input: {
  readonly listeners: BackgroundListenerPorts
  readonly boot?: BackgroundBoot
  readonly bootRetry?: BackgroundRetryAlarm
  readonly releaseCaptureTerminal?: (downloadId: number) => Promise<void>
  readonly onTransferChanged?: (delta: Browser.downloads.DownloadDelta) => Promise<void>
  readonly onBrowserStartup?: () => Promise<void>
  readonly trace?: (stage: string, error: unknown) => void
}) {
  return registerBackgroundLifecycle({
    listeners: input.listeners,
    boot: input.boot ?? availableBoot(),
    bootRetry: input.bootRetry ?? globalBootRetry(),
    makeMessageListener: () => () => false,
    alarms: [],
    downloads: {
      releaseCaptureTerminal: input.releaseCaptureTerminal ?? (async () => {}),
      onTransferChanged: input.onTransferChanged ?? (async () => {}),
    },
    clear: {
      onBrowserStartup: input.onBrowserStartup ?? (async () => {}),
    },
    trace: input.trace ?? (() => {}),
  })
}

describe('background runtime lifecycle', () => {
  it('registers every MV3 listener synchronously before boot begins', async () => {
    const order: string[] = []
    const h = listenerHarness(order)
    const readiness = register({ listeners: h.listeners, boot: availableBoot(order) })

    expect(order).toEqual([
      'register:alarm',
      'register:download',
      'register:startup',
      'register:message',
      'boot:base',
    ])
    await expect(readiness.base).resolves.toEqual({ tag: 'available' })
    expect(h.message()).toBeTypeOf('function')
  })

  it('arms one global retry for a failed readiness graph without same-turn spinning', async () => {
    const h = listenerHarness()
    const armBootRetry = vi.fn<() => Promise<void>>(async () => {})
    const clearBoot = vi.fn<() => Promise<void>>(async () => {})
    let baseAttempts = 0
    const readiness = register({
      listeners: h.listeners,
      boot: {
        ...availableBoot(),
        base: async () => {
          baseAttempts += 1
          throw new Error('storage unavailable')
        },
        clear: clearBoot,
      },
      bootRetry: globalBootRetry(armBootRetry),
    })

    await expect(readiness.clear).resolves.toMatchObject({
      tag: 'unavailable',
      failure: 'retryable',
    })
    await vi.waitFor(() => expect(armBootRetry).toHaveBeenCalledOnce())
    expect(baseAttempts).toBe(1)
    expect(clearBoot).not.toHaveBeenCalled()

    h.alarm()({ name: 'readiness:boot-retry' })
    await vi.waitFor(() => {
      expect(baseAttempts).toBe(2)
      expect(armBootRetry).toHaveBeenCalledTimes(2)
    })
    await tick()

    expect(baseAttempts).toBe(2)
    expect(clearBoot).not.toHaveBeenCalled()
    expect(armBootRetry).toHaveBeenCalledTimes(2)
  })

  it('recovers retryable Clear boot without inventing an alarm wake', async () => {
    const h = listenerHarness()
    const armBootRetry = vi.fn<() => Promise<void>>(async () => {})
    const wake = vi.fn<() => Promise<void>>(async () => {})
    let clearAttempts = 0
    const readiness = registerBackgroundLifecycle({
      listeners: h.listeners,
      boot: {
        ...availableBoot(),
        clear: async () => {
          clearAttempts += 1
          if (clearAttempts === 1) throw new Error('clear store unavailable')
        },
      },
      bootRetry: globalBootRetry(armBootRetry),
      makeMessageListener: () => () => false,
      alarms: [
        {
          names: ['clear-safety-alarm'],
          domain: 'clear',
          wake,
          retry: {
            name: 'clear-safety-alarm:boot-retry',
            arm: async () => {},
          },
        },
      ],
      downloads: {
        releaseCaptureTerminal: async () => {},
        onTransferChanged: async () => {},
      },
      clear: { onBrowserStartup: async () => {} },
      trace: () => {},
    })

    await expect(readiness.clear).resolves.toMatchObject({
      tag: 'unavailable',
      failure: 'retryable',
    })
    await vi.waitFor(() => expect(armBootRetry).toHaveBeenCalledOnce())

    h.alarm()({ name: 'readiness:boot-retry' })
    await vi.waitFor(() => expect(clearAttempts).toBe(2))
    await expect(readiness.clear).resolves.toEqual({ tag: 'available' })
    expect(armBootRetry).toHaveBeenCalledOnce()
    expect(wake).not.toHaveBeenCalled()

    h.alarm()({ name: 'clear-safety-alarm' })
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce())
  })

  it('does not retry permanent Clear boot failure', async () => {
    const h = listenerHarness()
    const armBootRetry = vi.fn<() => Promise<void>>(async () => {})
    const readiness = register({
      listeners: h.listeners,
      boot: {
        ...availableBoot(),
        clear: async () => {
          throw new PermanentBackgroundBootError(new Error('clear store corrupt'))
        },
      },
      bootRetry: globalBootRetry(armBootRetry),
    })

    await expect(readiness.clear).resolves.toMatchObject({
      tag: 'unavailable',
      failure: 'permanent',
    })
    await tick()

    expect(armBootRetry).not.toHaveBeenCalled()
  })

  it('feeds an observed browser startup into delayed Clear boot', async () => {
    const base = deferred()
    const h = listenerHarness()
    const clearBoot = vi.fn<(startupObserved: boolean) => Promise<void>>(async () => {})
    const onBrowserStartup = vi.fn<() => Promise<void>>(async () => {})
    const boot: BackgroundBoot = {
      ...availableBoot(),
      base: () => base.promise,
      clear: clearBoot,
    }
    const readiness = register({ listeners: h.listeners, boot, onBrowserStartup })

    h.startup()()
    base.resolve()
    await expect(readiness.clear).resolves.toEqual({ tag: 'available' })
    await tick()

    expect(clearBoot).toHaveBeenCalledWith(true)
    expect(onBrowserStartup).toHaveBeenCalledOnce()
  })

  it('consumes an observed startup after retrying Clear boot', async () => {
    const h = listenerHarness()
    const events: string[] = []
    const wake = vi.fn<() => Promise<void>>(async () => {
      events.push('wake')
    })
    const armRetry = vi.fn<() => Promise<void>>(async () => {})
    let attempts = 0
    const clearBoot = vi.fn<(startupObserved: boolean) => Promise<void>>(async () => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary Clear boot failure')
    })
    const onBrowserStartup = vi.fn<() => Promise<void>>(async () => {
      events.push('startup')
    })
    const readiness = registerBackgroundLifecycle({
      listeners: h.listeners,
      boot: { ...availableBoot(), clear: clearBoot },
      bootRetry: globalBootRetry(),
      makeMessageListener: () => () => false,
      alarms: [
        {
          names: ['clear-safety-alarm'],
          domain: 'clear',
          wake,
          retry: { name: 'clear-safety-alarm:boot-retry', arm: armRetry },
        },
      ],
      downloads: {
        releaseCaptureTerminal: async () => {},
        onTransferChanged: async () => {},
      },
      clear: { onBrowserStartup },
      trace: () => {},
    })

    h.startup()()
    await expect(readiness.clear).resolves.toMatchObject({
      tag: 'unavailable',
      failure: 'retryable',
    })
    h.alarm()({ name: 'clear-safety-alarm' })
    await vi.waitFor(() => expect(armRetry).toHaveBeenCalledOnce())
    h.alarm()({ name: 'clear-safety-alarm:boot-retry' })
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce())

    expect(clearBoot).toHaveBeenNthCalledWith(1, true)
    expect(clearBoot).toHaveBeenNthCalledWith(2, true)
    expect(onBrowserStartup).toHaveBeenCalledOnce()
    expect(events).toEqual(['startup', 'wake'])
  })

  it('continues transfer projection after Capture cleanup fails', async () => {
    const h = listenerHarness()
    const releaseCaptureTerminal = vi.fn<(downloadId: number) => Promise<void>>(async () => {
      throw new Error('offscreen failed')
    })
    const onTransferChanged = vi.fn<(delta: Browser.downloads.DownloadDelta) => Promise<void>>(
      async () => {},
    )
    const trace = vi.fn<(stage: string, error: unknown) => void>()
    const readiness = register({
      listeners: h.listeners,
      releaseCaptureTerminal,
      onTransferChanged,
      trace,
    })
    await Promise.all([readiness.fetched, readiness.transfer])

    h.download()({ id: 11, state: { current: 'complete' } } as Browser.downloads.DownloadDelta)
    await tick()

    expect(releaseCaptureTerminal).toHaveBeenCalledWith(11)
    expect(trace).toHaveBeenCalledWith(
      'capture-lease-release-failed',
      expect.objectContaining({ message: 'offscreen failed' }),
    )
    expect(onTransferChanged).toHaveBeenCalledOnce()
  })

  it('does not await hung Capture cleanup before transfer projection', async () => {
    const h = listenerHarness()
    const cleanup = deferred()
    const releaseCaptureTerminal = vi.fn<(downloadId: number) => Promise<void>>(
      () => cleanup.promise,
    )
    const onTransferChanged = vi.fn<(delta: Browser.downloads.DownloadDelta) => Promise<void>>(
      async () => {},
    )
    const readiness = register({
      listeners: h.listeners,
      releaseCaptureTerminal,
      onTransferChanged,
    })
    await Promise.all([readiness.fetched, readiness.transfer])

    h.download()({ id: 12, state: { current: 'complete' } } as Browser.downloads.DownloadDelta)
    await tick()

    expect(releaseCaptureTerminal).toHaveBeenCalledWith(12)
    expect(onTransferChanged).toHaveBeenCalledOnce()
    cleanup.resolve()
  })

  it('gates each alarm on its owner readiness only', async () => {
    const h = listenerHarness()
    const baseWake = vi.fn<() => Promise<void>>(async () => {})
    const transferWake = vi.fn<() => Promise<void>>(async () => {})
    const boot: BackgroundBoot = {
      ...availableBoot(),
      transfer: async () => {
        throw new Error('registry corrupt')
      },
    }
    const readiness = registerBackgroundLifecycle({
      listeners: h.listeners,
      boot,
      bootRetry: globalBootRetry(),
      makeMessageListener: () => () => false,
      alarms: [
        {
          names: ['base-alarm'],
          domain: 'base',
          wake: baseWake,
          retry: { name: 'base-alarm:boot-retry', arm: async () => {} },
        },
        {
          names: ['transfer-alarm'],
          domain: 'transfer',
          wake: transferWake,
          retry: { name: 'transfer-alarm:boot-retry', arm: async () => {} },
        },
      ],
      downloads: {
        releaseCaptureTerminal: async () => {},
        onTransferChanged: async () => {},
      },
      clear: { onBrowserStartup: async () => {} },
      trace: () => {},
    })
    await Promise.all([readiness.base, readiness.transfer])

    h.alarm()({ name: 'base-alarm' })
    h.alarm()({ name: 'transfer-alarm' })
    await tick()

    expect(baseWake).toHaveBeenCalledOnce()
    expect(transferWake).not.toHaveBeenCalled()
  })

  it('replays Clear projections at base readiness when Clear is unavailable', async () => {
    const h = listenerHarness()
    const projectionWake = vi.fn<() => Promise<void>>(async () => {})
    const armRetry = vi.fn<() => Promise<void>>(async () => {})
    const readiness = registerBackgroundLifecycle({
      listeners: h.listeners,
      boot: {
        ...availableBoot(),
        clear: async () => {
          throw new PermanentBackgroundBootError(new Error('clear store corrupt'))
        },
      },
      bootRetry: globalBootRetry(),
      makeMessageListener: () => () => false,
      alarms: [
        {
          names: ['clear-projection-alarm'],
          domain: 'base',
          wake: projectionWake,
          retry: { name: 'clear-projection-alarm:boot-retry', arm: armRetry },
        },
      ],
      downloads: {
        releaseCaptureTerminal: async () => {},
        onTransferChanged: async () => {},
      },
      clear: { onBrowserStartup: async () => {} },
      trace: () => {},
    })
    await expect(readiness.base).resolves.toEqual({ tag: 'available' })
    await expect(readiness.clear).resolves.toMatchObject({
      tag: 'unavailable',
      failure: 'permanent',
    })

    h.alarm()({ name: 'clear-projection-alarm' })
    await tick()

    expect(projectionWake).toHaveBeenCalledOnce()
    expect(armRetry).not.toHaveBeenCalled()
  })

  it('rearms one owner alarm, retries transient boot, then runs the consumed wake', async () => {
    const h = listenerHarness()
    const transferWake = vi.fn<() => Promise<void>>(async () => {})
    const armRetry = vi.fn<() => Promise<void>>(async () => {})
    let attempts = 0
    const boot: BackgroundBoot = {
      ...availableBoot(),
      transfer: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('storage unavailable')
      },
    }
    const readiness = registerBackgroundLifecycle({
      listeners: h.listeners,
      boot,
      bootRetry: globalBootRetry(),
      makeMessageListener: () => () => false,
      alarms: [
        {
          names: ['transfer-alarm'],
          domain: 'transfer',
          wake: transferWake,
          retry: { name: 'transfer-alarm:boot-retry', arm: armRetry },
        },
      ],
      downloads: {
        releaseCaptureTerminal: async () => {},
        onTransferChanged: async () => {},
      },
      clear: { onBrowserStartup: async () => {} },
      trace: () => {},
    })
    await expect(readiness.transfer).resolves.toMatchObject({
      tag: 'unavailable',
      failure: 'retryable',
    })

    h.alarm()({ name: 'transfer-alarm' })
    h.alarm()({ name: 'transfer-alarm' })
    await vi.waitFor(() => expect(armRetry).toHaveBeenCalledOnce())
    expect(transferWake).not.toHaveBeenCalled()

    h.alarm()({ name: 'transfer-alarm:boot-retry' })
    await vi.waitFor(() => expect(transferWake).toHaveBeenCalledOnce())
    expect(attempts).toBe(2)
    expect(armRetry).toHaveBeenCalledOnce()
  })

  it('rearms a consumed owner event when its wake fails', async () => {
    const h = listenerHarness()
    const armRetry = vi.fn<() => Promise<void>>(async () => {})
    const trace = vi.fn<(stage: string, error: unknown) => void>()
    let wakeAttempts = 0
    const wake = vi.fn<() => Promise<void>>(async () => {
      wakeAttempts += 1
      if (wakeAttempts === 1) throw new Error('wake failed')
    })
    const readiness = registerBackgroundLifecycle({
      listeners: h.listeners,
      boot: availableBoot(),
      bootRetry: globalBootRetry(),
      makeMessageListener: () => () => false,
      alarms: [
        {
          names: ['transfer-alarm'],
          domain: 'transfer',
          wake,
          retry: { name: 'transfer-alarm:boot-retry', arm: armRetry },
        },
      ],
      downloads: {
        releaseCaptureTerminal: async () => {},
        onTransferChanged: async () => {},
      },
      clear: { onBrowserStartup: async () => {} },
      trace,
    })
    await readiness.transfer

    h.alarm()({ name: 'transfer-alarm' })
    await vi.waitFor(() => expect(armRetry).toHaveBeenCalledOnce())
    expect(trace).toHaveBeenCalledWith(
      'alarm-failed',
      expect.objectContaining({ message: 'wake failed' }),
    )

    h.alarm()({ name: 'transfer-alarm:boot-retry' })
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2))
    expect(armRetry).toHaveBeenCalledOnce()
  })

  it('rearms a still-blocked owner without same-turn spinning', async () => {
    const h = listenerHarness()
    const wake = vi.fn<() => Promise<void>>(async () => {})
    const armRetry = vi.fn<() => Promise<void>>(async () => {})
    let attempts = 0
    const readiness = registerBackgroundLifecycle({
      listeners: h.listeners,
      boot: {
        ...availableBoot(),
        transfer: async () => {
          attempts += 1
          throw new Error('storage unavailable')
        },
      },
      bootRetry: globalBootRetry(),
      makeMessageListener: () => () => false,
      alarms: [
        {
          names: ['transfer-alarm'],
          domain: 'transfer',
          wake,
          retry: { name: 'transfer-alarm:boot-retry', arm: armRetry },
        },
      ],
      downloads: {
        releaseCaptureTerminal: async () => {},
        onTransferChanged: async () => {},
      },
      clear: { onBrowserStartup: async () => {} },
      trace: () => {},
    })
    await readiness.transfer

    h.alarm()({ name: 'transfer-alarm' })
    await vi.waitFor(() => expect(armRetry).toHaveBeenCalledOnce())
    h.alarm()({ name: 'transfer-alarm:boot-retry' })
    await vi.waitFor(() => {
      expect(attempts).toBe(2)
      expect(armRetry).toHaveBeenCalledTimes(2)
    })
    await tick()

    expect(wake).not.toHaveBeenCalled()
    expect(attempts).toBe(2)
    expect(armRetry).toHaveBeenCalledTimes(2)
  })

  it('keeps corrupt owner state fail-closed without arming a retry loop', async () => {
    const h = listenerHarness()
    const wake = vi.fn<() => Promise<void>>(async () => {})
    const armRetry = vi.fn<() => Promise<void>>(async () => {})
    const readiness = registerBackgroundLifecycle({
      listeners: h.listeners,
      boot: {
        ...availableBoot(),
        transfer: async () => {
          throw new PermanentBackgroundBootError(new Error('registry corrupt'))
        },
      },
      bootRetry: globalBootRetry(),
      makeMessageListener: () => () => false,
      alarms: [
        {
          names: ['transfer-alarm'],
          domain: 'transfer',
          wake,
          retry: { name: 'transfer-alarm:boot-retry', arm: armRetry },
        },
      ],
      downloads: {
        releaseCaptureTerminal: async () => {},
        onTransferChanged: async () => {},
      },
      clear: { onBrowserStartup: async () => {} },
      trace: () => {},
    })
    await expect(readiness.transfer).resolves.toMatchObject({
      tag: 'unavailable',
      failure: 'permanent',
      reason: 'registry corrupt',
    })

    h.alarm()({ name: 'transfer-alarm' })
    await tick()
    expect(wake).not.toHaveBeenCalled()
    expect(armRetry).not.toHaveBeenCalled()
  })
})
