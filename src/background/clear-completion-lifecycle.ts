import {
  SETTLE_CONFIRM_MS,
  bindCompletionHandle,
  rebindPersistedHandle as rebindPersistedHandleTransition,
  failCompletion,
  failUnboundCompletion,
  isTrulyCompleteDurable,
  observeCompletion,
  pruneExpiredAutomaticFailures,
  seedCompletionEntry,
  settleCompletion,
  type ClearLogRecord,
  type Scope,
  type SettleWitness,
} from '../core/clear/ledger'
import { didLand } from '../core/clear/settle'
import type { ClearDownloadSearch, ClearWakePort } from './clear-ports'
import { MAX_CLEAR_CLOCK_DELAY_MS } from './clear-state-ports'
import type {
  ClearWorklistProjection,
  ClearWorklistProjectionState,
} from './clear-worklist-projection'
import {
  assertDownloadId,
  assertRequestId,
  assertTime,
  assertTweetId,
  MAX_CLEAR_ACTIVE_POSTS,
  MAX_CLEAR_REQUESTS_PER_POST,
  type ClearClock,
  type ClearCoordinatorTrace,
  type ClearStateStore,
  unique,
} from './clear-state-store'

const SETTLE_PROBE_RETRY_MS = 1000
const CLEAR_ALARM_WATCHDOG_MS = 30_000
const RECONCILE_PROBE_CONCURRENCY = 8
export const CLEAR_FAILED_RETENTION_MS = 24 * 60 * 60 * 1000
const key = (tweetId: string, requestId: string, downloadId: number): string =>
  `${tweetId}\u0000${requestId}\u0000${downloadId}`
type SettleOutcome =
  | { readonly kind: 'stale' }
  | { readonly kind: 'retry'; readonly witness: SettleWitness }
  | {
      readonly kind: 'settled' | 'failed'
      readonly complete: boolean
    }
type TerminalOutcome =
  | { readonly kind: 'stale' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'complete'
      readonly witness: SettleWitness
    }

const projectScopes = (
  tweetId: string,
  scopes: Iterable<Scope>,
  state: ClearWorklistProjectionState,
  at: number,
): ClearWorklistProjection[] => [...scopes].map((scope) => ({ tweetId, scope, state, at }))

export interface SeedClearInput {
  readonly byTweet: ReadonlyMap<string, ReadonlyArray<string>>
  readonly startingByTweet: ReadonlyMap<string, ReadonlyArray<string>>
  readonly manualScopes: ReadonlyArray<Scope>
  readonly automaticScopes: ReadonlyArray<Scope>
  readonly crossListAutomaticScopes: ReadonlyArray<Scope>
}
export interface SeedClearResult {
  readonly trackedByTweet: ReadonlyMap<string, ReadonlySet<string>>
  /** Clear-store revision committed by this seed; fences older Worklist projections. */
  readonly worklistRevision: number
}

export interface ClearCompletionLifecycle {
  readonly seed: (input: SeedClearInput) => Promise<SeedClearResult>
  readonly bindStarted: (input: {
    readonly tweetId: string
    readonly requestId: string
    readonly downloadId: number
    readonly at?: number
  }) => Promise<void>
  readonly rebindPersistedHandle: (input: {
    readonly tweetId: string
    readonly requestId: string
    readonly downloadId: number
    readonly priorDownloadId?: number
    readonly at?: number
  }) => Promise<void>
  readonly failUnbound: (input: {
    readonly tweetId: string
    readonly requestId: string
    readonly at?: number
  }) => Promise<void>
  /** Explicit recovery opt-out. It never claims a download reached a terminal state. */
  readonly abandonTransfer: (input: {
    readonly tweetId: string
    readonly requestId: string
    readonly downloadId?: number
    readonly at?: number
  }) => Promise<void>
  readonly recordTerminal: (input: {
    readonly tweetId: string
    readonly requestId: string
    readonly downloadId: number
    readonly outcome: 'complete' | 'failed'
    readonly at?: number
  }) => Promise<void>
  readonly reconcileOnBoot: (input: {
    readonly retryOwnedRequestIds: ReadonlySet<string>
  }) => Promise<void>
  readonly probeDueSettles: (input: {
    readonly retryOwnedRequestIds: ReadonlySet<string>
  }) => Promise<void>
  readonly listClearLog: () => Promise<ReadonlyArray<ClearLogRecord>>
}

