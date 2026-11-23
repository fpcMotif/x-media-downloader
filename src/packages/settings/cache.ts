import { Option } from 'effect'
import type { Settings } from '@/packages/schema'

export interface SettingsCacheDeps {
  readonly read: () => Promise<Settings>
  readonly fallback: () => Promise<Settings>
  readonly write: (patch: Partial<Settings>) => Promise<Settings>
}

export interface SettingsCache {
  readonly get: () => Promise<Settings>
  readonly set: (patch: Partial<Settings>) => Promise<Settings>
  readonly invalidate: () => void
}

export function makeSettingsCache(deps: SettingsCacheDeps): SettingsCache {
  let current: Option.Option<Settings> = Option.none()
  let loading: Option.Option<Promise<Settings>> = Option.none()
  let generation = 0
  let nextReadId = 0
  let activeReadId = 0

  return {
    get: () => {
      if (Option.isSome(current)) return Promise.resolve(current.value)
      if (Option.isSome(loading)) return loading.value
      const startedAt = generation
      nextReadId += 1
      const readId = nextReadId
      activeReadId = readId
      const pending = (async (): Promise<Settings> => {
        try {
          const value = await deps.read()
          if (generation === startedAt && Option.isNone(current)) {
            current = Option.some(value)
          }
          return Option.isSome(current) ? current.value : value
        } catch {
          return await deps.fallback()
        } finally {
          if (activeReadId === readId) {
            loading = Option.none()
            activeReadId = 0
          }
        }
      })()
      loading = Option.some(pending)
      return pending
    },
    set: async (patch) => {
      const written = await deps.write(patch)
      generation += 1
      current = Option.some(written)
      return written
    },
    invalidate: () => {
      generation += 1
      activeReadId = 0
      current = Option.none()
      loading = Option.none()
    },
  }
}
