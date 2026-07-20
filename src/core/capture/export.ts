import type { TweetRecord } from './record'
import type { ConversationTree, TweetNode } from './tree'

/**
 * The public, stable export shape — one clean object per tweet, designed to be
 * predictable for an AI agent and readable for a human:
 *  - every key is always present (`null` for absent), so consumers never branch
 *    on `undefined`;
 *  - timestamps are ISO-8601 strings, not epoch millis;
 *  - a `url` permalink is derived for the tweet and any quote;
 *  - internal storage fields (`rawText`, `sourceRank`) are dropped.
 * This is the schema emitted by JSONL, the conversation-tree JSON, and the rows
 * projection — keep them in lock-step via {@link toExportTweet}.
 */
export interface ExportLink {
  readonly url: string
  readonly title: string | null
  readonly domain: string | null
}
export interface ExportMedia {
  readonly type: string
  readonly url: string
  readonly ext: string
}
export interface ExportQuote {
  readonly id: string
  readonly url: string
  readonly text: string | null
}
export interface ExportTweet {
  readonly id: string
  readonly url: string
  readonly kind: 'tweet' | 'reply' | 'retweet'
  readonly conversationId: string
  readonly replyTo: { readonly id: string; readonly handle: string | null } | null
  readonly author: {
    readonly handle: string
    readonly name: string | null
    readonly id: string | null
  }
  readonly createdAt: string | null
  readonly capturedAt: string
  readonly lang: string | null
  readonly text: string
  readonly links: ReadonlyArray<ExportLink>
  readonly media: ReadonlyArray<ExportMedia>
  readonly mentions: ReadonlyArray<string>
  readonly hashtags: ReadonlyArray<string>
  readonly quote: ExportQuote | null
  readonly source: string
}

/** Tweet permalink; the author-less `/i/status/` form when the handle is unknown. */
const permalink = (handle: string, id: string): string =>
  handle !== '' ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/status/${id}`

const isoOrNull = (ms: number | undefined): string | null =>
  ms === undefined ? null : new Date(ms).toISOString()

const indexById = (all: ReadonlyArray<TweetRecord>): Map<string, TweetRecord> =>
  new Map(all.map((r) => [r.tweetId, r]))

/** Project one stored `TweetRecord` to the clean public {@link ExportTweet}. A
 *  `quotedTweetId` is resolved against `byId` so the quote carries the quoted
 *  author's permalink + inlined text (null text when the quote wasn't captured). */
export function toExportTweet(r: TweetRecord, byId: Map<string, TweetRecord>): ExportTweet {
  let quote: ExportQuote | null = null
  if (r.quotedTweetId !== undefined) {
    const q = byId.get(r.quotedTweetId)
    quote = {
      id: r.quotedTweetId,
      url: permalink(q?.author.handle ?? '', r.quotedTweetId),
      text: q?.text ?? null,
    }
  }
  const kind =
    r.retweetOf !== undefined ? 'retweet' : r.inReplyToTweetId !== undefined ? 'reply' : 'tweet'
  return {
    id: r.tweetId,
    url: permalink(r.author.handle, r.tweetId),
    kind,
    conversationId: r.conversationId,
    replyTo:
      r.inReplyToTweetId === undefined
        ? null
        : { id: r.inReplyToTweetId, handle: r.inReplyToHandle ?? null },
    author: { handle: r.author.handle, name: r.author.name ?? null, id: r.author.userId ?? null },
    createdAt: isoOrNull(r.createdAt),
    capturedAt: new Date(r.capturedAt).toISOString(),
    lang: r.lang ?? null,
    text: r.text,
    links: r.links.map((l) => ({
      url: l.expandedUrl,
      title: l.title ?? null,
      domain: l.domain ?? null,
    })),
    media: r.media.map((m) => ({ type: m.type, url: m.url, ext: m.ext })),
    mentions: [...r.mentions],
    hashtags: [...r.hashtags],
    quote,
    source: r.source,
  }
}

/** One {@link ExportTweet} per line — the bulk AI-ingestion artifact. Quotes are
 *  resolved against the whole batch so a referenced quote carries its text. */
export function toJsonl(records: ReadonlyArray<TweetRecord>): string {
  const byId = indexById(records)
  return records.map((r) => JSON.stringify(toExportTweet(r, byId))).join('\n')
}

export interface ExportTreeNode extends ExportTweet {
  readonly children: ReadonlyArray<ExportTreeNode>
}

const toTreeNode = (node: TweetNode, byId: Map<string, TweetRecord>): ExportTreeNode => ({
  ...toExportTweet(node, byId),
  children: node.children.map((c) => toTreeNode(c, byId)),
})

/** One conversation as a nested tree of {@link ExportTweet}s (replies under their
 *  parent as `children`); pretty-printed for human + AI reading of one thread. */
export function toTreeJson(tree: ConversationTree, all: ReadonlyArray<TweetRecord>): string {
  const byId = indexById(all)
  return JSON.stringify(
    { conversationId: tree.conversationId, tweets: tree.roots.map((r) => toTreeNode(r, byId)) },
    null,
    2,
  )
}

/** Per-tweet ordered `type → count` so a media line is emitted once per type. */
const mediaCounts = (node: TweetNode): Array<[string, number]> => {
  const counts = new Map<string, number>()
  for (const m of node.media) counts.set(m.type, (counts.get(m.type) ?? 0) + 1)
  return [...counts]
}

const renderNode = (
  node: TweetNode,
  depth: number,
  byId: Map<string, TweetRecord>,
  out: string[],
): void => {
  const pad = '  '.repeat(depth)
  const e = toExportTweet(node, byId)
  const name = e.author.name !== null ? ` (${e.author.name})` : ''
  const when = e.createdAt ?? 'unknown time'
  out.push(`${pad}- **@${e.author.handle}**${name} · ${when} · [link](${e.url})`)
  for (const line of e.text.split('\n')) out.push(`${pad}  ${line}`)
  for (const link of e.links) {
    out.push(`${pad}  - 🔗 ${link.title !== null ? `${link.title} — ` : ''}${link.url}`)
  }
  for (const [type, count] of mediaCounts(node)) out.push(`${pad}  - 🎞 ${count} ${type}`)
  if (e.quote !== null) {
    out.push(`${pad}  > quote ${e.quote.url}: ${e.quote.text ?? '(not captured)'}`)
  }
  for (const child of node.children) renderNode(child, depth + 1, byId, out)
}

/** Threaded, depth-indented Markdown of one conversation: author + name +
 *  ISO time + permalink, indented multi-line text, link/media bullets, and the
 *  inlined quote. Built to drop straight into an AI chat or NotebookLM source. */
export function toMarkdown(tree: ConversationTree, all: ReadonlyArray<TweetRecord>): string {
  const byId = indexById(all)
  const rootHandle = tree.roots[0]?.author.handle
  const out: string[] = [`# Thread${rootHandle !== undefined ? ` by @${rootHandle}` : ''}`, '']
  for (const root of tree.roots) renderNode(root, 0, byId, out)
  return out.join('\n')
}
