import { describe, it, expect } from 'vitest'
import { guessMime, SIMPLE_MAX_BYTES } from './types'

describe('guessMime', () => {
  it.each([
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['png', 'image/png'],
    ['webp', 'image/webp'],
    ['gif', 'image/gif'],
    ['mp4', 'video/mp4'],
    ['mov', 'video/quicktime'],
  ])('maps .%s to %s', (ext, mime) => {
    expect(guessMime(ext)).toBe(mime)
  })

  it('normalizes a leading dot and uppercase', () => {
    expect(guessMime('.JPG')).toBe('image/jpeg')
    expect(guessMime('.MP4')).toBe('video/mp4')
  })

  it('falls back to octet-stream for an unknown extension', () => {
    expect(guessMime('xyz')).toBe('application/octet-stream')
    expect(guessMime('')).toBe('application/octet-stream')
  })
})

describe('constants', () => {
  it('SIMPLE_MAX_BYTES is 8 MiB', () => {
    expect(SIMPLE_MAX_BYTES).toBe(8 * 1024 * 1024)
  })
})
