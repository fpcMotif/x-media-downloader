/**
 * Clear-seed composition — the pure decision behind `handleDownload`'s
 * clear-on-complete seed: which scopes to clear, whether to seed at all, and
 * which media ids belong to which tweet. Extracted from the inline Effect-gen
 * block in `entrypoints/background.ts` so the sweep-vs-hook scope-widening
 * asymmetry (sweep widens via `clearAllListsOnSave`; the auto-hook does not) is
 * pinned by a test instead of a bare ternary. Behavior-preserving: this module
 * decides WHAT to seed, never WHETHER the invariants it composes (unclearable-id
 * rule, ledger merge/CAS) are correct — those stay owned by `clearer.ts` and
 * `ledger.ts`.
 */
import type { Scope } from './ledger'
import type { Settings, MediaItem } from '../schema'
import type { SaveRequest } from '../download/strategy'
import { isClearableTweetId } from './clearer'
import { hookScopes } from './ledger'

export type ClearSeedVerdict =
  | { readonly decision: 'skip'; readonly reason: 'aria2' | 'clear-off' | 'no-scopes' }
  | {
      readonly decision: 'seed'
      readonly byTweet: Map<string, string[]>
      readonly scopes: Scope[]
      readonly origin: 'sweep' | 'hook'
      readonly unclearableCount: number
    }

/**
 * Which scopes to clear + whether to seed at all, for one download batch.
 * `requests`/`mediaById` come from `handleDownload`'s admission+planning step;
 * `sweep` marks a one-list sweep (vs. the auto-hook); `clearExpect` widens a
 * tweet's expected media set past this batch's own grabs (spec: a For You
 * partial grab must wait for the post's full media set before Truly Complete).
 */
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

  // A sweep is strictly list-scoped: it reads clearAllListsOnSave but never
  // mutates it, and (with it on) widens by the hook's non-notInterested scopes
  // — the auto-hook itself is NOT widened by clearAllListsOnSave, only by its
  // own per-scope toggles. That asymmetry is current behavior, not fixed here.
  const scopes: Scope[] = sweep
    ? settings.clearAllListsOnSave
      ? [...new Set([sweep.scope, ...hookScopes(settings).filter((s) => s !== 'notInterested')])]
      : [sweep.scope]
    : hookScopes(settings)
  const origin: 'sweep' | 'hook' = sweep ? 'sweep' : 'hook'

  if (settings.downloadStrategy === 'aria2') return { decision: 'skip', reason: 'aria2' }
  if (!settings.clearOnSave) return { decision: 'skip', reason: 'clear-off' }
  if (scopes.length === 0) return { decision: 'skip', reason: 'no-scopes' }

  const byTweet = new Map<string, string[]>()
  const unclearable = new Set<string>()
  for (const r of requests) {
    const item = mediaById.get(r.id)
    if (item === undefined) continue
    // The Clear can only LOCATE a post by its numeric /status/ id (findArticle).
    // A tweetId that fails that check (e.g. a quote-card image's media-key
    // fallback, which belongs to a DIFFERENT post) would only defer-then-drop —
    // or worse, wrong-clear on a stray match. Skip it; the download still runs.
    if (!isClearableTweetId(item.postId)) {
      unclearable.add(item.postId)
      continue
    }
    byTweet.set(item.postId, [...(byTweet.get(item.postId) ?? []), r.id])
  }

  // For You: widen `expected` to the post's FULL media set so the clear waits
  // for every photo — a 1-of-4 grab must never mark the post Truly Complete and
  // "Not interested"-hide it, losing the other three. Only widens tweets already
  // in this batch; a tweetId not yet in byTweet stays untouched.
  for (const e of clearExpect ?? []) {
    const cur = byTweet.get(e.tweetId)
    if (cur !== undefined) byTweet.set(e.tweetId, [...new Set([...cur, ...e.ids])])
  }

  return { decision: 'seed', byTweet, scopes, origin, unclearableCount: unclearable.size }
}
