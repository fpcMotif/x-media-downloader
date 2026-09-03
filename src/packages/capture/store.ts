import { TweetRecord } from './record'

/** A conversation thread summarized for the panel's recent list (spec §8). */
export type RecentConversation = {
  conversationId: string
  rootHandle: string
  rootText: string
  count: number
  lastAt: number
}

/** The `CaptureSummaryRequest` reply: counts + the `n` newest threads. */
export type CaptureSummaryReply = {
  tweets: number
  conversations: number
  recent: RecentConversation[]
}

/**
 * Pick the winner between an existing and incoming snapshot (spec §6.4). Keep
 * `incoming` iff its `sourceRank` is higher, or equal rank with a `capturedAt`
 * no older than `existing` — so a later thin sighting never clobbers a rich one.
 * The winner replaces the loser whole (records are self-consistent snapshots).
 */
export function mergeRecord(existing: TweetRecord | undefined, incoming: TweetRecord): TweetRecord {
  if (existing === undefined) return incoming
  if (incoming.sourceRank > existing.sourceRank) return incoming
  if (incoming.sourceRank === existing.sourceRank && incoming.capturedAt >= existing.capturedAt) {
    return incoming
  }
  return existing
}

/** All records belonging to one conversation thread. */
export function selectConversation(
  records: ReadonlyArray<TweetRecord>,
  conversationId: string,
): TweetRecord[] {
  return records.filter((r) => r.conversationId === conversationId)
}

/** Fold ONE record into the by-conversation aggregate — the loop body of
 *  {@link foldCaptureSummary}, extracted so a cursor-driven caller can stream
 *  the store one record at a time instead of materializing it whole. */
function foldConversation(byConversation: Map<string, RecentConversation>, r: TweetRecord): void {
  const existing = byConversation.get(r.conversationId)
  const isRoot = r.tweetId === r.conversationId
  if (existing === undefined) {
    byConversation.set(r.conversationId, {
      conversationId: r.conversationId,
      rootHandle: r.author.handle,
      rootText: r.text,
      count: 1,
      lastAt: r.capturedAt,
    })
    return
  }
  existing.count += 1
  existing.lastAt = Math.max(existing.lastAt, r.capturedAt)
  if (isRoot) {
    existing.rootHandle = r.author.handle
    existing.rootText = r.text
  }
}

/** Newest-first threads, capped at `n`. */
function newestFirst(byConversation: Map<string, RecentConversation>, n: number) {
  return [...byConversation.values()].toSorted((a, b) => b.lastAt - a.lastAt).slice(0, n)
}

/**
 * Streaming accumulator for the panel summary (spec §8): the distinct-tweet
 * count plus the by-conversation aggregate, foldable one record at a time so
 * the popup's `CaptureSummaryRequest` never materializes the whole harvest in
 * SW memory. `tweets` is a plain count — the capture store's keyPath makes its
 * records unique by tweetId; do not fold an array that can carry duplicates.
 */
export type CaptureSummaryAcc = {
  tweets: number
  byConversation: Map<string, RecentConversation>
}

export const emptyCaptureSummary = (): CaptureSummaryAcc => ({
  tweets: 0,
  byConversation: new Map(),
})

export function foldCaptureSummary(acc: CaptureSummaryAcc, r: TweetRecord): CaptureSummaryAcc {
  acc.tweets += 1
  foldConversation(acc.byConversation, r)
  return acc
}

export function finishCaptureSummary(acc: CaptureSummaryAcc, n: number) {
  return {
    tweets: acc.tweets,
    conversations: acc.byConversation.size,
    recent: newestFirst(acc.byConversation, n),
  } satisfies CaptureSummaryReply
}
