import type { TweetRecord } from './record'
import type { RecentConversation } from './store'

export type CaptureSearchEntry = {
  conversationId: string
  count: number
  lastAt: number
  matched: boolean
  fallbackTweetId: string
}

export type CaptureSearchAcc = {
  needle: string
  byConversation: Map<string, CaptureSearchEntry>
}

export type CaptureSearchReply = {
  total: number
  matches: RecentConversation[]
}

export function startCaptureSearch(query: string): CaptureSearchAcc {
  return { needle: query.trim().toLowerCase(), byConversation: new Map() }
}

export function foldCaptureSearch(acc: CaptureSearchAcc, r: TweetRecord): CaptureSearchAcc {
  const hit = `@${r.author.handle} ${r.text}`.toLowerCase().includes(acc.needle)
  const entry = acc.byConversation.get(r.conversationId)
  if (entry === undefined) {
    acc.byConversation.set(r.conversationId, {
      conversationId: r.conversationId,
      count: 1,
      lastAt: r.capturedAt,
      matched: hit,
      fallbackTweetId: r.tweetId,
    })
    return acc
  }
  entry.count += 1
  entry.lastAt = Math.max(entry.lastAt, r.capturedAt)
  entry.matched ||= hit
  return acc
}

export function pickCaptureMatches(acc: CaptureSearchAcc, limit: number) {
  const matched = [...acc.byConversation.values()].filter((e) => e.matched)
  return {
    total: matched.length,
    picked: matched.toSorted((a, b) => b.lastAt - a.lastAt).slice(0, limit),
  }
}

export function captureSearchRowIds(picked: ReadonlyArray<CaptureSearchEntry>): string[] {
  return [...new Set(picked.flatMap((e) => [e.conversationId, e.fallbackTweetId]))]
}

export function finishCaptureSearch(
  picked: ReadonlyArray<CaptureSearchEntry>,
  records: ReadonlyArray<TweetRecord>,
): RecentConversation[] {
  const byId = new Map(records.map((r) => [r.tweetId, r]))
  return picked.flatMap((e) => {
    const shown = byId.get(e.conversationId) ?? byId.get(e.fallbackTweetId)
    if (shown === undefined) return []
    return [
      {
        conversationId: e.conversationId,
        rootHandle: shown.author.handle,
        rootText: shown.text,
        count: e.count,
        lastAt: e.lastAt,
      },
    ]
  })
}
