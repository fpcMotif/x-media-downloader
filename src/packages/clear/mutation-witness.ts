/**
 * Mutation witness — a bounded in-page log of the X GraphQL bookmark/like
 * mutations the MAIN-world tee actually observed (`inject.content.ts`'s
 * `xmd:mutation-response`), turned into a per-tweet release VERDICT. This is
 * the authoritative signal `tweet-clear.ts` and the manual sweep now consult
 * ahead of the DOM-flip heuristic: the DOM only ever infers that a control
 * disappeared or a row detached, while this module answers what the SERVER
 * actually said about the one mutation that matters for a given scope.
 *
 * Pure and side-effect-free — no `chrome.*`, no DOM — so it is trivially unit
 * tested and safe to construct once per page session.
 */
import type { ReleaseMutationOp } from '@/packages/schema'
import type { MembershipScope } from './clearer'

/** One observed mutation, already shape-validated by the caller (mirrors the
 *  `ReleaseMutationEvent` sent to the background, minus the wire `_tag`). */
export interface MutationWitnessEvent {
  readonly tweetId: string
  readonly op: ReleaseMutationOp
  readonly status: number
  readonly error: boolean
  readonly t: number
}

export interface MutationWitness {
  /** Record one observed mutation. Never throws. */
  readonly record: (ev: MutationWitnessEvent) => void
  /** The server verdict for `tweetId` leaving `scope`, as of any matching
   *  mutation observed at or after `sinceT` (the click time) — 'ok' the
   *  confirming op answered 200 with no error signal, 'error' it answered
   *  non-200 or carried an error signal, 'none' nothing matching has been
   *  observed yet (defer to the DOM heuristic). */
  readonly outcome: (
    tweetId: string,
    scope: MembershipScope,
    sinceT: number,
  ) => 'ok' | 'error' | 'none'
}

/** The ONE mutation op that confirms leaving each membership scope.
 *  `CreateBookmark`/`FavoriteTweet` are the RE-ADD ops — evidence for a
 *  different diagnosis (spec #59 H5), never a release outcome — so they are
 *  simply absent from this map and `outcome` can never match them. */
const CONFIRMING_OP = {
  like: 'UnfavoriteTweet',
  bookmark: 'DeleteBookmark',
} satisfies Record<MembershipScope, ReleaseMutationOp>

const DEFAULT_CAPACITY = 256

/** `now`/`capacity` are injected for parity with this package's other ports
 *  (fake-clock testability, matching `TweetClearerDeps['clock']`) even though
 *  `record` takes an explicit `t` per event — `now` is reserved for callers
 *  that want a witness-local clock rather than plumbing `Date.now()` at every
 *  call site. */
export function makeMutationWitness(opts?: {
  readonly now?: () => number
  readonly capacity?: number
}): MutationWitness {
  const capacity = opts?.capacity ?? DEFAULT_CAPACITY
  // Keyed by `${tweetId}:${op}` — only the NEWEST event per (tweet, op) is
  // ever read by `outcome`, so overwriting on record is both the ring-buffer
  // eviction unit AND the "newest matching event wins" rule in one structure.
  // A `Map` re-inserted key (delete-then-set) moves to the END of iteration
  // order, so the FIRST key is always the oldest surviving entry — the one
  // `record` evicts once size exceeds `capacity`.
  const events = new Map<string, MutationWitnessEvent>()

  function record(ev: MutationWitnessEvent): void {
    const key = `${ev.tweetId}:${ev.op}`
    events.delete(key)
    events.set(key, ev)
    if (events.size > capacity) {
      const oldest = events.keys().next().value
      if (oldest !== undefined) events.delete(oldest)
    }
  }

  function outcome(
    tweetId: string,
    scope: MembershipScope,
    sinceT: number,
  ): 'ok' | 'error' | 'none' {
    const ev = events.get(`${tweetId}:${CONFIRMING_OP[scope]}`)
    if (ev === undefined || ev.t < sinceT) return 'none'
    return ev.status === 200 && !ev.error ? 'ok' : 'error'
  }

  return { record, outcome }
}
