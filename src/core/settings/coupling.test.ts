import { describe, it, expect } from 'vitest'
import { dedupeToggleDelta } from './coupling'

describe('dedupeToggleDelta', () => {
  it('enabling turns on dedup and its history data source', () => {
    expect(dedupeToggleDelta(true)).toEqual({
      preventDuplicateDownloads: true,
      downloadHistoryEnabled: true,
    })
  })

  it('disabling turns off dedup but leaves history untouched', () => {
    const delta = dedupeToggleDelta(false)
    expect(delta).toEqual({ preventDuplicateDownloads: false })
    expect('downloadHistoryEnabled' in delta).toBe(false)
  })
})
