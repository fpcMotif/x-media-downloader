/**
 * Pure pacing and circuit-breaker state for destructive Clear requests.
 * The coordinator persists this beside the Completion Ledger in one IDB transaction.
 */

export const CLEAR_ATTEMPT_WINDOW_MS = 60_000
export const CLEAR_ATTEMPT_LIMIT = 20
export const CLEAR_SESSION_ATTEMPT_LIMIT = 200
export const CLEAR_MIN_POST_TERMINAL_DELAY_MS = 2_000
export const CLEAR_MAX_POST_TERMINAL_DELAY_MS = 4_000

const BACKOFF_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000] as const
const MAX_BACKOFF_LEVEL = BACKOFF_MS.length

export type ClearSafetyOutcome =
  | 'cleared'
  | 'already-clear'
  | 'not-actionable'
  | 'preflight-failed'
  | 'uncertain'

export interface ClearSafetyState {
  readonly version: 1
  readonly nextAttemptAt: number
  readonly attemptAts: readonly number[]
  readonly browserSessionEpoch: number
  readonly failureStreak: number
  readonly backoffLevel: number
  readonly blockedUntil: number
}

export type ClearSafetyDecision =
  | { readonly _tag: 'allowed' }
  | { readonly _tag: 'wait'; readonly until: number }
  | { readonly _tag: 'minute-capped'; readonly until: number }
  | { readonly _tag: 'session-capped' }

const allowed: ClearSafetyDecision = { _tag: 'allowed' }
const isSafeTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isPositiveSafeInteger = (value: unknown): value is number => isSafeTime(value) && value > 0
const isIntegerInRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const canAdd = (left: number, right: number): boolean =>
  Number.isSafeInteger(left + right) && left + right >= 0
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}
const isDelay = (value: number): boolean =>
  Number.isSafeInteger(value) &&
  value >= CLEAR_MIN_POST_TERMINAL_DELAY_MS &&
  value <= CLEAR_MAX_POST_TERMINAL_DELAY_MS
const isOutcome = (value: unknown): value is ClearSafetyOutcome =>
  value === 'cleared' ||
  value === 'already-clear' ||
  value === 'not-actionable' ||
  value === 'preflight-failed' ||
  value === 'uncertain'

export const initialClearSafetyState = (browserSessionEpoch = 1): ClearSafetyState | undefined =>
  isPositiveSafeInteger(browserSessionEpoch)
    ? {
        version: 1,
        nextAttemptAt: 0,
        attemptAts: [],
        browserSessionEpoch,
        failureStreak: 0,
        backoffLevel: 0,
        blockedUntil: 0,
      }
    : undefined

/** Exact, fail-closed decoder. `now` rejects stale storage that claims future sends. */
export const decodeClearSafetyState = (
  value: unknown,
  now: number,
): ClearSafetyState | undefined => {
  if (!isSafeTime(now) || !isPlainRecord(value)) return undefined
  const keys = [
    'version',
    'nextAttemptAt',
    'attemptAts',
    'browserSessionEpoch',
    'failureStreak',
    'backoffLevel',
    'blockedUntil',
  ] as const
  if (!hasOnlyKeys(value, keys) || value.version !== 1) return undefined
  if (
    !isSafeTime(value.nextAttemptAt) ||
    !Array.isArray(value.attemptAts) ||
    value.attemptAts.length > CLEAR_SESSION_ATTEMPT_LIMIT ||
    !isPositiveSafeInteger(value.browserSessionEpoch) ||
    !isIntegerInRange(value.failureStreak, 0, 2) ||
    !isIntegerInRange(value.backoffLevel, 0, MAX_BACKOFF_LEVEL) ||
    !isSafeTime(value.blockedUntil) ||
    (value.backoffLevel === 0) !== (value.blockedUntil === 0)
  )
    return undefined

  const attemptAts: number[] = []
  let previous = -1
  for (const attemptAt of value.attemptAts) {
    if (!isSafeTime(attemptAt) || attemptAt <= previous) return undefined
    attemptAts.push(attemptAt)
    previous = attemptAt
  }
  return {
    version: 1,
    nextAttemptAt: value.nextAttemptAt,
    attemptAts,
    browserSessionEpoch: value.browserSessionEpoch,
    failureStreak: value.failureStreak,
    backoffLevel: value.backoffLevel,
    blockedUntil: value.blockedUntil,
  }
}

export const encodeClearSafetyState = (state: ClearSafetyState): ClearSafetyState => ({
  version: 1,
  nextAttemptAt: state.nextAttemptAt,
  attemptAts: [...state.attemptAts],
  browserSessionEpoch: state.browserSessionEpoch,
  failureStreak: state.failureStreak,
  backoffLevel: state.backoffLevel,
  blockedUntil: state.blockedUntil,
})

