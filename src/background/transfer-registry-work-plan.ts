import {
  hasConfirmedSweepOwnership,
  listPendingForgetRecovery,
  listPendingLegacyForgetRecovery,
  type Aria2Profile,
  type ForgetTransferToken,
  type LegacyForgetTransferToken,
  type LegacyTransferEntry,
  type TransferEntry,
  type TransferPhase,
  type TransferRegistryStore,
} from '../core/download/transfer-registry'

export const TRANSFER_REGISTRY_PROBE_INTERVAL_MS = 6_000

type DirectReadyPhase = Extract<TransferPhase, { readonly tag: 'direct-ready' }>
type FetchedReadyPhase = Extract<TransferPhase, { readonly tag: 'ready' | 'fetched-capacity-wait' }>
type RetryPhase = Extract<TransferPhase, { readonly tag: 'retry-wait' }>
type BrowserProbePhase = Extract<TransferPhase, { readonly tag: 'active' | 'browser-unresolved' }>
type Aria2ReadyPhase = Extract<TransferPhase, { readonly tag: 'aria2-ready' }>
type TerminalPhase = Extract<TransferPhase, { readonly tag: 'terminal-pending' }>
type WakeWatchPhase = Extract<
  TransferPhase,
  {
    readonly tag:
      | 'direct-ready'
      | 'ready'
      | 'launching'
      | 'fetched-call-armed'
      | 'retry-refreshing'
      | 'retry-launching'
      | 'aria2-ready'
      | 'aria2-launching'
      | 'aria2-call-armed'
  }
>
type LegacyActivePhase = Extract<LegacyTransferEntry['phase'], { readonly tag: 'active' }>
type LegacyTerminalPhase = Extract<
  LegacyTransferEntry['phase'],
  { readonly tag: 'terminal-pending' }
>

export interface PendingFetchedStagingCleanup {
  readonly requestId?: string
  readonly attempt: number
  readonly retryAt: number
}

/**
 * Exact work claims. Drivers must re-check the supplied phase, profile, token,
 * or staging record inside the Registry lane before any side effect.
 */
export type TransferRegistryWork =
  | {
      readonly tag: 'launch-direct'
      readonly id: string
      readonly phase: DirectReadyPhase
    }
  | {
      readonly tag: 'launch-fetched'
      readonly id: string
      readonly phase: FetchedReadyPhase
    }
  | {
      readonly tag: 'launch-aria2'
      readonly id: string
      readonly phase: Aria2ReadyPhase
    }
  | {
      readonly tag: 'retry-browser'
      readonly id: string
      readonly phase: RetryPhase
    }
  | {
      readonly tag: 'probe-browser'
      readonly id: string
      readonly downloadId: number
      readonly phase: BrowserProbePhase
    }
  | {
      readonly tag: 'project-terminal'
      readonly id: string
      readonly phase: TerminalPhase
    }
  /**
   * Keeps a durable MV3 wake while a live worker owns an external call. It
   * never replays that call; a restarted worker quarantines the phase first.
   */
  | {
      readonly tag: 'watch-inflight'
      readonly id: string
      readonly phase: WakeWatchPhase
    }
  | {
      readonly tag: 'probe-aria2-profile'
      readonly profileId: string
      readonly profile: Aria2Profile
    }
  | {
      readonly tag: 'forget-transfer'
      readonly token: ForgetTransferToken
    }
  | {
      readonly tag: 'discard-fetched-staging'
      readonly leaseId: string
      readonly pending: PendingFetchedStagingCleanup
    }
  | {
      readonly tag: 'probe-legacy-browser'
      readonly id: string
      readonly downloadId: number
      readonly phase: LegacyActivePhase
    }
  | {
      readonly tag: 'project-legacy-terminal'
      readonly id: string
      readonly phase: LegacyTerminalPhase
    }
  | {
      readonly tag: 'forget-legacy-transfer'
      readonly token: LegacyForgetTransferToken
    }

export interface ScheduledTransferRegistryWork {
  readonly key: string
  readonly dueAt: number
  readonly work: TransferRegistryWork
}

export interface TransferRegistryWorkPlan {
  readonly scheduled: readonly ScheduledTransferRegistryWork[]
  readonly due: readonly TransferRegistryWork[]
  readonly wakeAt?: number
}

