import { describe, it, expect } from 'vitest'
import { classifyLink, extractLinks, filterLinks } from './links'
import type { ArchivedLink } from './links'

describe('classifyLink', () => {
  it('tags arxiv.org as scholarly', () => {
    const l = classifyLink('https://arxiv.org/abs/2401.00001')
    expect(l).toMatchObject({ kind: 'scholarly', publisher: 'arxiv' })
    expect(l.url).toBe('https://arxiv.org/abs/2401.00001')
  })

  it('matches subdomains of a publisher label (www. and export.)', () => {
    expect(classifyLink('https://www.arxiv.org/abs/1').publisher).toBe('arxiv')
    expect(classifyLink('https://export.arxiv.org/abs/1').publisher).toBe('arxiv')
  })

  it('does NOT match a different label that merely ends in the publisher name', () => {
    const l = classifyLink('https://notarxiv.org/abs/1')
    expect(l.kind).toBe('other')
    expect('publisher' in l).toBe(false)
  })

  it('is case-insensitive on the host', () => {
    expect(classifyLink('https://ARXIV.ORG/abs/1').publisher).toBe('arxiv')
    expect(classifyLink('HTTPS://Arxiv.Org/abs/1').publisher).toBe('arxiv')
  })

  it('matches academic.oup.com and bare oup.com as oup', () => {
    expect(classifyLink('https://academic.oup.com/journal/article/1').publisher).toBe('oup')
    expect(classifyLink('https://oup.com/x').publisher).toBe('oup')
  })

  it('classifies a sampling of the publisher table', () => {
    expect(classifyLink('https://doi.org/10.1/x').publisher).toBe('doi')
    expect(classifyLink('https://link.springer.com/article/1').publisher).toBe('springer')
    expect(classifyLink('https://www.springernature.com/x').publisher).toBe('springer')
    expect(classifyLink('https://www.nature.com/articles/1').publisher).toBe('nature')
    expect(classifyLink('https://www.sciencedirect.com/science/article/1').publisher).toBe(
      'elsevier',
    )
    expect(classifyLink('https://www.ncbi.nlm.nih.gov/pubmed/1').publisher).toBe('pubmed')
    expect(classifyLink('https://aclanthology.org/2020.acl-main.1/').publisher).toBe('acl')
    expect(classifyLink('https://openreview.net/forum?id=abc').publisher).toBe('openreview')
    expect(classifyLink('https://www.biorxiv.org/content/1').publisher).toBe('biorxiv')
  })

  it('path and query never affect the match', () => {
    expect(classifyLink('https://example.com/arxiv.org/abs/1').kind).toBe('other')
    expect(classifyLink('https://example.com/?u=arxiv.org').kind).toBe('other')
  })

  it('returns kind=other with no publisher for a non-scholarly host', () => {
    const l = classifyLink('https://www.youtube.com/watch?v=abc')
    expect(l.kind).toBe('other')
    expect('publisher' in l).toBe(false)
  })

  it('returns kind=other and preserves the raw string for an unparsable URL', () => {
    const l = classifyLink('not a url at all')
    expect(l).toMatchObject({ url: 'not a url at all', kind: 'other' })
    expect('publisher' in l).toBe(false)
  })
})

describe('extractLinks', () => {
  it('prefers expanded_url over the t.co url', () => {
    const out = extractLinks({
      urls: [{ url: 'https://t.co/abc', expanded_url: 'https://arxiv.org/abs/1' }],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.url).toBe('https://arxiv.org/abs/1')
    expect(out[0]!.publisher).toBe('arxiv')
  })

  it('falls back to the t.co url when expanded_url is absent', () => {
    const out = extractLinks({ urls: [{ url: 'https://t.co/keepme' }] })
    expect(out).toHaveLength(1)
    expect(out[0]!.url).toBe('https://t.co/keepme')
  })

  it('skips an entry that has neither url nor expanded_url', () => {
    const out = extractLinks({
      urls: [{ display_url: 'arxiv.org' }, { expanded_url: 'https://doi.org/10.1/y' }],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.url).toBe('https://doi.org/10.1/y')
  })

  it('dedupes by the chosen url (first wins)', () => {
    const out = extractLinks({
      urls: [
        { url: 'https://t.co/a', expanded_url: 'https://arxiv.org/abs/1' },
        { url: 'https://t.co/b', expanded_url: 'https://arxiv.org/abs/1' },
      ],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.url).toBe('https://arxiv.org/abs/1')
  })

  it('returns [] for null / number / missing urls / non-array urls', () => {
    expect(extractLinks(null)).toEqual([])
    expect(extractLinks(42)).toEqual([])
    expect(extractLinks('nope')).toEqual([])
    expect(extractLinks({})).toEqual([])
    expect(extractLinks({ urls: 'not-an-array' })).toEqual([])
    expect(extractLinks({ urls: {} })).toEqual([])
    expect(extractLinks(undefined)).toEqual([])
  })

  it('tolerates malformed individual entries inside a valid urls array', () => {
    const out = extractLinks({
      urls: [null, 7, 'x', { expanded_url: 'https://doi.org/10.1/z' }],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.url).toBe('https://doi.org/10.1/z')
  })
})

describe('filterLinks', () => {
  const links: ReadonlyArray<ArchivedLink> = [
    { url: 'https://arxiv.org/abs/1', kind: 'scholarly', publisher: 'arxiv' },
    { url: 'https://example.com/blog', kind: 'other' },
    { url: 'https://doi.org/10.1/x', kind: 'scholarly', publisher: 'doi' },
  ]

  it('all => identity (same contents)', () => {
    expect(filterLinks(links, 'all')).toEqual(links)
  })

  it('scholarly => only scholarly links', () => {
    const out = filterLinks(links, 'scholarly')
    expect(out).toHaveLength(2)
    expect(out.every((l) => l.kind === 'scholarly')).toBe(true)
  })

  it('none => []', () => {
    expect(filterLinks(links, 'none')).toEqual([])
  })
})
