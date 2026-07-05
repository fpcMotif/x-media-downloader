import type { TweetRecord } from './record'
import { selectConversation } from './store'
import { buildTree } from './tree'
import { toJsonl, toMarkdown, toTreeJson } from './export'

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
    const day = new Date(nowMs).toISOString().slice(0, 10).replace(/-/g, '')
    return { filename: `xharvest-${day}.jsonl`, text: toJsonl(records) }
  }
  if (conversationId === undefined) return null
  const [tree] = buildTree(selectConversation(records, conversationId))
  if (tree === undefined) return null
  if (kind === 'tree')
    return { filename: `thread-${conversationId}.json`, text: toTreeJson(tree, records) }
  return { filename: `thread-${conversationId}.md`, text: toMarkdown(tree, records) }
}
