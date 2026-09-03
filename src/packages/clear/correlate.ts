/**
 * Mutation↔clear correlation — the events that directly indict H1 or H5 (spec #59
 * ticket #65). The background side of the Release diagnostics pipeline already
 * ingests two disjoint event streams as ordinary `DownloadTraceEntry` lines:
 *  - clear-RESOLVE events (`clear-flip` — a confirmed flip; `clear-already-cleared`
 *    with `alreadyCleared=true` — a verified no-op) from ticket #62's discriminated
 *    confirmation, each carrying `scope=`/`origin=`/`arm=` in its `detail` string;
 *  - mutation OBSERVATION events (`clear-mutation`) from ticket #63's tee relay,
 *    carrying `op=`/`status=`/`error=`.
 * This module parses both back into structured values and correlates a NEW mutation
 * against the MOST RECENT resolve for the same tweetId+scope:
 *  - a FAILED `DeleteBookmark` (non-200, or 200-with-`errors`) landing within the
 *    correlation window of a `bookmark` resolve is the H1 fingerprint — the optimistic
 *    DOM flip was real, but the server rejected the mutation;
 *  - any `CreateBookmark` landing within the window of a `bookmark` resolve is the H5
 *    fingerprint — nothing in this extension's own Release paths can fire that op, so
 *    its mere presence near a clear is the smoking gun the parent spec asks for.
 * Deliberately ONE-DIRECTIONAL: a mutation is checked against resolves ALREADY
 * recorded, never the reverse (a resolve does not retroactively scan past mutations).
 * A mutation event that reaches the background before its matching resolve — possible
 * because the two arrive over independent, unordered `runtime.sendMessage` calls — is
 * a residual blind spot, the same kind `recheck.ts` documents for Chrome's timer
 * throttling: known, not silently pretended away.
 *
 * Pure: no chrome.*, no I/O, no Ledger/Worklist access, no clicks, no retries —
 * correlation is passive bookkeeping over trace lines that already exist.
 */
import type { DownloadTraceEntry, ReleaseMutationOp } from '@/packages/schema'
import type { ClearOrigin, MembershipScope } from './clearer'

/** How long after a clear resolves a mutation may still be attributed to it. Wide
 *  enough for a slow `DeleteBookmark` round-trip AND a rate-limit retry queued behind
 *  it, narrow enough that an UNRELATED bookmark action minutes later on the same post
 *  is never misread as evidence about THIS release. */
export const CORRELATION_WINDOW_MS = 30_000

/** Which signal confirmed the clear this mutation is being checked against — the
 *  same three-way split ticket #62 introduced, plus the already-cleared no-op (its
 *  own distinct stage, never an `arm=`). */
export type ConfirmBranch = 'testid' | 'detached' | 'already-cleared'

export interface ClearResolveEvent {
  readonly tweetId: string
  readonly scope: MembershipScope
  readonly t: number
  readonly origin: ClearOrigin
  readonly confirmBranch: ConfirmBranch
}

export interface MutationEvent {
  readonly tweetId: string
  readonly op: ReleaseMutationOp
  readonly status: number
  readonly error: boolean
  readonly t: number
}

/** `key=value value2` (space-joined) tokens → a plain lookup. Tolerant of anything
 *  that doesn't match `key=` (skipped, not thrown) — the trace-line format is this
 *  module's OWN emitted format, but parsing it back is still worth failing safe on,
 *  the same posture `bodyHasErrorSignal`/`tweetIdFromMutationRequestBody` take on
 *  page-controlled input. */
function parseTokens(detail: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const tok of detail.split(' ')) {
    const eq = tok.indexOf('=')
    if (eq > 0) out.set(tok.slice(0, eq), tok.slice(eq + 1))
  }
  return out
}

const MEMBERSHIP_SCOPES: ReadonlySet<string> = new Set(['bookmark', 'like'])
const CLEAR_ORIGINS: ReadonlySet<string> = new Set(['settle', 'drain', 'manual'])
const MUTATION_OPS: ReadonlySet<string> = new Set([
  'CreateBookmark',
  'DeleteBookmark',
  'FavoriteTweet',
  'UnfavoriteTweet',
])

function isMembershipScope(val: string): val is MembershipScope {
  return MEMBERSHIP_SCOPES.has(val)
}

function isClearOrigin(val: string): val is ClearOrigin {
  return CLEAR_ORIGINS.has(val)
}

function isReleaseMutationOp(val: string): val is ReleaseMutationOp {
  return MUTATION_OPS.has(val)
}

/** A resolve event, parsed back from the `clear-flip` / `clear-already-cleared` line
 *  it was originally emitted as — `null` for every other stage, an already-cleared
 *  line with `alreadyCleared=false` (not actually a resolve), or a line with
 *  malformed/missing tokens (fail safe, never throw on a shape this module itself
 *  produced but could still drift from if the emitter ever changes). Deliberately
 *  ignores `clear-flip-fabricated` — it is always co-emitted alongside an ordinary
 *  `clear-flip` for the exact same moment, so parsing both would double-count one
 *  resolve as two. */
