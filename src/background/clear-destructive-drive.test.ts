import { Schema } from 'effect'
import { expect, it, vi } from 'vitest'
import {
  emptyCompletionLedger,
  reserveClear,
  type CompletionLedgerEntry,
  type Scope,
} from '../core/clear/ledger'
import { initialClearSafetyState } from '../core/clear/safety'
import { Settings as SettingsSchema } from '../core/schema'
import { makeClearDestructiveDrive } from './clear-destructive-drive'
import type { ClearTabs } from './clear-ports'
import type { ClearClock, ClearStateStore, CoordinatorState } from './clear-state-store'

const TWEET_ID = '123'
const REQUEST_ID = 'request-a'

const readyState = (): CoordinatorState => {
  const completion = emptyCompletionLedger()
  const entry: CompletionLedgerEntry = {
    tweetId: TWEET_ID,
    manualScopes: new Set(),
    automaticScopes: new Set<Scope>(['bookmark']),
    crossListAutomaticScopes: new Set(),
    expected: new Set([REQUEST_ID]),
    done: new Set([REQUEST_ID]),
    failed: new Set(),
    inProgress: new Set(),
    clear: { bookmark: 'none', like: 'none', notInterested: 'none' },
    handles: {},
    settling: {},
    createdAt: 0,
    touchedAt: 0,
  }
  const safety = initialClearSafetyState(1)
  if (safety === undefined) throw new Error('invalid test safety')
  return {
    completion: { ...completion, entries: new Map([[TWEET_ID, entry]]) },
    safety,
  }
}

it('retains a safe reservation across a deadline, then resumes it once', async () => {
  const initial = readyState()
  let state = {
    ...initial,
    completion: reserveClear(initial.completion, TWEET_ID, 'bookmark', 9),
    safety: { ...initial.safety, nextAttemptAt: 20 },
  }
  let now = 10
  const turn: ClearStateStore['turn'] = async (_keys, transition) => {
    const result = transition(state)
    state = result.state
    return result.value
  }
  const store: ClearStateStore = {
    initialize: async () => {},
    turn,
    turnWithRevision: async (keys, transition) => ({
      value: await turn(keys, transition),
      revision: 1,
    }),
    snapshot: async () => state,
    listClearLog: async () => [],
    listWorklistProjections: async () => [],
    ackWorklistProjection: async () => 'missing',
    armWorklistWake: async () => {},
    prepareRecovery: () => (current) => current,
    activeTombstoneKeys: async () => [],
    isGateOpen: () => true,
    onBrowserStartup: async () => true,
    adoptExternalSession: async () => {},
  }
  const wake = vi.fn<(at: number) => Promise<void>>(async () => {})
  const clearTweetInTab = vi.fn<ClearTabs['clearTweetInTab']>(async (_tabId, _tweetId, scopes) => ({
    _tag: 'ClearTweetResponse',
    results: scopes.map((scope) => ({ scope, state: 'cleared' as const })),
  }))
  const settings = Schema.decodeUnknownSync(SettingsSchema)({
    clearOnSave: true,
    autoUnbookmarkOnSave: true,
  })
  const drive = makeClearDestructiveDrive({
    store,
    clock: { now: () => now, schedule: () => {} },
    wake: { schedule: wake },
    tabs: {
      locateClearTweet: async () => [
        {
          tabId: 1,
          response: {
            _tag: 'LocateClearTweetResponse',
            mounted: true,
            results: [{ scope: 'bookmark', state: 'actionable' }],
          },
        },
      ],
      clearTweetInTab,
    },
    settings: { withClearPolicyTurn: async (callback) => await callback(settings) },
    trace: () => {},
    project: async () => {},
    ensureProjectionWake: async () => {},
    postTerminalDelay: () => 2000,
  })

  await drive.driveReady()
  expect(wake).toHaveBeenCalledWith(20)
  expect(clearTweetInTab).not.toHaveBeenCalled()
  expect(state.completion.entries.get(TWEET_ID)?.clear.bookmark).toBe('reserved')

  now = 20
  await drive.driveReady()
  expect(clearTweetInTab).toHaveBeenCalledTimes(1)
  expect(state.completion.tombstones.get(TWEET_ID)?.get('bookmark')?.state).toBe('cleared')
})

