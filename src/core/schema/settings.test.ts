import { describe, expect, it } from 'vitest'
import {
  decodeSettingsPatch,
  decodeSettingsUpdateResponse,
  decodeSettingsUpdateRequest,
  MAX_SETTINGS_FAILURE_REASON_LENGTH,
  MAX_OAUTH_TOKEN_LENGTH,
  MAX_SETTINGS_PATCH_BYTES,
  SETTINGS_DEFAULTS,
} from './settings'

describe('Settings contract', () => {
  it('accepts an opaque token at its cap and rejects one byte over', () => {
    expect(decodeSettingsPatch({ gdriveAccessToken: 'x'.repeat(MAX_OAUTH_TOKEN_LENGTH) })).toEqual({
      gdriveAccessToken: 'x'.repeat(MAX_OAUTH_TOKEN_LENGTH),
    })
    expect(() =>
      decodeSettingsPatch({ gdriveAccessToken: 'x'.repeat(MAX_OAUTH_TOKEN_LENGTH + 1) }),
    ).toThrow('Expected valid Settings patch')
  })

  it('rejects unknown and oversized patches before persistence', () => {
    expect(() => decodeSettingsPatch({ unknown: true })).toThrow('Unknown settings key: unknown')
    expect(
      decodeSettingsUpdateRequest({
        _tag: 'SettingsUpdateRequest',
        patch: { filenameTemplate: '😀'.repeat(MAX_SETTINGS_PATCH_BYTES) },
      }),
    ).toBeUndefined()
  })

  it('accepts only UI-owned update fields', () => {
    expect(
      decodeSettingsUpdateRequest({
        _tag: 'SettingsUpdateRequest',
        patch: { cloudUploadEnabled: true },
      }),
    ).toEqual({ _tag: 'SettingsUpdateRequest', patch: { cloudUploadEnabled: true } })
    expect(
      decodeSettingsUpdateRequest({
        _tag: 'SettingsUpdateRequest',
        patch: { gdriveRefreshToken: 'must-stay-worker-owned' },
      }),
    ).toBeUndefined()
    expect(
      decodeSettingsUpdateRequest({
        _tag: 'SettingsUpdateRequest',
        patch: { cloudDeviceId: 'must-stay-worker-owned' },
      }),
    ).toBeUndefined()
  })

  it('measures a Settings request before reading wire fields', () => {
    const request: Record<string, unknown> = { patch: { theme: 'dark' } }
    Object.defineProperty(request, '_tag', {
      enumerable: true,
      get: () => {
        throw new Error('wire getter must not run')
      },
    })
    expect(() => decodeSettingsUpdateRequest(request)).not.toThrow()
    expect(decodeSettingsUpdateRequest(request)).toBeUndefined()
  })

  it('accepts only a complete, exact update acknowledgement', () => {
    expect(
      decodeSettingsUpdateResponse({ _tag: 'SettingsUpdateSuccess', settings: SETTINGS_DEFAULTS }),
    ).toEqual({ _tag: 'SettingsUpdateSuccess', settings: SETTINGS_DEFAULTS })
    expect(
      decodeSettingsUpdateResponse({ _tag: 'SettingsUpdateSuccess', settings: { theme: 'dark' } }),
    ).toBeUndefined()
    expect(
      decodeSettingsUpdateResponse({
        _tag: 'SettingsUpdateSuccess',
        settings: SETTINGS_DEFAULTS,
        extra: true,
      }),
    ).toBeUndefined()
    expect(
      decodeSettingsUpdateResponse({
        _tag: 'SettingsUpdateFailure',
        reason: 'x'.repeat(MAX_SETTINGS_FAILURE_REASON_LENGTH + 1),
      }),
    ).toBeUndefined()
  })

  it('limits unique media filters to the three supported types', () => {
    expect(decodeSettingsPatch({ skipTypes: ['photo', 'video', 'gif'] })).toEqual({
      skipTypes: ['photo', 'video', 'gif'],
    })
    expect(() => decodeSettingsPatch({ skipTypes: ['photo', 'photo'] })).toThrow(
      'Expected valid Settings patch',
    )
  })
})
