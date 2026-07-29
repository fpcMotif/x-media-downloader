import {
  MAX_SETTINGS_FINGERPRINT_LENGTH,
  MAX_SETTINGS_RECOVERY_KEYS,
  MAX_SETTINGS_RECOVERY_KEY_LENGTH,
  type SettingsRecoveryResponse,
  type SettingsRecoveryStatus,
} from '../core/schema/settings-recovery'
import { SETTINGS_DEFAULTS, decodeSettingsPatch, type Settings } from '../core/schema/settings'
import { makeSerialQueue } from '../core/serial-queue'
import {
  MAX_SETTINGS_STORE_BYTES,
  decodeSettingsStore,
  encodeSettingsStore,
  nextSettingsRevision,
  patchRecoverableSettingsStore,
  type SettingsStoreState,
} from '../core/settings/persistence'
import { settingsRecord, type SettingsRecord } from '../core/settings/storage'
import { isJsonWithinByteBudget } from '../core/wire/json-budget'

export interface SettingsWriter {
  readonly update: (patch: Readonly<Partial<Settings>>) => Promise<Settings>
  readonly updateWhen: (
    guard: (current: Readonly<Settings>) => boolean,
    patch: Readonly<Partial<Settings>>,
  ) => Promise<{ readonly applied: boolean; readonly settings: Settings }>
  /** Runs against one fresh safe projection in FIFO order with every mutation. */
  readonly withSnapshotTurn: <T>(
    callback: (current: Readonly<Settings>) => Promise<T>,
  ) => Promise<T>
}

export interface SettingsInvariantWriter extends SettingsWriter {
  /** Migrates healthy legacy data and repairs worker-owned fields in one commit. */
  readonly ensureInvariants: () => Promise<Settings>
  readonly inspectRecovery: () => Promise<SettingsRecoveryStatus>
  readonly recover: (
    action: 'repair' | 'reset',
    fingerprint: string,
  ) => Promise<SettingsRecoveryResponse>
}

/** Ordered, post-persist notifications from this background-only writer. */
export interface SettingsCommitSource {
  readonly onCommit: (listener: (settings: Settings) => void) => () => void
}

type SettingsWriterWithCommits = SettingsInvariantWriter & SettingsCommitSource

export class SettingsRecoveryRequiredError extends Error {
  override readonly name = 'SettingsRecoveryRequiredError'
}

type DeviceIdFactory = () => string
type RecoveryNonceFactory = () => string

const needsDeviceId = (settings: Readonly<Settings>): boolean =>
  (settings.cloudSyncEnabled || settings.captureMirrorEnabled) && settings.cloudDeviceId === ''

const applyOwnedFields = (settings: Settings, newDeviceId: DeviceIdFactory): Settings =>
  needsDeviceId(settings) ? { ...settings, cloudDeviceId: newDeviceId() } : settings

const digestRaw = async (raw: unknown): Promise<string | undefined> => {
  if (raw !== undefined && raw !== null && !isJsonWithinByteBudget(raw, MAX_SETTINGS_STORE_BYTES))
    return undefined
  const json = raw === undefined ? 'undefined' : JSON.stringify(raw)
  if (json === undefined) return undefined
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json))
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `sha256:${hex}`
}

const boundedKeys = (
  keys: readonly string[],
): { readonly keys: readonly string[]; readonly truncated: boolean } => {
  const result: string[] = []
  const seen = new Set<string>()
  let truncated = keys.length > MAX_SETTINGS_RECOVERY_KEYS
  for (const key of keys) {
    if (result.length === MAX_SETTINGS_RECOVERY_KEYS) break
    const bounded =
      key.length <= MAX_SETTINGS_RECOVERY_KEY_LENGTH
        ? key
        : `${key.slice(0, MAX_SETTINGS_RECOVERY_KEY_LENGTH - 1)}…`
    if (bounded !== key || seen.has(bounded)) truncated = true
    if (seen.has(bounded)) continue
    seen.add(bounded)
    result.push(bounded)
  }
  return { keys: result, truncated }
}

