import { describe, it, expect } from 'vitest'
import { isScholarlyUrl, selectLinks } from './links'

describe('isScholarlyUrl', () => {
  it('recognises the publishers the archive promises to keep', () => {
    expect(isScholarlyUrl('https://arxiv.org/abs/2406.01234')).toBe(true)
    expect(isScholarlyUrl('https://link.springer.com/article/10.1007/s00222-024-01234-5')).toBe(
      true,
    )
    expect(isScholarlyUrl('https://www.cambridge.org/core/journals/some-paper')).toBe(true)
    expect(isScholarlyUrl('https://academic.oup.com/mnras/article/527/1/1')).toBe(true)
    expect(isScholarlyUrl('https://doi.org/10.1000/xyz123')).toBe(true)
    expect(isScholarlyUrl('https://dx.doi.org/10.1000/xyz123')).toBe(true)
  })

  it('matches subdomains but not lookalike hosts', () => {
    expect(isScholarlyUrl('https://export.arxiv.org/abs/1234.5678')).toBe(true)
    expect(isScholarlyUrl('https://notarxiv.org/abs/1234.5678')).toBe(false)
    expect(isScholarlyUrl('https://arxiv.org.evil.com/abs/1234.5678')).toBe(false)
  })

  it('rejects ordinary and malformed URLs', () => {
    expect(isScholarlyUrl('https://example.com/post')).toBe(false)
    expect(isScholarlyUrl('https://x.com/alice/status/1')).toBe(false)
    expect(isScholarlyUrl('not a url')).toBe(false)
  })
})

describe('selectLinks', () => {
  const urls = [
    'https://arxiv.org/abs/2406.01234',
    'https://example.com/blog',
    'https://arxiv.org/abs/2406.01234', // duplicate
    'https://link.springer.com/article/10.1007/x',
  ]

  it('keeps everything de-duplicated and classified under "all"', () => {
    const links = selectLinks(urls, 'all')
    expect(links).toHaveLength(3)
    expect(links[0]).toEqual({ url: 'https://arxiv.org/abs/2406.01234', scholarly: true })
    expect(links[1]).toEqual({ url: 'https://example.com/blog', scholarly: false })
    expect(links[2]!.scholarly).toBe(true)
  })

  it('narrows to publisher links under "scholarly"', () => {
    const links = selectLinks(urls, 'scholarly')
    expect(links.map((l) => l.url)).toEqual([
      'https://arxiv.org/abs/2406.01234',
      'https://link.springer.com/article/10.1007/x',
    ])
  })

  it('drops everything under "none"', () => {
    expect(selectLinks(urls, 'none')).toEqual([])
  })

  it('skips empty strings', () => {
    expect(selectLinks(['', 'https://example.com'], 'all')).toHaveLength(1)
  })
})
