import { describe, expect, it } from 'vitest'
import {
  toExportTweet,
  toJsonl,
  toMarkdown,
  toRows,
  toTreeJson,
  type ExportTweet,
  type Row,
} from './export'
import { buildTree } from './tree'
import type { TweetRecord } from './record'

/** Minimal self-consistent TweetRecord; only the fields each converter reads vary. */
const rec = (
  over: Partial<TweetRecord> & { tweetId: string; conversationId: string },
): TweetRecord => ({
  author: { handle: 'alice' },
  text: '',
  rawText: '',
  metrics: {},
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'tweetDetail',
  sourceRank: 2,
  capturedAt: 1_700_000_000_000,
  ...over,
})

const byId = (rs: ReadonlyArray<TweetRecord>): Map<string, TweetRecord> =>
  new Map(rs.map((r) => [r.tweetId, r]))

const root = rec({
  tweetId: 'R',
  conversationId: 'C',
  author: { handle: 'alice', name: 'Alice', userId: 'u1' },
  text: 'hello world https://example.com/post',
  createdAt: 1_700_000_000_000,
  lang: 'en',
  links: [
    { expandedUrl: 'https://example.com/post', title: 'A Great Post', domain: 'example.com' },
  ],
  media: [
    { id: 'm1', type: 'photo', url: 'https://pbs/m1.jpg', ext: 'jpg', index: 0 },
    { id: 'm2', type: 'photo', url: 'https://pbs/m2.jpg', ext: 'jpg', index: 1 },
  ],
  mentions: ['carol'],
  hashtags: ['ai'],
  metrics: { replies: 1, retweets: 2, likes: 794, quotes: 3, bookmarks: 4, views: 1000 },
})

const reply = rec({
  tweetId: 'A',
  conversationId: 'C',
  inReplyToTweetId: 'R',
  inReplyToHandle: 'alice',
  author: { handle: 'bob' },
  text: 'nice thread\nsecond line',
  createdAt: 1_700_000_001_000,
  links: [{ expandedUrl: 'https://bare.example' }],
})

const quoting = rec({
  tweetId: 'Q',
  conversationId: 'C',
  inReplyToTweetId: 'A',
  author: { handle: 'carol' },
  text: 'see this',
  quotedTweetId: 'QT',
})

const quoted = rec({
  tweetId: 'QT',
  conversationId: 'OTHER',
  author: { handle: 'dave' },
  text: 'the quoted insight',
})

const all = [root, reply, quoting, quoted]

