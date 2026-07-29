import { describe, expect, it, vi } from 'vitest'
import { makeBackgroundReadiness, PermanentBackgroundBootError } from './readiness'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('background readiness', () => {
  it('contains corrupt transfer state without blocking local or cloud owners', async () => {
    const calls: string[] = []
    const readiness = makeBackgroundReadiness({
      base: async () => {
        calls.push('base')
      },
      fetched: async () => {
        calls.push('fetched')
      },
      transfer: async () => {
        calls.push('transfer')
        throw new PermanentBackgroundBootError(new Error('registry corrupt'))
      },
      clear: async () => {
        calls.push('clear')
      },
      cloud: async () => {
        calls.push('cloud')
      },
      trace: () => {},
    })
    await flush()
    await expect(readiness.base).resolves.toEqual({ tag: 'available' })
    await expect(readiness.fetched).resolves.toEqual({ tag: 'available' })
    await expect(readiness.transfer).resolves.toMatchObject({
      tag: 'unavailable',
      failure: 'permanent',
    })
    await expect(readiness.clear).resolves.toMatchObject({
      tag: 'unavailable',
      failure: 'permanent',
    })
    await expect(readiness.cloud).resolves.toEqual({ tag: 'available' })
    expect(calls).toEqual(['base', 'fetched', 'cloud', 'transfer'])
  })

  it('waits for Fetched inspection before transfer recovery', async () => {
    let releaseFetched!: () => void
    const fetched = new Promise<void>((resolve) => {
      releaseFetched = resolve
    })
    const transfer = vi.fn<() => Promise<void>>(async () => {})
    const readiness = makeBackgroundReadiness({
      base: async () => {},
      fetched: () => fetched,
      transfer,
      clear: async () => {},
      cloud: async () => {},
      trace: () => {},
    })
    await flush()
    expect(transfer).not.toHaveBeenCalled()
    releaseFetched()
    await expect(readiness.transfer).resolves.toEqual({ tag: 'available' })
    expect(transfer).toHaveBeenCalledOnce()
  })

  it('keeps Direct transfer recovery and local owners available when Fetched is corrupt', async () => {
    const transfer = vi.fn<() => Promise<void>>(async () => {})
    const clear = vi.fn<() => Promise<void>>(async () => {})
    const readiness = makeBackgroundReadiness({
      base: async () => {},
      fetched: async () => {
        throw new Error('lease store corrupt')
      },
      transfer,
      clear,
      cloud: async () => {},
      trace: () => {},
    })
    await expect(readiness.fetched).resolves.toMatchObject({ tag: 'unavailable' })
    await expect(readiness.transfer).resolves.toEqual({ tag: 'available' })
    await expect(readiness.clear).resolves.toEqual({ tag: 'available' })
    await expect(readiness.base).resolves.toEqual({ tag: 'available' })
    expect(transfer).toHaveBeenCalledOnce()
    expect(clear).toHaveBeenCalledOnce()
  })

  it('contains cloud startup failure without delaying transfer recovery', async () => {
    const transfer = vi.fn<() => Promise<void>>(async () => {})
    const readiness = makeBackgroundReadiness({
      base: async () => {},
      fetched: async () => {},
      transfer,
      clear: async () => {},
      cloud: async () => {
        throw new Error('cloud offline')
      },
      trace: () => {},
    })
    await expect(readiness.cloud).resolves.toMatchObject({ tag: 'unavailable' })
    await expect(readiness.transfer).resolves.toEqual({ tag: 'available' })
    expect(transfer).toHaveBeenCalledOnce()
  })

  it('retries failed prerequisites only for the consumed owner domain', async () => {
    const calls: string[] = []
    let baseAttempts = 0
    const readiness = makeBackgroundReadiness({
      base: async () => {
        calls.push('base')
        baseAttempts += 1
        if (baseAttempts === 1) throw new Error('storage unavailable')
      },
      fetched: async () => {
        calls.push('fetched')
      },
      transfer: async () => {
        calls.push('transfer')
      },
      clear: async () => {
        calls.push('clear')
      },
      cloud: async () => {
        calls.push('cloud')
      },
      trace: () => {},
    })
    await expect(readiness.transfer).resolves.toMatchObject({
      tag: 'unavailable',
      failure: 'retryable',
    })

    await expect(readiness.retry('transfer')).resolves.toEqual({ tag: 'available' })

    expect(calls).toEqual(['base', 'base', 'fetched', 'transfer'])
    await expect(readiness.cloud).resolves.toMatchObject({ tag: 'unavailable' })
  })
})
