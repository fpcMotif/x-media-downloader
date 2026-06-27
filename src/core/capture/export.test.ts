import { describe, expect, it } from 'vitest'
import { toJsonl, toMarkdown, toRows, toTreeJson, type Row } from './export'
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
  capturedAt: 0,
  ...over,
})

/** Root R (links + media) -> reply A; plus a quoting tweet Q whose quotedTweetId
 *  points at QT which lives in a DIFFERENT conversation group. */
const root = rec({
  tweetId: 'R',
  conversationId: 'C',
  author: { handle: 'alice', name: 'Alice' },
  text: 'hello world https://example.com/post',
  createdAt: 1_700_000_000_000,
  links: [{ expandedUrl: 'https://example.com/post', title: 'A Great Post' }],
  media: [
    { id: 'm1', type: 'photo', url: 'https://pbs/m1.jpg', ext: 'jpg', index: 0 },
    { id: 'm2', type: 'photo', url: 'https://pbs/m2.jpg', ext: 'jpg', index: 1 },
  ],
})

const reply = rec({
  tweetId: 'A',
  conversationId: 'C',
  inReplyToTweetId: 'R',
  author: { handle: 'bob' },
  text: 'nice thread',
  createdAt: 1_700_000_001_000,
})

const quoting = rec({
  tweetId: 'Q',
  conversationId: 'C',
  inReplyToTweetId: 'A',
  author: { handle: 'carol' },
  text: 'see this',
  createdAt: 1_700_000_002_000,
  quotedTweetId: 'QT',
})

const quoted = rec({
  tweetId: 'QT',
  conversationId: 'OTHER',
  author: { handle: 'dave' },
  text: 'the quoted insight',
})

const all = [root, reply, quoting, quoted]

describe('toJsonl', () => {
  it('emits one record per line carrying conversationId + inReplyToTweetId', () => {
    const lines = toJsonl(all).split('\n')
    expect(lines).toHaveLength(all.length)
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(parsed.map((p) => p.tweetId)).toEqual(['R', 'A', 'Q', 'QT'])
    for (const p of parsed) expect('conversationId' in p).toBe(true)
    for (const p of parsed) expect('inReplyToTweetId' in p).toBe(true)
    const replyLine = parsed.find((p) => p.tweetId === 'A')!
    expect(replyLine.inReplyToTweetId).toBe('R')
    expect(replyLine.conversationId).toBe('C')
  })

  it('handles empty input', () => {
    expect(toJsonl([])).toBe('')
  })
})

describe('toTreeJson', () => {
  it('emits valid pretty nested JSON with quoted text inlined', () => {
    const tree = buildTree(all).find((t) => t.conversationId === 'C')!
    const json = toTreeJson(tree, all)
    expect(json).toContain('\n')
    const parsed = JSON.parse(json) as { conversationId: string }
    expect(parsed.conversationId).toBe('C')
    // QT lives in OTHER conversation but its text resolves into this tree's output.
    expect(json).toContain('the quoted insight')
  })

  it('handles an empty tree and empty record set', () => {
    expect(() => JSON.parse(toTreeJson({ conversationId: 'C', roots: [] }, []))).not.toThrow()
  })
})

describe('toMarkdown', () => {
  const render = () => toMarkdown(buildTree(all).find((t) => t.conversationId === 'C')!, all)

  it('renders author handle and timestamp per tweet', () => {
    const md = render()
    expect(md).toContain('@alice')
    expect(md).toContain('@bob')
    expect(md).toContain(new Date(1_700_000_000_000).toISOString())
  })

  it('renders the expanded text', () => {
    expect(render()).toContain('hello world https://example.com/post')
  })

  it('depth-indents nested replies', () => {
    const lines = render().split('\n')
    const rootLine = lines.find((l) => l.includes('@alice'))!
    const replyLine = lines.find((l) => l.includes('@bob'))!
    const indent = (l: string) => l.length - l.trimStart().length
    expect(indent(replyLine)).toBeGreaterThan(indent(rootLine))
  })

  it('renders link bullets as `title — url`', () => {
    expect(render()).toContain('A Great Post — https://example.com/post')
  })

  it('renders a `[media: type ×N]` line', () => {
    expect(render()).toContain('[media: photo ×2]')
  })

  it('inlines cross-conversation quoted tweet text', () => {
    expect(render()).toContain('the quoted insight')
  })

  it('handles an empty tree', () => {
    expect(() => toMarkdown({ conversationId: 'C', roots: [] }, [])).not.toThrow()
  })

  it('falls back for missing timestamp, untitled links, and unresolved quotes', () => {
    const sparse = rec({
      tweetId: 'S',
      conversationId: 'C',
      author: { handle: 'edna' },
      text: 'sparse',
      links: [{ expandedUrl: 'https://bare.example' }],
      quotedTweetId: 'GONE',
    })
    const md = toMarkdown(buildTree([sparse])[0]!, [sparse])
    expect(md).toContain('(unknown)')
    expect(md).toContain('- https://bare.example')
    expect(md).not.toContain('https://bare.example —')
    expect(md).toContain('> quote GONE: (not captured)')
  })
})

describe('toTreeJson unresolved quote', () => {
  it('keeps a bare quotedTweetId when the quoted record is absent', () => {
    const quoter = rec({ tweetId: 'Z', conversationId: 'C', quotedTweetId: 'GONE' })
    const json = toTreeJson(buildTree([quoter])[0]!, [quoter])
    const parsed = JSON.parse(json) as { roots: Array<{ quoted: Record<string, unknown> }> }
    expect(parsed.roots[0]!.quoted.quotedTweetId).toBe('GONE')
    expect('quotedText' in parsed.roots[0]!.quoted).toBe(false)
  })
})

describe('toRows', () => {
  it('projects one Row per record with tweetId, conversationId, handle, text and joined links', () => {
    const rows: Row[] = toRows(all)
    expect(rows).toHaveLength(all.length)
    const r = rows.find((x) => x.tweetId === 'R')!
    expect(r.conversationId).toBe('C')
    expect(r.handle).toBe('alice')
    expect(r.text).toBe('hello world https://example.com/post')
    expect(r.links).toBe('https://example.com/post')
    const a = rows.find((x) => x.tweetId === 'A')!
    expect(a.links).toBe('')
  })

  it('handles empty input', () => {
    expect(toRows([])).toEqual([])
  })
})
