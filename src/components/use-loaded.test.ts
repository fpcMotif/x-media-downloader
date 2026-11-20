import { describe, expect, it } from 'vitest'
import { type Loaded, runLoad } from './use-loaded'

const collect = <T>() => {
  const seen: Loaded<T>[] = []
  const push = (s: Loaded<T>): void => {
    seen.push(s)
  }
  return { seen, push }
}

describe('runLoad', () => {
  it('reports Ready with the loaded value', async () => {
    const out = collect<number>()
    await runLoad(
      () => Promise.resolve(7),
      () => true,
      out.push,
    )
    expect(out.seen).toEqual([{ _tag: 'Ready', value: 7 }])
  })

  it('reports Failed when the loader rejects', async () => {
    const out = collect<number>()
    await runLoad(
      () => Promise.reject(new Error('worker gone')),
      () => true,
      out.push,
    )
    expect(out.seen).toEqual([{ _tag: 'Failed' }])
  })

  it('reports nothing once the owner is no longer active', async () => {
    const out = collect<number>()
    await runLoad(
      () => Promise.resolve(7),
      () => false,
      out.push,
    )
    await runLoad(
      () => Promise.reject(new Error('late')),
      () => false,
      out.push,
    )
    expect(out.seen).toEqual([])
  })
})
