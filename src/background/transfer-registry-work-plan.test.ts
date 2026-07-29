import { describe, expect, it } from 'vitest'
import {
  decodeTransferRegistryStore,
  emptyTransferRegistryStore,
  type LegacyTransferPhase,
  type TransferEntry,
  type TransferPhase,
  type TransferRegistryStore,
  type TransferRequest,
} from '../core/download/transfer-registry'
import {
  planTransferRegistryWork,
  TRANSFER_REGISTRY_PROBE_INTERVAL_MS,
  transferRegistryForgetKey,
  transferRegistryWorkKey,
  type PendingFetchedStagingCleanup,
  type TransferRegistryWork,
  type TransferRegistryWorkPlanInput,
} from './transfer-registry-work-plan'

const NOW = 100
const PROFILE_ID = 'profile-1'
const GID = '0000000000000001'
const profile = {
  profileId: PROFILE_ID,
  rpcUrl: 'http://127.0.0.1:6800/jsonrpc',
  secret: 'secret',
  failureCount: 0,
  nextProbeAt: 95,
}
const options = { split: 4 }

const phases = {
  launching: { tag: 'launching', attempt: 0, since: 80 },
  'direct-prepared': { tag: 'direct-prepared', attempt: 0, since: 80 },
  'direct-ready': { tag: 'direct-ready', attempt: 0, since: 80 },
  'fetched-prepared': { tag: 'fetched-prepared', attempt: 0, since: 80 },
  ready: { tag: 'ready', attempt: 0, since: 80 },
  'fetched-capacity-wait': {
    tag: 'fetched-capacity-wait',
    attempt: 0,
    retryAt: 120,
  },
  'fetched-call-armed': {
    tag: 'fetched-call-armed',
    attempt: 0,
    since: 80,
    armedAt: 85,
    leaseId: 'lease-1',
  },
  active: {
    tag: 'active',
    downloadId: 7,
    attempt: 0,
    startedAt: 80,
    nextProbeAt: 90,
  },
  'retry-wait': {
    tag: 'retry-wait',
    attempt: 1,
    retryAt: 120,
    priorDownloadId: 7,
  },
  'retry-refreshing': {
    tag: 'retry-refreshing',
    attempt: 1,
    since: 80,
    priorDownloadId: 7,
  },
  'retry-launching': {
    tag: 'retry-launching',
    attempt: 1,
    since: 80,
    priorDownloadId: 7,
  },
  'unresolved-launch': {
    tag: 'unresolved-launch',
    attempt: 0,
    since: 80,
    reason: 'worker-restart',
  },
  'browser-unresolved': {
    tag: 'browser-unresolved',
    attempt: 0,
    since: 80,
    reason: 'worker-restart',
    downloadId: 7,
    nextProbeAt: 90,
  },
  'aria2-launching': {
    tag: 'aria2-launching',
    attempt: 0,
    since: 80,
    profileId: PROFILE_ID,
    gid: GID,
  },
  'aria2-prepared': {
    tag: 'aria2-prepared',
    attempt: 0,
    since: 80,
    profileId: PROFILE_ID,
    gid: GID,
    options,
  },
  'aria2-ready': {
    tag: 'aria2-ready',
    attempt: 0,
    since: 80,
    profileId: PROFILE_ID,
    gid: GID,
    options,
  },
  'aria2-active': {
    tag: 'aria2-active',
    gid: GID,
    profileId: PROFILE_ID,
    startedAt: 80,
  },
  'aria2-call-armed': {
    tag: 'aria2-call-armed',
    attempt: 0,
    since: 80,
    armedAt: 85,
    profileId: PROFILE_ID,
    gid: GID,
  },
  'aria2-unresolved': {
    tag: 'aria2-unresolved',
    since: 80,
    reason: 'call-ambiguous',
    gid: GID,
    profileId: PROFILE_ID,
  },
  'forget-pending': {
    tag: 'forget-pending',
    since: 80,
    recovery: {
      tag: 'unresolved-launch',
      attempt: 0,
      since: 70,
      reason: 'worker-restart',
    },
  },
  'terminal-pending': {
    tag: 'terminal-pending',
    evidence: { tag: 'start-failed' },
    observedAt: 80,
    projectAt: 90,
  },
} satisfies {
  readonly [Tag in TransferPhase['tag']]: Extract<TransferPhase, { readonly tag: Tag }>
}