export function parseClearResolveEvent(entry: DownloadTraceEntry): ClearResolveEvent | null {
  if (entry.tweetId === undefined) return null
  if (entry.stage !== 'clear-flip' && entry.stage !== 'clear-already-cleared') return null
  const tokens = parseTokens(entry.detail ?? '')
  const scope = tokens.get('scope')
  const origin = tokens.get('origin')
  if (scope === undefined || !isMembershipScope(scope)) return null
  if (origin === undefined || !isClearOrigin(origin)) return null
  if (entry.stage === 'clear-already-cleared') {
    if (tokens.get('alreadyCleared') !== 'true') return null
    return {
      tweetId: entry.tweetId,
      scope,
      t: entry.t,
      origin,
      confirmBranch: 'already-cleared',
    }
  }
  const arm = tokens.get('arm')
  if (arm !== 'testid' && arm !== 'detached') return null
  return {
    tweetId: entry.tweetId,
    scope,
    t: entry.t,
    origin,
    confirmBranch: arm,
  }
}

/** A mutation event, parsed back from the `clear-mutation` line ticket #63 emits.
 *  `null` for every other stage, a missing tweetId (the mutation's own tee capture
 *  is itself best-effort — see `tweetIdFromMutationRequestBody`), or malformed
 *  tokens. */
export function parseMutationEvent(entry: DownloadTraceEntry): MutationEvent | null {
  if (entry.tweetId === undefined) return null
  if (entry.stage !== 'clear-mutation') return null
  const tokens = parseTokens(entry.detail ?? '')
  const op = tokens.get('op')
  const status = tokens.get('status')
  const error = tokens.get('error')
  if (op === undefined || !isReleaseMutationOp(op)) return null
  if (status === undefined || !/^\d+$/.test(status)) return null
  if (error !== 'true' && error !== 'false') return null
  return {
    tweetId: entry.tweetId,
    op,
    status: Number(status),
    error: error === 'true',
    t: entry.t,
  }
}

/** The bounded recent-resolve table: at most one entry per (tweetId, scope) — a
 *  fresh resolve for the same key REPLACES the old one, since only the latest
 *  clear for a given post+scope is what a later mutation could be evidence about.
 *  Ephemeral by design (in-memory, like the background's existing `traceEvents`
 *  session ring): an SW recycle inside the correlation window loses the table, the
 *  same residual gap that ring already accepts. */
export interface CorrelationState {
  readonly resolves: ReadonlyMap<string, ClearResolveEvent>
}
export const EMPTY_CORRELATION_STATE: CorrelationState = { resolves: new Map() }

const resolveKey = (tweetId: string, scope: MembershipScope): string => `${tweetId}:${scope}`

/** Record a fresh resolve, pruning every entry the window has already aged out
 *  (relative to `now`) — the table can only ever hold entries a mutation could
 *  still correlate against, so it never grows unbounded across a long session. */
export function recordResolve(
  state: CorrelationState,
  event: ClearResolveEvent,
  now: number,
): CorrelationState {
  const next = new Map(state.resolves)
  for (const [k, v] of next) if (now - v.t > CORRELATION_WINDOW_MS) next.delete(k)
  next.set(resolveKey(event.tweetId, event.scope), event)
  return { resolves: next }
}

export type CorrelationVerdict =
  | {
      readonly kind: 'server-reject'
      readonly resolve: ClearResolveEvent
      readonly mutation: MutationEvent
    }
  | {
      readonly kind: 're-add-fingerprint'
      readonly resolve: ClearResolveEvent
      readonly mutation: MutationEvent
    }

type FormattedCorrelationVerdict = {
  readonly stage: string
  readonly detail: string
}

/** Correlate ONE mutation against the current resolve table. Pure: never mutates
 *  `state` (the caller decides separately whether/when to `recordResolve`), issues
 *  nothing, retries nothing, touches no Ledger/Worklist state — passive bookkeeping
 *  only. `null` when the mutation is ordinary (no bookmark resolve nearby, wrong op,
 *  a successful DeleteBookmark, or outside the window either direction). */
export function correlateMutation(
  state: CorrelationState,
  mutation: MutationEvent,
): CorrelationVerdict | null {
  const resolve = state.resolves.get(resolveKey(mutation.tweetId, 'bookmark'))
  if (!resolve) return null
  if (mutation.op === 'DeleteBookmark' && (mutation.status !== 200 || mutation.error)) {
    // The server-reject fingerprint requires the mutation to have landed AT OR AFTER
    // the optimistic resolve — a failure timestamped BEFORE the resolve can't be the
    // resolve's own mutation (they'd be for different attempts).
    const delta = mutation.t - resolve.t
    if (delta >= 0 && delta <= CORRELATION_WINDOW_MS)
      return { kind: 'server-reject', resolve, mutation }
    return null
  }
  if (mutation.op === 'CreateBookmark') {
    // The re-add fingerprint is symmetric: a re-add racing IN FRONT of the resolve
    // (already recorded by the time this mutation is processed) is just as much
    // evidence of a cross-entry-point double-fire (H5) as one landing after.
    if (Math.abs(mutation.t - resolve.t) <= CORRELATION_WINDOW_MS)
      return { kind: 're-add-fingerprint', resolve, mutation }
    return null
  }
  return null
}

