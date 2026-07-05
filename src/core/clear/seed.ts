/**
 * Clear-seed composition — the pure decision that turns one download batch into
 * a Completion Ledger seed (or a reasoned skip). Extracted verbatim from
 * `handleDownload` in `src/entrypoints/background.ts`, where it was inline in an
 * Effect-gen block that also mutated live background state (`clearOriginTab`,
 * `clearCoordinator`) — un-unit-testable by construction. Here it is pure data
 * in, pure data out: no Effect, no I/O, no `chrome.*`.
 *
 * The one invariant worth calling out because it already produced a real
 * surprise (2026-06-24 audit): a SWEEP seed widens its clear scopes via
 * `settings.clearAllListsOnSave` (unioning in the hook's non-`notInterested`
 * scopes, since a sweep is strictly list-scoped and must never touch the For You
 * feed); the auto-HOOK path never widens — it always seeds exactly
 * `hookScopes(settings)`. This asymmetry is REPRODUCED faithfully here and
 * pinned by `seed.test.ts` as CURRENT behavior, not fixed — changing that policy
 * is a separate product decision this module deliberately does not make.
 */
import type { Scope } from './ledger'
import { hookScopes } from './ledger'
import type { Settings, MediaItem } from '../schema'
import type { SaveRequest } from '../download/strategy'
import { isClearableTweetId } from './clearer'

/** The clear-seed decision for one download batch: either a reasoned skip (why
 *  nothing was seeded) or a seed ready for `ClearCoordinator.seedClearLedger`.
 *  `unclearableCount` annotates a SUCCESSFUL seed — the unclearable subset is
 *  simply excluded, never a reason to skip the rest of the batch. */
export type ClearSeedVerdict =
  | { readonly decision: 'skip'; readonly reason: 'aria2' | 'clear-off' | 'no-scopes' }
  | {
      readonly decision: 'seed'
      readonly byTweet: Map<string, string[]>
      readonly scopes: Scope[]
      readonly origin: 'sweep' | 'hook'
      readonly unclearableCount: number
    }

/** Compose the clear-seed verdict for a download batch. Behavior-preserving
 *  extraction of `handleDownload`'s inline clear-seed block — reproduces its
 *  scope selection, skip checks (aria2 / clear-off / no-scopes, first match
 *  wins), quote-card-id filtering (`isClearableTweetId`), and `clearExpect`
 *  widening exactly. */
export function planClearSeed(input: {
  readonly requests: ReadonlyArray<SaveRequest>
  readonly mediaById: ReadonlyMap<string, MediaItem>
  readonly sweep?: { readonly scope: Scope }
  readonly clearExpect?: ReadonlyArray<{
    readonly tweetId: string
    readonly ids: ReadonlyArray<string>
  }>
  readonly settings: Settings
}): ClearSeedVerdict {
  const { requests, mediaById, sweep, clearExpect, settings } = input

  // A sweep is strictly list-scoped: it must claim ONLY the scope(s) explicitly
  // swept, so `sweep.scope` is unconditionally included. Widening is opt-in via
  // `clearAllListsOnSave` and NEVER pulls in `notInterested` (that scope is
  // For-You-only and a sweep never runs there). The hook path has no widening
  // step at all — it seeds exactly the per-scope toggles.
  const clearScopes: Scope[] = sweep
    ? settings.clearAllListsOnSave
      ? [...new Set([sweep.scope, ...hookScopes(settings).filter((s) => s !== 'notInterested')])]
      : [sweep.scope]
    : hookScopes(settings)
  const origin: 'sweep' | 'hook' = sweep ? 'sweep' : 'hook'

  if (settings.downloadStrategy === 'aria2') return { decision: 'skip', reason: 'aria2' }
  if (!settings.clearOnSave) return { decision: 'skip', reason: 'clear-off' }
  // Unreachable via the sweep path: `sweep.scope` is always included above, so
  // `clearScopes` can never be empty when `sweep` is given. Only the hook path
  // (all three per-scope toggles off) can land here.
  if (clearScopes.length === 0) return { decision: 'skip', reason: 'no-scopes' }

  const byTweet = new Map<string, string[]>()
  const unclearable = new Set<string>()
  for (const r of requests) {
    const item = mediaById.get(r.id)
    if (item === undefined) continue
    // The Clear can only LOCATE a post by its numeric /status/ id. A non-numeric
    // tweetId (e.g. the media-key fallback for a quote-card image, whose id
    // belongs to a DIFFERENT post) would defer-then-drop and silently leave the
    // post in its lists. Skip it — downloads still run off `requests`, not
    // `byTweet` — without dropping any OTHER, clearable tweet in this batch.
    if (!isClearableTweetId(item.tweetId)) {
      unclearable.add(item.tweetId)
      continue
    }
    byTweet.set(item.tweetId, [...(byTweet.get(item.tweetId) ?? []), r.id])
  }

  // For You: widen `expected` to the post's FULL media set so the clear waits
  // for every photo — a 1-of-4 grab must never mark the post Truly Complete and
  // "Not interested"-hide it, losing the other three. A no-op for any tweetId
  // not already in `byTweet` (filtered out above, or simply not in this batch).
  for (const e of clearExpect ?? []) {
    const cur = byTweet.get(e.tweetId)
    if (cur !== undefined) byTweet.set(e.tweetId, [...new Set([...cur, ...e.ids])])
  }

  return {
    decision: 'seed',
    byTweet,
    scopes: clearScopes,
    origin,
    unclearableCount: unclearable.size,
  }
}
