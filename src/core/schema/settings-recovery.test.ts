import { describe, expect, it } from 'vitest'
import {
  MAX_SETTINGS_FINGERPRINT_LENGTH,
  MAX_SETTINGS_RECOVERY_KEYS,
  decodeSettingsRecoveryRequest,
  decodeSettingsRecoveryResponse,
} from './settings-recovery'

describe('Settings recovery contract', () => {
  it('accepts only exact action shapes', () => {
    expect(
      decodeSettingsRecoveryRequest({
        _tag: 'SettingsRecoveryRequest',
        action: 'inspect',
      }),
    ).toEqual({ _tag: 'SettingsRecoveryRequest', action: 'inspect' })
    expect(
      decodeSettingsRecoveryRequest({
        _tag: 'SettingsRecoveryRequest',
        action: 'repair',
        fingerprint: 'sha256:abc',
      }),
    ).toEqual({
      _tag: 'SettingsRecoveryRequest',
      action: 'repair',
      fingerprint: 'sha256:abc',
    })
    expect(
      decodeSettingsRecoveryRequest({
        _tag: 'SettingsRecoveryRequest',
        action: 'reset',
      }),
    ).toBeUndefined()
    expect(
      decodeSettingsRecoveryRequest({
        _tag: 'SettingsRecoveryRequest',
        action: 'inspect',
        fingerprint: 'not-allowed',
      }),
    ).toBeUndefined()
    expect(
      decodeSettingsRecoveryRequest({
        _tag: 'SettingsRecoveryRequest',
        action: 'repair',
        fingerprint: 'x'.repeat(MAX_SETTINGS_FINGERPRINT_LENGTH + 1),
      }),
    ).toBeUndefined()
  })

  it('decodes one bounded status without raw Settings values', () => {
    const status = {
      _tag: 'SettingsRecoveryStatus',
      kind: 'recoverable',
      revision: 4,
      fingerprint: 'sha256:abc',
      invalidKeys: ['downloadConcurrency'],
      unknownKeys: ['futureSetting'],
      truncated: false,
    } as const
    expect(decodeSettingsRecoveryResponse(status)).toEqual(status)
    expect(
      decodeSettingsRecoveryResponse({
        ...status,
        raw: { gdriveRefreshToken: 'must-not-cross-wire' },
      }),
    ).toBeUndefined()
    expect(
      decodeSettingsRecoveryResponse({
        ...status,
        unknownKeys: Array.from(
          { length: MAX_SETTINGS_RECOVERY_KEYS + 1 },
          (_, index) => `future-${index}`,
        ),
      }),
    ).toBeUndefined()
  })

  it('accepts only defined failure reasons', () => {
    expect(
      decodeSettingsRecoveryResponse({
        _tag: 'SettingsRecoveryFailure',
        reason: 'stale-snapshot',
      }),
    ).toEqual({
      _tag: 'SettingsRecoveryFailure',
      reason: 'stale-snapshot',
    })
    expect(
      decodeSettingsRecoveryResponse({
        _tag: 'SettingsRecoveryFailure',
        reason: 'raw-data',
      }),
    ).toBeUndefined()
  })
})
