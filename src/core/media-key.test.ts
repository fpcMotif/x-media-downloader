import { describe, it, expect } from 'vitest'
import { mediaBasenameKey } from './media-key'

describe('mediaBasenameKey', () => {
  it('strips the final extension from the last path segment', () => {
    expect(mediaBasenameKey('https://cdn.example.com/media/ABC.jpg')).toBe('ABC')
  })

  it('keeps a segment that has no extension', () => {
    expect(mediaBasenameKey('https://cdn.example.com/media/NODOT')).toBe('NODOT')
  })

  it('strips a query string before taking the basename', () => {
    expect(mediaBasenameKey('https://cdn.example.com/media/ABC.jpg?format=jpg&name=orig')).toBe(
      'ABC',
    )
  })

  it('strips a fragment before taking the basename', () => {
    expect(mediaBasenameKey('https://cdn.example.com/media/ABC.jpg#anchor')).toBe('ABC')
  })

  it('strips the fragment first, so a query that trails the fragment is dropped too', () => {
    expect(mediaBasenameKey('https://cdn.example.com/media/ABC#frag?x=1')).toBe('ABC')
  })

  it('returns null for a path that ends in a trailing slash', () => {
    expect(mediaBasenameKey('https://cdn.example.com/media/')).toBe(null)
  })

  it('returns null for the empty string', () => {
    expect(mediaBasenameKey('')).toBe(null)
  })

  it('works on a bare pathname with no host', () => {
    expect(mediaBasenameKey('/v/t51.82787-15/abc_n.jpg')).toBe('abc_n')
  })
})