export interface TransferRegistryWorkPlanInput {
  readonly store: TransferRegistryStore
  readonly now: number
  readonly sweepBootBarrierOpen: boolean
  readonly preparationBlocks: ReadonlySet<string>
  readonly fetchedCleanupBlocks: ReadonlySet<string>
  readonly pendingFetchedStagingCleanup: ReadonlyMap<string, PendingFetchedStagingCleanup>
  /** Exact work keys currently outside the serialized lane. Re-plan when each drive ends. */
  readonly activeWorkKeys: ReadonlySet<string>
  /** Overrides the default recovery deadline for one exact current or legacy forget token. */
  readonly forgetRetryAt: ReadonlyMap<string, number>
  /** Renews a live-worker call watchdog without changing its durable phase. */
  readonly inflightWatchRetryAt: ReadonlyMap<string, number>
}

const workKey = (...parts: readonly (string | number)[]): string => JSON.stringify(parts)

export const transferRegistryWorkKey = (work: TransferRegistryWork): string => {
  switch (work.tag) {
    case 'launch-direct':
    case 'launch-fetched':
    case 'launch-aria2':
    case 'retry-browser':
    case 'probe-browser':
    case 'project-terminal':
    case 'watch-inflight':
    case 'probe-legacy-browser':
    case 'project-legacy-terminal':
      return workKey(work.tag, work.id)
    case 'probe-aria2-profile':
      return workKey(work.tag, work.profileId)
    case 'discard-fetched-staging':
      return workKey(work.tag, work.leaseId)
    case 'forget-transfer':
      return workKey(
        work.tag,
        work.token.id,
        work.token.projectionId,
        work.token.createdAt,
        work.token.since,
      )
    case 'forget-legacy-transfer':
      return workKey(
        work.tag,
        work.token.id,
        work.token.downloadId,
        work.token.startedAt,
        work.token.since,
      )
  }
}

export const transferRegistryForgetKey = (
  token: ForgetTransferToken | LegacyForgetTransferToken,
): string =>
  'projectionId' in token
    ? transferRegistryWorkKey({ tag: 'forget-transfer', token })
    : transferRegistryWorkKey({ tag: 'forget-legacy-transfer', token })

const isRegistryTime = (value: number): boolean => Number.isSafeInteger(value) && value >= 0

const saturatingDeadline = (now: number, delay: number): number =>
  now > Number.MAX_SAFE_INTEGER - delay ? Number.MAX_SAFE_INTEGER : now + delay

const wakeWatchSince = (phase: WakeWatchPhase): number =>
  phase.tag === 'fetched-call-armed' || phase.tag === 'aria2-call-armed'
    ? phase.armedAt
    : phase.since

const assertNever = (value: never): never => {
  throw new TypeError(`unknown transfer phase: ${JSON.stringify(value)}`)
}

const canRunSweepWork = (entry: TransferEntry, sweepBootBarrierOpen: boolean): boolean =>
  entry.request.sweepReceipt === undefined ||
  (sweepBootBarrierOpen && hasConfirmedSweepOwnership(entry))

/**
 * The single policy source for live timers, the durable MV3 alarm, and due-work
 * dispatch. Boot-only phase normalization must run before calling this planner.
 */
