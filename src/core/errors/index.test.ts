import { describe, expect, it } from 'vitest'
import { DetectError, DownloadError } from './index'

describe('domain errors', () => {
  it('preserves tagged download error data', () => {
    const error = new DownloadError({ id: 'media-1', reason: 'network closed' })

    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('DownloadError')
    expect(error.id).toBe('media-1')
    expect(error.reason).toBe('network closed')
  })

  it('preserves tagged detect error data', () => {
    const error = new DetectError({ reason: 'no media near pointer' })

    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('DetectError')
    expect(error.reason).toBe('no media near pointer')
  })
})
