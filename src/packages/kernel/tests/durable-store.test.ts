import { setTimeout as sleep } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@/packages/schema'
import { makeSerialQueue } from '../serial-queue'
import { runSerializedRmw, type DurableStore } from '../durable-store'

const tick = (): Promise<void> => sleep(0)
const decodeStrings = (raw: JsonValue): string[] => (Array.isArray(raw) ? raw.map(String) : [])

function delayedStore(initial: JsonValue): DurableStore & { value: JsonValue; sets: number } {
  const box = {
    value: initial,
    sets: 0,
    async get() {
      await tick()
      return box.value
    },
    async set(value: JsonValue) {
      await tick()
      box.sets += 1
      box.value = value
    },
  }
  return box
}

describe('runSerializedRmw', () => {
  it('keeps both updates when delayed writes race', async () => {
    const queue = makeSerialQueue()
    const store = delayedStore([])

    await Promise.all([
      runSerializedRmw(queue, store, decodeStrings, (state) => [...state, 'a']),
      runSerializedRmw(queue, store, decodeStrings, async (state) => {
        await tick()
        return [...state, 'b']
      }),
    ])

    expect(store.value).toEqual(['a', 'b'])
  })

  it('does not write when the reducer returns its input', async () => {
    const queue = makeSerialQueue()
    const store = delayedStore(['a'])

    const next = await runSerializedRmw(queue, store, decodeStrings, (state) => state)

    expect(store.sets).toBe(0)
    expect(next).toEqual(['a'])
  })

  it('still writes when the reducer returns a new value', async () => {
    const queue = makeSerialQueue()
    const store = delayedStore([])

    await runSerializedRmw(queue, store, decodeStrings, (state) => [...state, 'a'])

    expect(store.sets).toBe(1)
    expect(store.value).toEqual(['a'])
  })

  it('does not write when a null store is cleared to null', async () => {
    const queue = makeSerialQueue()
    const store = delayedStore(null)

    await runSerializedRmw(
      queue,
      store,
      (raw) => raw,
      () => null,
    )

    expect(store.sets).toBe(0)
  })
})
