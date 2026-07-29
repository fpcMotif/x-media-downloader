import { describe, expect, it } from 'vitest'
import {
  applyClearOutcome,
  canIssueClear,
  CLEAR_ATTEMPT_LIMIT,
  CLEAR_ATTEMPT_WINDOW_MS,
  CLEAR_MAX_POST_TERMINAL_DELAY_MS,
  CLEAR_MIN_POST_TERMINAL_DELAY_MS,
  decodeClearSafetyState,
  encodeClearSafetyState,
  initialClearSafetyState,
  issueClear,
  recentClearAttemptAts,
  recoverAttemptedClear,
  resetBrowserSession,
  type ClearSafetyState,
} from './safety'

const initial = (): ClearSafetyState => initialClearSafetyState()!
const state = (over: Partial<ClearSafetyState> = {}): ClearSafetyState => ({
  ...initial(),
  ...over,
})
const attempted = (over: Partial<ClearSafetyState> = {}): ClearSafetyState =>
  state({ attemptAts: [1], ...over })
const issue = (at: number, count: number): ClearSafetyState =>
  Array.from({ length: count }).reduce<ClearSafetyState>((current, _, index) => {
    const next = issueClear(current, at + index + 1)
    if (next === undefined) throw new Error('test issue rejected')
    return next
  }, initial())

