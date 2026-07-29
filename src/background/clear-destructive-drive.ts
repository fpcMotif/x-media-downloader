import {
  attemptReservedClear,
  clearScopeIntent,
  isTrulyCompleteDurable,
  pruneResolvedEntry,
  releaseReservedClear,
  reserveClear,
  resolveAttemptedClear,
  skipReadyClear,
  type CompletionLedgerEntry,
  type Scope,
} from '../core/clear/ledger'
import {
  applyClearOutcome,
  canIssueClear,
  CLEAR_MAX_POST_TERMINAL_DELAY_MS,
  CLEAR_MIN_POST_TERMINAL_DELAY_MS,
  issueClear,
  type ClearSafetyDecision,
  type ClearSafetyOutcome,
  type ClearSafetyState,
} from '../core/clear/safety'
import { makeSerialQueue } from '../core/serial-queue'
import type { Settings } from '../core/schema'
import type { ClearSettingsAuthority, ClearTabs, ClearWakePort } from './clear-ports'
import {
  assertTime,
  assertTweetId,
  entryScopes,
  type ClearClock,
  type ClearCoordinatorTrace,
  type ClearStateStore,
  type CoordinatorState,
} from './clear-state-store'
import type { ClearWorklistProjection } from './clear-worklist-projection'

const SETTLE_PROBE_RETRY_MS = 1000
const MAX_TERMINAL_REPLANS = 3
interface PendingTerminal {
  readonly tweetId: string
  readonly scope: Scope
  readonly result: 'cleared' | 'failed' | 'skipped' | 'uncertain'
  readonly outcome: ClearSafetyOutcome
  readonly terminalAt: number
  readonly postTerminalDelayMs: number
  readonly expectedSafety?: ClearSafetyState
}
type TerminalFlushResult =
  | { readonly _tag: 'settled'; readonly state: CoordinatorState }
  | { readonly _tag: 'replan' }
type ClearIssueResult =
  | { readonly issued: false; readonly decision?: ClearSafetyDecision }
  | {
      readonly issued: true
      readonly at: number
      readonly allLists: boolean
    }
const sameSafety = (left: ClearSafetyState, right: ClearSafetyState): boolean =>
  left.version === right.version &&
  left.nextAttemptAt === right.nextAttemptAt &&
  left.browserSessionEpoch === right.browserSessionEpoch &&
  left.failureStreak === right.failureStreak &&
  left.backoffLevel === right.backoffLevel &&
  left.blockedUntil === right.blockedUntil &&
  left.attemptAts.length === right.attemptAts.length &&
  left.attemptAts.every((at, index) => at === right.attemptAts[index])
const ready = (state: CoordinatorState, entry: CompletionLedgerEntry): Scope[] =>
  isTrulyCompleteDurable(entry)
    ? (['bookmark', 'like', 'notInterested'] as Scope[]).filter(
        (scope) =>
          entryScopes(entry).includes(scope) &&
          !state.completion.tombstones.get(entry.tweetId)?.has(scope) &&
          ['none', 'failed', 'reserved'].includes(entry.clear[scope]),
      )
    : []
const permits = (
  entry: CompletionLedgerEntry,
  scope: Scope,
  settings: Readonly<Settings>,
): boolean => {
  if (!settings.clearOnSave) return false
  const intent = clearScopeIntent(entry, scope)
  if (intent === undefined) return false
  if (intent === 'manual') return true
  const enabled =
    scope === 'bookmark'
      ? settings.autoUnbookmarkOnSave
      : scope === 'like'
        ? settings.autoUnlikeOnSave
        : settings.autoNotInterestedOnSave
  return enabled && (intent !== 'cross-list-automatic' || settings.clearAllListsOnSave)
}
const terminalResult = (
  response: Awaited<ReturnType<ClearTabs['clearTweetInTab']>>,
  scope: Scope,
): Pick<PendingTerminal, 'result' | 'outcome'> => {
  const item =
    response?.results.length === 1 && response.results[0]?.scope === scope
      ? response.results[0]
      : undefined
  switch (item?.state) {
    case 'cleared':
      return { result: 'cleared', outcome: 'cleared' }
    case 'already-clear':
      return { result: 'skipped', outcome: 'already-clear' }
    case 'not-actionable':
      return { result: 'failed', outcome: 'not-actionable' }
    case 'preflight-failed':
      return { result: 'failed', outcome: 'preflight-failed' }
    default:
      return { result: 'uncertain', outcome: 'uncertain' }
  }
}

