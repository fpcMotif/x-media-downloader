import { Context, Effect, Layer, Option, Schema } from 'effect'
import { storage } from 'wxt/utils/storage'
import { Settings as SettingsSchema, type JsonValue, type Settings } from '@/packages/schema'
import { destinationLostDelta } from './coupling'
import { hasSecretField, mergeSettings, splitSettings } from './lib/secret-fields'
import { normalizeFilenameTemplate } from './lib/template-migration'

export { SECRET_SETTINGS_FIELDS, type SecretSettingsField } from './lib/secret-fields'

const defaults: Settings = Schema.decodeUnknownSync(SettingsSchema)({})

const item = storage.defineItem<JsonValue>('local:settings', { fallback: {} })
const secretsItem = storage.defineItem<JsonValue>('local:settingsSecrets', { fallback: {} })

const readMergedRaw = async (): Promise<JsonValue> => {
  const [publicRaw, secretsRaw] = await Promise.all([item.getValue(), secretsItem.getValue()])
  return mergeSettings(publicRaw, secretsRaw)
}

const decodeNormalized = (raw: JsonValue): Option.Option<Settings> =>
  Option.map(Schema.decodeUnknownOption(SettingsSchema)(raw), (decoded) => ({
    ...decoded,
    filenameTemplate: normalizeFilenameTemplate(decoded.filenameTemplate),
  }))

const writeSplit = async (next: Settings): Promise<void> => {
  const [publicRaw, secretsRaw] = await Promise.all([item.getValue(), secretsItem.getValue()])
  const { publicPart, secretPart } = splitSettings(next)
  const hadLegacySecret = hasSecretField(publicRaw)
  const parsedSecrets = decodeNormalized(secretsRaw)
  const parsedPublic = decodeNormalized(publicRaw)
  if (
    hadLegacySecret ||
    Option.isNone(parsedSecrets) ||
    JSON.stringify(splitSettings(parsedSecrets.value).secretPart) !== JSON.stringify(secretPart)
  ) {
    await secretsItem.setValue(secretPart)
  }
  if (
    hadLegacySecret ||
    Option.isNone(parsedPublic) ||
    JSON.stringify(splitSettings(parsedPublic.value).publicPart) !== JSON.stringify(publicPart)
  ) {
    await item.setValue(publicPart)
  }
}

const isRelayAck = Schema.is(Schema.Struct({ ok: Schema.Literal(true) }))

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
  get: Effect.promise(() => readMergedRaw()).pipe(Effect.map(decode)),
  // set applies the destination backstop: a write that leaves Cloud-only
  // without a live Cloud destination forces Save to this computer back on,
  // so a grab always has somewhere to put bytes (issue #95).
  set: (patch) =>
    Effect.gen(function* () {
      const current = decode(yield* Effect.promise(() => readMergedRaw()))
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
        if (!isRelayAck(reply))
          return yield* Effect.die(
            new Error('Backend relay control was not acknowledged; settings unchanged'),
          )
      }
      yield* Effect.promise(() => writeSplit(next))
      return next
    }),
})

const provide = <A, E>(eff: Effect.Effect<A, E, SettingsService>): Promise<A> =>
  Effect.runPromise(Effect.provide(eff, SettingsServiceLive))

export const readSettings = (): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.get))

/** Promise helpers for UI contexts (popup) — thin wrappers over the service. */
export const getSettings = async (): Promise<Settings> => {
  try {
    return await readSettings()
  } catch (err) {
    console.warn('[XMD] getSettings failed, falling back to defaults:', err)
    return defaults
  }
}
export const setSettings = (patch: Partial<Settings>): Promise<Settings> =>
  provide(Effect.flatMap(SettingsService, (s) => s.set(patch)))

/** Live subscription for long-lived contexts (content scripts), so popup changes
 *  reach already-open tabs without a reload. Returns an unwatch function. */
export const watchSettings = (cb: (s: Settings) => void): (() => void) => {
  let seq = 0
  const notify = (): void => {
    const id = ++seq
    void (async () => {
      const raw = await readMergedRaw()
      if (id !== seq) return
      cb(decode(raw))
    })()
  }
  const unwatchPublic = item.watch(notify)
  const unwatchSecrets = secretsItem.watch(notify)
  return () => {
    seq += 1
    unwatchPublic()
    unwatchSecrets()
  }
}

export const migrateSettingsSecrets = async (): Promise<boolean> => {
  const publicRaw = await item.getValue()
  if (!hasSecretField(publicRaw)) return false
  await writeSplit(decode(mergeSettings(publicRaw, await secretsItem.getValue())))
  return true
}