const fetchedTags = new Set<TransferPhase['tag']>([
  'fetched-prepared',
  'ready',
  'fetched-capacity-wait',
  'fetched-call-armed',
])
const aria2Tags = new Set<TransferPhase['tag']>([
  'aria2-launching',
  'aria2-prepared',
  'aria2-ready',
  'aria2-active',
  'aria2-call-armed',
  'aria2-unresolved',
])

const request = (
  id: string,
  mode: TransferRequest['mode'],
  over: Partial<TransferRequest> = {},
): TransferRequest => ({
  id,
  projectionId: `projection-${id}`,
  url: 'https://video.example/a.mp4',
  filename: 'a.mp4',
  mode,
  historyPolicy: 'record',
  ...over,
})

const storeForPhase = (phase: TransferPhase): TransferRegistryStore => {
  const id = `entry-${phase.tag}`
  const mode = aria2Tags.has(phase.tag)
    ? 'aria2'
    : fetchedTags.has(phase.tag)
      ? 'fetched'
      : 'direct'
  return {
    ...emptyTransferRegistryStore,
    entries: {
      [id]: {
        request: request(id, mode),
        createdAt: 70,
        phase,
      },
    },
    profiles: aria2Tags.has(phase.tag) ? { [PROFILE_ID]: profile } : {},
  }
}

const plan = (
  store: TransferRegistryStore,
  over: Partial<Omit<TransferRegistryWorkPlanInput, 'store'>> = {},
) =>
  planTransferRegistryWork({
    store,
    now: NOW,
    sweepBootBarrierOpen: true,
    preparationBlocks: new Set(),
    fetchedCleanupBlocks: new Set(),
    pendingFetchedStagingCleanup: new Map(),
    activeWorkKeys: new Set(),
    forgetRetryAt: new Map(),
    inflightWatchRetryAt: new Map(),
    ...over,
  })

type WorkTag = TransferRegistryWork['tag']
type PhaseExpectation = readonly [tag: WorkTag, dueAt: number] | null
const expectedByPhase = {
  launching: ['watch-inflight', 80 + TRANSFER_REGISTRY_PROBE_INTERVAL_MS],
  'direct-prepared': null,
  'direct-ready': ['launch-direct', NOW],
  'fetched-prepared': null,
  ready: ['launch-fetched', NOW],
  'fetched-capacity-wait': ['launch-fetched', 120],
  'fetched-call-armed': ['watch-inflight', 85 + TRANSFER_REGISTRY_PROBE_INTERVAL_MS],
  active: ['probe-browser', 90],
  'retry-wait': ['retry-browser', 120],
  'retry-refreshing': ['watch-inflight', 80 + TRANSFER_REGISTRY_PROBE_INTERVAL_MS],
  'retry-launching': ['watch-inflight', 80 + TRANSFER_REGISTRY_PROBE_INTERVAL_MS],
  'unresolved-launch': null,
  'browser-unresolved': ['probe-browser', 90],
  'aria2-launching': ['watch-inflight', 80 + TRANSFER_REGISTRY_PROBE_INTERVAL_MS],
  'aria2-prepared': null,
  'aria2-ready': ['launch-aria2', NOW],
  'aria2-active': ['probe-aria2-profile', 95],
  'aria2-call-armed': ['watch-inflight', 85 + TRANSFER_REGISTRY_PROBE_INTERVAL_MS],
  'aria2-unresolved': ['probe-aria2-profile', 95],
  'forget-pending': ['forget-transfer', 80 + TRANSFER_REGISTRY_PROBE_INTERVAL_MS],
  'terminal-pending': ['project-terminal', 90],
} satisfies { readonly [Tag in TransferPhase['tag']]: PhaseExpectation }

