import { Schema } from 'effect'
import { TweetRecord } from './record'

/** A conversation thread summarized for the panel's recent list (spec §8). */
export type RecentConversation = {
  conversationId: string
  rootHandle: string
  rootText: string
  count: number
  lastAt: number
}

const RecordsSchema = Schema.Array(TweetRecord)

/** Decode raw persisted input into validated records; corrupt input → `[]`. */
export function decodeRecords(raw: unknown): TweetRecord[] {
  try {
    return [...Schema.decodeUnknownSync(RecordsSchema)(raw)]
  } catch {
    return []
  }
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

/** The `n` newest conversation threads, each surfaced for the recent list (spec §8). */
export function recentConversations(
  records: ReadonlyArray<TweetRecord>,
  n: number,
): RecentConversation[] {
  const byConversation = new Map<string, RecentConversation>()
  for (const r of records) {
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
      continue
    }
    existing.count += 1
    existing.lastAt = Math.max(existing.lastAt, r.capturedAt)
    if (isRoot) {
      existing.rootHandle = r.author.handle
      existing.rootText = r.text
    }
  }
  return [...byConversation.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, n)
}
