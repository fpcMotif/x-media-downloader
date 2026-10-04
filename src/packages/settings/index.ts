import { Context, Effect, Layer, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import {
  Settings as SettingsSchema,
  type JsonValue,
  type Settings,
} from '@/packages/schema'
import { destinationLostDelta } from './coupling'
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
  // set applies the destination backstop: a write that leaves Cloud-only
  // without a live Cloud destination forces Save to this computer back on,
  // so a grab always has somewhere to put bytes (issue #95).
  set: (patch) =>
    Effect.gen(function* () {
      const current = decode(yield* Effect.promise(() => item.getValue()))
      const merged = { ...current, ...patch }
      const next = decode({ ...merged, ...destinationLostDelta(merged) })
      if (current.convexDriveConnected && current.convexUrl !== next.convexUrl)
        return yield* Effect.die(new Error('Disconnect backend Drive before changing deployments'))
      const relayControlChanged =
        (current.convexDriveConnected || next.convexDriveConnected) &&
        (current.cloudUploadEnabled !== next.cloudUploadEnabled ||
          current.convexDriveEnabled !== next.convexDriveEnabled ||
          current.convexDriveConnected !== next.convexDriveConnected ||
          current.gdriveUploadEnabled !== next.gdriveUploadEnabled)
      if (relayControlChanged) {
        const reply = yield* Effect.promise(() =>
          browser.runtime.sendMessage({
            _tag: 'RelayControlRequest',
            enabled: next.cloudUploadEnabled,
            accepting: next.convexDriveEnabled && next.gdriveUploadEnabled,
            connected: next.convexDriveConnected,
          }),
        )
        if (!reply || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true)
          return yield* Effect.die(
            new Error('Backend relay control was not acknowledged; settings unchanged'),
          )
      }
      yield* Effect.promise(() => item.setValue(next))
      return next
    }),
})

const provide = <A, E>(eff: Effect.Effect<A, E, SettingsService>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, SettingsServiceLive))

/** Promise helpers for UI contexts (popup) — thin wrappers over the service. */
export const getSettings = (): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.get)).catch((err: unknown) => {
    console.warn('[XMD] getSettings failed, falling back to defaults:', err)
    return defaults
  })
export const setSettings = (patch: Partial<Settings>): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.set(patch)))

/** Live subscription for long-lived contexts (content scripts), so popup changes
 *  reach already-open tabs without a reload. Returns an unwatch function. */
export const watchSettings = (cb: (s: Settings) => void): (() => void) =>
  item.watch((raw) => cb(decode(raw)))