describe('transfer Registry work plan', () => {
  for (const tag of Object.keys(phases) as TransferPhase['tag'][]) {
    it(`maps ${tag} to its only automatic work`, () => {
      const phase = phases[tag]
      const store = storeForPhase(phase)
      expect(decodeTransferRegistryStore(store).ok).toBe(true)
      const result = plan(store)
      const expected = expectedByPhase[tag]
      expect(result.scheduled.map(({ dueAt, work }) => [work.tag, dueAt] as const)).toEqual(
        expected === null ? [] : [expected],
      )
      expect(result.due.map((work) => work.tag)).toEqual(
        expected !== null && expected[1] <= NOW ? [expected[0]] : [],
      )
      expect(result.wakeAt).toBe(expected === null ? undefined : Math.max(NOW, expected[1]))
    })
  }

  it('maps every legacy phase', () => {
    const legacyPhases = {
      active: { tag: 'active', nextProbeAt: 90 },
      'terminal-pending': {
        tag: 'terminal-pending',
        outcome: 'complete',
        at: 80,
        projectAt: 95,
      },
      'forget-pending': { tag: 'forget-pending', since: 80 },
      unresolved: { tag: 'unresolved' },
    } satisfies {
      readonly [Tag in LegacyTransferPhase['tag']]: Extract<
        LegacyTransferPhase,
        { readonly tag: Tag }
      >
    }
    const expected = {
      active: ['probe-legacy-browser', 90],
      'terminal-pending': ['project-legacy-terminal', 95],
      'forget-pending': ['forget-legacy-transfer', 80 + TRANSFER_REGISTRY_PROBE_INTERVAL_MS],
      unresolved: null,
    } satisfies {
      readonly [Tag in LegacyTransferPhase['tag']]: PhaseExpectation
    }
    for (const tag of Object.keys(legacyPhases) as LegacyTransferPhase['tag'][]) {
      const phase = legacyPhases[tag]
      const store = {
        ...emptyTransferRegistryStore,
        legacy: {
          legacy: {
            downloadId: 9,
            startedAt: 70,
            tweetId: '123',
            phase,
          },
        },
      }
      expect(decodeTransferRegistryStore(store).ok).toBe(true)
      const result = plan(store)
      const wanted = expected[tag]
      expect(result.scheduled.map(({ dueAt, work }) => [work.tag, dueAt] as const)).toEqual(
        wanted === null ? [] : [wanted],
      )
    }
  })

  it('requires durable Sweep ownership and the boot barrier for starts and projection', () => {
    const id = 'sweep-ready'
    const phase = phases['direct-ready']
    const baseEntry: TransferEntry = {
      request: request(id, 'direct', {
        sweepReceipt: {
          receiptId: 'receipt-1',
          tweetId: '123',
          scope: 'bookmark',
        },
      }),
      createdAt: 70,
      phase,
    }
    const store = {
      ...emptyTransferRegistryStore,
      entries: { [id]: baseEntry },
    }
    expect(plan(store).scheduled).toEqual([])

    const owned = {
      ...store,
      entries: {
        [id]: {
          ...baseEntry,
          sweepOwnership: { receiptId: 'receipt-1', clearSeedId: 1 },
        },
      },
    }
    expect(plan(owned, { sweepBootBarrierOpen: false }).scheduled).toEqual([])
    expect(plan(owned).scheduled[0]?.work.tag).toBe('launch-direct')

    const terminal = {
      ...owned,
      entries: {
        [id]: {
          ...owned.entries[id],
          phase: phases['terminal-pending'],
        },
      },
    } satisfies TransferRegistryStore
    expect(plan(terminal, { sweepBootBarrierOpen: false }).scheduled).toEqual([])
    expect(plan(terminal).scheduled[0]?.work.tag).toBe('project-terminal')
  })

  it('keeps a durable watch while a live coordinator blocks a launch', () => {
    const direct = storeForPhase(phases['direct-ready'])
    const directId = Object.keys(direct.entries)[0]!
    expect(plan(direct, { preparationBlocks: new Set([directId]) }).scheduled).toMatchObject([
      { dueAt: 80 + TRANSFER_REGISTRY_PROBE_INTERVAL_MS, work: { tag: 'watch-inflight' } },
    ])

    const fetched = storeForPhase(phases.ready)
    const fetchedId = Object.keys(fetched.entries)[0]!
    expect(plan(fetched, { preparationBlocks: new Set([fetchedId]) }).scheduled).toMatchObject([
      { dueAt: 80 + TRANSFER_REGISTRY_PROBE_INTERVAL_MS, work: { tag: 'watch-inflight' } },
    ])
    expect(plan(fetched, { fetchedCleanupBlocks: new Set([fetchedId]) }).scheduled).toEqual([])

    const active = storeForPhase(phases.active)
    const activeId = Object.keys(active.entries)[0]!
    expect(
      plan(active, {
        preparationBlocks: new Set([activeId]),
        fetchedCleanupBlocks: new Set([activeId]),
      }).scheduled[0]?.work.tag,
    ).toBe('probe-browser')
  })

  it('carries exact phase, profile, and staging fences', () => {
    const browser = storeForPhase(phases.active)
    const browserPhase = Object.values(browser.entries)[0]!.phase
    const browserWork = plan(browser).scheduled[0]!.work
    expect(browserWork.tag).toBe('probe-browser')
    const plannedBrowserPhase = browserWork.tag === 'probe-browser' ? browserWork.phase : undefined
    expect(plannedBrowserPhase).toBe(browserPhase)

    const aria2 = storeForPhase(phases['aria2-active'])
    const profileWork = plan(aria2).scheduled[0]!.work
    expect(profileWork.tag).toBe('probe-aria2-profile')
    const plannedProfile =
      profileWork.tag === 'probe-aria2-profile' ? profileWork.profile : undefined
    expect(plannedProfile).toBe(profile)

    const pending: PendingFetchedStagingCleanup = {
      requestId: 'fetched-1',
      attempt: 2,
      retryAt: 90,
    }
    const cleanupWork = plan(emptyTransferRegistryStore, {
      pendingFetchedStagingCleanup: new Map([['lease-1', pending]]),
    }).scheduled[0]!.work
    expect(cleanupWork.tag).toBe('discard-fetched-staging')
    const plannedCleanup =
      cleanupWork.tag === 'discard-fetched-staging' ? cleanupWork.pending : undefined
    expect(plannedCleanup).toBe(pending)
  })

  it('aggregates one profile probe and ignores unresolved rows without an exact handle', () => {
    const first = storeForPhase(phases['aria2-active'])
    const firstEntry = Object.values(first.entries)[0]!
    const secondId = 'aria2-unresolved-2'
    const second: TransferEntry = {
      request: request(secondId, 'aria2'),
      createdAt: 70,
      phase: { ...phases['aria2-unresolved'], gid: '0000000000000002' },
    }
    const noHandleId = 'aria2-unresolved-no-handle'
    const noHandle: TransferEntry = {
      request: request(noHandleId, 'aria2'),
      createdAt: 70,
      phase: {
        tag: 'aria2-unresolved',
        since: 80,
        reason: 'legacy-false-handoff',
      },
    }
    const result = plan({
      ...first,
      entries: {
        [firstEntry.request.id]: firstEntry,
        [secondId]: second,
        [noHandleId]: noHandle,
      },
    })
    expect(result.scheduled.map(({ work }) => work.tag)).toEqual(['probe-aria2-profile'])
  })

  it('uses exact forget retry overrides and saturates the default deadline', () => {
    const current = storeForPhase(phases['forget-pending'])
    const currentToken = plan(current).scheduled[0]!.work
    expect(currentToken.tag).toBe('forget-transfer')
    const token = (
      currentToken as Extract<TransferRegistryWork, { readonly tag: 'forget-transfer' }>
    ).token
    const override = new Map([[transferRegistryForgetKey(token), 140]])
    expect(plan(current, { forgetRetryAt: override }).scheduled[0]?.dueAt).toBe(140)

    const maxPhase: TransferPhase = {
      ...phases['forget-pending'],
      since: Number.MAX_SAFE_INTEGER - 1,
    }
    expect(plan(storeForPhase(maxPhase)).scheduled[0]?.dueAt).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('omits active drives until their owner re-plans', () => {
    const store = storeForPhase(phases['direct-ready'])
    const first = plan(store)
    const activeKey = first.scheduled[0]!.key
    expect(activeKey).toBe(transferRegistryWorkKey(first.scheduled[0]!.work))
    expect(plan(store, { activeWorkKeys: new Set([activeKey]) })).toEqual({
      scheduled: [],
      due: [],
    })
  })

  it('sorts by deadline then collision-safe key and clamps overdue alarms to now', () => {
    const directId = 'same:id'
    const fetchedId = 'same'
    const store: TransferRegistryStore = {
      ...emptyTransferRegistryStore,
      entries: {
        [directId]: {
          request: request(directId, 'direct'),
          createdAt: 70,
          phase: phases['direct-ready'],
        },
        [fetchedId]: {
          request: request(fetchedId, 'fetched'),
          createdAt: 70,
          phase: { ...phases['fetched-capacity-wait'], retryAt: 90 },
        },
      },
    }
    const result = plan(store)
    expect(new Set(result.scheduled.map(({ key }) => key)).size).toBe(2)
    expect(result.scheduled.map(({ dueAt }) => dueAt)).toEqual([90, NOW])
    expect(result.due).toHaveLength(2)
    expect(result.wakeAt).toBe(NOW)
  })

  it('rejects invalid runtime times and ancillary deadlines', () => {
    expect(() => plan(emptyTransferRegistryStore, { now: -1 })).toThrow(
      'invalid Registry plan time',
    )
    expect(() =>
      plan(emptyTransferRegistryStore, {
        pendingFetchedStagingCleanup: new Map([
          ['lease-1', { attempt: 0, retryAt: Number.POSITIVE_INFINITY }],
        ]),
      }),
    ).toThrow('invalid Registry work deadline')
  })
})