/** Format a verdict as the `{stage, detail}` pair the durable log's existing
 *  `report`/`traceBackground` sink expects — `t`/`tweetId` are the CALLER's to set
 *  (mirrors every other `clear-*` emitter in this codebase, which never bakes its
 *  own timestamp into the detail string twice). `elapsedMs` is signed: negative
 *  means the mutation preceded the resolve. */
export function formatCorrelationVerdict(verdict: CorrelationVerdict) {
  const { resolve, mutation } = verdict
  const head = `scope=${resolve.scope} origin=${resolve.origin} confirmBranch=${resolve.confirmBranch} resolvedAt=${resolve.t} elapsedMs=${mutation.t - resolve.t}`
  if (verdict.kind === 'server-reject') {
    return {
      stage: 'clear-server-reject',
      detail: `${head} status=${mutation.status} error=${mutation.error}`,
    } satisfies FormattedCorrelationVerdict
  }
  return { stage: 'clear-re-add-fingerprint', detail: head } satisfies FormattedCorrelationVerdict
}

/** Running mismatch counters — DERIVED fresh from a `DownloadTraceEntry[]` (the
 *  durable log's own retained window, or any slice of it), never separately
 *  persisted: the log itself is already durable, so a parallel incrementing counter
 *  would only be a second source of truth to keep in sync. Feeds BOTH the
 *  diagnostics export's meta line and the popup summary (ticket #66) — one
 *  computation, so the two can never disagree. `clears` counts `clear-flip` lines
 *  plus verified `clear-already-cleared` no-ops (mirrors `parseClearResolveEvent`'s
 *  own admission rule) — NOT `clear-flip-fabricated`, which duplicates an
 *  already-counted `clear-flip`; `clearsByBranch` is the SAME admitted set, split
 *  by `confirmBranch` for the summary's "12 released · 12 flips" style readout. */
export interface ReleaseCorrelationCounters {
  readonly clears: number
  readonly clearsByBranch: {
    readonly testid: number
    readonly detached: number
    readonly alreadyCleared: number
  }
  readonly mutations: number
  readonly serverRejects: number
  readonly reAddFingerprints: number
  readonly reappearances: number
}

export function computeReleaseCorrelationCounters(
  events: ReadonlyArray<DownloadTraceEntry>,
): ReleaseCorrelationCounters {
  let clears = 0
  let testid = 0
  let detached = 0
  let alreadyCleared = 0
  let mutations = 0
  let serverRejects = 0
  let reAddFingerprints = 0
  let reappearances = 0
  for (const e of events) {
    if (e.stage === 'clear-flip' || e.stage === 'clear-already-cleared') {
      const resolved = parseClearResolveEvent(e)
      if (resolved !== null) {
        clears++
        if (resolved.confirmBranch === 'testid') testid++
        else if (resolved.confirmBranch === 'detached') detached++
        else alreadyCleared++
      }
    } else if (e.stage === 'clear-mutation') mutations++
    else if (e.stage === 'clear-server-reject') serverRejects++
    else if (e.stage === 'clear-re-add-fingerprint') reAddFingerprints++
    else if (e.stage === 'clear-reappeared') reappearances++
  }
  return {
    clears,
    clearsByBranch: { testid, detached, alreadyCleared },
    mutations,
    serverRejects,
    reAddFingerprints,
    reappearances,
  }
}

/**
 * The popup's Release summary readout (ticket #66's "12 released · 12 flips · 0
 * mismatches" demo line) — the ONE piece of "counter derivation logic" the ticket
 * asks to be pure and unit-tested, kept out of the (untested-by-design)
 * `entrypoints/popup` React tree entirely so the UI component stays a thin renderer
 * of a string this module already produced. `flips` is `testid + detached` — the
 * two branches that involved an actual click-and-confirm, deliberately excluding
 * `alreadyCleared` (a verified no-op is not "a flip"). `mismatches` sums every
 * anomaly a reader would want to know about at a glance: server-rejects, re-add
 * fingerprints, and re-appearances — the three counters that, at zero, mean
 * "nothing to see"; above zero, mean "open the export."
 */
export function formatReleaseSummaryLine(counters: ReleaseCorrelationCounters): string {
  const flips = counters.clearsByBranch.testid + counters.clearsByBranch.detached
  const mismatches = counters.serverRejects + counters.reAddFingerprints + counters.reappearances
  return `${counters.clears} released · ${flips} flip${flips === 1 ? '' : 's'} · ${mismatches} mismatch${mismatches === 1 ? '' : 'es'}`
}
