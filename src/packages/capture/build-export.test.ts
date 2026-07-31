import { describe, it, expect } from 'vitest'
import { composeCaptureExport } from './build-export'
import { toJsonl, toMarkdown, toTreeJson } from './lib/export'
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
