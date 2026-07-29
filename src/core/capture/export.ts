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

/** Largest UTF-8 fragment handed to an export byte sink. */
export const MAX_CAPTURE_EXPORT_FRAGMENT_BYTES = 64 * 1024

type JsonToken = { readonly text: string; readonly bytes: number }

const ascii = (text: string): JsonToken => ({ text, bytes: text.length })

const utf8Bytes = (codePoint: number): number =>
  codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4

/** JSON.stringify-compatible string tokens, including lone-surrogate escaping. */
function* jsonStringTokens(value: string): Generator<JsonToken> {
  yield ascii('"')
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const escape =
      code === 0x22
        ? '\\"'
        : code === 0x5c
          ? '\\\\'
          : code === 0x08
            ? '\\b'
            : code === 0x0c
              ? '\\f'
              : code === 0x0a
                ? '\\n'
                : code === 0x0d
                  ? '\\r'
                  : code === 0x09
                    ? '\\t'
                    : code < 0x20 || (code >= 0xd800 && code <= 0xdfff)
                      ? `\\u${code.toString(16).padStart(4, '0')}`
                      : undefined
    if (escape !== undefined) {
      if (code >= 0xd800 && code <= 0xdbff) {
        const low = value.charCodeAt(i + 1)
        if (low >= 0xdc00 && low <= 0xdfff) {
          const text = value.slice(i, i + 2)
          yield { text, bytes: 4 }
          i += 1
          continue
        }
      }
      yield ascii(escape)
      continue
    }
    const text = value[i]!
    yield { text, bytes: utf8Bytes(code) }
  }
  yield ascii('"')
}

const unsupportedJsonValue = (value: unknown): boolean =>
  value === undefined || typeof value === 'function' || typeof value === 'symbol'

/** Schema-record JSON serializer. Iteration bounds output; tree traversal is separate. */
function* jsonTokens(
  value: unknown,
  space = 0,
  depth = 0,
  ancestors = new Set<object>(),
): Generator<JsonToken> {
  if (value === null) {
    yield ascii('null')
    return
  }
  if (typeof value === 'string') {
    yield* jsonStringTokens(value)
    return
  }
  if (typeof value === 'number') {
    yield ascii(Number.isFinite(value) ? String(value === 0 ? 0 : value) : 'null')
    return
  }
  if (typeof value === 'boolean') {
    yield ascii(String(value))
    return
  }
  if (typeof value === 'bigint') throw new TypeError('Do not know how to serialize a BigInt')
  if (unsupportedJsonValue(value)) return

  const object = value as object
  if (ancestors.has(object)) throw new TypeError('Converting circular structure to JSON')
  ancestors.add(object)
  const indent = (level: number): JsonToken => ascii(' '.repeat(space * level))
  if (Array.isArray(value)) {
    yield ascii('[')
    for (let index = 0; index < value.length; index++) {
      yield ascii(index === 0 ? (space === 0 ? '' : '\n') : space === 0 ? ',' : ',\n')
      if (space !== 0) yield indent(depth + 1)
      const item = value[index]
      yield* jsonTokens(unsupportedJsonValue(item) ? null : item, space, depth + 1, ancestors)
    }
    if (value.length > 0 && space !== 0) {
      yield ascii('\n')
      yield indent(depth)
    }
    yield ascii(']')
  } else {
    const entries = Object.keys(value as Record<string, unknown>)
      .map((key) => [key, (value as Record<string, unknown>)[key]] as const)
      .filter((entry) => !unsupportedJsonValue(entry[1]))
    yield ascii('{')
    for (let index = 0; index < entries.length; index++) {
      const [key, item] = entries[index]!
      yield ascii(index === 0 ? (space === 0 ? '' : '\n') : space === 0 ? ',' : ',\n')
      if (space !== 0) yield indent(depth + 1)
      yield* jsonStringTokens(key)
      yield ascii(space === 0 ? ':' : ': ')
      yield* jsonTokens(item, space, depth + 1, ancestors)
    }
    if (entries.length > 0 && space !== 0) {
      yield ascii('\n')
      yield indent(depth)
    }
    yield ascii('}')
  }
  ancestors.delete(object)
}

function* splitToken(token: JsonToken): Generator<JsonToken> {
  if (token.bytes <= MAX_CAPTURE_EXPORT_FRAGMENT_BYTES) {
    yield token
    return
  }
  let text = ''
  let bytes = 0
  for (const character of token.text) {
    const size = utf8Bytes(character.codePointAt(0)!)
    if (bytes + size > MAX_CAPTURE_EXPORT_FRAGMENT_BYTES) {
      yield { text, bytes }
      text = ''
      bytes = 0
    }
    text += character
    bytes += size
  }
  if (text !== '') yield { text, bytes }
}

