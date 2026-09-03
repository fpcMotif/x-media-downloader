import { Context, Effect, Layer, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import { Settings as SettingsSchema, type Settings, type JsonValue } from '@/packages/schema'
import { normalizeFilenameTemplate } from './lib/template-migration'

const defaults: Settings = Schema.decodeUnknownSync(SettingsSchema)({})

const item = storage.defineItem<JsonValue>('local:settings', { fallback: {} })

/** Decode stored settings; fall back to defaults on a SchemaError (corrupt data).
 *  Also heals a persisted LEGACY DEFAULT `filenameTemplate` (any default this
 *  project has ever shipped) to the current default — see
 *  `template-migration.ts`. This is the one seam every consumer decodes
 *  through (get/set/watch), so every reader sees the migrated value without
 *  needing its own normalization pass. Pure + idempotent: a user-customized
 *  template is never touched. */
function decode(raw: JsonValue): Settings {
  try {
    /* v8 ignore next -- defineItem's fallback ({}) means raw is never null/undefined here; `?? {}` is unreachable */
    const decoded = Schema.decodeUnknownSync(SettingsSchema)(raw ?? {})
    return { ...decoded, filenameTemplate: normalizeFilenameTemplate(decoded.filenameTemplate) }
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

/** Live subscription for long-lived contexts (content scripts), so popup changes
 *  reach already-open tabs without a reload. Returns an unwatch function. */
export const watchSettings = (cb: (s: Settings) => void): (() => void) =>
  item.watch((raw) => cb(decode(raw)))