describe('toExportTweet', () => {
  it('projects the clean schema: permalink, ISO times, kind, metrics, resolved quote', () => {
    const e = toExportTweet(root, byId(all))
    expect(e).toMatchObject<Partial<ExportTweet>>({
      id: 'R',
      url: 'https://x.com/alice/status/R',
      kind: 'tweet',
      conversationId: 'C',
      replyTo: null,
      author: { handle: 'alice', name: 'Alice', id: 'u1' },
      lang: 'en',
      quote: null,
      source: 'tweetDetail',
    })
    expect(e.createdAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(e.capturedAt).toBe(new Date(1_700_000_000_000).toISOString())
    expect(e.links[0]).toEqual({
      url: 'https://example.com/post',
      title: 'A Great Post',
      domain: 'example.com',
    })
    expect(e.media[0]).toEqual({ type: 'photo', url: 'https://pbs/m1.jpg', ext: 'jpg' })
    expect(e.metrics).toEqual({
      replies: 1,
      reposts: 2,
      likes: 794,
      quotes: 3,
      bookmarks: 4,
      views: 1000,
    })
  })

  it('derives kind=reply with a replyTo object, and null-coalesces sparse fields', () => {
    const e = toExportTweet(reply, byId(all))
    expect(e.kind).toBe('reply')
    expect(e.replyTo).toEqual({ id: 'R', handle: 'alice' })
    expect(e.author).toEqual({ handle: 'bob', name: null, id: null })
    expect(e.createdAt).not.toBeNull()
    expect(e.links[0]).toEqual({ url: 'https://bare.example', title: null, domain: null })
    expect(e.metrics).toEqual({
      replies: null,
      reposts: null,
      likes: null,
      quotes: null,
      bookmarks: null,
      views: null,
    })
  })

  it('resolves a quote to the quoted author permalink + inlined text', () => {
    const e = toExportTweet(quoting, byId(all))
    expect(e.kind).toBe('reply')
    expect(e.replyTo).toEqual({ id: 'A', handle: null })
    expect(e.quote).toEqual({
      id: 'QT',
      url: 'https://x.com/dave/status/QT',
      text: 'the quoted insight',
    })
    expect(e.createdAt).toBeNull()
  })

  it('handles an unresolved quote (author-less permalink, null text)', () => {
    const e = toExportTweet(
      rec({ tweetId: 'Z', conversationId: 'C', quotedTweetId: 'GONE' }),
      byId([]),
    )
    expect(e.quote).toEqual({ id: 'GONE', url: 'https://x.com/i/status/GONE', text: null })
  })

  it('uses the author-less permalink when the handle is unknown, and kind=retweet', () => {
    const e = toExportTweet(
      rec({ tweetId: 'RT', conversationId: 'C', author: { handle: '' }, retweetOf: 'X1' }),
      byId([]),
    )
    expect(e.url).toBe('https://x.com/i/status/RT')
    expect(e.kind).toBe('retweet')
  })
})

describe('toJsonl', () => {
  it('emits one clean ExportTweet per line with stable keys', () => {
    const lines = toJsonl(all).split('\n')
    expect(lines).toHaveLength(all.length)
    const parsed = lines.map((l) => JSON.parse(l) as ExportTweet)
    expect(parsed.map((p) => p.id)).toEqual(['R', 'A', 'Q', 'QT'])
    for (const p of parsed) {
      expect(
        'url' in p && 'replyTo' in p && 'quote' in p && 'metrics' in p && 'createdAt' in p,
      ).toBe(true)
    }
    const replyLine = parsed.find((p) => p.id === 'A')!
    expect(replyLine.replyTo).toEqual({ id: 'R', handle: 'alice' })
    // quote resolved across the batch
    expect(parsed.find((p) => p.id === 'Q')!.quote?.text).toBe('the quoted insight')
  })

  it('handles empty input', () => {
    expect(toJsonl([])).toBe('')
  })
})

describe('toTreeJson', () => {
  it('emits pretty nested JSON under `tweets` with quoted text inlined', () => {
    const tree = buildTree(all).find((t) => t.conversationId === 'C')!
    const json = toTreeJson(tree, all)
    expect(json).toContain('\n')
    const parsed = JSON.parse(json) as {
      conversationId: string
      tweets: Array<{ id: string; children: unknown[] }>
    }
    expect(parsed.conversationId).toBe('C')
    expect(parsed.tweets[0]!.id).toBe('R')
    expect(parsed.tweets[0]!.children.length).toBeGreaterThan(0)
    expect(json).toContain('the quoted insight')
  })

  it('handles an empty tree and empty record set', () => {
    expect(() => JSON.parse(toTreeJson({ conversationId: 'C', roots: [] }, []))).not.toThrow()
  })
})

describe('toMarkdown', () => {
  const render = () => toMarkdown(buildTree(all).find((t) => t.conversationId === 'C')!, all)

  it('renders a thread header, author+name, ISO time and permalink', () => {
    const md = render()
    expect(md).toContain('# Thread by @alice')
    expect(md).toContain('**@alice** (Alice)')
    expect(md).toContain('[link](https://x.com/alice/status/R)')
    expect(md).toContain(new Date(1_700_000_000_000).toISOString())
  })

  it('indents continuation lines of multi-line text', () => {
    const lines = render().split('\n')
    const i = lines.findIndex((l) => l.includes('nice thread'))
    expect(lines[i + 1]).toContain('second line')
    expect(lines[i + 1]!.startsWith(' ')).toBe(true)
  })

  it('renders link bullets, media counts, and inlined quote', () => {
    const md = render()
    expect(md).toContain('🔗 A Great Post — https://example.com/post')
    expect(md).toContain('🎞 2 photo')
    expect(md).toContain('> quote https://x.com/dave/status/QT: the quoted insight')
  })

  it('depth-indents nested replies', () => {
    const lines = render().split('\n')
    const indent = (frag: string) => {
      const l = lines.find((x) => x.includes(frag))!
      return l.length - l.trimStart().length
    }
    expect(indent('@bob')).toBeGreaterThan(indent('@alice'))
  })

  it('handles an empty tree (bare header, no throw)', () => {
    expect(toMarkdown({ conversationId: 'C', roots: [] }, [])).toBe('# Thread\n')
  })

  it('falls back for missing timestamp, untitled link, and unresolved quote', () => {
    const sparse = rec({
      tweetId: 'S',
      conversationId: 'C',
      author: { handle: 'edna' },
      text: 'sparse',
      createdAt: undefined,
      links: [{ expandedUrl: 'https://bare.example' }],
      quotedTweetId: 'GONE',
    })
    const md = toMarkdown(buildTree([sparse])[0]!, [sparse])
    expect(md).toContain('unknown time')
    expect(md).toContain('🔗 https://bare.example')
    expect(md).not.toContain('— https://bare.example')
    expect(md).toContain('> quote https://x.com/i/status/GONE: (not captured)')
  })
})

describe('toRows', () => {
  it('projects flat, spreadsheet-friendly rows', () => {
    const rows: Row[] = toRows(all)
    expect(rows).toHaveLength(all.length)
    const r = rows.find((x) => x.id === 'R')!
    expect(r).toMatchObject({
      url: 'https://x.com/alice/status/R',
      conversationId: 'C',
      kind: 'tweet',
      handle: 'alice',
      name: 'Alice',
      links: 'https://example.com/post',
      media: 'https://pbs/m1.jpg https://pbs/m2.jpg',
      likes: 794,
      views: 1000,
    })
    const a = rows.find((x) => x.id === 'A')!
    expect(a.name).toBe('')
    expect(a.media).toBe('')
    expect(a.likes).toBeNull()
  })

  it('uses empty createdAt when absent', () => {
    const rows = toRows([rec({ tweetId: 'N', conversationId: 'C', createdAt: undefined })])
    expect(rows[0]!.createdAt).toBe('')
  })

  it('handles empty input', () => {
    expect(toRows([])).toEqual([])
  })
})