const assertScopes = (value: SeedClearInput): void => {
  for (const scopes of [value.manualScopes, value.automaticScopes, value.crossListAutomaticScopes])
    if (
      !scopes.every((scope) => ['bookmark', 'like', 'notInterested'].includes(scope)) ||
      !unique(scopes)
    )
      throw new TypeError('Clear scopes must be unique')
  if (value.manualScopes.length + value.automaticScopes.length === 0)
    throw new TypeError('At least one Clear scope is required')
  if (!value.crossListAutomaticScopes.every((scope) => value.automaticScopes.includes(scope)))
    throw new TypeError('Cross-list scopes must be automatic scopes')
}

export const makeClearCompletionLifecycle = (input: {
  readonly store: ClearStateStore
  readonly clock: ClearClock
  readonly wake: ClearWakePort
  readonly downloadSearch: ClearDownloadSearch
  readonly trace: (stage: string, context?: ClearCoordinatorTrace) => void
  readonly project: () => Promise<void>
  readonly onReady: (tweetIds?: ReadonlyArray<string>) => Promise<void>
}): ClearCompletionLifecycle => {
  const scheduled = new Map<string, number>()
  let settleProbeNotBefore = 0
  const watchdogAt = (dueAt: number): number => {
    const now = input.clock.now()
    assertTime(now)
    return Math.max(
      dueAt,
      now > Number.MAX_SAFE_INTEGER - CLEAR_ALARM_WATCHDOG_MS
        ? Number.MAX_SAFE_INTEGER
        : now + CLEAR_ALARM_WATCHDOG_MS,
    )
  }
  const armSettleWake = async (dueAts: ReadonlyArray<number>): Promise<void> => {
    const next = dueAts.reduce<number | undefined>((earliest, dueAt) => {
      const at = watchdogAt(dueAt)
      return earliest === undefined ? at : Math.min(earliest, at)
    }, undefined)
    if (next !== undefined) await input.wake.schedule(next)
  }
  const scheduleSettle = (
    tweetId: string,
    requestId: string,
    witness: SettleWitness,
    retryDelay?: number,
  ): void => {
    const timer = key(tweetId, requestId, witness.downloadId)
    const now = input.clock.now()
    assertTime(now)
    const retryAt =
      retryDelay === undefined
        ? witness.dueAt
        : now > Number.MAX_SAFE_INTEGER - retryDelay
          ? Number.MAX_SAFE_INTEGER
          : now + retryDelay
    const runAt = Math.max(witness.dueAt, settleProbeNotBefore, retryAt)
    if (scheduled.get(timer) === runAt) return
    scheduled.set(timer, runAt)
    const scheduleHop = (): void => {
      if (scheduled.get(timer) !== runAt) return
      const observedAt = input.clock.now()
      assertTime(observedAt)
      const remaining = Math.max(0, runAt - observedAt)
      const delay = Math.min(remaining, MAX_CLEAR_CLOCK_DELAY_MS)
      try {
        input.clock.schedule(() => {
          if (scheduled.get(timer) !== runAt) return
          const firedAt = input.clock.now()
          assertTime(firedAt)
          if (firedAt < runAt) {
            scheduleHop()
            return
          }
          scheduled.delete(timer)
          void settle(tweetId, requestId, witness.downloadId).catch((error: unknown) => {
            input.trace('clear-settle-error', {
              tweetId,
              requestId,
              detail: error instanceof Error ? error.message : String(error),
            })
            if (!(error instanceof Error && error.name === 'ClearCoordinatorCorruptionError'))
              scheduleSettle(tweetId, requestId, witness, SETTLE_PROBE_RETRY_MS)
          })
        }, delay)
      } catch (error) {
        if (scheduled.get(timer) === runAt) scheduled.delete(timer)
        throw error
      }
    }
    scheduleHop()
  }
  const settle = async (tweetId: string, requestId: string, downloadId: number): Promise<void> => {
    const snapshot = await input.store.snapshot()
    const expectedWitness = snapshot.completion.entries.get(tweetId)?.settling[requestId]
    if (expectedWitness?.downloadId !== downloadId) return
    let row: Awaited<ReturnType<ClearDownloadSearch['search']>>
    try {
      row = await input.downloadSearch.search(downloadId)
    } catch (error) {
      input.trace('clear-settle-search-error', {
        tweetId,
        requestId,
        detail: error instanceof Error ? error.message : String(error),
      })
      scheduleSettle(tweetId, requestId, expectedWitness, SETTLE_PROBE_RETRY_MS)
      return
    }
    const observedAt = input.clock.now()
    assertTime(observedAt)
    const outcome = await input.store.turn<SettleOutcome>([], (state) => {
      const before = state.completion.entries.get(tweetId)
      const witness = before?.settling[requestId]
      if (witness?.downloadId !== downloadId) return { state, value: { kind: 'stale' } }
      if (row?.state === 'in_progress' && row.exists !== false)
        return { state, value: { kind: 'retry', witness } }
      const landed = didLand(row)
      const at = observedAt
      const completion = landed
        ? settleCompletion(state.completion, {
            tweetId,
            requestId,
            downloadId,
            at,
          })
        : failCompletion(state.completion, {
            tweetId,
            requestId,
            downloadId,
            at,
          })
      if (landed && completion === state.completion)
        return { state, value: { kind: 'retry', witness } }
      const after = completion.entries.get(tweetId)
      return {
        state: completion === state.completion ? state : { ...state, completion },
        value: {
          kind: landed ? 'settled' : 'failed',
          complete:
            before !== undefined &&
            after !== undefined &&
            !isTrulyCompleteDurable(before) &&
            isTrulyCompleteDurable(after),
        },
        worklist: landed
          ? before !== undefined &&
            after !== undefined &&
            !isTrulyCompleteDurable(before) &&
            isTrulyCompleteDurable(after)
            ? projectScopes(tweetId, after.manualScopes, 'downloaded', at)
            : []
          : projectScopes(tweetId, before?.manualScopes ?? [], 'failed', at),
      }
    })
    if (outcome.kind === 'retry')
      return scheduleSettle(tweetId, requestId, outcome.witness, SETTLE_PROBE_RETRY_MS)
    if (outcome.kind === 'settled' && outcome.complete) {
      await input.project()
      await input.onReady([tweetId])
    } else if (outcome.kind === 'failed') await input.project()
  }
  const probeDueSettles: ClearCompletionLifecycle['probeDueSettles'] = async (value) => {
    const snapshot = await input.store.snapshot()
    const settles = [...snapshot.completion.entries].flatMap(([tweetId, entry]) =>
      Object.entries(entry.settling).flatMap(([requestId, witness]) =>
        value.retryOwnedRequestIds.has(requestId) ? [] : [{ tweetId, requestId, witness }],
      ),
    )
    await armSettleWake(settles.map(({ witness }) => Math.max(witness.dueAt, settleProbeNotBefore)))
    for (const { tweetId, requestId, witness } of settles)
      scheduleSettle(tweetId, requestId, witness)
    const now = input.clock.now()
    assertTime(now)
    const due = settles.filter(
      ({ witness }) => Math.max(witness.dueAt, settleProbeNotBefore) <= now,
    )
    let nextProbe = 0
    const probe = async (): Promise<void> => {
      while (nextProbe < due.length) {
        const current = due[nextProbe]
        nextProbe += 1
        if (current === undefined) return
        // oxlint-disable-next-line no-await-in-loop -- one lane in the bounded probe pool.
        await settle(current.tweetId, current.requestId, current.witness.downloadId)
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(RECONCILE_PROBE_CONCURRENCY, due.length) },
        async () => await probe(),
      ),
    )
  }
  const seed = async (value: SeedClearInput): Promise<SeedClearResult> => {
    assertScopes(value)
    if (value.byTweet.size === 0) throw new TypeError('Seed must contain a tweet')
    if (value.byTweet.size > MAX_CLEAR_ACTIVE_POSTS)
      throw new TypeError(`Seed must contain at most ${MAX_CLEAR_ACTIVE_POSTS} tweets`)
    const at = input.clock.now()
    assertTime(at)
    for (const [tweetId, requestIds] of value.byTweet) {
      assertTweetId(tweetId)
      if (requestIds.length > MAX_CLEAR_REQUESTS_PER_POST)
        throw new TypeError(
          `Expected at most ${MAX_CLEAR_REQUESTS_PER_POST} request ids for ${tweetId}`,
        )
      if (requestIds.length === 0 || !unique(requestIds))
        throw new TypeError(`Expected request ids must be unique and nonempty for ${tweetId}`)
      requestIds.forEach(assertRequestId)
      const starting = value.startingByTweet.get(tweetId)
      if (
        starting === undefined ||
        starting.length === 0 ||
        !unique(starting) ||
        !starting.every((id) => requestIds.includes(id))
      )
        throw new TypeError(
          `Starting request ids must be a nonempty expected subset for ${tweetId}`,
        )
    }
    for (const tweetId of value.startingByTweet.keys())
      if (!value.byTweet.has(tweetId))
        throw new TypeError(`Starting requests have no expected tweet ${tweetId}`)
    const scopes = [...new Set([...value.manualScopes, ...value.automaticScopes])]
    const tombstoneKeys = [...value.byTweet.keys()].flatMap((tweetId) =>
      scopes.map((scope) => [tweetId, scope] as const),
    )
    const result = await input.store.turnWithRevision(tombstoneKeys, (state) => {
      let completion =
        at < CLEAR_FAILED_RETENTION_MS
          ? state.completion
          : pruneExpiredAutomaticFailures(state.completion, at - CLEAR_FAILED_RETENTION_MS)
      const worklist: ClearWorklistProjection[] = []
      for (const [tweetId, expected] of value.byTweet) {
        completion = seedCompletionEntry(completion, {
          tweetId,
          expected,
          starting: value.startingByTweet.get(tweetId)!,
          manualScopes: value.manualScopes,
          automaticScopes: value.automaticScopes,
          crossListAutomaticScopes: value.crossListAutomaticScopes,
          at,
        })
        const entry = completion.entries.get(tweetId)
        const tombstones = completion.tombstones.get(tweetId)
        for (const scope of value.manualScopes) {
          const tombstone = tombstones?.get(scope)
          if (tombstone?.state === 'cleared')
            worklist.push({
              tweetId,
              scope,
              state: 'cleared',
              at: tombstone.at,
            })
        }
        const allTombstoned = [...value.manualScopes, ...value.automaticScopes].every((scope) =>
          tombstones?.has(scope),
        )
        const tracked =
          value.manualScopes
            .filter((scope) => !tombstones?.has(scope))
            .every((scope) => entry?.manualScopes.has(scope)) &&
          value.automaticScopes
            .filter((scope) => !tombstones?.has(scope))
            .every((scope) => entry?.automaticScopes.has(scope))
        if (
          !allTombstoned &&
          (!tracked ||
            !value.startingByTweet
              .get(tweetId)!
              .every(
                (id) =>
                  entry?.expected.has(id) &&
                  entry.inProgress.has(id) &&
                  !entry.done.has(id) &&
                  !entry.failed.has(id) &&
                  entry.handles[id] === undefined &&
                  entry.settling[id] === undefined,
              ))
        )
          throw new Error(`Could not restart active Clear entry ${tweetId}`)
      }
      const trackedByTweet = new Map<string, ReadonlySet<string>>()
      for (const [tweetId, starting] of value.startingByTweet) {
        const entry = completion.entries.get(tweetId)
        if (entry !== undefined)
          trackedByTweet.set(tweetId, new Set(starting.filter((id) => entry.expected.has(id))))
      }
      return {
        state: completion === state.completion ? state : { ...state, completion },
        value: { trackedByTweet },
        worklist,
      }
    })
    await input.project()
    return { ...result.value, worklistRevision: result.revision }
  }
  const bindStarted: ClearCompletionLifecycle['bindStarted'] = async (value) => {
    assertTweetId(value.tweetId)
    assertRequestId(value.requestId)
    assertDownloadId(value.downloadId)
    const at = value.at ?? input.clock.now()
    assertTime(at)
    await input.store.turn([], (state) => {
      const before = state.completion.entries.get(value.tweetId)
      if (before === undefined || !before.expected.has(value.requestId))
        throw new Error(`Cannot bind untracked request ${value.requestId}`)
      if (
        before.handles[value.requestId]?.downloadId === value.downloadId ||
        before.settling[value.requestId]?.downloadId === value.downloadId
      )
        return { state, value: undefined }
      const completion = bindCompletionHandle(state.completion, {
        ...value,
        at,
      })
      if (
        completion.entries.get(value.tweetId)?.handles[value.requestId]?.downloadId !==
        value.downloadId
      )
        throw new Error(`Could not bind download ${value.downloadId}`)
      return { state: { ...state, completion }, value: undefined }
    })
  }
  const rebindPersistedHandle: ClearCompletionLifecycle['rebindPersistedHandle'] = async (
    value,
  ) => {
    assertTweetId(value.tweetId)
    assertRequestId(value.requestId)
    assertDownloadId(value.downloadId)
    if (value.priorDownloadId !== undefined) assertDownloadId(value.priorDownloadId)
    const at = value.at ?? input.clock.now()
    assertTime(at)
    await input.store.turn([], (state) => {
      const completion = rebindPersistedHandleTransition(state.completion, {
        ...value,
        at,
      })
      return {
        state: completion === state.completion ? state : { ...state, completion },
        value: undefined,
      }
    })
  }
  const failUnbound: ClearCompletionLifecycle['failUnbound'] = async (value) => {
    assertTweetId(value.tweetId)
    assertRequestId(value.requestId)
    const at = value.at ?? input.clock.now()
    assertTime(at)
    const changed = await input.store.turn([], (state) => {
      const before = state.completion.entries.get(value.tweetId)
      if (before === undefined || !before.expected.has(value.requestId))
        throw new Error(`Cannot fail untracked request ${value.requestId}`)
      if (before.failed.has(value.requestId) && !before.inProgress.has(value.requestId))
        return { state, value: false }
      const completion = failUnboundCompletion(state.completion, {
        ...value,
        at,
      })
      if (!completion.entries.get(value.tweetId)?.failed.has(value.requestId))
        throw new Error(`Request ${value.requestId} is bound; exact handle required`)
      return {
        state: { ...state, completion },
        value: true,
        worklist: projectScopes(value.tweetId, before.manualScopes, 'failed', at),
      }
    })
    if (changed) await input.project()
  }
  const abandonTransfer: ClearCompletionLifecycle['abandonTransfer'] = async (value) => {
    assertTweetId(value.tweetId)
    assertRequestId(value.requestId)
    if (value.downloadId !== undefined) assertDownloadId(value.downloadId)
    const at = value.at ?? input.clock.now()
    assertTime(at)
    const changed = await input.store.turn([], (state) => {
      const before = state.completion.entries.get(value.tweetId)
      if (before === undefined || !before.expected.has(value.requestId))
        return { state, value: false }
      if (before.failed.has(value.requestId) && !before.inProgress.has(value.requestId))
        return { state, value: false }
      const completion =
        value.downloadId === undefined
          ? failUnboundCompletion(state.completion, { ...value, at })
          : failCompletion(state.completion, {
              ...value,
              downloadId: value.downloadId,
              at,
            })
      if (!completion.entries.get(value.tweetId)?.failed.has(value.requestId))
        throw new Error(`Cannot abandon request ${value.requestId} without its exact handle`)
      return {
        state: { ...state, completion },
        value: true,
        worklist: projectScopes(value.tweetId, before.manualScopes, 'failed', at),
      }
    })
    if (changed) await input.project()
  }
  const recordTerminal: ClearCompletionLifecycle['recordTerminal'] = async (value) => {
    assertTweetId(value.tweetId)
    assertRequestId(value.requestId)
    assertDownloadId(value.downloadId)
    const at = value.at ?? input.clock.now()
    assertTime(at)
    if (value.outcome === 'complete' && at > Number.MAX_SAFE_INTEGER - SETTLE_CONFIRM_MS)
      throw new TypeError('Completion timestamp is too large')
    if (value.outcome === 'complete') await armSettleWake([at + SETTLE_CONFIRM_MS])
    const result = await input.store.turn<TerminalOutcome>([], (state) => {
      const before = state.completion.entries.get(value.tweetId)
      if (before === undefined || !before.expected.has(value.requestId))
        return { state, value: { kind: 'stale' } }
      const handle = before.handles[value.requestId]
      const settling = before.settling[value.requestId]
      if (handle?.downloadId !== value.downloadId && settling?.downloadId !== value.downloadId)
        return { state, value: { kind: 'stale' } }
      if (value.outcome === 'failed') {
        const completion = failCompletion(state.completion, { ...value, at })
        return {
          state: { ...state, completion },
          value: { kind: 'failed' },
          worklist: projectScopes(value.tweetId, before.manualScopes, 'failed', at),
        }
      }
      if (settling?.downloadId === value.downloadId)
        return {
          state,
          value: { kind: 'complete', witness: settling },
        }
      const completion = observeCompletion(state.completion, {
        ...value,
        at,
      })
      const witness = completion.entries.get(value.tweetId)?.settling[value.requestId]
      if (witness?.downloadId !== value.downloadId)
        throw new Error(`Could not observe completion ${value.downloadId}`)
      return {
        state: { ...state, completion },
        value: { kind: 'complete', witness },
      }
    })
    if (result.kind === 'complete') scheduleSettle(value.tweetId, value.requestId, result.witness)
    else if (result.kind === 'failed') await input.project()
  }
  const reconcileOnBoot: ClearCompletionLifecycle['reconcileOnBoot'] = async (value) => {
    await input.store.initialize()
    const snapshot = await input.store.snapshot()
    const snapshotAt = input.clock.now()
    assertTime(snapshotAt)
    if (snapshotAt > Number.MAX_SAFE_INTEGER - SETTLE_CONFIRM_MS)
      throw new TypeError('Completion timestamp is too large')
    // A persisted deadline can be old because the wall clock moved or state was
    // malformed. A fresh worker never treats it as a completed settle delay.
    settleProbeNotBefore = snapshotAt + SETTLE_CONFIRM_MS
    await armSettleWake(
      [...snapshot.completion.entries].flatMap(([, entry]) =>
        Object.entries(entry.settling).flatMap(([requestId, witness]) =>
          value.retryOwnedRequestIds.has(requestId)
            ? []
            : [Math.max(witness.dueAt, settleProbeNotBefore)],
        ),
      ),
    )
    const probes = [...snapshot.completion.entries].flatMap(([tweetId, entry]) =>
      Object.entries(entry.handles).flatMap(([requestId, witness]) =>
        value.retryOwnedRequestIds.has(requestId)
          ? []
          : [{ tweetId, requestId, downloadId: witness.downloadId }],
      ),
    )
    const unbound = [...snapshot.completion.entries].flatMap(([tweetId, entry]) =>
      [...entry.inProgress].flatMap((requestId) =>
        entry.handles[requestId] === undefined &&
        entry.settling[requestId] === undefined &&
        !entry.done.has(requestId) &&
        !entry.failed.has(requestId) &&
        !value.retryOwnedRequestIds.has(requestId)
          ? [{ tweetId, requestId }]
          : [],
      ),
    )
    type SearchRow = Awaited<ReturnType<ClearDownloadSearch['search']>>
    const observed = new Map<string, { readonly ok: true; readonly row: SearchRow }>()
    let nextProbe = 0
    const probe = async (): Promise<void> => {
      while (nextProbe < probes.length) {
        const current = probes[nextProbe]
        nextProbe += 1
        if (current === undefined) return
        try {
          // oxlint-disable-next-line no-await-in-loop -- one lane in the bounded probe pool.
          const row = await input.downloadSearch.search(current.downloadId)
          observed.set(key(current.tweetId, current.requestId, current.downloadId), {
            ok: true,
            row,
          })
        } catch (error) {
          input.trace('clear-reconcile-search-error', {
            tweetId: current.tweetId,
            requestId: current.requestId,
            detail: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    await Promise.all(
      Array.from(
        { length: Math.min(RECONCILE_PROBE_CONCURRENCY, probes.length) },
        async () => await probe(),
      ),
    )
    const recoveryKeys = await input.store.activeTombstoneKeys()
    const reconciliationAt = input.clock.now()
    assertTime(reconciliationAt)
    const observesComplete = probes.some(({ tweetId, requestId, downloadId }) => {
      const observation = observed.get(key(tweetId, requestId, downloadId))
      return (
        observation?.row?.state === 'complete' &&
        observation.row.exists !== false &&
        snapshot.completion.entries.get(tweetId)?.handles[requestId]?.downloadId === downloadId
      )
    })
    if (observesComplete) {
      if (reconciliationAt > Number.MAX_SAFE_INTEGER - SETTLE_CONFIRM_MS)
        throw new TypeError('Completion timestamp is too large')
      await armSettleWake([reconciliationAt + SETTLE_CONFIRM_MS])
    }
    const recover = input.store.prepareRecovery(reconciliationAt)
    const result = await input.store.turn(recoveryKeys, (state) => {
      let completion = state.completion
      const failed = new Map<string, Scope[]>()
      for (const { tweetId, requestId, downloadId } of probes) {
        const current = completion.entries.get(tweetId)
        if (current?.handles[requestId]?.downloadId !== downloadId) continue
        const observation = observed.get(key(tweetId, requestId, downloadId))
        if (observation === undefined) continue
        const row = observation.row
        if (row?.state === 'complete' && row.exists !== false)
          completion = observeCompletion(completion, {
            tweetId,
            requestId,
            downloadId,
            at: reconciliationAt,
          })
        else if (row === undefined || row.state === 'interrupted' || row.exists === false) {
          completion = failCompletion(completion, {
            tweetId,
            requestId,
            downloadId,
            at: reconciliationAt,
          })
          failed.set(tweetId, [...current.manualScopes])
        }
      }
      for (const { tweetId, requestId } of unbound) {
        const current = completion.entries.get(tweetId)
        if (
          current === undefined ||
          !current.inProgress.has(requestId) ||
          current.handles[requestId] !== undefined ||
          current.settling[requestId] !== undefined ||
          current.done.has(requestId) ||
          current.failed.has(requestId)
        )
          continue
        completion = failUnboundCompletion(completion, {
          tweetId,
          requestId,
          at: reconciliationAt,
        })
        failed.set(tweetId, [...current.manualScopes])
      }
      const recovered = recover({ completion, safety: state.safety })
      const settles = [...recovered.completion.entries].flatMap(([tweetId, entry]) =>
        Object.entries(entry.settling).flatMap(([requestId, witness]) =>
          value.retryOwnedRequestIds.has(requestId) ? [] : [{ tweetId, requestId, witness }],
        ),
      )
      return {
        state: recovered,
        value: { settles },
        worklist: [...failed].flatMap(([tweetId, scopes]) =>
          projectScopes(tweetId, scopes, 'failed', reconciliationAt),
        ),
      }
    })
    for (const { tweetId, requestId, witness } of result.settles)
      scheduleSettle(tweetId, requestId, witness)
    await probeDueSettles(value)
    await input.project()
    await input.onReady()
  }
  return {
    seed,
    bindStarted,
    rebindPersistedHandle,
    failUnbound,
    abandonTransfer,
    recordTerminal,
    reconcileOnBoot,
    probeDueSettles,
    listClearLog: input.store.listClearLog,
  }
}
