import type { JsonValue } from '@/packages/schema'
import type { SerialQueue } from './serial-queue'

export interface DurableStore {
  readonly get: () => Promise<JsonValue>
  readonly set: (value: JsonValue) => Promise<void>
}

export const runSerializedRmw = <S extends JsonValue>(
  queue: SerialQueue,
  store: DurableStore,
  decode: (raw: JsonValue) => S,
  update: (state: S) => S | Promise<S>,
): Promise<S> =>
  queue.run(async () => {
    const next = await update(decode(await store.get()))
    await store.set(next)
    return next
  })
