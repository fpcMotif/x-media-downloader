import { describe, it, expect } from 'vitest'
import {
  composeCaptureExport,
  composeJsonlChunk,
  jsonlExportFilename,
  quotedIdsOutside,
} from './build-export'
import { toJsonl, toMarkdown, toTreeJson, type ExportTweet } from './lib/export'
import { buildTree } from './lib/tree'
import { selectConversation } from './store'
import type { TweetRecord } from './record'

/** Minimal self-consistent TweetRecord; only the fields the composer's
 *  dependents read vary (mirrors store.test.ts / tree.test.ts fixtures). */
const rec = (
  over: Partial<TweetRecord> & { tweetId: string; conversationId: string },
): TweetRecord => ({
  author: { handle: 'alice' },
  text: '',
  rawText: '',
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'tweetDetail',
  sourceRank: 2,
  capturedAt: 1_700_000_000_000,
  ...over,
})

const root = rec({
  tweetId: 'R',
  conversationId: 'C',
  author: { handle: 'alice', name: 'Alice', userId: 'u1' },
  text: 'root text',
  createdAt: 1_700_000_000_000,
})

const reply = rec({
  tweetId: 'A',
  conversationId: 'C',
  inReplyToTweetId: 'R',
  inReplyToHandle: 'alice',
  author: { handle: 'bob' },
  text: 'reply text',
  createdAt: 1_700_000_001_000,
})

const other = rec({
  tweetId: 'Z',
  conversationId: 'OTHER',
  author: { handle: 'carol' },
  text: 'unrelated conversation',
})

const records = [root, reply, other]

describe('composeCaptureExport', () => {
  it('jsonl: stamps the filename from nowMs and matches toJsonl(records)', () => {
    const nowMs = Date.parse('2026-07-05T12:34:56.000Z')
    const result = composeCaptureExport(records, 'jsonl', undefined, nowMs)
    expect(result).not.toBeNull()
    expect(result?.filename).toBe('xharvest-20260705.jsonl')
    expect(result?.text).toBe(toJsonl(records))
  })

  it('tree: returns null when conversationId is undefined', () => {
    expect(composeCaptureExport(records, 'tree', undefined, 0)).toBeNull()
  })

  it('tree: returns null when conversationId matches no record', () => {
    expect(composeCaptureExport(records, 'tree', 'no-such-conversation', 0)).toBeNull()
  })

  it('tree: filename is thread-<id>.json, text matches toTreeJson on the same tree/records', () => {
    const result = composeCaptureExport(records, 'tree', 'C', 0)
    expect(result).not.toBeNull()
    expect(result?.filename).toBe('thread-C.json')
    const [tree] = buildTree(selectConversation(records, 'C'))
    expect(result?.text).toBe(toTreeJson(tree!, records))
  })

  it('markdown: filename is thread-<id>.md, text matches toMarkdown on the same tree/records', () => {
    const result = composeCaptureExport(records, 'markdown', 'C', 0)
    expect(result).not.toBeNull()
    expect(result?.filename).toBe('thread-C.md')
    const [tree] = buildTree(selectConversation(records, 'C'))
    expect(result?.text).toBe(toMarkdown(tree!, records))
  })
})

const parseExportLine = (line: string): ExportTweet => JSON.parse(line)

describe('chunked jsonl export', () => {
  const all = [
    rec({ tweetId: '1', conversationId: '1', text: 'first record' }),
    rec({ tweetId: '2', conversationId: '2', text: 'second', quotedTweetId: '9' }),
    rec({ tweetId: '3', conversationId: '3', text: 'third' }),
    rec({ tweetId: '4', conversationId: '4', text: 'fourth' }),
    rec({ tweetId: '5', conversationId: '5', text: 'fifth', quotedTweetId: '1' }),
  ]

  it('chunks joined by a newline equal the whole export', () => {
    const chunks = [all.slice(0, 2), all.slice(2, 4), all.slice(4, 5)]
    const texts = chunks.map((chunk) => {
      const outside = quotedIdsOutside(chunk)
      return composeJsonlChunk(
        chunk,
        all.filter((r) => outside.includes(r.tweetId)),
      )
    })
    expect(texts.join('\n')).toBe(toJsonl(all))
  })

  it('a quote outside the chunk carries its text', () => {
    const chunk = all.slice(4, 5)
    const outside = quotedIdsOutside(chunk)
    const line = composeJsonlChunk(
      chunk,
      all.filter((r) => outside.includes(r.tweetId)),
    )
    const parsed = parseExportLine(line)
    expect(parsed.quote?.text).toBe('first record')
  })

  it('quotedIdsOutside lists each outside id once and skips ids inside the chunk', () => {
    const chunk = [
      rec({ tweetId: 'a', conversationId: 'a', quotedTweetId: 'b' }),
      rec({ tweetId: 'b', conversationId: 'b' }),
      rec({ tweetId: 'c', conversationId: 'c', quotedTweetId: 'z' }),
      rec({ tweetId: 'd', conversationId: 'd', quotedTweetId: 'z' }),
    ]
    expect(quotedIdsOutside(chunk)).toEqual(['z'])
  })

  it('an empty chunk composes to an empty string', () => {
    expect(composeJsonlChunk([], [])).toBe('')
    expect(quotedIdsOutside([])).toEqual([])
  })

  it('jsonlExportFilename stamps the UTC day', () => {
    const nowMs = Date.parse('2026-07-05T12:34:56.000Z')
    expect(jsonlExportFilename(nowMs)).toBe('xharvest-20260705.jsonl')
  })
})
