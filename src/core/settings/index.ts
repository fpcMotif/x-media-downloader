import { Context, Effect, Layer, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import { Settings as SettingsSchema, type Settings } from '../schema'

const defaults: Settings = Schema.decodeUnknownSync(SettingsSchema)({})

const item = storage.defineItem<unknown>('local:settings', { fallback: {} })

/** Decode stored settings; fall back to defaults on a SchemaError (corrupt data). */
function decode(raw: unknown): Settings {
  try {
    return Schema.decodeUnknownSync(SettingsSchema)(raw ?? {})
  } catch {
    return defaults
  }
}

export class SettingsService extends Context.Service<
  SettingsService,
  {
    readonly get: Effect.Effect<Settings>
    readonly set: (patch: Partial<Settings>) => Effect.Effect<Settings>
  }
>()('app/SettingsService') {}

// Single-writer (background SW): read-modify-write is non-atomic (ADR-0005).
export const SettingsServiceLive = Layer.succeed(SettingsService, {
  get: Effect.promise(() => item.getValue()).pipe(Effect.map(decode)),
  set: (patch) =>
    Effect.gen(function* () {
      const current = decode(yield* Effect.promise(() => item.getValue()))
      const next = decode({ ...current, ...patch })
      yield* Effect.promise(() => item.setValue(next))
      return next
    }),
})

const provide = <A, E>(eff: Effect.Effect<A, E, SettingsService>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, SettingsServiceLive))

/** Promise helpers for UI contexts (popup) — thin wrappers over the service. */
export const getSettings = (): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.get))
export const setSettings = (patch: Partial<Settings>): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.set(patch)))
