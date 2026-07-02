/**
 * Local-first "is this tweet already saved?" index for the timeline badge.
 *
 * The badge must answer for many ids on every scroll, so the source of truth is
 * an in-memory `Set` seeded from local history (Feature 003) and lit up the
 * instant a download completes (`markSaved`) — zero round-trips for the common
 * case. Convex is the *backstop*: it's consulted only for ids the client has
 * never seen, its hits are unioned into the Set, and a "not saved" answer is
 * cached as a timestamped miss so a cold timeline doesn't hammer the backend.
 * Offline degrades to the local subset and never throws (cloud sync is
 * fire-and-forget, ADR-0009: the badge must never block on the network).
 *
 * Pure and deterministic under an injected clock; no Effect, no direct I/O.
 */

/** Returns the subset of `tweetIds` that the backend reports as already saved. */
export type QueryConvex = (tweetIds: string[]) => Promise<string[]>

export interface SavedIndex {
  /** Prime the Set from local history; cheap to call repeatedly at boot. */
  readonly seed: (tweetIds: Iterable<string>) => void
  /** A download just completed: this id is saved as of now, no query needed. */
  readonly markSaved: (tweetId: string) => void
  /** Sync, memory-only: the subset of `tweetIds` known saved right now
   *  (input order, deduped). The instant half of a sweep answer. */
  readonly known: (tweetIds: string[]) => string[]
  /**
   * Consult the backstop for the genuine unknowns among `tweetIds` (known ids,
   * fresh misses, and ids already in flight are never re-queried — a concurrent
   * refresh for the same id JOINS the in-flight query instead) and cache the
   * answer. Resolves to the ids that BECAME known-saved during this call — the
   * delta a caller can push to the overlay. Never rejects: a backstop failure
   * yields [] and leaves the ids re-queryable.
   */
  readonly refresh: (tweetIds: string[], queryConvex: QueryConvex) => Promise<string[]>
  /**
   * Resolve which of `tweetIds` are saved. Known ids answer from memory;
   * genuine unknowns (not a fresh miss) are batched into one `queryConvex`
   * call. Hits are cached; still-missing ids are stamped so they aren't
   * re-queried within the TTL. On rejection, returns just the known subset.
   * Result preserves input order and is deduped.
   */
  readonly resolve: (tweetIds: string[], queryConvex: QueryConvex) => Promise<string[]>
}

const DEFAULT_MISS_TTL_MS = 5 * 60_000

export function makeSavedIndex(opts: { now?: () => number; missTtlMs?: number } = {}): SavedIndex {
  const now = opts.now ?? (() => Date.now())
  const missTtlMs = opts.missTtlMs ?? DEFAULT_MISS_TTL_MS

  /** Ids known to be saved (local history + markSaved + Convex hits). */
  const saved = new Set<string>()
  /** id → timestamp of the last "Convex said not saved"; trusted within the TTL. */
  const misses = new Map<string, number>()
  /** id → the in-flight backstop query covering it; a concurrent refresh joins it. */
  const inflight = new Map<string, Promise<void>>()

  const seed: SavedIndex['seed'] = (tweetIds) => {
    for (const id of tweetIds) {
      saved.add(id)
      misses.delete(id)
    }
  }

  const markSaved: SavedIndex['markSaved'] = (tweetId) => {
    saved.add(tweetId)
    misses.delete(tweetId)
  }

  /** Every input id that's now known-saved, in input order, deduped. */
  const known: SavedIndex['known'] = (tweetIds) => {
    const out: string[] = []
    const emitted = new Set<string>()
    for (const id of tweetIds) {
      if (saved.has(id) && !emitted.has(id)) {
        emitted.add(id)
        out.push(id)
      }
    }
    return out
  }

  const refresh: SavedIndex['refresh'] = async (tweetIds, queryConvex) => {
    const at = now()
    const preKnown = new Set(tweetIds.filter((id) => saved.has(id)))

    // The ids worth asking Convex about: not already known-saved, not a
    // still-fresh miss, and not already being asked (join that flight instead).
    // Deduped so a repeated id is queried at most once.
    const toQuery: string[] = []
    const queued = new Set<string>()
    const joined = new Set<Promise<void>>()
    for (const id of tweetIds) {
      if (saved.has(id) || queued.has(id)) continue
      const missedAt = misses.get(id)
      if (missedAt !== undefined && at - missedAt < missTtlMs) continue
      const pending = inflight.get(id)
      if (pending !== undefined) {
        joined.add(pending)
        continue
      }
      queued.add(id)
      toQuery.push(id)
    }

    if (toQuery.length > 0) {
      const flight = (async () => {
        try {
          const hits = new Set(await queryConvex(toQuery))
          for (const id of toQuery) {
            if (hits.has(id)) {
              saved.add(id)
              misses.delete(id)
            } else if (!saved.has(id)) {
              // Guarded: a markSaved that landed mid-flight beats a stale miss.
              misses.set(id, at)
            }
          }
        } catch {
          // Offline / backend down: degrade to the local subset. Don't stamp a
          // miss — we never learned the answer, so a later refresh should retry.
        } finally {
          // The flight owns these entries for its whole lifetime (a joiner never
          // replaces them, a new flight only starts for ids NOT in the map).
          for (const id of toQuery) inflight.delete(id)
        }
      })()
      for (const id of toQuery) inflight.set(id, flight)
      joined.add(flight)
    }

    await Promise.all(joined)

    // The delta: input ids now known-saved that weren't when the call began.
    const out: string[] = []
    const emitted = new Set<string>()
    for (const id of tweetIds) {
      if (saved.has(id) && !preKnown.has(id) && !emitted.has(id)) {
        emitted.add(id)
        out.push(id)
      }
    }
    return out
  }

  const resolve: SavedIndex['resolve'] = async (tweetIds, queryConvex) => {
    await refresh(tweetIds, queryConvex)
    return known(tweetIds)
  }

  return { seed, markSaved, known, refresh, resolve }
}
