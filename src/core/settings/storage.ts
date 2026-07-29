import { storage } from 'wxt/utils/storage'
import { decodeSettingsPatch, SETTINGS_DEFAULTS, type Settings } from '../schema/settings'
import { decodeSettingsStore } from './persistence'

export interface SettingsRecord {
  readonly get: () => Promise<unknown>
  readonly set: (raw: unknown) => Promise<void>
}

export const defaults: Settings = SETTINGS_DEFAULTS

const item = storage.defineItem<unknown>('local:settings', { fallback: {} })

export const settingsRecord: SettingsRecord = {
  get: () => item.getValue(),
  set: (raw) => item.setValue(raw),
}

export const watchSettingsRecord = (callback: (raw: unknown) => void): (() => void) =>
  item.watch(callback)

/** Runtime projection. Recovery state is fail-safe and never rewrites raw data. */
export const decodeSettings = (raw: unknown): Settings => decodeSettingsStore(raw).settings

export { decodeSettingsPatch }
