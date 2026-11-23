import { Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import { Settings } from '@/packages/schema'
import { makeSettingsCache } from '../cache'

const base = Schema.decodeUnknownSync(Settings)({})

const withConcurrency = (downloadConcurrency: number): Settings => ({
  ...base,
  downloadConcurrency,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeStorage() {
  let stored = base
  const read = vi.fn<() => Promise<Settings>>(async () => stored)
  const fallback = vi.fn<() => Promise<Settings>>(async () => base)
  const write = vi.fn<(patch: Partial<Settings>) => Promise<Settings>>(async (patch) => {
    stored = { ...stored, ...patch }
    return stored
  })
  return {
    get stored() {
      return stored
    },
    set stored(next: Settings) {
      stored = next
    },
    read,
    fallback,
    write,
    cache: makeSettingsCache({ read, fallback, write }),
  }
}

describe('makeSettingsCache', () => {
  it('reads storage once for repeated gets', async () => {
    const f = fakeStorage()

    const first = await f.cache.get()
    const second = await f.cache.get()
    const third = await f.cache.get()

    expect(first).toEqual(base)
    expect(second).toEqual(base)
    expect(third).toEqual(base)
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('shares one read between concurrent first gets', async () => {
    const f = fakeStorage()

    const [first, second] = await Promise.all([f.cache.get(), f.cache.get()])

    expect(first).toEqual(base)
    expect(second).toEqual(base)
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('re-reads once after an external change', async () => {
    const f = fakeStorage()
    await f.cache.get()
    f.stored = withConcurrency(2)
    f.cache.invalidate()

    const first = await f.cache.get()
    const second = await f.cache.get()

    expect(first.downloadConcurrency).toBe(2)
    expect(second.downloadConcurrency).toBe(2)
    expect(f.read).toHaveBeenCalledTimes(2)
  })

  it('serves its own write immediately', async () => {
    const f = fakeStorage()
    await f.cache.get()

    await f.cache.set({ downloadConcurrency: 2 })
    const next = await f.cache.get()

    expect(next.downloadConcurrency).toBe(2)
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('a late change event never reverts a newer own write', async () => {
    const f = fakeStorage()

    await f.cache.set({ downloadConcurrency: 2 })
    await f.cache.set({ downloadConcurrency: 3 })
    f.cache.invalidate()
    const next = await f.cache.get()

    expect(next.downloadConcurrency).toBe(3)
  })

  it('a read that started before a change is not cached', async () => {
    const pending = deferred<Settings>()
    const read = vi.fn<() => Promise<Settings>>().mockImplementationOnce(() => pending.promise)
    read.mockImplementation(async () => withConcurrency(2))
    const fallback = vi.fn<() => Promise<Settings>>(async () => base)
    const write = vi.fn<(patch: Partial<Settings>) => Promise<Settings>>(async () => base)
    const cache = makeSettingsCache({ read, fallback, write })

    const first = cache.get()
    cache.invalidate()
    pending.resolve(base)
    await first

    const second = await cache.get()

    expect(second.downloadConcurrency).toBe(2)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a read that started before an own write does not overwrite it', async () => {
    const pending = deferred<Settings>()
    const read = vi.fn<() => Promise<Settings>>(() => pending.promise)
    const fallback = vi.fn<() => Promise<Settings>>(async () => base)
    const write = vi.fn<(patch: Partial<Settings>) => Promise<Settings>>(async (patch) => ({
      ...base,
      ...patch,
    }))
    const cache = makeSettingsCache({ read, fallback, write })

    const first = cache.get()
    await cache.set({ downloadConcurrency: 2 })
    pending.resolve(base)
    await first

    const next = await cache.get()

    expect(next.downloadConcurrency).toBe(2)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps the old value when a write fails', async () => {
    const f = fakeStorage()
    await f.cache.get()
    f.write.mockRejectedValueOnce(new Error('write failed'))

    await expect(f.cache.set({ downloadConcurrency: 2 })).rejects.toThrow('write failed')

    expect((await f.cache.get()).downloadConcurrency).toBe(base.downloadConcurrency)
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it('a failed read is answered by the fallback and is not cached', async () => {
    const read = vi
      .fn<() => Promise<Settings>>()
      .mockRejectedValueOnce(new Error('storage down'))
      .mockResolvedValueOnce(withConcurrency(2))
    const fallback = vi.fn<() => Promise<Settings>>(async () => base)
    const write = vi.fn<(patch: Partial<Settings>) => Promise<Settings>>(async () => base)
    const cache = makeSettingsCache({ read, fallback, write })

    const first = await cache.get()
    const second = await cache.get()

    expect(first).toEqual(base)
    expect(fallback).toHaveBeenCalledTimes(1)
    expect(second.downloadConcurrency).toBe(2)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
