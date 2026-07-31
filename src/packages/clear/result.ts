/**
 * One home for the per-scope clear verdict — the `{scope, ok, noop?}` shape and the
 * three-way ok/noop→verdict truth table that the producer (overlay), the drain, the
 * tab-broadcaster and the clear-coordinator all speak.
 *
 * `ok` alone hid a no-op: a scope that didn't fire (off-page / not-a-member) reports
 * ok:true purely so the in-memory ledger can settle, so `ok` collapsed a REAL flip and
 * a deliberate skip behind the same token — a log line `like:ok` could mean "un-liked"
 * OR "skipped", and a durable 'cleared' flag written off a bare `ok` marked a post
 * cleared that was never touched. The split is load-bearing: ok = verified flip,
 * noop = deliberately not fired, fail = clicked but no flip.
 */
import type { Scope } from './ledger'

/** One scope's clear outcome as reported by the in-page clearer. `noop` is only
 *  meaningful when `ok` is true (deliberately-not-fired; reported ok so ledgers settle). */
export interface ClearScopeResult {
  readonly scope: Scope
  readonly ok: boolean
  // `boolean | undefined` (not a bare `boolean`) so the schema-derived
  // `ClearTweetResponse.results` — `Schema.optional` yields an explicit-undefined
  // optional — assigns straight through under `exactOptionalPropertyTypes`.
  readonly noop?: boolean | undefined
}

/** flipped = verified un-bookmark/un-like; skipped = deliberate no-op (off-list);
 *  failed = clicked but no flip (or not clicked). ok:false ⇒ failed regardless of noop. */
export function clearVerdict(r: ClearScopeResult): 'flipped' | 'skipped' | 'failed' {
  if (!r.ok) return 'failed'
  return r.noop ? 'skipped' : 'flipped'
}

/** The scopes that REALLY flipped — the only ones a durable 'cleared' flag may record. */
export function flippedScopes(results: ReadonlyArray<ClearScopeResult>): Scope[] {
  return results.filter((r) => clearVerdict(r) === 'flipped').map((r) => r.scope)
}

const VERDICT_TOKEN: Record<ReturnType<typeof clearVerdict>, string> = {
  flipped: 'ok',
  skipped: 'noop',
  failed: 'fail',
}

/** Trace vocabulary: space-joined `scope:ok|noop|fail` tokens (exact tokens are load-bearing —
 *  existing tests/greps match them). */
export function formatClearResults(results: ReadonlyArray<ClearScopeResult>): string {
  return results.map((r) => `${r.scope}:${VERDICT_TOKEN[clearVerdict(r)]}`).join(' ')
}
