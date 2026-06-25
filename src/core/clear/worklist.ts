/**
 * Durable sweep worklist — the persistent "flag" behind the one-by-one
 * download+clear sweep. A pure projection of each swept tweet's lifecycle, keyed
 * by tweetId, so the sweep survives scrolling, popup close, and SW recycle, and
 * never re-touches a post it already cleared.
 *
 * Lifecycle: `queued` (enqueued for download) → `downloaded` (bytes verified by
 * the background's Settle gate) → `cleared` (un-bookmarked/un-liked and the flip
 * verified) | `failed` (download permanently failed → never clears). `cleared`
 * is terminal — the worklist never regresses out of it, which is what makes a
 * re-run skip already-handled posts.
 *
 * Pure + storage-agnostic on purpose: the background is the single writer and
 * backs this with `storage.local` today, but it is meant to move to Convex sync
 * as the state store later — that swap should be a backend change at the I/O
 * boundary, not a rewrite of this logic. Every function returns the SAME
 * reference when nothing changes, so callers can skip a write cheaply.
 */
import { Schema, Option } from 'effect'
import { ClearScope } from '../schema'

export const SweepState = Schema.Literals(['queued', 'downloaded', 'cleared', 'failed'])
export type SweepState = typeof SweepState.Type

export const SweepEntry = Schema.Struct({
  tweetId: Schema.String,
  scope: ClearScope,
  state: SweepState,
  at: Schema.Number,
})
export type SweepEntry = typeof SweepEntry.Type

export const SweepWorklist = Schema.Record(Schema.String, SweepEntry)
export type SweepWorklist = typeof SweepWorklist.Type

export const emptyWorklist: SweepWorklist = {}

const decodeEntry = Schema.decodeUnknownOption(SweepEntry)

/** Worklist key: scope-qualified so the SAME tweet swept under BOTH list scopes
 *  (a post that is both bookmarked AND liked) keeps an independent lifecycle per
 *  scope. Keying by bare tweetId conflated them — clearing it in one scope made a
 *  sweep of the OTHER scope skip it as already-done, so it was never un-{liked}. */
export const keyFor = (scope: ClearScope, tweetId: string): string => `${scope}:${tweetId}`

/** Tolerant decode of persisted JSON → worklist. Entry-by-entry: a single corrupt
 *  entry is dropped, never the whole map — so one bad record can't lose the
 *  durable progress cache. Re-keys by `(scope, tweetId)` from the entry itself, so
 *  it both normalizes the composite key and migrates any pre-scope bare-tweetId
 *  data for free. (Even a full reset would be safe — a cleared post is no longer a
 *  member on the page, so it can't be re-clicked — but per-entry resilience keeps
 *  the skip-cache intact across an isolated corruption.) */
export const decodeWorklist = (raw: unknown): SweepWorklist => {
  if (raw === null || typeof raw !== 'object') return emptyWorklist
  const out: Record<string, SweepEntry> = {}
  for (const value of Object.values(raw as Record<string, unknown>)) {
    const decoded = decodeEntry(value)
    if (Option.isSome(decoded))
      out[keyFor(decoded.value.scope, decoded.value.tweetId)] = decoded.value
  }
  return out
}

/** Has this tweet already been cleared IN THIS SCOPE? The ONLY state a re-run must
 *  skip — and only for the same list, so the other scope still gets swept. */
export const isCleared = (wl: SweepWorklist, tweetId: string, scope: ClearScope): boolean =>
  wl[keyFor(scope, tweetId)]?.state === 'cleared'

/** Take responsibility for a (tweet, scope) at `queued`, unless that scope is
 *  already `cleared` (terminal — never re-queue a list we removed it from).
 *  Re-queues `failed`/stale entries so a re-run retries them. */
export const enqueue = (
  wl: SweepWorklist,
  tweetId: string,
  scope: ClearScope,
  at: number,
): SweepWorklist => {
  const key = keyFor(scope, tweetId)
  if (wl[key]?.state === 'cleared') return wl
  return { ...wl, [key]: { tweetId, scope, state: 'queued', at } }
}

/** Take responsibility for multiple (tweet, scope) at `queued`, unless that scope is
 *  already `cleared`. Batches the object allocations to avoid O(N^2) overhead
 *  when enqueuing many posts at once. */
export const enqueueBatch = (
  wl: SweepWorklist,
  tweetIds: ReadonlyArray<string>,
  scope: ClearScope,
  at: number,
): SweepWorklist => {
  let next: Record<string, SweepEntry> = wl
  let mutated = false
  for (const tweetId of tweetIds) {
    const key = keyFor(scope, tweetId)
    if (wl[key]?.state === 'cleared') continue
    if (!mutated) {
      next = { ...wl }
      mutated = true
    }
    next[key] = { tweetId, scope, state: 'queued', at }
  }
  return next
}

/** Advance an EXISTING (tweet, scope) entry's state. No-op when that scope isn't
 *  tracked (so a normal, non-sweep download never creates a worklist entry) or is
 *  already `cleared` (terminal). Returns the same reference when nothing changes. */
export const markState = (
  wl: SweepWorklist,
  tweetId: string,
  scope: ClearScope,
  state: SweepState,
  at: number,
): SweepWorklist => {
  const key = keyFor(scope, tweetId)
  const existing = wl[key]
  if (existing === undefined || existing.state === 'cleared' || existing.state === state) return wl
  return { ...wl, [key]: { ...existing, state, at } }
}

/** Counts per state, for the popup's status line. */
export const summarize = (wl: SweepWorklist): Record<SweepState, number> => {
  const counts: Record<SweepState, number> = { queued: 0, downloaded: 0, cleared: 0, failed: 0 }
  for (const e of Object.values(wl)) counts[e.state] += 1
  return counts
}

/** Bound the map: the `cleared`/`failed` history grows without limit otherwise.
 *  NEVER evict an in-flight entry (`queued`/`downloaded`) — losing its durable
 *  state mid-sweep is the one harmful eviction; cap only TERMINAL entries (oldest
 *  first), leaving room for all active ones. Same reference when within bounds. */
export const capWorklist = (wl: SweepWorklist, max: number): SweepWorklist => {
  const entries = Object.values(wl)
  if (entries.length <= max) return wl
  const active = entries.filter((e) => e.state === 'queued' || e.state === 'downloaded')
  const terminal = entries.filter((e) => e.state === 'cleared' || e.state === 'failed')
  const room = Math.max(0, max - active.length)
  const kept = [...active, ...terminal.toSorted((a, b) => b.at - a.at).slice(0, room)]
  // Re-key by the scope-qualified key (NOT bare tweetId) — else a cap would both
  // drop the scope qualification and collide two scopes that share a tweetId.
  return Object.fromEntries(kept.map((e) => [keyFor(e.scope, e.tweetId), e]))
}