function* boundedFragments(tokens: Iterable<JsonToken>): Generator<string> {
  let parts: string[] = []
  let bytes = 0
  for (const token of tokens) {
    for (const piece of splitToken(token)) {
      if (bytes > 0 && bytes + piece.bytes > MAX_CAPTURE_EXPORT_FRAGMENT_BYTES) {
        yield parts.join('')
        parts = []
        bytes = 0
      }
      parts.push(piece.text)
      bytes += piece.bytes
      if (bytes === MAX_CAPTURE_EXPORT_FRAGMENT_BYTES) {
        yield parts.join('')
        parts = []
        bytes = 0
      }
    }
  }
  if (parts.length > 0) yield parts.join('')
}

/** Compact JSON fragments, each at most 64 KiB after UTF-8 encoding. */
export function* jsonValueFragments(value: unknown): Generator<string> {
  yield* boundedFragments(jsonTokens(value))
}

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
  const fragments: string[] = []
  for (const [index, record] of records.entries()) {
    if (index > 0) fragments.push('\n')
    fragments.push(...exportTweetJsonFragments(record, byId))
  }
  return fragments.join('')
}

export interface ExportTreeNode extends ExportTweet {
  readonly children: ReadonlyArray<ExportTreeNode>
}

/** One compact JSONL row, split on UTF-8-safe fragment boundaries. */
export function* exportTweetJsonFragments(
  record: TweetRecord,
  byId: Map<string, TweetRecord>,
): Generator<string> {
  yield* boundedFragments(jsonTokens(toExportTweet(record, byId)))
}

function* treeJsonTokens(
  tree: ConversationTree,
  byId: Map<string, TweetRecord>,
): Generator<JsonToken> {
  const indent = (depth: number): JsonToken => ascii('  '.repeat(depth))
  yield ascii('{\n  "conversationId": ')
  yield* jsonTokens(tree.conversationId, 2, 1)
  yield ascii(',\n  "tweets": [')

  type Frame = {
    readonly node: TweetNode
    readonly depth: number
    readonly tweet: ExportTweet
    nextChild: number
    opened: boolean
  }
  const stack: Frame[] = []
  for (let rootIndex = 0; rootIndex < tree.roots.length; rootIndex++) {
    yield ascii(rootIndex === 0 ? '\n' : ',\n')
    yield indent(2)
    stack.push({
      node: tree.roots[rootIndex]!,
      depth: 2,
      tweet: toExportTweet(tree.roots[rootIndex]!, byId),
      nextChild: 0,
      opened: false,
    })
    while (stack.length > 0) {
      const frame = stack.at(-1)!
      if (!frame.opened) {
        frame.opened = true
        yield ascii('{')
        const entries = Object.entries(frame.tweet)
        for (const [key, value] of entries) {
          yield ascii('\n')
          yield indent(frame.depth + 1)
          yield* jsonStringTokens(key)
          yield ascii(': ')
          yield* jsonTokens(value, 2, frame.depth + 1)
          yield ascii(',')
        }
        yield ascii('\n')
        yield indent(frame.depth + 1)
        yield ascii('"children": [')
      }

      const child = frame.node.children[frame.nextChild]
      if (child !== undefined) {
        yield ascii(frame.nextChild === 0 ? '\n' : ',\n')
        yield indent(frame.depth + 2)
        frame.nextChild += 1
        stack.push({
          node: child,
          depth: frame.depth + 2,
          tweet: toExportTweet(child, byId),
          nextChild: 0,
          opened: false,
        })
        continue
      }

      if (frame.nextChild > 0) {
        yield ascii('\n')
        yield indent(frame.depth + 1)
      }
      yield ascii(']\n')
      yield indent(frame.depth)
      yield ascii('}')
      stack.pop()
    }
  }
  if (tree.roots.length > 0) yield ascii('\n  ')
  yield ascii(']\n}')
}

/** Pretty tree JSON fragments. Traversal is iterative. */
export function* treeJsonFragments(
  tree: ConversationTree,
  byId: Map<string, TweetRecord>,
): Generator<string> {
  yield* boundedFragments(treeJsonTokens(tree, byId))
}

/** One conversation as a nested tree of {@link ExportTweet}s (replies under their
 *  parent as `children`); pretty-printed for human + AI reading of one thread. */
export function toTreeJson(tree: ConversationTree, all: ReadonlyArray<TweetRecord>): string {
  return [...treeJsonFragments(tree, indexById(all))].join('')
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

/** Flat, spreadsheet-friendly projection (Sheets / Notion / CSV). One row per
 *  tweet with scalar columns; arrays are space-joined. */
export interface Row {
  readonly id: string
  readonly url: string
  readonly conversationId: string
  readonly kind: string
  readonly handle: string
  readonly name: string
  readonly createdAt: string
  readonly text: string
  readonly links: string
  readonly media: string
}

export function toRows(records: ReadonlyArray<TweetRecord>): Row[] {
  const byId = indexById(records)
  return records.map((r) => {
    const e = toExportTweet(r, byId)
    return {
      id: e.id,
      url: e.url,
      conversationId: e.conversationId,
      kind: e.kind,
      handle: e.author.handle,
      name: e.author.name ?? '',
      createdAt: e.createdAt ?? '',
      text: e.text,
      links: e.links.map((l) => l.url).join(' '),
      media: e.media.map((m) => m.url).join(' '),
    }
  })
}
