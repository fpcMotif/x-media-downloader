import { Result, Schema } from 'effect'
import {
  SETTINGS_DEFAULTS,
  SETTINGS_KEYS,
  Settings as SettingsSchema,
  decodeSettingsPatch,
  type Settings,
} from '../schema/settings'
import { hasWireKeys, isWireRecord } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { normalizeFilenameTemplate } from './template-migration'

export const SETTINGS_STORE_VERSION = 1
export const MAX_SETTINGS_STORE_BYTES = 256 * 1024

const ENVELOPE_KEYS = ['version', 'revision', 'settings'] as const
const AUTHORITY_DEFAULTS = {
  cloudSyncEnabled: false,
  cloudUploadEnabled: false,
  captureMirrorEnabled: false,
  clearOnSave: false,
  downloadStrategy: 'direct',
} as const satisfies Partial<Settings>

type SettingsStoreFormat = 'none' | 'legacy' | 'v1' | 'unsupported'
type SettingsStoreBlockedReason = 'unsafe-or-oversize' | 'not-an-object' | 'unsupported-version'

interface SettingsStoreStateBase {
  readonly format: SettingsStoreFormat
  /** Runtime projection. Recoverable state forces authority-bearing choices safe. */
  readonly settings: Settings
  /** Valid known fields. Explicit Repair keeps these and defaults invalid fields. */
  readonly repairSettings: Settings
  readonly revision: number
  readonly invalidKeys: readonly string[]
  readonly unknownKeys: readonly string[]
}

export type SettingsStoreState =
  | (SettingsStoreStateBase & {
      readonly kind: 'absent'
      readonly format: 'none'
    })
  | (SettingsStoreStateBase & {
      readonly kind: 'legacy-valid'
      readonly format: 'legacy'
    })
  | (SettingsStoreStateBase & {
      readonly kind: 'current'
      readonly format: 'v1'
      readonly needsCanonicalWrite: boolean
    })
  | (SettingsStoreStateBase & {
      readonly kind: 'recoverable'
      readonly format: 'legacy' | 'v1'
      readonly canPatch: boolean
    })
  | (SettingsStoreStateBase & {
      readonly kind: 'blocked'
      readonly format: 'unsupported'
      readonly reason: SettingsStoreBlockedReason
    })

export interface StoredSettingsV1 {
  readonly version: typeof SETTINGS_STORE_VERSION
  readonly revision: number
  readonly settings: Settings
}

const normalized = (settings: Settings): Settings => ({
  ...settings,
  filenameTemplate: normalizeFilenameTemplate(settings.filenameTemplate),
})

const safeProjection = (settings: Settings): Settings => ({
  ...settings,
  ...AUTHORITY_DEFAULTS,
})

const isRevision = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER

const decodeExactSettings = (raw: unknown): Settings | undefined => {
  if (!isWireRecord(raw) || !hasWireKeys(raw, SETTINGS_KEYS)) return undefined
  const decoded = Schema.decodeUnknownResult(SettingsSchema, {
    onExcessProperty: 'error',
  })(raw)
  return Result.isSuccess(decoded) ? normalized(decoded.success) : undefined
}

interface SalvagedSettings {
  readonly settings: Settings
  readonly invalidKeys: readonly string[]
  readonly unknownKeys: readonly string[]
}

const salvageSettings = (
  raw: Readonly<Record<string, unknown>>,
  missingIsInvalid: boolean,
): SalvagedSettings => {
  const next: Record<string, unknown> = { ...SETTINGS_DEFAULTS }
  const invalidKeys: string[] = []
  const unknownKeys = Object.keys(raw).filter(
    (key) => !SETTINGS_KEYS.includes(key as keyof Settings),
  )

  for (const key of SETTINGS_KEYS) {
    if (!Object.hasOwn(raw, key)) {
      if (missingIsInvalid) invalidKeys.push(key)
      continue
    }
    try {
      const field = decodeSettingsPatch({ [key]: raw[key] })
      next[key] = field[key]
    } catch {
      invalidKeys.push(key)
    }
  }

  return {
    settings: normalized(next as Settings),
    invalidKeys,
    unknownKeys,
  }
}

const blocked = (reason: SettingsStoreBlockedReason): SettingsStoreState => ({
  kind: 'blocked',
  format: 'unsupported',
  reason,
  settings: { ...SETTINGS_DEFAULTS },
  repairSettings: { ...SETTINGS_DEFAULTS },
  revision: 0,
  invalidKeys: [],
  unknownKeys: [],
})

