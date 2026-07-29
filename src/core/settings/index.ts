import type { Settings } from '../schema/settings'
import { decodeSettingsOwnership, type SettingsOwnershipSnapshot } from './ownership'
import { settingsRecord, watchSettingsRecord } from './storage'

/** Read the safe runtime projection. The background writer owns every mutation. */
export const getSettings = async (): Promise<Settings> => (await getSettingsOwnership()).runtime

/** Read runtime safety and committed intent without conflating recovery with opt-out. */
export const getSettingsOwnership = async (): Promise<SettingsOwnershipSnapshot> =>
  decodeSettingsOwnership(await settingsRecord.get())

/** Live subscription for long-lived contexts (content scripts), so popup changes
 *  reach already-open tabs without a reload. Returns an unwatch function. */
export const watchSettings = (cb: (s: Settings) => void): (() => void) =>
  watchSettingsRecord((raw) => cb(decodeSettingsOwnership(raw).runtime))

/** Background lifecycle view. Recovery is unavailable, never an implicit opt-out. */
export const watchSettingsOwnership = (
  cb: (snapshot: SettingsOwnershipSnapshot) => void,
): (() => void) => watchSettingsRecord((raw) => cb(decodeSettingsOwnership(raw)))

export type { SettingsOwnershipSnapshot } from './ownership'
