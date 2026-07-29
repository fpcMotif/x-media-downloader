import type { CaptureDb, CaptureReadSnapshot } from './capture-db'
import {
  makeCaptureExportStaging,
  type CaptureExportStaging,
  type CaptureJsonlLine,
} from './capture-export-staging'
import {
  exportTweetJsonFragments,
  jsonValueFragments,
  toExportTweet,
  treeJsonFragments,
} from '../core/capture/export'
import type { TweetRecord } from '../core/capture/record'
import { buildTree, type ConversationTree, type TweetNode } from '../core/capture/tree'
import {
  MAX_FETCHED_BYTES,
  type ByteSource,
  type FetchedTransferGateway,
} from '../core/download/fetched-transfer-contract'
import type { CaptureExportKind, CaptureExportResult } from '../core/schema/capture'
import { makeSerialQueue } from '../core/serial-queue'
import { MAX_TRANSFER_REGISTRY_ID_LENGTH } from '../core/wire/limits'

type CaptureReadDb = Pick<CaptureDb, 'withReadSnapshot'>

const encoder = new TextEncoder()
const QUOTE_CACHE_RECORDS = 128
const SOURCE_FRAGMENT_CODE_UNITS = 8 * 1024

const makeQuoteReader = (read: CaptureReadSnapshot) => {
  const cache = new Map<string, TweetRecord | undefined>()
  return async (tweetId: string): Promise<TweetRecord | undefined> => {
    if (cache.has(tweetId)) {
      const hit = cache.get(tweetId)
      cache.delete(tweetId)
      cache.set(tweetId, hit)
      return hit
    }
    const record = await read.get(tweetId)
    cache.set(tweetId, record)
    if (cache.size > QUOTE_CACHE_RECORDS) cache.delete(cache.keys().next().value!)
    return record
  }
}

async function* jsonlLines(
  read: CaptureReadSnapshot,
  initial: ReadonlyArray<TweetRecord>,
): AsyncGenerator<CaptureJsonlLine> {
  let page = initial
  const readQuote = makeQuoteReader(read)
  // oxlint-disable no-await-in-loop -- export pages and quote lookups preserve source order
  for (;;) {
    for (const record of page) {
      const quoted =
        record.quotedTweetId === undefined ? undefined : await readQuote(record.quotedTweetId)
      const byId = new Map<string, TweetRecord>()
      if (quoted !== undefined) byId.set(quoted.tweetId, quoted)
      yield () => exportTweetJsonFragments(record, byId)
    }
    const afterTweetId = page.at(-1)?.tweetId
    if (afterTweetId === undefined) return
    page = await read.page(afterTweetId)
    if (page.length === 0) return
  }
  // oxlint-enable no-await-in-loop
}

function byteSource(fragments: AsyncGenerator<string>): ByteSource {
  let canceled = false
  let pending = ''
  let offset = 0
  return {
    read: async () => {
      if (canceled) return { done: true }
      while (offset >= pending.length) {
        // oxlint-disable-next-line no-await-in-loop -- an async generator is sequential by contract
        const next = await fragments.next()
        if (next.done) return { done: true }
        pending = next.value
        offset = 0
      }
      let end = Math.min(offset + SOURCE_FRAGMENT_CODE_UNITS, pending.length)
      const high = pending.charCodeAt(end - 1)
      const low = pending.charCodeAt(end)
      if (
        end < pending.length &&
        high >= 0xd800 &&
        high <= 0xdbff &&
        low >= 0xdc00 &&
        low <= 0xdfff
      )
        end -= 1
      const value = encoder.encode(pending.slice(offset, end))
      offset = end
      return { done: false, value }
    },
    cancel: async () => {
      canceled = true
      await fragments.return(undefined)
    },
  }
}

type ConversationInput =
  | { readonly kind: 'empty' }
  | { readonly kind: 'too-large' }
  | {
      readonly kind: 'ready'
      readonly records: ReadonlyArray<TweetRecord>
      readonly byId: Map<string, TweetRecord>
    }

const jsonBytesWithin = (value: unknown, limit: number): number | null => {
  let bytes = 0
  for (const fragment of jsonValueFragments(value)) {
    bytes += encoder.encode(fragment).byteLength
    if (bytes > limit) return null
  }
  return bytes
}

async function collectConversation(
  read: CaptureReadSnapshot,
  initial: ReadonlyArray<TweetRecord>,
  conversationId: string,
  maxBytes: number,
): Promise<ConversationInput> {
  const records: TweetRecord[] = []
  let inputBytes = 0
  let page = initial
  // oxlint-disable no-await-in-loop -- one stable bounded index scan precedes quote lookups
  for (;;) {
    for (const record of page) {
      const recordBytes = jsonBytesWithin(record, maxBytes - inputBytes)
      if (recordBytes === null) return { kind: 'too-large' }
      inputBytes += recordBytes
      records.push(record)
    }
    const afterTweetId = page.at(-1)?.tweetId
    if (afterTweetId === undefined) break
    page = await read.conversationPage(conversationId, afterTweetId)
    if (page.length === 0) break
  }
  if (records.length === 0) return { kind: 'empty' }

  const byId = new Map(records.map((record) => [record.tweetId, record]))
  for (const record of records) {
    const quotedId = record.quotedTweetId
    if (quotedId === undefined || byId.has(quotedId)) continue
    const quoted = await read.get(quotedId)
    if (quoted === undefined) continue
    const quotedBytes = jsonBytesWithin(quoted, maxBytes - inputBytes)
    if (quotedBytes === null) return { kind: 'too-large' }
    inputBytes += quotedBytes
    byId.set(quoted.tweetId, quoted)
  }
  // oxlint-enable no-await-in-loop
  return { kind: 'ready', records, byId }
}

