import { describe, expect, it } from 'vitest'
import { SETTINGS_DEFAULTS } from '../schema/settings'
import {
  MAX_SETTINGS_STORE_BYTES,
  SETTINGS_STORE_VERSION,
  decodeSettingsStore,
  encodeSettingsStore,
  patchRecoverableSettingsStore,
} from './persistence'

describe('Settings persistence', () => {
  it('recognizes a valid legacy subset without inventing corruption', () => {
    const state = decodeSettingsStore({ theme: 'dark', downloadConcurrency: 7 })

    expect(state).toMatchObject({
      kind: 'legacy-valid',
      format: 'legacy',
      settings: { theme: 'dark', downloadConcurrency: 7 },
      invalidKeys: [],
      unknownKeys: [],
    })
  })

  it('salvages known fields but forces authority-bearing choices safe', () => {
    const state = decodeSettingsStore({
      theme: 'dark',
      downloadConcurrency: 'fast',
      downloadStrategy: 'aria2',
      cloudSyncEnabled: true,
      cloudUploadEnabled: true,
      captureMirrorEnabled: true,
      clearOnSave: true,
      gdriveRefreshToken: 'keep-this-token',
      futureSetting: { mode: 'keep' },
    })

    expect(state).toMatchObject({
      kind: 'recoverable',
      settings: {
        theme: 'dark',
        downloadConcurrency: SETTINGS_DEFAULTS.downloadConcurrency,
        downloadStrategy: 'direct',
        cloudSyncEnabled: false,
        cloudUploadEnabled: false,
        captureMirrorEnabled: false,
        clearOnSave: false,
        gdriveRefreshToken: 'keep-this-token',
      },
      repairSettings: {
        downloadStrategy: 'aria2',
        cloudSyncEnabled: true,
        cloudUploadEnabled: true,
        captureMirrorEnabled: true,
        clearOnSave: true,
      },
      invalidKeys: ['downloadConcurrency'],
      unknownKeys: ['futureSetting'],
    })
  })

  it('never interprets another version as legacy Settings', () => {
    expect(
      decodeSettingsStore({
        version: 2,
        theme: 'dark',
        cloudUploadEnabled: true,
      }),
    ).toMatchObject({
      kind: 'blocked',
      reason: 'unsupported-version',
      settings: SETTINGS_DEFAULTS,
    })
  })

  it('recognizes one exact current envelope', () => {
    const raw = encodeSettingsStore({ ...SETTINGS_DEFAULTS, theme: 'dark' }, 8)

    expect(decodeSettingsStore(raw)).toMatchObject({
      kind: 'current',
      format: 'v1',
      revision: 8,
      settings: { theme: 'dark' },
      needsCanonicalWrite: false,
    })
  })

  it('routes an exhausted exact revision through explicit recovery', () => {
    const state = decodeSettingsStore(
      encodeSettingsStore(
        {
          ...SETTINGS_DEFAULTS,
          downloadStrategy: 'aria2',
          cloudUploadEnabled: true,
        },
        Number.MAX_SAFE_INTEGER,
      ),
    )

    expect(state).toMatchObject({
      kind: 'recoverable',
      revision: Number.MAX_SAFE_INTEGER,
      invalidKeys: ['$envelope.revision'],
      canPatch: false,
      settings: {
        downloadStrategy: 'direct',
        cloudUploadEnabled: false,
      },
      repairSettings: {
        downloadStrategy: 'aria2',
        cloudUploadEnabled: true,
      },
    })
  })

  it('marks malformed v1 data recoverable instead of defaulting it silently', () => {
    const state = decodeSettingsStore({
      version: SETTINGS_STORE_VERSION,
      revision: 4,
      settings: {
        ...SETTINGS_DEFAULTS,
        downloadConcurrency: 'fast',
        futureSetting: 'keep',
      },
      futureEnvelopeField: true,
    })

    expect(state).toMatchObject({
      kind: 'recoverable',
      format: 'v1',
      revision: 4,
      invalidKeys: ['downloadConcurrency'],
      unknownKeys: ['$envelope.futureEnvelopeField', 'futureSetting'],
      canPatch: true,
    })
  })

  it('treats a missing version on an envelope shape as recoverable, never legacy', () => {
    expect(
      decodeSettingsStore({
        revision: 1,
        settings: { ...SETTINGS_DEFAULTS },
      }),
    ).toMatchObject({
      kind: 'recoverable',
      format: 'v1',
      invalidKeys: ['$envelope.version'],
    })
  })

  it('preserves unrelated corrupt, unknown, and token values during a legacy patch', () => {
    const raw = {
      theme: 'dark',
      downloadConcurrency: 'fast',
      gdriveRefreshToken: 'opaque-token',
      futureSetting: { nested: true },
    }
    const state = decodeSettingsStore(raw)
    expect(state.kind).toBe('recoverable')
    if (state.kind !== 'recoverable') return

    expect(patchRecoverableSettingsStore(raw, state, { theme: 'light' })).toEqual({
      theme: 'light',
      downloadConcurrency: 'fast',
      gdriveRefreshToken: 'opaque-token',
      futureSetting: { nested: true },
    })
  })

  it('preserves v1 envelope and Settings extras while advancing its revision', () => {
    const raw = {
      version: SETTINGS_STORE_VERSION,
      revision: 7,
      settings: {
        ...SETTINGS_DEFAULTS,
        downloadConcurrency: 'fast',
        futureSetting: { nested: true },
      },
      futureEnvelopeField: 'keep',
    }
    const state = decodeSettingsStore(raw)
    expect(state.kind).toBe('recoverable')
    if (state.kind !== 'recoverable') return

    expect(patchRecoverableSettingsStore(raw, state, { theme: 'dark' })).toEqual({
      version: SETTINGS_STORE_VERSION,
      revision: 8,
      settings: {
        ...SETTINGS_DEFAULTS,
        theme: 'dark',
        downloadConcurrency: 'fast',
        futureSetting: { nested: true },
      },
      futureEnvelopeField: 'keep',
    })
  })

  it('blocks hostile and oversized raw data before reading fields', () => {
    let reads = 0
    const hostile: Record<string, unknown> = {}
    Object.defineProperty(hostile, 'theme', {
      enumerable: true,
      get: () => {
        reads += 1
        return 'dark'
      },
    })

    expect(decodeSettingsStore(hostile).kind).toBe('blocked')
    expect(reads).toBe(0)
    expect(decodeSettingsStore({ value: 'x'.repeat(MAX_SETTINGS_STORE_BYTES) }).kind).toBe(
      'blocked',
    )
  })
})
