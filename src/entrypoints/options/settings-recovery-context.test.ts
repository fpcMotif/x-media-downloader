import { describe, expect, it } from 'vitest'
import {
  beginSettingsRecovery,
  initialSettingsRecoveryState,
  settleSettingsRecovery,
} from './settings-recovery-context'

const recoverable = {
  _tag: 'SettingsRecoveryStatus',
  kind: 'recoverable',
  revision: 2,
  fingerprint: 'sha256:before',
  invalidKeys: ['theme'],
  unknownKeys: [],
  truncated: false,
} as const

describe('Options Settings Recovery state', () => {
  it('publishes a fresh status and clears a prior failure', () => {
    const failed = settleSettingsRecovery(initialSettingsRecoveryState, {
      _tag: 'SettingsRecoveryFailure',
      reason: 'unavailable',
    })

    expect(settleSettingsRecovery(failed, recoverable)).toEqual({
      status: recoverable,
      failure: null,
      loading: false,
    })
  })

  it('keeps the last unsafe status visible after stale confirmation', () => {
    const known = settleSettingsRecovery(initialSettingsRecoveryState, recoverable)
    const stale = settleSettingsRecovery(known, {
      _tag: 'SettingsRecoveryFailure',
      reason: 'stale-snapshot',
    })

    expect(stale).toEqual({
      status: recoverable,
      failure: {
        _tag: 'SettingsRecoveryFailure',
        reason: 'stale-snapshot',
      },
      loading: false,
    })
    expect(beginSettingsRecovery(stale)).toEqual({
      status: recoverable,
      failure: null,
      loading: true,
    })
  })

  it('replaces the warning only after a healthy response', () => {
    const known = settleSettingsRecovery(initialSettingsRecoveryState, recoverable)
    const healthy = {
      ...recoverable,
      kind: 'healthy',
      revision: 3,
      fingerprint: 'sha256:after',
      invalidKeys: [],
    } as const

    expect(settleSettingsRecovery(known, healthy)).toEqual({
      status: healthy,
      failure: null,
      loading: false,
    })
  })
})