function* textRangeFragments(value: string, start: number, end: number): Generator<string> {
  while (start < end) {
    let next = Math.min(start + SOURCE_FRAGMENT_CODE_UNITS, end)
    const high = value.charCodeAt(next - 1)
    const low = value.charCodeAt(next)
    if (next < end && high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) next -= 1
    yield value.slice(start, next)
    start = next
  }
}

function* markdownNodeFragments(
  node: TweetNode,
  depth: number,
  byId: Map<string, TweetRecord>,
): Generator<string> {
  const pad = '  '.repeat(depth)
  const tweet = toExportTweet(node, byId)
  yield '\n'
  yield pad
  yield '- **@'
  yield tweet.author.handle
  yield '**'
  if (tweet.author.name !== null) {
    yield ' ('
    yield tweet.author.name
    yield ')'
  }
  yield ` · ${tweet.createdAt ?? 'unknown time'} · [link](`
  yield tweet.url
  yield ')'

  let lineStart = 0
  for (;;) {
    const newline = tweet.text.indexOf('\n', lineStart)
    const lineEnd = newline === -1 ? tweet.text.length : newline
    yield '\n'
    yield pad
    yield '  '
    yield* textRangeFragments(tweet.text, lineStart, lineEnd)
    if (newline === -1) break
    lineStart = newline + 1
  }

  for (const link of tweet.links) {
    yield '\n'
    yield pad
    yield '  - 🔗 '
    if (link.title !== null) {
      yield link.title
      yield ' — '
    }
    yield link.url
  }
  const media = new Map<string, number>()
  for (const item of tweet.media) media.set(item.type, (media.get(item.type) ?? 0) + 1)
  for (const [type, count] of media) {
    yield '\n'
    yield pad
    yield `  - 🎞 ${count} `
    yield type
  }
  if (tweet.quote !== null) {
    yield '\n'
    yield pad
    yield '  > quote '
    yield tweet.quote.url
    yield ': '
    yield tweet.quote.text ?? '(not captured)'
  }
}

async function* markdownFragments(
  tree: ConversationTree,
  byId: Map<string, TweetRecord>,
): AsyncGenerator<string> {
  const rootHandle = tree.roots[0]?.author.handle
  yield `# Thread${rootHandle === undefined ? '' : ` by @${rootHandle}`}\n`
  const stack = tree.roots.toReversed().map((node) => ({ node, depth: 0 }))
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!
    yield* markdownNodeFragments(node, depth, byId)
    for (const child of node.children.toReversed()) stack.push({ node: child, depth: depth + 1 })
  }
}

async function* asyncFragments(fragments: Iterable<string>): AsyncGenerator<string> {
  yield* fragments
}

const filenameFor = (
  kind: CaptureExportKind,
  conversationId: string | undefined,
  now: number,
): string | null => {
  if (kind === 'jsonl') {
    const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '')
    return `xharvest-${day}.jsonl`
  }
  if (conversationId === undefined) return null
  return kind === 'tree' ? `thread-${conversationId}.json` : `thread-${conversationId}.md`
}

const mimeTypeFor = (kind: CaptureExportKind): string => {
  if (kind === 'jsonl') return 'application/x-ndjson'
  if (kind === 'tree') return 'application/json'
  return 'text/markdown'
}

const jsonlPartFilename = (firstFilename: string, part: number): string =>
  part === 0
    ? firstFilename
    : firstFilename.replace(/\.jsonl$/, `.part-${String(part + 1).padStart(4, '0')}.jsonl`)

const capturePartOwnerId = (exportId: string, part: number): string => {
  if (part === 0) return exportId
  const suffix = `:part-${part + 1}`
  return `${exportId.slice(0, MAX_TRANSFER_REGISTRY_ID_LENGTH - suffix.length)}${suffix}`
}

