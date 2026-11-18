import { describe, expect, it, vi } from 'vitest'
import { makeHiddenAwareSleep } from '../hidden-sleep'

describe('makeHiddenAwareSleep', () => {
  it('uses timerSleep when the document is visible', async () => {
    const timerSleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
    const workerSleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
    const sleep = makeHiddenAwareSleep({
      isHidden: () => false,
      now: () => 1_000,
      timerSleep,
      workerSleep,
    })

    await sleep(200)

    expect(timerSleep).toHaveBeenCalledTimes(1)
    expect(timerSleep).toHaveBeenCalledWith(200)
    expect(workerSleep).not.toHaveBeenCalled()
  })

  it('uses workerSleep when the document is hidden and the worker waits the full duration', async () => {
    let now = 1_000
    const timerSleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
    const workerSleep = vi.fn<(ms: number) => Promise<void>>(async (ms) => {
      now += ms
    })
    const sleep = makeHiddenAwareSleep({
      isHidden: () => true,
      now: () => now,
      timerSleep,
      workerSleep,
    })

    await sleep(200)

    expect(workerSleep).toHaveBeenCalledTimes(1)
    expect(workerSleep).toHaveBeenCalledWith(200)
    expect(timerSleep).not.toHaveBeenCalled()
  })

  it('falls back to timerSleep when hidden and workerSleep rejects', async () => {
    const timerSleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
    const workerSleep = vi.fn<(ms: number) => Promise<void>>(async () => {
      throw new Error('channel closed')
    })
    const sleep = makeHiddenAwareSleep({
      isHidden: () => true,
      now: () => 1_000,
      timerSleep,
      workerSleep,
    })

    await sleep(200)

    expect(timerSleep).toHaveBeenCalledTimes(1)
    expect(timerSleep).toHaveBeenCalledWith(200)
  })

  it('tops up with timerSleep when hidden and workerSleep resolves immediately', async () => {
    const timerSleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
    const workerSleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
    const sleep = makeHiddenAwareSleep({
      isHidden: () => true,
      now: () => 1_000,
      timerSleep,
      workerSleep,
    })

    await sleep(200)

    expect(timerSleep).toHaveBeenCalledTimes(1)
    expect(timerSleep).toHaveBeenCalledWith(200)
  })

  it('always uses timerSleep when enabled is false, even while hidden', async () => {
    const timerSleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
    const workerSleep = vi.fn<(ms: number) => Promise<void>>(async () => {})
    const sleep = makeHiddenAwareSleep({
      isHidden: () => true,
      now: () => 1_000,
      timerSleep,
      workerSleep,
      enabled: false,
    })

    await sleep(200)

    expect(timerSleep).toHaveBeenCalledTimes(1)
    expect(timerSleep).toHaveBeenCalledWith(200)
    expect(workerSleep).not.toHaveBeenCalled()
  })
})
