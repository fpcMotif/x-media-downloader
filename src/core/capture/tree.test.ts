import { describe, it, expect } from 'vitest'
import { buildTree, type ConversationTree, type TweetNode } from './tree'
import type { TweetRecord } from './record'

/** Minimal self-consistent TweetRecord for tree-shape tests; only the fields
 *  buildTree reads (tweetId, conversationId, inReplyToTweetId, createdAt) vary. */
const rec = (
  over: Partial<TweetRecord> & { tweetId: string; conversationId: string },
): TweetRecord => ({
  inReplyToTweetId: undefined,
  author: { handle: 'a' },
  text: '',
  rawText: '',
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'tweetDetail',
  sourceRank: 2,
  capturedAt: 0,
  ...over,
})

const ids = (nodes: TweetNode[]): string[] => nodes.map((n) => n.tweetId)

describe('buildTree', () => {
  it('reconstructs a multi-level chain root R -> A -> B (B grandchild of R)', () => {
    const trees = buildTree([
      rec({ tweetId: 'A', conversationId: 'C', inReplyToTweetId: 'R', createdAt: 2 }),
      rec({ tweetId: 'B', conversationId: 'C', inReplyToTweetId: 'A', createdAt: 3 }),
      rec({ tweetId: 'R', conversationId: 'C', createdAt: 1 }),
    ])
    expect(trees).toHaveLength(1)
    const tree = trees[0]!
    expect(tree.conversationId).toBe('C')
    expect(ids(tree.roots)).toEqual(['R'])
    const r = tree.roots[0]!
    expect(ids(r.children)).toEqual(['A'])
    const a = r.children[0]!
    expect(ids(a.children)).toEqual(['B'])
  })

  it('surfaces an orphan reply (parent not captured) as an additional root', () => {
    const trees = buildTree([
      rec({ tweetId: 'R', conversationId: 'C', createdAt: 1 }),
      rec({ tweetId: 'O', conversationId: 'C', inReplyToTweetId: 'GHOST', createdAt: 2 }),
    ])
    expect(trees).toHaveLength(1)
    expect(ids(trees[0]!.roots)).toEqual(['R', 'O'])
    expect(trees[0]!.roots.every((n) => n.children.length === 0)).toBe(true)
  })

  it('does not throw and roots a group whose true root was never captured', () => {
    let trees: ConversationTree[] = []
    expect(() => {
      trees = buildTree([
        rec({ tweetId: 'A', conversationId: 'C', inReplyToTweetId: 'MISSING', createdAt: 1 }),
        rec({ tweetId: 'B', conversationId: 'C', inReplyToTweetId: 'A', createdAt: 2 }),
      ])
    }).not.toThrow()
    expect(ids(trees[0]!.roots)).toEqual(['A'])
    expect(ids(trees[0]!.roots[0]!.children)).toEqual(['B'])
  })

  it('does not throw or recurse forever on a self-thread (reply to itself)', () => {
    let trees: ConversationTree[] = []
    expect(() => {
      trees = buildTree([rec({ tweetId: 'S', conversationId: 'C', inReplyToTweetId: 'S' })])
    }).not.toThrow()
    expect(ids(trees[0]!.roots)).toEqual(['S'])
    expect(trees[0]!.roots[0]!.children).toEqual([])
  })

  it('does not throw or recurse forever on a two-record cycle', () => {
    let trees: ConversationTree[] = []
    expect(() => {
      trees = buildTree([
        rec({ tweetId: 'X', conversationId: 'C', inReplyToTweetId: 'Y', createdAt: 1 }),
        rec({ tweetId: 'Y', conversationId: 'C', inReplyToTweetId: 'X', createdAt: 2 }),
      ])
    }).not.toThrow()
    // Every record is reachable exactly once across the emitted forest.
    const seen: string[] = []
    const walk = (n: TweetNode) => {
      seen.push(n.tweetId)
      n.children.forEach(walk)
    }
    trees[0]!.roots.forEach(walk)
    expect(seen.sort()).toEqual(['X', 'Y'])
  })

  it('orders roots and children by createdAt then tweetId', () => {
    const trees = buildTree([
      rec({ tweetId: 'r2', conversationId: 'C', createdAt: 5 }),
      rec({ tweetId: 'r1', conversationId: 'C', createdAt: 5 }),
      rec({ tweetId: 'r0', conversationId: 'C', createdAt: 1 }),
      rec({ tweetId: 'cB', conversationId: 'C', inReplyToTweetId: 'r0', createdAt: 9 }),
      rec({ tweetId: 'cA', conversationId: 'C', inReplyToTweetId: 'r0', createdAt: 9 }),
      // two undefined-createdAt siblings: both sort first, tie-broken by tweetId.
      rec({ tweetId: 'cNoTimeB', conversationId: 'C', inReplyToTweetId: 'r0' }),
      rec({ tweetId: 'cNoTimeA', conversationId: 'C', inReplyToTweetId: 'r0' }),
    ])
    // createdAt ascending, then tweetId ascending; undefined createdAt sorts first.
    expect(ids(trees[0]!.roots)).toEqual(['r0', 'r1', 'r2'])
    const r0 = trees[0]!.roots[0]!
    expect(ids(r0.children)).toEqual(['cNoTimeA', 'cNoTimeB', 'cA', 'cB'])
  })

  it('returns one ConversationTree per distinct conversationId', () => {
    const trees = buildTree([
      rec({ tweetId: 'a', conversationId: 'C1', createdAt: 1 }),
      rec({ tweetId: 'b', conversationId: 'C2', createdAt: 1 }),
    ])
    expect(trees.map((t) => t.conversationId).sort()).toEqual(['C1', 'C2'])
  })

  it('returns no trees for empty input', () => {
    expect(buildTree([])).toEqual([])
  })
})
