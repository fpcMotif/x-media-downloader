import type { SerialQueue } from './serial-queue'

export interface DurableStore {
  readonly get: () => Promise<unknown>
  readonly set: (value: unknown) => Promise<void>
}

export const runSerializedRmw = <S>(
  queue: SerialQueue,
  store: DurableStore,
  decode: (raw: unknown) => S,
  update: (state: S) => S | Promise<S>,
): Promise<S> =>
  queue.run(async () => {
    const next = await update(decode(await store.get()))
    await store.set(next)
    return next
  })
