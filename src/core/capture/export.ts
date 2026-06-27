import type { TweetRecord } from './record'
import type { ConversationTree, TweetNode } from './tree'

/** One `TweetRecord` per line (carries `conversationId` + `inReplyToTweetId`);
 *  the bulk AI-ingestion artifact. The reply key is always present (null when a
 *  top-level tweet) so consumers can rely on the field. */
export function toJsonl(records: ReadonlyArray<TweetRecord>): string {
  return records
    .map((r) => JSON.stringify({ ...r, inReplyToTweetId: r.inReplyToTweetId ?? null }))
    .join('\n')
}

const indexById = (all: ReadonlyArray<TweetRecord>): Map<string, TweetRecord> =>
  new Map(all.map((r) => [r.tweetId, r]))

/** Resolve a `quotedTweetId` against the full set, inlining the quoted text; an
 *  unresolved reference stays bare. */
const resolveQuote = (
  node: TweetRecord,
  byId: Map<string, TweetRecord>,
): { quotedTweetId: string; quotedText?: string } | undefined => {
  if (node.quotedTweetId === undefined) return undefined
  const quoted = byId.get(node.quotedTweetId)
  return quoted
    ? { quotedTweetId: node.quotedTweetId, quotedText: quoted.text }
    : { quotedTweetId: node.quotedTweetId }
}

type JsonNode = TweetNode & {
  quoted?: { quotedTweetId: string; quotedText?: string }
  children: JsonNode[]
}

const annotate = (node: TweetNode, byId: Map<string, TweetRecord>): JsonNode => {
  const quoted = resolveQuote(node, byId)
  return {
    ...node,
    ...(quoted !== undefined ? { quoted } : {}),
    children: node.children.map((c) => annotate(c, byId)),
  }
}

/** One `ConversationTree` as pretty nested JSON, with each node's `quotedTweetId`
 *  resolved against `all` so referenced quoted text is inlined. */
export function toTreeJson(tree: ConversationTree, all: ReadonlyArray<TweetRecord>): string {
  const byId = indexById(all)
  return JSON.stringify(
    { conversationId: tree.conversationId, roots: tree.roots.map((r) => annotate(r, byId)) },
    null,
    2,
  )
}

const renderNode = (
  node: TweetNode,
  depth: number,
  byId: Map<string, TweetRecord>,
  out: string[],
): void => {
  const pad = '  '.repeat(depth)
  const when = node.createdAt !== undefined ? new Date(node.createdAt).toISOString() : 'unknown'
  out.push(`${pad}- @${node.author.handle} (${when})`)
  out.push(`${pad}  ${node.text}`)
  for (const link of node.links) {
    out.push(`${pad}  - ${link.title !== undefined ? `${link.title} — ` : ''}${link.expandedUrl}`)
  }
  for (const [type, count] of mediaCounts(node)) {
    out.push(`${pad}  [media: ${type} ×${count}]`)
  }
  const quoted = resolveQuote(node, byId)
  if (quoted !== undefined) {
    out.push(`${pad}  > quote ${quoted.quotedTweetId}: ${quoted.quotedText ?? '(not captured)'}`)
  }
  for (const child of node.children) renderNode(child, depth + 1, byId, out)
}

/** Per-tweet ordered `type → count` so a `[media: type ×N]` line is emitted once
 *  per distinct media type. */
const mediaCounts = (node: TweetNode): Array<[string, number]> => {
  const counts = new Map<string, number>()
  for (const m of node.media) counts.set(m.type, (counts.get(m.type) ?? 0) + 1)
  return [...counts]
}

/** Threaded, depth-indented Markdown: per tweet the author + timestamp, expanded
 *  text, `title — url` link bullets, `[media: type ×N]` lines, and inlined quoted
 *  text resolved cross-conversation via `all`. */
export function toMarkdown(tree: ConversationTree, all: ReadonlyArray<TweetRecord>): string {
  const byId = indexById(all)
  const out: string[] = []
  for (const root of tree.roots) renderNode(root, 0, byId, out)
  return out.join('\n')
}

export type Row = {
  tweetId: string
  conversationId: string
  handle: string
  text: string
  links: string
}

/** Flat projection seam for a later Notion/Sheets exporter — one `Row` per
 *  record with `links` joined; no exporter is built. */
export function toRows(records: ReadonlyArray<TweetRecord>): Row[] {
  return records.map((r) => ({
    tweetId: r.tweetId,
    conversationId: r.conversationId,
    handle: r.author.handle,
    text: r.text,
    links: r.links.map((l) => l.expandedUrl).join(' '),
  }))
}