describe('ClearSafetyCircuit state', () => {
  it('starts closed only by no limits', () =>
    expect(canIssueClear(initial(), 0)).toEqual({ _tag: 'allowed' }))
  it('uses a positive safe epoch', () => expect(initialClearSafetyState(0)).toBeUndefined())
  it('rejects a negative epoch', () => expect(initialClearSafetyState(-1)).toBeUndefined())
  it('rejects a fractional epoch', () => expect(initialClearSafetyState(1.5)).toBeUndefined())
  it('records one issuance', () => expect(issueClear(initial(), 1)?.attemptAts).toEqual([1]))
  it('records time zero, but not twice', () => {
    const once = issueClear(initial(), 0)!
    expect(once.attemptAts).toEqual([0])
    expect(issueClear(once, 0)).toBeUndefined()
  })
  it('does not issue at the same timestamp', () =>
    expect(issueClear(state({ attemptAts: [2] }), 2)).toBeUndefined())
  it('does not issue before the prior timestamp', () =>
    expect(issueClear(state({ attemptAts: [2] }), 1)).toBeUndefined())
  it('waits for pacing', () =>
    expect(canIssueClear(state({ nextAttemptAt: 4 }), 3)).toEqual({ _tag: 'wait', until: 4 }))
  it('waits for backoff', () =>
    expect(canIssueClear(state({ blockedUntil: 4 }), 3)).toEqual({ _tag: 'wait', until: 4 }))
  it('uses the later deadline', () =>
    expect(canIssueClear(state({ nextAttemptAt: 5, blockedUntil: 6 }), 3)).toEqual({
      _tag: 'wait',
      until: 6,
    }))
  it('allows at an exact deadline', () =>
    expect(canIssueClear(state({ nextAttemptAt: 3 }), 3)).toEqual({ _tag: 'allowed' }))
  it('keeps only the strict rolling suffix', () =>
    expect(recentClearAttemptAts(state({ attemptAts: [1, 2, 60_001] }), 60_001)).toEqual([
      2, 60_001,
    ]))
  it('admits exactly nineteen attempts in the minute', () =>
    expect(canIssueClear(issue(0, CLEAR_ATTEMPT_LIMIT - 1), 20)).toEqual({ _tag: 'allowed' }))
  it('caps twenty attempts in the minute', () => {
    const current = issue(0, CLEAR_ATTEMPT_LIMIT)
    expect(canIssueClear(current, 21)).toEqual({
      _tag: 'minute-capped',
      until: CLEAR_ATTEMPT_WINDOW_MS + 1,
    })
  })
  it('reopens at the oldest attempt expiry', () => {
    const current = issue(0, CLEAR_ATTEMPT_LIMIT)
    expect(canIssueClear(current, CLEAR_ATTEMPT_WINDOW_MS + 1)).toEqual({ _tag: 'allowed' })
  })
  it('caps a full browser session', () =>
    expect(
      canIssueClear(state({ attemptAts: Array.from({ length: 200 }, (_, i) => i + 1) }), 300_000),
    ).toEqual({ _tag: 'session-capped' }))
  it('does not append while capped', () =>
    expect(
      issueClear(state({ attemptAts: Array.from({ length: 200 }, (_, i) => i + 1) }), 300_000),
    ).toBeUndefined())

  it('rejects terminal feedback without a recorded issuance', () =>
    expect(applyClearOutcome(initial(), 'cleared', 10, 2_000)).toBeUndefined())
  it('rejects terminal feedback before the latest issuance', () =>
    expect(
      applyClearOutcome(attempted({ attemptAts: [11] }), 'cleared', 10, 2_000),
    ).toBeUndefined())
  it('does not move a later pacing deadline backward', () =>
    expect(
      applyClearOutcome(attempted({ nextAttemptAt: 10_000 }), 'cleared', 10, 2_000)?.nextAttemptAt,
    ).toBe(10_000))
  it('does not move a later backoff deadline backward', () =>
    expect(
      applyClearOutcome(
        attempted({ failureStreak: 2, blockedUntil: 4_000_000 }),
        'uncertain',
        10,
        2_000,
      )?.blockedUntil,
    ).toBe(4_000_000))

  it('writes the minimum terminal delay', () =>
    expect(
      applyClearOutcome(attempted(), 'already-clear', 10, CLEAR_MIN_POST_TERMINAL_DELAY_MS)
        ?.nextAttemptAt,
    ).toBe(2_010))
  it('writes the maximum terminal delay', () =>
    expect(
      applyClearOutcome(attempted(), 'already-clear', 10, CLEAR_MAX_POST_TERMINAL_DELAY_MS)
        ?.nextAttemptAt,
    ).toBe(4_010))
  it('rejects a short terminal delay', () =>
    expect(applyClearOutcome(attempted(), 'cleared', 1, 1_999)).toBeUndefined())
  it('rejects a long terminal delay', () =>
    expect(applyClearOutcome(attempted(), 'cleared', 1, 4_001)).toBeUndefined())
  it('rejects a fractional terminal delay', () =>
    expect(applyClearOutcome(attempted(), 'cleared', 1, 2_000.5)).toBeUndefined())
  it('rejects overflow pacing', () =>
    expect(
      applyClearOutcome(attempted(), 'cleared', Number.MAX_SAFE_INTEGER, 2_000),
    ).toBeUndefined())
  it('cleared resets the failure streak', () =>
    expect(
      applyClearOutcome(attempted({ failureStreak: 2 }), 'cleared', 10, 2_000)?.failureStreak,
    ).toBe(0))
  it('safe already-clear is neutral', () =>
    expect(
      applyClearOutcome(attempted({ failureStreak: 2 }), 'already-clear', 10, 2_000)?.failureStreak,
    ).toBe(2))
  it('safe not-actionable is neutral', () =>
    expect(
      applyClearOutcome(attempted({ failureStreak: 2 }), 'not-actionable', 10, 2_000)
        ?.failureStreak,
    ).toBe(2))
  it('first bad outcome increments the streak', () =>
    expect(applyClearOutcome(attempted(), 'uncertain', 10, 2_000)?.failureStreak).toBe(1))
  it('second bad outcome increments the streak', () =>
    expect(
      applyClearOutcome(attempted({ failureStreak: 1 }), 'preflight-failed', 10, 2_000)
        ?.failureStreak,
    ).toBe(2))
  it('third bad outcome trips fifteen minutes', () => {
    const next = applyClearOutcome(attempted({ failureStreak: 2 }), 'uncertain', 10, 2_000)!
    expect(next).toMatchObject({ failureStreak: 0, backoffLevel: 1, blockedUntil: 900_010 })
  })
  it('next incident trips thirty minutes', () => {
    const next = applyClearOutcome(
      attempted({ failureStreak: 2, backoffLevel: 1 }),
      'uncertain',
      10,
      2_000,
    )!
    expect(next).toMatchObject({ failureStreak: 0, backoffLevel: 2, blockedUntil: 1_800_010 })
  })
  it('third level is sixty minutes', () => {
    const next = applyClearOutcome(
      attempted({ failureStreak: 2, backoffLevel: 2 }),
      'uncertain',
      10,
      2_000,
    )!
    expect(next).toMatchObject({ failureStreak: 0, backoffLevel: 3, blockedUntil: 3_600_010 })
  })
  it('later incidents stay at sixty minutes', () => {
    const next = applyClearOutcome(
      attempted({ failureStreak: 2, backoffLevel: 3 }),
      'uncertain',
      10,
      2_000,
    )!
    expect(next).toMatchObject({ backoffLevel: 3, blockedUntil: 3_600_010 })
  })
  it('recovery is an uncertain outcome', () =>
    expect(recoverAttemptedClear(attempted({ failureStreak: 1 }), 10, 2_000)?.failureStreak).toBe(
      2,
    ))
  it('recovery can trip backoff', () =>
    expect(recoverAttemptedClear(attempted({ failureStreak: 2 }), 10, 2_000)?.blockedUntil).toBe(
      900_010,
    ))
  it('recovers an attempted send at its persisted logical time after clock rollback', () =>
    expect(
      recoverAttemptedClear(attempted({ attemptAts: [10_000] }), 9_999, 2_000)?.nextAttemptAt,
    ).toBe(12_000))

  it('startup resets only the session budget', () => {
    const next = resetBrowserSession(
      state({ attemptAts: [1, 2], failureStreak: 2, backoffLevel: 1 }),
    )!
    expect(next).toMatchObject({
      browserSessionEpoch: 2,
      attemptAts: [],
      failureStreak: 2,
      backoffLevel: 1,
    })
  })
  it('does not wrap the session epoch', () =>
    expect(
      resetBrowserSession(state({ browserSessionEpoch: Number.MAX_SAFE_INTEGER })),
    ).toBeUndefined())

  it('round-trips exact state', () => {
    const value = state({
      attemptAts: [1, 2],
      nextAttemptAt: 4,
      backoffLevel: 1,
      blockedUntil: 5,
    })
    expect(decodeClearSafetyState(encodeClearSafetyState(value), 2)).toEqual(value)
  })
  it('copies the encoded attempt array', () => {
    const value = state({ attemptAts: [1] })
    const encoded = encodeClearSafetyState(value)
    expect(encoded.attemptAts).not.toBe(value.attemptAts)
  })
  it('rejects an unknown key', () =>
    expect(decodeClearSafetyState({ ...initial(), extra: true }, 0)).toBeUndefined())
  it('rejects a missing key', () => {
    const { blockedUntil: _, ...raw } = initial()
    expect(decodeClearSafetyState(raw, 0)).toBeUndefined()
  })
  it('rejects an unknown version', () =>
    expect(decodeClearSafetyState({ ...initial(), version: 2 }, 0)).toBeUndefined())
  it('rejects a non-plain object', () => expect(decodeClearSafetyState([], 0)).toBeUndefined())
  it('rejects unsafe timestamps', () =>
    expect(
      decodeClearSafetyState({ ...initial(), nextAttemptAt: Number.MAX_VALUE }, 0),
    ).toBeUndefined())
  it('retains a future attempt after clock rollback and waits past its exact timestamp', () => {
    const rolledBack = state({ attemptAts: [10_000] })
    expect(decodeClearSafetyState(encodeClearSafetyState(rolledBack), 9_999)).toEqual(rolledBack)
    expect(canIssueClear(rolledBack, 9_999)).toEqual({ _tag: 'wait', until: 10_001 })
    expect(canIssueClear(rolledBack, 10_000)).toEqual({ _tag: 'wait', until: 10_001 })
    expect(canIssueClear(rolledBack, 10_001)).toEqual({ _tag: 'allowed' })
  })
  it('rejects a negative attempt', () =>
    expect(decodeClearSafetyState({ ...initial(), attemptAts: [-1] }, 0)).toBeUndefined())
  it('rejects unsorted attempts', () =>
    expect(decodeClearSafetyState({ ...initial(), attemptAts: [2, 1] }, 2)).toBeUndefined())
  it('rejects duplicate attempts', () =>
    expect(decodeClearSafetyState({ ...initial(), attemptAts: [1, 1] }, 1)).toBeUndefined())
  it('rejects more than the session cap', () =>
    expect(
      decodeClearSafetyState(
        { ...initial(), attemptAts: Array.from({ length: 201 }, (_, i) => i) },
        200,
      ),
    ).toBeUndefined())
  it('rejects a failure streak outside circuit range', () =>
    expect(decodeClearSafetyState({ ...initial(), failureStreak: 3 }, 0)).toBeUndefined())
  it('rejects a bad backoff level', () =>
    expect(decodeClearSafetyState({ ...initial(), backoffLevel: 4 }, 0)).toBeUndefined())
  it('rejects a fractional backoff level', () =>
    expect(decodeClearSafetyState({ ...initial(), backoffLevel: 1.5 }, 0)).toBeUndefined())
  it('rejects a backoff level without a deadline', () =>
    expect(decodeClearSafetyState({ ...initial(), backoffLevel: 1 }, 0)).toBeUndefined())
  it('rejects a deadline without a backoff level', () =>
    expect(decodeClearSafetyState({ ...initial(), blockedUntil: 1 }, 0)).toBeUndefined())
})
