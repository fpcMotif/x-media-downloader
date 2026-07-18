import { describe, it, expect } from 'vitest'
import { makeLatestFrameTask } from './latest-frame'

const makeHarness = <T>() => {
  const frames: (() => void)[] = []
  const ran: T[] = []
  const task = makeLatestFrameTask<T>(
    (run) => frames.push(run),
    (v) => ran.push(v),
  )
  const flushFrame = (): void => {
    const f = frames.shift()
    f?.()
  }
  return { task, frames, ran, flushFrame }
}

describe('makeLatestFrameTask', () => {
  it('A/B/C pushed before one frame runs only C', () => {
    const h = makeHarness<string>()
    h.task.push('A')
    h.task.push('B')
    h.task.push('C')
    expect(h.frames).toHaveLength(1)
    h.flushFrame()
    expect(h.ran).toEqual(['C'])
  })

  it('a push after the frame gets a new frame', () => {
    const h = makeHarness<string>()
    h.task.push('A')
    h.flushFrame()
    h.task.push('B')
    expect(h.frames).toHaveLength(1)
    h.flushFrame()
    expect(h.ran).toEqual(['A', 'B'])
  })

  it('clear() before the frame runs nothing', () => {
    const h = makeHarness<string>()
    h.task.push('A')
    h.task.clear()
    h.flushFrame()
    expect(h.ran).toEqual([])
    // The frame consumed itself; nothing is left queued.
    expect(h.frames).toHaveLength(0)
  })

  it('clear() only drops the pending sample — a later push runs', () => {
    const h = makeHarness<string>()
    h.task.push('A')
    h.task.clear()
    h.flushFrame()
    h.task.push('B')
    h.flushFrame()
    expect(h.ran).toEqual(['B'])
  })
})
