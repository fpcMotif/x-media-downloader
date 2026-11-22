import type { TweetRecord } from './record'
import { selectConversation } from './store'
import { buildTree } from './lib/tree'
import { toExportTweet, toJsonl, toMarkdown, toTreeJson } from './lib/export'

export function jsonlExportFilename(nowMs: number): string {
  const day = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '')
  return `xharvest-${day}.jsonl`
}

export function quotedIdsOutside(chunk: ReadonlyArray<TweetRecord>): string[] {
  const inChunk = new Set(chunk.map((r) => r.tweetId))
  const quoted = chunk.flatMap((r) => (r.quotedTweetId === undefined ? [] : [r.quotedTweetId]))
  return [...new Set(quoted)].filter((id) => !inChunk.has(id))
}

export function composeJsonlChunk(
  chunk: ReadonlyArray<TweetRecord>,
  quoted: ReadonlyArray<TweetRecord>,
): string {
  const byId = new Map([...quoted, ...chunk].map((r) => [r.tweetId, r]))
  return chunk.map((r) => JSON.stringify(toExportTweet(r, byId))).join('\n')
}

/**
 * Compose one of the three Knowledge Capture export artifacts (spec §10) —
 * pure so the 100%-coverage gate over src/core can see it. `nowMs` stands in
 * for `Date.now()` (used only by the `jsonl` day-stamp); the caller supplies
 * the full record set instead of this reaching into a store itself.
 */
export function composeCaptureExport(
  records: ReadonlyArray<TweetRecord>,
  kind: 'jsonl' | 'tree' | 'markdown',
  conversationId: string | undefined,
  nowMs: number,
): { filename: string; text: string } | null {
  if (kind === 'jsonl') {
    return { filename: jsonlExportFilename(nowMs), text: toJsonl(records) }
  }
  if (conversationId === undefined) return null
  const [tree] = buildTree(selectConversation(records, conversationId))
  if (tree === undefined) return null
  if (kind === 'tree')
    return { filename: `thread-${conversationId}.json`, text: toTreeJson(tree, records) }
  return { filename: `thread-${conversationId}.md`, text: toMarkdown(tree, records) }
}