export function planTransferRegistryWork(
  input: TransferRegistryWorkPlanInput,
): TransferRegistryWorkPlan {
  if (!isRegistryTime(input.now)) throw new TypeError('invalid Registry plan time')

  const scheduled: ScheduledTransferRegistryWork[] = []
  const keys = new Set<string>()
  const add = (dueAt: number, work: TransferRegistryWork): void => {
    if (!isRegistryTime(dueAt)) throw new TypeError('invalid Registry work deadline')
    const key = transferRegistryWorkKey(work)
    if (input.activeWorkKeys.has(key)) return
    if (keys.has(key)) throw new TypeError(`duplicate Registry work: ${key}`)
    keys.add(key)
    scheduled.push({ key, dueAt, work })
  }
  const launchAllowed = (entry: TransferEntry): boolean =>
    canRunSweepWork(entry, input.sweepBootBarrierOpen) &&
    !input.preparationBlocks.has(entry.request.id)
  const addInflightWatch = (id: string, phase: WakeWatchPhase): void => {
    const work = { tag: 'watch-inflight' as const, id, phase }
    add(
      input.inflightWatchRetryAt.get(transferRegistryWorkKey(work)) ??
        saturatingDeadline(wakeWatchSince(phase), TRANSFER_REGISTRY_PROBE_INTERVAL_MS),
      work,
    )
  }

  for (const entry of Object.values(input.store.entries)) {
    const { phase } = entry
    switch (phase.tag) {
      case 'direct-ready':
        if (launchAllowed(entry))
          add(input.now, { tag: 'launch-direct', id: entry.request.id, phase })
        else if (input.preparationBlocks.has(entry.request.id))
          addInflightWatch(entry.request.id, phase)
        break
      case 'ready':
        if (launchAllowed(entry) && !input.fetchedCleanupBlocks.has(entry.request.id))
          add(input.now, {
            tag: 'launch-fetched',
            id: entry.request.id,
            phase,
          })
        else if (input.preparationBlocks.has(entry.request.id))
          addInflightWatch(entry.request.id, phase)
        break
      case 'fetched-capacity-wait':
        if (launchAllowed(entry) && !input.fetchedCleanupBlocks.has(entry.request.id))
          add(phase.retryAt, {
            tag: 'launch-fetched',
            id: entry.request.id,
            phase,
          })
        break
      case 'aria2-ready':
        if (launchAllowed(entry))
          add(input.now, { tag: 'launch-aria2', id: entry.request.id, phase })
        else if (input.preparationBlocks.has(entry.request.id))
          addInflightWatch(entry.request.id, phase)
        break
      case 'retry-wait':
        if (launchAllowed(entry))
          add(phase.retryAt, {
            tag: 'retry-browser',
            id: entry.request.id,
            phase,
          })
        break
      case 'active':
      case 'browser-unresolved':
        add(phase.nextProbeAt, {
          tag: 'probe-browser',
          id: entry.request.id,
          downloadId: phase.downloadId,
          phase,
        })
        break
      case 'terminal-pending':
        if (canRunSweepWork(entry, input.sweepBootBarrierOpen))
          add(phase.projectAt, {
            tag: 'project-terminal',
            id: entry.request.id,
            phase,
          })
        break
      case 'launching':
      case 'fetched-call-armed':
      case 'retry-refreshing':
      case 'retry-launching':
      case 'aria2-launching':
      case 'aria2-call-armed':
        addInflightWatch(entry.request.id, phase)
        break
      case 'direct-prepared':
      case 'fetched-prepared':
      case 'unresolved-launch':
      case 'aria2-prepared':
      case 'aria2-active':
      case 'aria2-unresolved':
      case 'forget-pending':
        break
      default:
        assertNever(phase)
    }
  }

  for (const token of listPendingForgetRecovery(input.store)) {
    const work = { tag: 'forget-transfer' as const, token }
    add(
      input.forgetRetryAt.get(transferRegistryWorkKey(work)) ??
        saturatingDeadline(token.since, TRANSFER_REGISTRY_PROBE_INTERVAL_MS),
      work,
    )
  }

  for (const [id, entry] of Object.entries(input.store.legacy)) {
    const { phase } = entry
    switch (phase.tag) {
      case 'active':
        add(phase.nextProbeAt, {
          tag: 'probe-legacy-browser',
          id,
          downloadId: entry.downloadId,
          phase,
        })
        break
      case 'terminal-pending':
        add(phase.projectAt, { tag: 'project-legacy-terminal', id, phase })
        break
      case 'forget-pending':
      case 'unresolved':
        break
      default:
        assertNever(phase)
    }
  }

  for (const token of listPendingLegacyForgetRecovery(input.store)) {
    const work = { tag: 'forget-legacy-transfer' as const, token }
    add(
      input.forgetRetryAt.get(transferRegistryWorkKey(work)) ??
        saturatingDeadline(token.since, TRANSFER_REGISTRY_PROBE_INTERVAL_MS),
      work,
    )
  }

  const probeableProfiles = new Set<string>()
  for (const entry of Object.values(input.store.entries)) {
    const { phase } = entry
    if (
      (phase.tag === 'aria2-active' || phase.tag === 'aria2-unresolved') &&
      phase.profileId !== undefined &&
      phase.gid !== undefined
    )
      probeableProfiles.add(phase.profileId)
  }
  for (const profileId of probeableProfiles) {
    const profile = input.store.profiles[profileId]
    if (profile !== undefined)
      add(profile.nextProbeAt, {
        tag: 'probe-aria2-profile',
        profileId,
        profile,
      })
  }

  for (const [leaseId, pending] of input.pendingFetchedStagingCleanup)
    add(pending.retryAt, { tag: 'discard-fetched-staging', leaseId, pending })

  scheduled.sort((left, right) => left.dueAt - right.dueAt || left.key.localeCompare(right.key))
  const due = scheduled.filter(({ dueAt }) => dueAt <= input.now).map(({ work }) => work)
  const first = scheduled[0]
  return {
    scheduled,
    due,
    ...(first === undefined ? {} : { wakeAt: Math.max(input.now, first.dueAt) }),
  }
}
