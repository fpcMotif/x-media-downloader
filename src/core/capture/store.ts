import { Schema } from 'effect'
import { MAX_CAPTURE_SUMMARY_ROOT_TEXT_LENGTH } from './contract'
import { TweetRecord } from './record'
import { incomingCaptureWins } from './revision'

/** A conversation thread summarized for the panel's recent list (spec §8). */
export type RecentConversation = {
  conversationId: string
  rootHandle: string
  rootText: string
  count: number
  lastAt: number
}

const decodeRecord = Schema.decodeUnknownSync(TweetRecord)

/** Decode raw persisted input into validated records; skip corrupt rows. */
export function decodeRecords(raw: unknown): TweetRecord[] {
  if (!Array.isArray(raw)) return []
  const records: TweetRecord[] = []
  for (const row of raw) {
    try {
      records.push(decodeRecord(row))
    } catch {
      // A stale/corrupt IndexedDB row must not discard its healthy neighbours.
    }
  }
  return records
}

/**
 * Pick the winner between an existing and incoming snapshot (spec §6.4). Keep
 * `incoming` iff its `sourceRank` is higher, or equal rank with a `capturedAt`
 * no older than `existing` — so a later thin sighting never clobbers a rich one.
 * The winner replaces the loser whole (records are self-consistent snapshots).
 */
export function mergeRecord(existing: TweetRecord | undefined, incoming: TweetRecord): TweetRecord {
  if (existing === undefined) return incoming
  return incomingCaptureWins(existing, incoming) ? incoming : existing
}

/** All records belonging to one conversation thread. */
export function selectConversation(
  records: ReadonlyArray<TweetRecord>,
  conversationId: string,
): TweetRecord[] {
  return records.filter((r) => r.conversationId === conversationId)
}

/** Distinct tweet and conversation counts over the collection (spec §8). */
export function summarize(records: ReadonlyArray<TweetRecord>): {
  tweets: number
  conversations: number
} {
  const tweets = new Set<string>()
  const conversations = new Set<string>()
  for (const r of records) {
    tweets.add(r.tweetId)
    conversations.add(r.conversationId)
  }
  return { tweets: tweets.size, conversations: conversations.size }
}

/** Fold ONE record into the by-conversation aggregate — the loop body of
 *  {@link recentConversations}, extracted so a cursor-driven caller can stream
 *  the store one record at a time instead of materializing it whole. */
function foldConversation(byConversation: Map<string, RecentConversation>, r: TweetRecord): void {
  const existing = byConversation.get(r.conversationId)
  const isRoot = r.tweetId === r.conversationId
  if (existing === undefined) {
    byConversation.set(r.conversationId, {
      conversationId: r.conversationId,
      rootHandle: r.author.handle,
      rootText: r.text.slice(0, MAX_CAPTURE_SUMMARY_ROOT_TEXT_LENGTH),
      count: 1,
      lastAt: r.capturedAt,
    })
    return
  }
  existing.count += 1
  existing.lastAt = Math.max(existing.lastAt, r.capturedAt)
  if (isRoot) {
    existing.rootHandle = r.author.handle
    existing.rootText = r.text.slice(0, MAX_CAPTURE_SUMMARY_ROOT_TEXT_LENGTH)
  }
}

/** Newest-first threads, capped at `n`. */
function newestFirst(byConversation: Map<string, RecentConversation>, n: number) {
  return [...byConversation.values()].toSorted((a, b) => b.lastAt - a.lastAt).slice(0, n)
}

/** The `n` newest conversation threads, each surfaced for the recent list (spec §8). */
export function recentConversations(
  records: ReadonlyArray<TweetRecord>,
  n: number,
): RecentConversation[] {
  const byConversation = new Map<string, RecentConversation>()
  for (const r of records) foldConversation(byConversation, r)
  return newestFirst(byConversation, n)
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

/** The `CaptureSummaryRequest` reply: counts + the `n` newest threads. */
export function finishCaptureSummary(
  acc: CaptureSummaryAcc,
  n: number,
): { tweets: number; conversations: number; recent: RecentConversation[] } {
  return {
    tweets: acc.tweets,
    conversations: acc.byConversation.size,
    recent: newestFirst(acc.byConversation, n),
  }
}