export function makeCaptureExporter(deps: {
  readonly captureDb: CaptureReadDb
  readonly gateway: FetchedTransferGateway
  readonly staging?: CaptureExportStaging
  readonly now?: () => number
  readonly requestId?: () => string
  readonly maxBytes?: number
}) {
  const now = deps.now ?? Date.now
  const requestId = deps.requestId ?? (() => crypto.randomUUID())
  const maxBytes = deps.maxBytes ?? MAX_FETCHED_BYTES
  const staging = deps.staging ?? makeCaptureExportStaging()
  const lane = makeSerialQueue()
  return {
    start: async (kind: CaptureExportKind, conversationId?: string): Promise<CaptureExportResult> =>
      lane.run(async () => {
        const filename = filenameFor(kind, conversationId, now())
        if (filename === null) return { _tag: 'CaptureExportEmpty' }
        try {
          const stage = async (
            open: () => Promise<ByteSource>,
            exportId?: string,
          ): Promise<CaptureExportResult> => {
            const result = await deps.gateway.start({
              owner: { tag: 'capture', exportId: exportId ?? requestId() },
              filename,
              open: async () => ({
                mimeType: mimeTypeFor(kind),
                body: await open(),
              }),
            })
            return result.kind === 'too-large'
              ? { _tag: 'CaptureExportTooLarge' }
              : result.kind === 'started'
                ? { _tag: 'CaptureExportStarted', filename }
                : result.kind === 'unavailable'
                  ? { _tag: 'CaptureExportUnavailable' }
                  : { _tag: 'CaptureExportUncertain' }
          }
          if (kind === 'jsonl') {
            const exportId = requestId()
            const materialized = await deps.captureDb.withReadSnapshot(async (read) => {
              const firstPage = await read.page()
              if (firstPage.length === 0) return 'empty' as const
              return staging.materializeJsonl(exportId, jsonlLines(read, firstPage), maxBytes)
            })
            if (materialized === 'empty') return { _tag: 'CaptureExportEmpty' }
            if (materialized.kind === 'empty') return { _tag: 'CaptureExportEmpty' }
            if (materialized.kind === 'too-large') return { _tag: 'CaptureExportTooLarge' }
            let startedParts = 0
            try {
              // oxlint-disable no-await-in-loop -- part order is the archive order
              for (let part = 0; part < materialized.partCount; part += 1) {
                const owner = {
                  tag: 'capture' as const,
                  exportId: capturePartOwnerId(exportId, part),
                }
                let reservation:
                  | Awaited<ReturnType<FetchedTransferGateway['reserve']>>
                  | Awaited<ReturnType<FetchedTransferGateway['awaitCaptureReservation']>>
                try {
                  reservation =
                    startedParts === 0
                      ? await deps.gateway.reserve(owner)
                      : await deps.gateway.awaitCaptureReservation(owner)
                } catch {
                  return startedParts === 0
                    ? { _tag: 'CaptureExportFailed' }
                    : { _tag: 'CaptureExportUncertain' }
                }
                if (reservation.kind === 'owner-duplicate')
                  return { _tag: 'CaptureExportUncertain' }
                if (reservation.kind !== 'reserved')
                  return startedParts === 0
                    ? { _tag: 'CaptureExportUnavailable' }
                    : { _tag: 'CaptureExportUncertain' }

                let result: Awaited<ReturnType<FetchedTransferGateway['startReserved']>>
                try {
                  result = await deps.gateway.startReserved({
                    leaseId: reservation.leaseId,
                    owner,
                    filename: jsonlPartFilename(filename, part),
                    open: async () => ({
                      mimeType: mimeTypeFor(kind),
                      body: staging.source(exportId, part),
                    }),
                  })
                } catch {
                  return startedParts === 0
                    ? { _tag: 'CaptureExportFailed' }
                    : { _tag: 'CaptureExportUncertain' }
                }
                if (result.kind === 'started') {
                  startedParts += 1
                  continue
                }
                if (result.kind === 'too-large')
                  return startedParts === 0
                    ? { _tag: 'CaptureExportTooLarge' }
                    : { _tag: 'CaptureExportUncertain' }
                if (result.kind === 'unavailable')
                  return startedParts === 0
                    ? { _tag: 'CaptureExportUnavailable' }
                    : { _tag: 'CaptureExportUncertain' }
                return { _tag: 'CaptureExportUncertain' }
              }
              // oxlint-enable no-await-in-loop
              return { _tag: 'CaptureExportStarted', filename }
            } finally {
              await staging.discard(exportId).catch(() => undefined)
            }
          }

          const input = await deps.captureDb.withReadSnapshot(async (read) => {
            const firstPage = await read.conversationPage(conversationId!)
            return firstPage.length === 0
              ? ({ kind: 'empty' } as const)
              : collectConversation(read, firstPage, conversationId!, maxBytes)
          })
          if (input.kind === 'empty') return { _tag: 'CaptureExportEmpty' }
          if (input.kind === 'too-large') return { _tag: 'CaptureExportTooLarge' }
          const tree = buildTree(input.records)[0]
          if (tree === undefined) return { _tag: 'CaptureExportEmpty' }
          return await stage(async () =>
            byteSource(
              kind === 'tree'
                ? asyncFragments(treeJsonFragments(tree, input.byId))
                : markdownFragments(tree, input.byId),
            ),
          )
        } catch {
          return { _tag: 'CaptureExportFailed' }
        }
      }),
    /** Fetched boot calls this after lease inspection. It owns no Blob state. */
    discardStaleStaging: () => staging.discardStale(),
  }
}