it('replans terminal feedback after a CAS winner changes safety', async () => {
  let state = readyState()
  let now = 10
  let injectedConflict = false
  let stalePlanCommitted = false
  let terminalTransitionCalls = 0
  const turn: ClearStateStore['turn'] = async (_keys, transition) => {
    const terminal = state.completion.entries.get(TWEET_ID)?.clear.bookmark === 'attempted'
    if (terminal) terminalTransitionCalls += 1
    const planned = transition(state)
    if (!terminal || injectedConflict) {
      state = planned.state
      return planned.value
    }
    injectedConflict = true
    state = {
      ...state,
      safety: { ...state.safety, attemptAts: [...state.safety.attemptAts, 11] },
    }
    terminalTransitionCalls += 1
    const rebased = transition(state)
    stalePlanCommitted = rebased.state !== state
    state = rebased.state
    return rebased.value
  }
  const store: ClearStateStore = {
    initialize: async () => {},
    turn,
    turnWithRevision: async (keys, transition) => ({
      value: await turn(keys, transition),
      revision: 1,
    }),
    snapshot: async () => state,
    listClearLog: async () => [],
    listWorklistProjections: async () => [],
    ackWorklistProjection: async () => 'missing',
    armWorklistWake: async () => {},
    prepareRecovery: () => (current) => current,
    activeTombstoneKeys: async () => [],
    isGateOpen: () => true,
    onBrowserStartup: async () => true,
    adoptExternalSession: async () => {},
  }
  const clock: ClearClock = {
    now: () => now,
    schedule: () => {},
  }
  const settings = Schema.decodeUnknownSync(SettingsSchema)({
    clearOnSave: true,
    autoUnbookmarkOnSave: true,
  })
  const clearTweetInTab = vi.fn<ClearTabs['clearTweetInTab']>(async () => {
    now = 11
    return undefined
  })
  const drive = makeClearDestructiveDrive({
    store,
    clock,
    wake: { schedule: async () => {} },
    tabs: {
      locateClearTweet: async () => [
        {
          tabId: 1,
          response: {
            _tag: 'LocateClearTweetResponse',
            mounted: true,
            results: [{ scope: 'bookmark', state: 'actionable' }],
          },
        },
      ],
      clearTweetInTab,
    },
    settings: { withClearPolicyTurn: async (callback) => await callback(settings) },
    trace: () => {},
    project: async () => {},
    ensureProjectionWake: async () => {},
    postTerminalDelay: () => 2000,
  })

  await drive.driveReady()

  expect(stalePlanCommitted).toBe(false)
  expect(terminalTransitionCalls).toBe(3)
  expect(clearTweetInTab).toHaveBeenCalledTimes(1)
  expect(state.safety).toMatchObject({
    attemptAts: [10, 11],
    failureStreak: 1,
    nextAttemptAt: 2011,
  })
  expect(state.completion.tombstones.get(TWEET_ID)?.get('bookmark')).toMatchObject({
    state: 'uncertain',
    at: 11,
  })
})

it('establishes terminal projection recovery before an irreversible Clear', async () => {
  let state = readyState()
  const store: ClearStateStore = {
    initialize: async () => {},
    turn: async (_keys, transition) => {
      const result = transition(state)
      state = result.state
      return result.value
    },
    turnWithRevision: async (_keys, transition) => {
      const result = transition(state)
      state = result.state
      return { value: result.value, revision: 1 }
    },
    snapshot: async () => state,
    listClearLog: async () => [],
    listWorklistProjections: async () => [],
    ackWorklistProjection: async () => 'missing',
    armWorklistWake: async () => {},
    prepareRecovery: () => (current) => current,
    activeTombstoneKeys: async () => [],
    isGateOpen: () => true,
    onBrowserStartup: async () => true,
    adoptExternalSession: async () => {},
  }
  const settings = Schema.decodeUnknownSync(SettingsSchema)({
    clearOnSave: true,
    autoUnbookmarkOnSave: true,
  })
  const clearTweetInTab = vi.fn<ClearTabs['clearTweetInTab']>()
  const drive = makeClearDestructiveDrive({
    store,
    clock: { now: () => 10, schedule: () => {} },
    wake: { schedule: async () => {} },
    tabs: {
      locateClearTweet: async () => [
        {
          tabId: 1,
          response: {
            _tag: 'LocateClearTweetResponse',
            mounted: true,
            results: [{ scope: 'bookmark', state: 'actionable' }],
          },
        },
      ],
      clearTweetInTab,
    },
    settings: { withClearPolicyTurn: async (callback) => await callback(settings) },
    trace: () => {},
    project: async () => {},
    ensureProjectionWake: async () => {
      throw new Error('alarms unavailable')
    },
    postTerminalDelay: () => 2000,
  })

  await expect(drive.driveReady()).rejects.toThrow('alarms unavailable')

  expect(clearTweetInTab).not.toHaveBeenCalled()
  expect(state.completion.entries.get(TWEET_ID)?.clear.bookmark).toBe('none')
})