export interface ClearDestructiveDrive {
  readonly driveReady: (input?: {
    readonly onlyTabId?: number
    readonly tweetIds?: ReadonlyArray<string>
  }) => Promise<void>
  readonly onSafetyWake: () => Promise<void>
}
export const makeClearDestructiveDrive = (input: {
  readonly store: ClearStateStore
  readonly clock: ClearClock
  readonly wake: ClearWakePort
  readonly tabs: ClearTabs
  readonly settings: ClearSettingsAuthority
  readonly trace: (stage: string, context?: ClearCoordinatorTrace) => void
  readonly project: () => Promise<void>
  /** Must persist a retry wake before any irreversible Clear can be issued. */
  readonly ensureProjectionWake: () => Promise<void> | void
  readonly postTerminalDelay?: () => number
  readonly onError?: (error: unknown) => void
}): ClearDestructiveDrive => {
  const driveSerial = makeSerialQueue(input.onError)
  let pendingTerminal: PendingTerminal | undefined
  let terminalRetryScheduled = false
  let immediateDriveScheduled = false
  let shortWakeAt: number | undefined
  const sampleDelay = (): number => {
    const delay =
      input.postTerminalDelay?.() ??
      CLEAR_MIN_POST_TERMINAL_DELAY_MS +
        Math.floor(
          Math.random() * (CLEAR_MAX_POST_TERMINAL_DELAY_MS - CLEAR_MIN_POST_TERMINAL_DELAY_MS + 1),
        )
    if (
      !Number.isSafeInteger(delay) ||
      delay < CLEAR_MIN_POST_TERMINAL_DELAY_MS ||
      delay > CLEAR_MAX_POST_TERMINAL_DELAY_MS
    )
      throw new TypeError(`Invalid Clear post-terminal delay: ${delay}`)
    return delay
  }
  const persisted = (state: CoordinatorState, pending: PendingTerminal): boolean => {
    if (pending.expectedSafety === undefined || !sameSafety(state.safety, pending.expectedSafety))
      return false
    const tombstone = state.completion.tombstones.get(pending.tweetId)?.get(pending.scope)
    if (pending.result === 'cleared' || pending.result === 'uncertain')
      return tombstone?.state === pending.result && tombstone.at === pending.terminalAt
    const entry = state.completion.entries.get(pending.tweetId)
    return entry === undefined || entry.clear[pending.scope] === pending.result
  }
  const scheduleDecision = async (decision: ClearSafetyDecision): Promise<void> => {
    if (decision._tag === 'allowed') {
      if (immediateDriveScheduled) return
      immediateDriveScheduled = true
      input.clock.schedule(() => {
        immediateDriveScheduled = false
        void driveReady().catch((error: unknown) =>
          input.trace('clear-immediate-drive-error', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        )
      }, 0)
      return
    }
    if (decision._tag === 'session-capped') return
    const until = decision.until
    try {
      await input.wake.schedule(until)
    } catch (error) {
      input.trace('clear-wake-error', {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    const delay = Math.max(0, until - input.clock.now())
    if (delay > CLEAR_MAX_POST_TERMINAL_DELAY_MS || shortWakeAt === until) return
    shortWakeAt = until
    input.clock.schedule(() => {
      if (shortWakeAt !== until) return
      shortWakeAt = undefined
      void driveReady().catch((error: unknown) =>
        input.trace('clear-wake-drive-error', {
          detail: error instanceof Error ? error.message : String(error),
        }),
      )
    }, delay)
  }
  const scheduleTerminalRetry = (): void => {
    if (terminalRetryScheduled || pendingTerminal === undefined) return
    terminalRetryScheduled = true
    input.clock.schedule(() => {
      terminalRetryScheduled = false
      if (pendingTerminal !== undefined)
        void flushTerminal().catch((error: unknown) =>
          input.trace('clear-terminal-retry-error', {
            detail: error instanceof Error ? error.message : String(error),
          }),
        )
    }, SETTLE_PROBE_RETRY_MS)
  }
  const flushTerminal = async (): Promise<void> => {
    let pending = pendingTerminal
    if (pending === undefined) return
    let next: CoordinatorState | undefined
    try {
      // oxlint-disable no-await-in-loop -- each stale plan must observe the CAS winner before replanning.
      for (let attempt = 1; attempt <= MAX_TERMINAL_REPLANS && next === undefined; attempt += 1) {
        const observed = await input.store.snapshot()
        if (persisted(observed, pending)) {
          next = observed
          break
        }
        const observedEntry = observed.completion.entries.get(pending.tweetId)
        const expectedSafety =
          observedEntry?.clear[pending.scope] === 'attempted'
            ? applyClearOutcome(
                observed.safety,
                pending.outcome,
                pending.terminalAt,
                pending.postTerminalDelayMs,
              )
            : pending.expectedSafety
        if (expectedSafety === undefined)
          throw new Error(`Cannot persist terminal Clear ${pending.tweetId}/${pending.scope}`)
        const prepared: PendingTerminal = { ...pending, expectedSafety }
        if (pendingTerminal !== pending) {
          pending = pendingTerminal
          if (pending === undefined) return
          continue
        }
        pendingTerminal = prepared
        pending = prepared
        const result = await input.store.turn<TerminalFlushResult>(
          [[prepared.tweetId, prepared.scope]],
          (state) => {
            const entry = state.completion.entries.get(prepared.tweetId)
            if (entry?.clear[prepared.scope] !== 'attempted') {
              if (persisted(state, prepared)) return { state, value: { _tag: 'settled', state } }
              throw new Error(`Cannot persist terminal Clear ${prepared.tweetId}/${prepared.scope}`)
            }
            const safety = applyClearOutcome(
              state.safety,
              prepared.outcome,
              prepared.terminalAt,
              prepared.postTerminalDelayMs,
            )
            if (safety === undefined) throw new Error('Could not apply Clear safety outcome')
            if (!sameSafety(safety, expectedSafety)) return { state, value: { _tag: 'replan' } }
            let completion = resolveAttemptedClear(state.completion, {
              tweetId: prepared.tweetId,
              scope: prepared.scope,
              result: prepared.result,
              at: prepared.terminalAt,
            })
            if (completion === state.completion)
              throw new Error(
                `Could not resolve terminal Clear ${prepared.tweetId}/${prepared.scope}`,
              )
            completion = pruneResolvedEntry(completion, prepared.tweetId, prepared.terminalAt)
            const resolved = { completion, safety }
            const worklist: ClearWorklistProjection[] =
              entry.manualScopes.has(prepared.scope) &&
              (prepared.result === 'cleared' || prepared.result === 'skipped')
                ? [
                    {
                      tweetId: prepared.tweetId,
                      scope: prepared.scope,
                      state: 'cleared',
                      at: prepared.terminalAt,
                    },
                  ]
                : []
            return {
              state: resolved,
              value: { _tag: 'settled', state: resolved },
              worklist,
            }
          },
        )
        if (result._tag === 'settled') next = result.state
      }
      // oxlint-enable no-await-in-loop
      if (next === undefined) throw new Error('Terminal Clear replan exhausted')
    } catch (error) {
      scheduleTerminalRetry()
      throw error
    }
    if (pendingTerminal === pending) pendingTerminal = undefined
    await input.project()
    await scheduleDecision(canIssueClear(next.safety, input.clock.now()))
  }
  const driveTweet = async (tweetId: string, onlyTabId?: number): Promise<void> => {
    const before = await input.store.snapshot()
    const decision = canIssueClear(before.safety, input.clock.now())
    if (decision._tag !== 'allowed') return await scheduleDecision(decision)
    const entry = before.completion.entries.get(tweetId)
    if (entry === undefined) return
    const drivable = ready(before, entry)
    if (drivable.length === 0) return
    const policy = await input.settings.withClearPolicyTurn(async (settings) => settings)
    const denied = drivable.filter(
      (scope) => entry.clear[scope] === 'reserved' && !permits(entry, scope, policy),
    )
    if (denied.length > 0) {
      const deniedAt = input.clock.now()
      assertTime(deniedAt)
      await input.store.turn([], (state) => {
        let completion = state.completion
        for (const scope of denied)
          completion = releaseReservedClear(completion, tweetId, scope, deniedAt)
        return {
          state: completion === state.completion ? state : { ...state, completion },
          value: undefined,
        }
      })
    }
    const scopes = drivable.filter((scope) => permits(entry, scope, policy))
    if (scopes.length === 0) return
    const allLists = scopes.some(
      (scope) => clearScopeIntent(entry, scope) === 'cross-list-automatic',
    )
    const located = (
      await input.tabs.locateClearTweet(tweetId, scopes, onlyTabId, allLists)
    ).filter(({ tabId }) => onlyTabId === undefined || tabId === onlyTabId)
    const actionable = new Set<Scope>(),
      alreadyEvidence = new Set<Scope>()
    for (const { response } of located)
      for (const result of response.results ?? []) {
        if (!scopes.includes(result.scope)) continue
        if (result.state === 'actionable') actionable.add(result.scope)
        else if (result.state === 'already-clear') alreadyEvidence.add(result.scope)
      }
    const already = new Set([...alreadyEvidence].filter((scope) => !actionable.has(scope)))
    if (already.size > 0) {
      const alreadyAt = input.clock.now()
      assertTime(alreadyAt)
      await input.store.turn(
        [...already].map((scope) => [tweetId, scope] as const),
        (state) => {
          let completion = state.completion
          const worklist: ClearWorklistProjection[] = []
          for (const scope of already) {
            const current = completion.entries.get(tweetId)
            const manual = current?.manualScopes.has(scope) ?? false
            const beforeScope = current?.clear[scope]
            completion = releaseReservedClear(completion, tweetId, scope, alreadyAt)
            completion = skipReadyClear(completion, tweetId, scope, alreadyAt)
            if (
              manual &&
              beforeScope !== undefined &&
              completion.entries.get(tweetId)?.clear[scope] !== beforeScope
            )
              worklist.push({
                tweetId,
                scope,
                state: 'cleared',
                at: alreadyAt,
              })
          }
          completion = pruneResolvedEntry(completion, tweetId, alreadyAt)
          return {
            state: completion === state.completion ? state : { ...state, completion },
            value: undefined,
            worklist,
          }
        },
      )
      await input.project()
    }
    const candidate = located.find(({ response }) =>
      (response.results ?? []).some(
        (result) =>
          scopes.includes(result.scope) &&
          result.state === 'actionable' &&
          !already.has(result.scope),
      ),
    )
    if (candidate === undefined) return
    const scope = scopes.find((candidateScope) =>
      (candidate.response.results ?? []).some(
        (result) => result.scope === candidateScope && result.state === 'actionable',
      ),
    )
    if (scope === undefined) return
    // A verified click produces terminal Worklist evidence. Establish its
    // recovery lane before reserving or issuing the irreversible action.
    await input.ensureProjectionWake()
    const reserveAt = input.clock.now()
    assertTime(reserveAt)
    // The serialized drive owns an earlier durable reservation. No side effect
    // has happened yet; resume it after a deadline or failed pre-send turn.
    const reserved =
      entry.clear[scope] === 'reserved' ||
      (await input.store.turn([[tweetId, scope]], (state) => {
        const completion = reserveClear(state.completion, tweetId, scope, reserveAt)
        const won =
          completion !== state.completion &&
          completion.entries.get(tweetId)?.clear[scope] === 'reserved'
        return { state: won ? { ...state, completion } : state, value: won }
      }))
    if (!reserved) return
    try {
      await input.settings.withClearPolicyTurn(async (settings) => {
        await flushTerminal()
        const postTerminalDelayMs = sampleDelay()
        const attemptAt = input.clock.now()
        assertTime(attemptAt)
        const attempt = await input.store.turn<ClearIssueResult>([[tweetId, scope]], (state) => {
          const current = state.completion.entries.get(tweetId)
          if (current === undefined || current.clear[scope] !== 'reserved')
            return { state, value: { issued: false } }
          if (!isTrulyCompleteDurable(current) || !permits(current, scope, settings)) {
            const completion = releaseReservedClear(state.completion, tweetId, scope, attemptAt)
            return {
              state: completion === state.completion ? state : { ...state, completion },
              value: { issued: false },
            }
          }
          const at = attemptAt
          const issueDecision = canIssueClear(state.safety, at)
          if (issueDecision._tag !== 'allowed')
            return { state, value: { issued: false, decision: issueDecision } }
          const safety = issueClear(state.safety, at),
            completion = attemptReservedClear(state.completion, tweetId, scope, at)
          if (
            safety === undefined ||
            completion === state.completion ||
            completion.entries.get(tweetId)?.clear[scope] !== 'attempted'
          )
            throw new Error(`Could not issue Clear ${tweetId}/${scope}`)
          return {
            state: { completion, safety },
            value: {
              issued: true,
              at,
              allLists: clearScopeIntent(current, scope) === 'cross-list-automatic',
            },
          }
        })
        if (!attempt.issued) {
          if (attempt.decision !== undefined) await scheduleDecision(attempt.decision)
          return
        }
        let response
        try {
          response = await input.tabs.clearTweetInTab(
            candidate.tabId,
            tweetId,
            [scope],
            attempt.allLists,
          )
        } catch {
          response = undefined
        }
        pendingTerminal = {
          tweetId,
          scope,
          ...terminalResult(response, scope),
          terminalAt: Math.max(attempt.at, input.clock.now()),
          postTerminalDelayMs,
        }
        await flushTerminal()
      })
    } catch (error) {
      const releaseAt = input.clock.now()
      assertTime(releaseAt)
      try {
        await input.store.turn([[tweetId, scope]], (state) => {
          const completion = releaseReservedClear(state.completion, tweetId, scope, releaseAt)
          return {
            state: completion === state.completion ? state : { ...state, completion },
            value: undefined,
          }
        })
      } catch (releaseError) {
        input.trace('clear-reservation-release-error', {
          tweetId,
          detail: releaseError instanceof Error ? releaseError.message : String(releaseError),
        })
      }
      throw error
    }
  }
  const driveReadyImpl: ClearDestructiveDrive['driveReady'] = async (value = {}) => {
    if (
      value.onlyTabId !== undefined &&
      (!Number.isInteger(value.onlyTabId) || value.onlyTabId < 0)
    )
      throw new TypeError(`Invalid tab id: ${value.onlyTabId}`)
    value.tweetIds?.forEach(assertTweetId)
    await input.store.initialize()
    if (!input.store.isGateOpen()) return
    await flushTerminal()
    const state = await input.store.snapshot()
    const selected = value.tweetIds === undefined ? undefined : new Set(value.tweetIds)
    const tweetIds = [...state.completion.entries.values()]
      .filter((entry) => selected === undefined || selected.has(entry.tweetId))
      .filter((entry) => ready(state, entry).length > 0)
      .map((entry) => entry.tweetId)
    // oxlint-disable-next-line no-await-in-loop -- each issue persists shared cadence and budget before the next.
    for (const tweetId of tweetIds) await driveTweet(tweetId, value.onlyTabId)
  }
  const driveReady: ClearDestructiveDrive['driveReady'] = async (value = {}) =>
    await driveSerial.run(async () => await driveReadyImpl(value))
  return {
    driveReady,
    onSafetyWake: async () => {
      await input.store.adoptExternalSession()
      await driveReady()
    },
  }
}
