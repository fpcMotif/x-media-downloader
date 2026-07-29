/**
 * Clear-seed composition — the pure decision behind `handleDownload`'s
 * clear-on-complete seed: which scopes to clear, whether to seed at all, and
 * which media ids belong to which tweet. Extracted from the inline Effect-gen
 * block in `entrypoints/background.ts` so the sweep-vs-hook scope-widening
 * asymmetry (sweep widens via `clearAllListsOnSave`; the auto-hook does not) is
 * pinned by a test instead of a bare ternary. Behavior-preserving: this module
 * decides WHAT to seed, never WHETHER its inputs are valid or persistence is
 * correct. Tweet identity stays owned by `schema/tweet.ts`; merge/CAS stays
 * owned by `ledger.ts`.
 */
import type { Scope } from './ledger'
import type { Settings, MediaItem } from '../schema'
import { isTweetSnowflake } from '../schema/tweet'
import type { SaveRequest } from '../download/strategy'
import { hookScopes } from './ledger'

export type ClearSeedVerdict =
  | {
      readonly decision: 'skip'
      readonly reason: 'aria2' | 'clear-off' | 'no-scopes' | 'no-clearable-tweet'
    }
  | {
      readonly decision: 'seed'
      /** Full prerequisite set, including expected requests not started by this batch. */
      readonly byTweet: Map<string, string[]>
      /** Requests this batch will actually start. Only these restart prior terminal state. */
      readonly startingByTweet: Map<string, string[]>
      /** Explicit sweep intent. Current automatic policy cannot revoke it. */
      readonly manualScopes: Scope[]
      /** Scopes still governed by their per-scope setting at Clear time. */
      readonly automaticScopes: Scope[]
      /** Automatic sweep widening; also requires clearAllListsOnSave at Clear time. */
      readonly crossListAutomaticScopes: Scope[]
      /** Compatibility projection for tracing and callers that only need the union. */
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
    readonly requestIds: ReadonlyArray<string>
  }>
  readonly settings: Settings
}): ClearSeedVerdict {
  const { requests, mediaById, sweep, clearExpect, settings } = input

  // A sweep is strictly list-scoped: it reads clearAllListsOnSave but never
  // mutates it, and (with it on) widens by the hook's non-notInterested scopes
  // — the auto-hook itself is NOT widened by clearAllListsOnSave, only by its
  // own per-scope toggles. That asymmetry is current behavior, not fixed here.
  const hook = hookScopes(settings)
  const manualScopes: Scope[] = sweep ? [sweep.scope] : []
  const crossListAutomaticScopes: Scope[] =
    sweep && settings.clearAllListsOnSave ? hook.filter((scope) => scope !== 'notInterested') : []
  const automaticScopes: Scope[] = sweep ? crossListAutomaticScopes : hook
  const scopes: Scope[] = [...new Set([...manualScopes, ...automaticScopes])]
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
    if (!isTweetSnowflake(item.postId)) {
      unclearable.add(item.postId)
      continue
    }
    byTweet.set(item.postId, [...(byTweet.get(item.postId) ?? []), r.id])
  }
  const startingByTweet = new Map(
    [...byTweet].map(([tweetId, requestIds]) => [tweetId, [...requestIds]]),
  )

  // For You: widen `expected` to the post's FULL media set so the clear waits
  // for every photo — a 1-of-4 grab must never mark the post Truly Complete and
  // "Not interested"-hide it, losing the other three. Only widens tweets already
  // in this batch; a tweetId not yet in byTweet stays untouched.
  for (const e of clearExpect ?? []) {
    const cur = byTweet.get(e.tweetId)
    if (cur !== undefined) byTweet.set(e.tweetId, [...new Set([...cur, ...e.requestIds])])
  }

  if (byTweet.size === 0) return { decision: 'skip', reason: 'no-clearable-tweet' }

  return {
    decision: 'seed',
    byTweet,
    startingByTweet,
    manualScopes,
    automaticScopes,
    crossListAutomaticScopes,
    scopes,
    origin,
    unclearableCount: unclearable.size,
  }
}
