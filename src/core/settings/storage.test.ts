import { describe, expect, it } from 'vitest'
import { defaults, decodeSettings, decodeSettingsPatch } from './storage'

describe('Settings storage decoding', () => {
  it.each([
    ['downloadConcurrency', 2.5],
    ['aria2Split', 17],
    ['minWidth', -1],
    ['minHeight', Infinity],
    ['dailyMaxCount', 1.5],
    ['maxFileSizeMB', -0.1],
    ['dailyMaxMB', NaN],
    ['gdriveTokenExpiry', -1],
    ['dropboxTokenExpiry', Infinity],
  ] as const)('recovers a corrupt durable %s value to defaults', (key, value) => {
    expect(decodeSettings({ [key]: value })).toEqual(defaults)
  })

  it.each([
    ['downloadConcurrency', 2.5],
    ['aria2Split', 0],
    ['minWidth', 1.5],
    ['minHeight', -1],
    ['dailyMaxCount', Infinity],
    ['maxFileSizeMB', -1],
    ['dailyMaxMB', NaN],
    ['gdriveTokenExpiry', -1],
    ['dropboxTokenExpiry', Infinity],
  ] as const)('rejects invalid patch %s=%s', (key, value) => {
    expect(() => decodeSettingsPatch({ [key]: value })).toThrow('Expected')
  })

  it('accepts finite fractional MB patches', () => {
    expect(decodeSettingsPatch({ maxFileSizeMB: 0.5, dailyMaxMB: 1.25 })).toEqual({
      maxFileSizeMB: 0.5,
      dailyMaxMB: 1.25,
    })
  })
})
