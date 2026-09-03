import { describe, expect, it } from 'vitest'
import type { JsonValue } from '@/packages/schema'
import { makeSerialQueue } from '../serial-queue'
import { runSerializedRmw, type DurableStore } from '../durable-store'

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const decodeStrings = (raw: JsonValue): string[] => (Array.isArray(raw) ? raw.map(String) : [])

function delayedStore(initial: JsonValue): DurableStore & { value: JsonValue } {
  const box = {
    value: initial,
    async get() {
      await tick()
      return box.value
    },
    async set(value: JsonValue) {
      await tick()
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
})
