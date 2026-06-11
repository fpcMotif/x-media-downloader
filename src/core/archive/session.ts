import type { ArchiveSource } from './capture'

/**
 * Archive-session bookkeeping (ADR-0010): which tweets a save job is waiting
 * on, which units (media + record downloads) have settled, and whether a saved
 * tweet's bookmark/like is still pending cleanup. Pure + idempotent so that
 * duplicate `downloads.onChanged` deltas can never double-count.
 */

export type CleanupState = 'kept' | 'pending' | 'removed' | 'failed'

export interface SessionTweet {
  readonly tweetId: string
  readonly source: ArchiveSource
  /** Request ids (media + record) this tweet's "saved" verdict waits on. */
  readonly unitIds: ReadonlyArray<string>
  readonly savedIds: ReadonlyArray<string>
  readonly failedIds: ReadonlyArray<string>
  /** Units the ledger already covered (counted, never downloaded again). */
  readonly skipped: number
  readonly cleanup: CleanupState
}

export interface ArchiveSession {
  readonly id: string
  readonly source: ArchiveSource
  readonly startedAt: number
  readonly tweets: ReadonlyArray<SessionTweet>
}

export interface SessionSummary {
  readonly source: ArchiveSource
  readonly startedAt: number
  readonly tweets: number
  readonly saved: number
  readonly failed: number
  readonly skipped: number
  readonly removed: number
  readonly removeFailed: number
  readonly done: boolean
}

export function startSession(opts: {
  readonly id: string
  readonly source: ArchiveSource
  readonly startedAt: number
  readonly removeAfterSave: boolean
  readonly tweets: ReadonlyArray<{
    readonly tweetId: string
    readonly unitIds: ReadonlyArray<string>
    readonly skipped: number
  }>
}): ArchiveSession {
  return {
    id: opts.id,
    source: opts.source,
    startedAt: opts.startedAt,
    tweets: opts.tweets.map((t) => ({
      tweetId: t.tweetId,
      source: opts.source,
      unitIds: t.unitIds,
      savedIds: [],
      failedIds: [],
      skipped: t.skipped,
      cleanup: opts.removeAfterSave ? 'pending' : 'kept',
    })),
  }
}

/**
 * Record one unit's terminal outcome. Idempotent per unit id: a unit already
 * settled is left untouched, and unit ids absent from the session are ignored.
 */
export function recordUnitOutcome(s: ArchiveSession, unitId: string, ok: boolean): ArchiveSession {
  return {
    ...s,
    tweets: s.tweets.map((t) => {
      if (!t.unitIds.includes(unitId)) return t
      if (t.savedIds.includes(unitId) || t.failedIds.includes(unitId)) return t
      return ok
        ? { ...t, savedIds: [...t.savedIds, unitId] }
        : { ...t, failedIds: [...t.failedIds, unitId] }
    }),
  }
}

/** A tweet is saved when every unit settled and none failed (zero units ⇒ saved). */
export function isTweetSaved(t: SessionTweet): boolean {
  return t.failedIds.length === 0 && t.savedIds.length === t.unitIds.length
}

/** Saved tweets still awaiting bookmark/like removal. */
export function cleanupCandidates(s: ArchiveSession): ReadonlyArray<SessionTweet> {
  return s.tweets.filter((t) => t.cleanup === 'pending' && isTweetSaved(t))
}

/** Mark a tweet's cleanup result; only a `pending` tweet transitions. */
export function markCleanup(s: ArchiveSession, tweetId: string, ok: boolean): ArchiveSession {
  return {
    ...s,
    tweets: s.tweets.map((t) =>
      t.tweetId === tweetId && t.cleanup === 'pending'
        ? { ...t, cleanup: ok ? 'removed' : 'failed' }
        : t,
    ),
  }
}

export function summarize(s: ArchiveSession): SessionSummary {
  let saved = 0
  let failed = 0
  let skipped = 0
  let removed = 0
  let removeFailed = 0
  let allSettled = true
  let pendingSaved = false
  for (const t of s.tweets) {
    saved += t.savedIds.length
    failed += t.failedIds.length
    skipped += t.skipped
    if (t.cleanup === 'removed') removed += 1
    if (t.cleanup === 'failed') removeFailed += 1
    if (t.savedIds.length + t.failedIds.length < t.unitIds.length) allSettled = false
    if (t.cleanup === 'pending' && isTweetSaved(t)) pendingSaved = true
  }
  return {
    source: s.source,
    startedAt: s.startedAt,
    tweets: s.tweets.length,
    saved,
    failed,
    skipped,
    removed,
    removeFailed,
    done: allSettled && !pendingSaved,
  }
}