const decodeEnvelope = (raw: Readonly<Record<string, unknown>>): SettingsStoreState => {
  if (Object.hasOwn(raw, 'version') && raw.version !== SETTINGS_STORE_VERSION)
    return blocked('unsupported-version')

  const invalidEnvelopeKeys: string[] = []
  const unknownEnvelopeKeys = Object.keys(raw)
    .filter((key) => !ENVELOPE_KEYS.includes(key as (typeof ENVELOPE_KEYS)[number]))
    .map((key) => `$envelope.${key}`)

  if (raw.version !== SETTINGS_STORE_VERSION) invalidEnvelopeKeys.push('$envelope.version')
  const revision = isRevision(raw.revision) ? raw.revision : 0
  const revisionExhausted = raw.revision === Number.MAX_SAFE_INTEGER
  if (!isRevision(raw.revision) || revisionExhausted) invalidEnvelopeKeys.push('$envelope.revision')

  const settingsRecord = isWireRecord(raw.settings) ? raw.settings : undefined
  if (settingsRecord === undefined) invalidEnvelopeKeys.push('$envelope.settings')
  const salvaged = salvageSettings(settingsRecord ?? {}, true)
  const exact = settingsRecord === undefined ? undefined : decodeExactSettings(settingsRecord)
  const exactEnvelope =
    raw.version === SETTINGS_STORE_VERSION &&
    isRevision(raw.revision) &&
    !revisionExhausted &&
    hasWireKeys(raw, ENVELOPE_KEYS) &&
    exact !== undefined

  if (exactEnvelope && settingsRecord !== undefined) {
    return {
      kind: 'current',
      format: 'v1',
      settings: exact,
      repairSettings: exact,
      revision,
      invalidKeys: [],
      unknownKeys: [],
      needsCanonicalWrite: exact.filenameTemplate !== settingsRecord.filenameTemplate,
    }
  }

  const repairSettings = exact ?? salvaged.settings
  return {
    kind: 'recoverable',
    format: 'v1',
    settings: safeProjection(repairSettings),
    repairSettings,
    revision,
    invalidKeys: [...invalidEnvelopeKeys, ...salvaged.invalidKeys],
    unknownKeys: [...unknownEnvelopeKeys, ...salvaged.unknownKeys],
    canPatch:
      !revisionExhausted && (settingsRecord !== undefined || !Object.hasOwn(raw, 'settings')),
  }
}

/**
 * Sole Settings persistence decoder.
 *
 * It never treats a versioned value as legacy. Corrupt/future values remain
 * durable until a named patch can preserve them or the user confirms recovery.
 */
export const decodeSettingsStore = (raw: unknown): SettingsStoreState => {
  if (raw === null || raw === undefined) {
    return {
      kind: 'absent',
      format: 'none',
      settings: { ...SETTINGS_DEFAULTS },
      repairSettings: { ...SETTINGS_DEFAULTS },
      revision: 0,
      invalidKeys: [],
      unknownKeys: [],
    }
  }
  if (!isJsonWithinByteBudget(raw, MAX_SETTINGS_STORE_BYTES)) return blocked('unsafe-or-oversize')
  if (!isWireRecord(raw)) return blocked('not-an-object')

  const looksVersioned =
    Object.hasOwn(raw, 'version') ||
    Object.hasOwn(raw, 'revision') ||
    Object.hasOwn(raw, 'settings')
  if (looksVersioned) return decodeEnvelope(raw)

  const salvaged = salvageSettings(raw, false)
  if (salvaged.invalidKeys.length === 0 && salvaged.unknownKeys.length === 0) {
    return {
      kind: 'legacy-valid',
      format: 'legacy',
      settings: salvaged.settings,
      repairSettings: salvaged.settings,
      revision: 0,
      invalidKeys: [],
      unknownKeys: [],
    }
  }
  return {
    kind: 'recoverable',
    format: 'legacy',
    settings: safeProjection(salvaged.settings),
    repairSettings: salvaged.settings,
    revision: 0,
    invalidKeys: salvaged.invalidKeys,
    unknownKeys: salvaged.unknownKeys,
    canPatch: true,
  }
}

export const nextSettingsRevision = (revision: number): number => {
  if (!isRevision(revision) || revision === Number.MAX_SAFE_INTEGER)
    throw new Error('Settings revision is exhausted')
  return revision + 1
}

/** Create the only canonical Settings storage shape. */
export const encodeSettingsStore = (settings: Settings, revision: number): StoredSettingsV1 => {
  if (!isRevision(revision)) throw new Error('Expected a safe Settings revision')
  const exact = decodeExactSettings(settings)
  if (exact === undefined) throw new Error('Expected complete valid Settings')
  return {
    version: SETTINGS_STORE_VERSION,
    revision,
    settings: exact,
  }
}

/**
 * Patch bounded recoverable raw state without rewriting unrelated values.
 * `undefined` means the shape cannot preserve those values safely.
 */
export const patchRecoverableSettingsStore = (
  raw: unknown,
  state: Extract<SettingsStoreState, { readonly kind: 'recoverable' }>,
  patch: Readonly<Partial<Settings>>,
): unknown | undefined => {
  if (!state.canPatch || !isWireRecord(raw)) return undefined
  if (state.format === 'legacy') return { ...raw, ...patch }

  const rawSettings = Object.hasOwn(raw, 'settings') ? raw.settings : {}
  if (!isWireRecord(rawSettings)) return undefined
  if (isRevision(raw.revision) && raw.revision === Number.MAX_SAFE_INTEGER) return undefined
  return {
    ...raw,
    ...(isRevision(raw.revision) && raw.revision < Number.MAX_SAFE_INTEGER
      ? { revision: raw.revision + 1 }
      : {}),
    settings: { ...rawSettings, ...patch },
  }
}
