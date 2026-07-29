import { createContext } from 'preact'
import { useContext } from 'preact/hooks'
import type {
  SettingsRecoveryFailure,
  SettingsRecoveryResponse,
  SettingsRecoveryStatus,
} from '@/core/schema'

export interface OptionsSettingsRecoveryState {
  readonly status: SettingsRecoveryStatus | null
  readonly failure: SettingsRecoveryFailure | null
  readonly loading: boolean
}

export const initialSettingsRecoveryState: OptionsSettingsRecoveryState = {
  status: null,
  failure: null,
  loading: true,
}

export const beginSettingsRecovery = (
  state: OptionsSettingsRecoveryState,
): OptionsSettingsRecoveryState => ({
  ...state,
  failure: null,
  loading: true,
})

/** Keep the last known unsafe status visible when refresh or CAS fails. */
export const settleSettingsRecovery = (
  state: OptionsSettingsRecoveryState,
  response: SettingsRecoveryResponse,
): OptionsSettingsRecoveryState =>
  response._tag === 'SettingsRecoveryStatus'
    ? { status: response, failure: null, loading: false }
    : { status: state.status, failure: response, loading: false }

export interface OptionsSettingsRecoveryController {
  readonly state: OptionsSettingsRecoveryState
  readonly refresh: () => Promise<void>
  readonly recover: (action: 'repair' | 'reset', fingerprint: string) => Promise<void>
}

export const OptionsSettingsRecoveryContext =
  createContext<OptionsSettingsRecoveryController | null>(null)

export const useOptionsSettingsRecovery = (): OptionsSettingsRecoveryController => {
  const controller = useContext(OptionsSettingsRecoveryContext)
  if (controller === null) throw new Error('Settings Recovery context is missing')
  return controller
}