/** The attempts strictly inside `(now - 60s, now]`; expiry is safe to schedule at. */
export const recentClearAttemptAts = (
  state: ClearSafetyState,
  now: number,
): readonly number[] | undefined => {
  if (!isSafeTime(now)) return undefined
  const windowStart = Math.max(0, now - CLEAR_ATTEMPT_WINDOW_MS)
  return state.attemptAts.filter((attemptAt) => attemptAt > windowStart && attemptAt <= now)
}

export const canIssueClear = (state: ClearSafetyState, now: number): ClearSafetyDecision => {
  if (!isSafeTime(now)) return { _tag: 'wait', until: Number.MAX_SAFE_INTEGER }
  const latestAttemptAt = state.attemptAts.at(-1)
  if (latestAttemptAt !== undefined && latestAttemptAt >= now && !canAdd(latestAttemptAt, 1))
    return { _tag: 'session-capped' }
  const waitUntil = Math.max(
    state.nextAttemptAt,
    state.blockedUntil,
    latestAttemptAt !== undefined && latestAttemptAt >= now ? latestAttemptAt + 1 : 0,
  )
  if (waitUntil > now) return { _tag: 'wait', until: waitUntil }
  if (state.attemptAts.length >= CLEAR_SESSION_ATTEMPT_LIMIT) return { _tag: 'session-capped' }
  const recent = recentClearAttemptAts(state, now)
  if (recent === undefined) return { _tag: 'wait', until: Number.MAX_SAFE_INTEGER }
  if (recent.length < CLEAR_ATTEMPT_LIMIT) return allowed
  const oldest = recent[0]
  if (oldest === undefined || !canAdd(oldest, CLEAR_ATTEMPT_WINDOW_MS))
    return { _tag: 'session-capped' }
  return { _tag: 'minute-capped', until: oldest + CLEAR_ATTEMPT_WINDOW_MS }
}

/** Appends a conservative budget charge only when issuance is presently allowed. */
export const issueClear = (state: ClearSafetyState, now: number): ClearSafetyState | undefined => {
  if (canIssueClear(state, now)._tag !== 'allowed') return undefined
  const last = state.attemptAts.at(-1)
  if (last !== undefined && now <= last) return undefined
  return { ...state, attemptAts: [...state.attemptAts, now] }
}

/** Persist the exact terminal result and the next post-terminal pacing deadline. */
export const applyClearOutcome = (
  state: ClearSafetyState,
  outcome: ClearSafetyOutcome,
  terminalAt: number,
  postTerminalDelayMs: number,
): ClearSafetyState | undefined => {
  if (!isOutcome(outcome) || !isSafeTime(terminalAt) || !isDelay(postTerminalDelayMs))
    return undefined
  if (!canAdd(terminalAt, postTerminalDelayMs)) return undefined
  const latestAttemptAt = state.attemptAts.at(-1)
  if (latestAttemptAt === undefined || terminalAt < latestAttemptAt) return undefined
  const nextAttemptAt = Math.max(state.nextAttemptAt, terminalAt + postTerminalDelayMs)

  if (outcome === 'cleared') return { ...state, failureStreak: 0, nextAttemptAt }
  if (outcome === 'already-clear' || outcome === 'not-actionable')
    return { ...state, nextAttemptAt }

  const failureStreak = state.failureStreak + 1
  if (failureStreak < 3) return { ...state, failureStreak, nextAttemptAt }

  const backoffLevel = Math.min(state.backoffLevel + 1, MAX_BACKOFF_LEVEL)
  const backoffMs = BACKOFF_MS[backoffLevel - 1]
  if (backoffMs === undefined || !canAdd(terminalAt, backoffMs)) return undefined
  return {
    ...state,
    failureStreak: 0,
    backoffLevel,
    blockedUntil: Math.max(state.blockedUntil, terminalAt + backoffMs),
    nextAttemptAt,
  }
}

/** A worker that lost a reply must treat its durable Attempted scope as uncertain. */
export const recoverAttemptedClear = (
  state: ClearSafetyState,
  recoveredAt: number,
  postTerminalDelayMs: number,
): ClearSafetyState | undefined => {
  const logicalRecoveredAt = Math.max(recoveredAt, state.attemptAts.at(-1) ?? 0)
  return applyClearOutcome(state, 'uncertain', logicalRecoveredAt, postTerminalDelayMs)
}

/** Only a proven browser startup may reset the per-session cap. */
export const resetBrowserSession = (state: ClearSafetyState): ClearSafetyState | undefined => {
  if (!canAdd(state.browserSessionEpoch, 1) || state.browserSessionEpoch >= Number.MAX_SAFE_INTEGER)
    return undefined
  return { ...state, browserSessionEpoch: state.browserSessionEpoch + 1, attemptAts: [] }
}
