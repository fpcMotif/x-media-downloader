import type { Settings } from '../schema/settings'
import { decodeSettingsStore, type SettingsStoreState } from './persistence'

/**
 * Runtime safety and committed user intent are separate.
 *
 * Recovery-required data exposes only the fail-safe runtime projection. It
 * cannot authorize destructive cleanup from a projected `false` value.
 */
export type SettingsOwnershipSnapshot =
  | {
      readonly availability: 'available'
      readonly runtime: Settings
      readonly desired: Settings
    }
  | {
      readonly availability: 'recovery-required'
      readonly runtime: Settings
      readonly reason: 'recoverable' | 'blocked'
    }

export const settingsOwnershipFromState = (state: SettingsStoreState): SettingsOwnershipSnapshot =>
  state.kind === 'recoverable' || state.kind === 'blocked'
    ? {
        availability: 'recovery-required',
        runtime: state.settings,
        reason: state.kind,
      }
    : {
        availability: 'available',
        runtime: state.settings,
        desired: state.repairSettings,
      }

export const decodeSettingsOwnership = (raw: unknown): SettingsOwnershipSnapshot =>
  settingsOwnershipFromState(decodeSettingsStore(raw))
