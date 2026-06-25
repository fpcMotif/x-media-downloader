import { describe, it, expect } from 'vitest'
import { CLEAR_AFTER_DOWNLOAD } from './copy'

describe('CLEAR_AFTER_DOWNLOAD', () => {
  it('is the single source of truth for the clear-after-download label + description', () => {
    expect(CLEAR_AFTER_DOWNLOAD.label).toBe('Clear after download')
    expect(CLEAR_AFTER_DOWNLOAD.description).toMatch(/once its media truly lands/)
  })
})