const statusKind = (state: SettingsStoreState): SettingsRecoveryStatus['kind'] =>
  state.kind === 'recoverable' ? 'recoverable' : state.kind === 'blocked' ? 'blocked' : 'healthy'

export function makeSettingsWriter(
  record: SettingsRecord = settingsRecord,
  newDeviceId: DeviceIdFactory = () => crypto.randomUUID(),
  newRecoveryNonce: RecoveryNonceFactory = () => crypto.randomUUID(),
): SettingsWriterWithCommits {
  const writes = makeSerialQueue()
  const commitListeners = new Set<(settings: Settings) => void>()
  let generation = 0
  // Unsafe/oversize raw cannot be content-hashed without reading untrusted
  // data. Its fallback is CAS only within this sole production writer lane.
  // A write or worker recycle invalidates it and forces a fresh inspection.
  let opaqueSnapshot: { readonly generation: number; readonly fingerprint: string } | undefined

  const persist = async (raw: unknown): Promise<void> => {
    await record.set(raw)
    generation += 1
    opaqueSnapshot = undefined
  }

  /** A listener must only enqueue its own work. The record is already durable,
   * and a subscriber failure must not turn that committed write into an error. */
  const publishCommit = (settings: Settings): void => {
    for (const listener of commitListeners) {
      try {
        listener(settings)
      } catch {
        /* committed Settings remain successful if an observer is unavailable */
      }
    }
  }

  const recoveryStatus = async (
    raw: unknown,
    state: SettingsStoreState,
  ): Promise<SettingsRecoveryStatus> => {
    const digest = await digestRaw(raw)
    const fingerprint =
      digest ??
      (opaqueSnapshot?.generation === generation
        ? opaqueSnapshot.fingerprint
        : `opaque:${newRecoveryNonce()}`)
    if (fingerprint.length > MAX_SETTINGS_FINGERPRINT_LENGTH)
      throw new Error('Recovery fingerprint is too long')
    if (digest === undefined) opaqueSnapshot = { generation, fingerprint }
    const invalid = boundedKeys(state.invalidKeys)
    const unknown = boundedKeys(state.unknownKeys)
    return {
      _tag: 'SettingsRecoveryStatus',
      kind: statusKind(state),
      revision: state.revision,
      fingerprint,
      invalidKeys: invalid.keys,
      unknownKeys: unknown.keys,
      truncated: invalid.truncated || unknown.truncated,
    }
  }

  const fingerprintMatches = async (raw: unknown, fingerprint: string): Promise<boolean> => {
    if (fingerprint.startsWith('sha256:')) return (await digestRaw(raw)) === fingerprint
    return (
      (await digestRaw(raw)) === undefined &&
      opaqueSnapshot?.generation === generation &&
      opaqueSnapshot.fingerprint === fingerprint
    )
  }

  const canonicalCommit = async (
    state: Exclude<SettingsStoreState, { readonly kind: 'recoverable' | 'blocked' }>,
    patch: Readonly<Partial<Settings>>,
  ): Promise<Settings> => {
    const settings = applyOwnedFields({ ...state.repairSettings, ...patch }, newDeviceId)
    const revision = state.kind === 'current' ? nextSettingsRevision(state.revision) : 1
    const stored = encodeSettingsStore(settings, revision)
    await persist(stored)
    publishCommit(stored.settings)
    return stored.settings
  }

  const commit = async (
    raw: unknown,
    state: SettingsStoreState,
    patch: Readonly<Partial<Settings>>,
  ): Promise<Settings> => {
    if (state.kind === 'blocked')
      throw new SettingsRecoveryRequiredError('Settings must be reset before they can be changed')
    if (state.kind !== 'recoverable') return canonicalCommit(state, patch)

    const logical = applyOwnedFields({ ...state.repairSettings, ...patch }, newDeviceId)
    const rawPatch: Readonly<Partial<Settings>> =
      logical.cloudDeviceId === state.repairSettings.cloudDeviceId
        ? patch
        : { ...patch, cloudDeviceId: logical.cloudDeviceId }
    const candidate = patchRecoverableSettingsStore(raw, state, rawPatch)
    if (candidate === undefined)
      throw new SettingsRecoveryRequiredError(
        'Settings must be repaired before this value can be changed',
      )
    const candidateState = decodeSettingsStore(candidate)
    if (candidateState.kind === 'blocked')
      throw new SettingsRecoveryRequiredError('Settings patch exceeds the safe storage limit')
    if (candidateState.kind === 'recoverable') {
      await persist(candidate)
      return candidateState.settings
    }

    const revision = candidateState.kind === 'current' ? candidateState.revision : 1
    const stored = encodeSettingsStore(candidateState.repairSettings, revision)
    await persist(stored)
    publishCommit(stored.settings)
    return stored.settings
  }

  return {
    update: (patch) =>
      writes.run(async () => {
        const typedPatch = decodeSettingsPatch(patch)
        const raw = await record.get()
        return commit(raw, decodeSettingsStore(raw), typedPatch)
      }),
    updateWhen: (guard, patch) =>
      writes.run(async () => {
        const typedPatch = decodeSettingsPatch(patch)
        const raw = await record.get()
        const state = decodeSettingsStore(raw)
        if (!guard(state.settings)) return { applied: false, settings: state.settings }
        return {
          applied: true,
          settings: await commit(raw, state, typedPatch),
        }
      }),
    withSnapshotTurn: (callback) =>
      writes.run(async () => {
        const state = decodeSettingsStore(await record.get())
        return await callback(state.settings)
      }),
    onCommit: (listener) => {
      commitListeners.add(listener)
      return () => commitListeners.delete(listener)
    },
    ensureInvariants: () =>
      writes.run(async () => {
        const raw = await record.get()
        const state = decodeSettingsStore(raw)
        if (state.kind === 'blocked' || state.kind === 'recoverable') return state.settings

        const settings = applyOwnedFields(state.repairSettings, newDeviceId)
        const needsWrite =
          state.kind !== 'current' ||
          state.needsCanonicalWrite ||
          settings.cloudDeviceId !== state.repairSettings.cloudDeviceId
        if (!needsWrite) return state.settings

        const revision = state.kind === 'current' ? nextSettingsRevision(state.revision) : 1
        const stored = encodeSettingsStore(settings, revision)
        await persist(stored)
        publishCommit(stored.settings)
        return stored.settings
      }),
    inspectRecovery: () =>
      writes.run(async () => {
        const raw = await record.get()
        return recoveryStatus(raw, decodeSettingsStore(raw))
      }),
    recover: (action, fingerprint) =>
      writes.run(async () => {
        const raw = await record.get()
        if (!(await fingerprintMatches(raw, fingerprint)))
          return {
            _tag: 'SettingsRecoveryFailure',
            reason: 'stale-snapshot',
          }
        const state = decodeSettingsStore(raw)
        if (
          (action === 'repair' && state.kind !== 'recoverable') ||
          (action === 'reset' && state.kind !== 'recoverable' && state.kind !== 'blocked')
        )
          return {
            _tag: 'SettingsRecoveryFailure',
            reason: 'not-recoverable',
          }

        const settings = applyOwnedFields(
          action === 'repair' ? state.repairSettings : { ...SETTINGS_DEFAULTS },
          newDeviceId,
        )
        const revision =
          state.format === 'v1' && state.revision < Number.MAX_SAFE_INTEGER ? state.revision + 1 : 1
        const stored = encodeSettingsStore(settings, revision)
        await persist(stored)
        publishCommit(stored.settings)
        return recoveryStatus(stored, decodeSettingsStore(stored))
      }),
  }
}

/** The extension's sole production Settings mutation seam. */
export const settingsWriter = makeSettingsWriter()
