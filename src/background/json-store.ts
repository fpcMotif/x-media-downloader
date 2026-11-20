import { storage } from 'wxt/utils/storage'
import type { JsonValue } from '@/packages/schema'
import type { DurableStore } from '@/packages/kernel/durable-store'

/** Returns a {@link DurableStore} over one `browser.storage.local` item. A
 *  missing item reads as `null`, which each store's decoder maps to its empty
 *  state. */
export const jsonStorageStore = (key: `local:${string}`): DurableStore => {
  const item = storage.defineItem<JsonValue>(key, { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}
