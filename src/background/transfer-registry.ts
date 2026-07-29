import type { Aria2Status } from '../core/download/aria2'
import type {
  FetchedBootObservation,
  FetchedTerminalTransferObservation,
} from '../core/download/fetched-transfer-contract'
import type { DownloadHandle } from '../core/download/strategy'
import {
  terminalProjectionFromEntry,
  type TerminalProjection,
} from '../core/download/terminal-outcome'
import {
  aria2EndpointIdentity,
  ackTerminal,
  abandonSweepReceipt as abandonSweepReceiptTransition,
  abandonPrepared,
  armDirectCall as armDirectCallTransition,
  armAria2Call as armAria2CallTransition,
  armFetchedCall as armFetchedCallTransition,
  beginCapacityLaunch,
  beginForgetRecovery,
  beginLegacyForgetRecovery,
  bindStarted as bindStartedTransition,
  claimRetryRefresh,
  completeForgetRecovery,
  completeLegacyForgetRecovery,
  completeRetryRefresh,
  confirmSweepOwnership as confirmSweepOwnershipTransition,
  decodeTransferRegistryStore,
  deferProbe,
  deferAria2ProfileProbe,
  deferLaunchForCapacity,
  deferUnresolvedBrowserProbe,
  deferTerminalProjection,
  emptyTransferRegistryStore,
  enrichBrowserTerminal,
  failAria2CallDefinitely,
  failRetryStart,
  failRetryRefresh,
  isCurrentLaunch,
  hasConfirmedSweepOwnership,
  launchTokenFor,
  markAria2CallAmbiguous,
  markAria2ConfirmedUnbound,
  permitPreparedLaunches,
  recordBrowserTerminal,
  prepareLaunchGroups,
  prepareLaunches,
  quarantineActive,
  quarantineLaunchingOnBoot,
  rebaseClockRollbackOnBoot,
  recordAria2ProfileProbeSuccess,
  recordAria2ProfileUnavailable,
  recordAria2Progress,
  recordAria2Terminal,
  recordBrowserLive,
  listTransferRecovery,
  listPendingForgetRecovery,
  listPendingLegacyForgetRecovery,
  isBoundedJson,
  MAX_TRANSFER_REGISTRY_STORE_BYTES,
  recoverFetchedObservation,
  rescheduleRetryLaunchFailure,
  rejectStart as rejectStartTransition,
  resolveUntrackedStart as resolveUntrackedStartTransition,
  scheduleInterruptedRetry,
  TERMINAL_PROJECT_RETRY_MS,
  type Aria2LaunchReservation,
  type Aria2LaunchOptionsSnapshot,
  type Aria2ProfileSnapshot,
  type LaunchToken,
  type ForgetTransferToken,
  type LegacyForgetTransferToken,
  type TransferEntry,
  type TransferRegistryStore,
  type TransferRecoveryItem,
  type TransferLaunchGroup,
  type TransferRequest,
} from '../core/download/transfer-registry'
import { migrateV2TransferRegistryStore } from '../core/download/transfer-registry-v2-migration'
import { interruptBackoffMs, isRetryableInterruptReason } from '../core/download/interrupt-retry'
import { makeSerialQueue } from '../core/serial-queue'
import {
  planTransferRegistryWork,
  TRANSFER_REGISTRY_PROBE_INTERVAL_MS,
  transferRegistryForgetKey,
  transferRegistryWorkKey,
  type PendingFetchedStagingCleanup,
  type ScheduledTransferRegistryWork,
  type TransferRegistryWork,
  type TransferRegistryWorkPlan,
} from './transfer-registry-work-plan'

/** Kept stable to retain existing durable transfer state. */
export const TRANSFER_REGISTRY_STORAGE_KEY = 'local:browserTransferRegistry'

/** Unsafe durable transfer state stays read-only and must never enter an automatic boot loop. */
export class TransferRegistryCorruptionError extends Error {
  override readonly name = 'TransferRegistryCorruptionError'
  readonly reason: string

  constructor(reason: string) {
    super(`transfer registry unsafe: ${reason}`)
    this.reason = reason
  }
}

/** An exact queue transition no longer matches the durable launch it was given. */
export class TransferRegistryTransitionError extends Error {
  override readonly name = 'TransferRegistryTransitionError'

  constructor(operation: string, id: string, reason: string) {
    super(`transfer registry ${operation} rejected for ${id}: ${reason}`)
  }
}

const PROBE_INTERVAL_MS = TRANSFER_REGISTRY_PROBE_INTERVAL_MS
const FETCHED_STAGING_CLEANUP_MAX_BACKOFF_MS = 60_000
const cappedDeadline = (now: number, delay: number): number =>
  now > Number.MAX_SAFE_INTEGER - delay ? Number.MAX_SAFE_INTEGER : now + delay
const fetchedStagingCleanupBackoffMs = (attempt: number): number =>
  Math.min(PROBE_INTERVAL_MS * 2 ** attempt, FETCHED_STAGING_CLEANUP_MAX_BACKOFF_MS)

export interface TransferRegistryStorage {
  readonly get: () => Promise<unknown>
  readonly set: (store: TransferRegistryStore) => Promise<void>
}
export interface TransferRegistryClock {
  readonly now: () => number
  readonly schedule: (run: () => void, delayMs: number) => () => void
}
export interface BrowserDownloadRow {
  readonly id: number
  readonly state?: 'in_progress' | 'complete' | 'interrupted' | string | undefined
  readonly exists?: boolean | undefined
  readonly error?: string | undefined
  readonly bytesReceived?: number | undefined
  readonly totalBytes?: number | undefined
}
export interface TransferRegistryDownloads {
  readonly search: (downloadId: number) => Promise<ReadonlyArray<BrowserDownloadRow>>
  readonly cancel: (downloadId: number) => Promise<void>
}
export interface BrowserDownloadDelta {
  readonly id: number
  readonly state?: { readonly current?: string }
  readonly error?: { readonly current?: string }
}
interface BrowserTerminalFence {
  readonly id: string
  readonly createdAt: number
  readonly downloadId: number
  readonly state: 'complete' | 'interrupted'
  readonly observedAt: number
}
interface BrowserFollowUp {
  readonly fence?: BrowserTerminalFence
  readonly releaseFetched?: number
}
export interface TransferRegistryDeps {
  readonly storage: TransferRegistryStorage
  /** Used only when no registry key exists. It must return a fully valid v3 store. */
  readonly migrateLegacy?: () => Promise<TransferRegistryStore | undefined>
  readonly cleanupLegacy?: () => Promise<void>
  readonly clock: TransferRegistryClock
  readonly wake: {
    readonly schedule: (at: number | undefined) => Promise<void>
  }
  readonly downloads: TransferRegistryDownloads
  readonly startRetry: (
    mode: 'direct' | 'fetched',
    request: TransferRequest,
    token: LaunchToken,
  ) => Promise<
    | { readonly tag: 'started'; readonly downloadId: number }
    | { readonly tag: 'ambiguous' }
    | { readonly tag: 'busy' }
    | { readonly tag: 'failed' }
  >
  readonly reserveFetched: (
    request: TransferRequest,
    token: LaunchToken,
  ) => Promise<
    | { readonly tag: 'reserved'; readonly leaseId: string }
    | { readonly tag: 'busy' }
    | { readonly tag: 'ambiguous' }
    | { readonly tag: 'failed' }
  >
  readonly startReservedFetched: (
    request: TransferRequest,
    token: LaunchToken,
    leaseId: string,
  ) => Promise<
    | { readonly tag: 'started'; readonly downloadId: number }
    | { readonly tag: 'ambiguous' }
    | { readonly tag: 'failed' }
  >
  readonly startAria2: (
    request: TransferRequest,
    token: LaunchToken,
    profile: Aria2ProfileSnapshot,
    options: Aria2LaunchOptionsSnapshot,
  ) => Promise<
    | { readonly tag: 'started'; readonly gid: string }
    | { readonly tag: 'ambiguous' }
    | { readonly tag: 'failed' }
  >
  readonly fetchedBoot?: ReadonlyArray<FetchedBootObservation>
  readonly discardRecoveredStaging: (leaseIds: ReadonlyArray<string>) => Promise<void>
  readonly refreshUrl: (request: TransferRequest) => Promise<string>
  /** Finds exact lease evidence before an armed Fetched terminal is called orphan. */
  readonly observeTerminalFetched: (
    downloadId: number,
  ) => Promise<FetchedTerminalTransferObservation | undefined>
  readonly releaseFetched: (downloadId: number) => Promise<void>
  /** Safe after a retry or explicit orphan proof; failed cleanup has its own durable wake. */
  readonly releaseAutonomousFetched: (downloadId: number) => Promise<void>
  readonly aria2: {
    readonly tellStatus: (
      profile: Readonly<{ rpcUrl: string; secret: string }>,
      gid: string,
    ) => Promise<Aria2Status>
  }
  readonly clear: {
    readonly bindTransfer: (
      request: TransferRequest,
      downloadId: number,
      priorDownloadId?: number,
    ) => Promise<void>
    readonly abandonTransfer: (
      tweetId: string,
      requestId: string,
      downloadId?: number,
    ) => Promise<void>
  }
  /** Critical, idempotent terminal sink. It never receives an aria2 secret or profile. */
  readonly projectTerminal: (projection: TerminalProjection) => Promise<void>
  /** Durable v1 terminal sink. New transfers never use it. */
  readonly projectLegacyTerminal: (
    id: string,
    outcome: 'complete' | 'failed',
    downloadId: number,
    observedAt: number,
    tweetId?: string,
  ) => Promise<void>
  readonly trace?: (stage: string, detail: string) => void
}
export interface TransferRegistry {
  readonly ready: () => Promise<void>
  readonly prepare: (
    requests: readonly TransferRequest[],
    aria2Reservations?: Readonly<Record<string, Aria2LaunchReservation>>,
  ) => Promise<{
    readonly launches: readonly LaunchToken[]
    readonly duplicateIds: readonly string[]
  }>
  /** One durable mutation owns all artifacts for each media group. */
  readonly prepareGroups: (
    groups: readonly TransferLaunchGroup[],
    aria2Reservations?: Readonly<Record<string, Aria2LaunchReservation>>,
  ) => Promise<{
    readonly launches: readonly LaunchToken[]
    readonly duplicateMainIds: readonly string[]
  }>
  /** Durably permits exact prepared rows after Clear and cloud admission. */
  readonly releasePreparedStarts: (tokens: readonly LaunchToken[]) => Promise<void>
  /** Resolves only after the exact pre-call arm is durable. Rejects stale input. */
  readonly armAria2Call: (id: string, token: LaunchToken) => Promise<void>
  /** Resolves only after the exact pre-call arm is durable. Rejects stale input. */
  readonly armDirectCall: (id: string, token: LaunchToken) => Promise<void>
  /** Resolves only after the exact lease arm is durable. Rejects stale input. */
  readonly armFetchedCall: (id: string, token: LaunchToken, leaseId: string) => Promise<void>
  readonly abandonPrepared: (tokens: readonly LaunchToken[]) => Promise<void>
  /** Resolves only after the exact handle bind is durable. Rejects stale input. */
  readonly bindStarted: (id: string, token: LaunchToken, handle: DownloadHandle) => Promise<void>
  readonly rejectStart: (id: string, token: LaunchToken) => Promise<void>
  /** Records a Fetched capacity miss. The alarm, not a live promise, retries it. */
  readonly deferLaunch: (id: string, token: LaunchToken) => Promise<void>
  readonly resolveUntrackedStart: (
    id: string,
    token: LaunchToken,
    handle?: DownloadHandle,
  ) => Promise<void>
  readonly onDownloadChanged: (delta: BrowserDownloadDelta) => Promise<void>
  readonly probeStuck: () => Promise<void>
  readonly onWake: () => Promise<void>
  /** Adopts gateway evidence discovered after an initially unavailable Fetched boot. */
  readonly reconcileFetchedBoot: (
    observations: ReadonlyArray<FetchedBootObservation>,
  ) => Promise<void>
  readonly clearRecovery: () => Promise<{
    readonly active: readonly {
      readonly request: TransferRequest
      readonly downloadId: number
    }[]
    readonly retryOwnedRequestIds: ReadonlySet<string>
    readonly legacyActive: readonly {
      readonly id: string
      readonly downloadId: number
      readonly tweetId?: string
    }[]
  }>
  readonly inspectRecovery: () => Promise<readonly TransferRecoveryItem[]>
  /** Stable identities whose terminal projection may still replay after a partial sink failure. */
  readonly listPendingTerminalProjectionIds: () => Promise<ReadonlyArray<string>>
  /** Exact persisted intents for receipt-led boot repair. Never reconstruct from an ID. */
  readonly listSweepReceiptIntents: () => Promise<readonly TransferRequest[]>
  /** Confirmed Sweep intents still awaiting their durable admission permit. */
  readonly listPreparedSweepIntents: () => Promise<readonly TransferRequest[]>
  /** Deletes only wholly pre-call, unconfirmed intents for one failed queued receipt. */
  readonly abandonSweepReceipt: (receiptId: string) => Promise<boolean>
  /** Durable proof that Clear and Worklist own these exact Sweep receipts. */
  readonly confirmSweepOwnership: (
    clearSeedIdByReceipt: ReadonlyMap<string, number>,
  ) => Promise<ReadonlySet<string>>
  /** Opens boot-held Sweep work only after repair confirms and retires every live receipt. */
  readonly releaseConfirmedSweepStarts: () => Promise<void>
  readonly forgetRecovery: (id: string) => Promise<boolean>
}

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const terminalFromRow = (row: BrowserDownloadRow): 'complete' | 'failed' | undefined =>
  row.state === 'complete' ? 'complete' : row.state === 'interrupted' ? 'failed' : undefined
const isTerminalAria2Status = (
  status: Aria2Status,
): status is Extract<Aria2Status, { readonly status: 'complete' | 'error' | 'removed' }> =>
  status.status === 'complete' || status.status === 'error' || status.status === 'removed'
const browserEntryFor = (
  state: TransferRegistryStore,
  downloadId: number,
): TransferEntry | undefined =>
  Object.values(state.entries).find(
    (entry) =>
      (entry.phase.tag === 'active' || entry.phase.tag === 'browser-unresolved') &&
      entry.phase.downloadId === downloadId,
  )
const legacyEntryFor = (
  state: TransferRegistryStore,
  downloadId: number,
): readonly [string, TransferRegistryStore['legacy'][string]] | undefined =>
  Object.entries(state.legacy).find(([, entry]) => entry.downloadId === downloadId)
const sameProfile = (left: Aria2ProfileSnapshot, right: Aria2ProfileSnapshot): boolean =>
  aria2EndpointIdentity(left.rpcUrl) === aria2EndpointIdentity(right.rpcUrl) &&
  left.secret === right.secret
const hasLocalTimer = (work: TransferRegistryWork): boolean =>
  work.tag === 'launch-direct' ||
  work.tag === 'launch-fetched' ||
  work.tag === 'launch-aria2' ||
  work.tag === 'retry-browser' ||
  work.tag === 'probe-browser' ||
  work.tag === 'probe-legacy-browser'
const sameWorkFence = (
  left: ScheduledTransferRegistryWork,
  right: ScheduledTransferRegistryWork,
): boolean => {
  if (left.key !== right.key || left.dueAt !== right.dueAt || left.work.tag !== right.work.tag)
    return false
  const leftWork = left.work
  const rightWork = right.work
  switch (leftWork.tag) {
    case 'launch-direct':
    case 'launch-fetched':
    case 'launch-aria2':
    case 'retry-browser':
    case 'probe-browser':
    case 'project-terminal':
    case 'watch-inflight':
    case 'probe-legacy-browser':
    case 'project-legacy-terminal':
      return 'phase' in rightWork && leftWork.phase === rightWork.phase
    case 'probe-aria2-profile':
      return rightWork.tag === leftWork.tag && leftWork.profile === rightWork.profile
    case 'discard-fetched-staging':
      return rightWork.tag === leftWork.tag && leftWork.pending === rightWork.pending
    case 'forget-transfer':
    case 'forget-legacy-transfer':
      return true
  }
}
/**
 * Durable transfer owner. State changes commit before side effects. A corrupt
 * snapshot is read-only: uncertainty never starts or re-adds a transfer.
 */
export function makeTransferRegistry(deps: TransferRegistryDeps): TransferRegistry {
  const serial = makeSerialQueue()
  let state = emptyTransferRegistryStore
  let unsafeReason: string | undefined
  const timers = new Map<
    string,
    {
      readonly scheduled: ScheduledTransferRegistryWork
      readonly stop: () => void
    }
  >()
  const capacityLaunches = new Set<string>()
  const readyLaunches = new Set<string>()
  const fetchedCleanupBlocks = new Set<string>()
  const pendingFetchedStagingCleanup = new Map<string, PendingFetchedStagingCleanup>()
  const fetchedStagingCleanupDrives = new Set<string>()
  const livePreparationBlocks = new Set<string>()
  const activeWorkKeys = new Set<string>()
  const activeWorkDrives = new Map<string, Promise<void>>()
  let sweepBootBarrierOpen = false
  let readyForWork = false
  const forgetDrives = new Map<string, Promise<boolean>>()
  const forgetRetryAt = new Map<string, number>()
  const inflightWatchRetryAt = new Map<string, number>()
  const trace = (stage: string, detail: string): void => deps.trace?.(stage, detail)
  const canRunSweepWork = (entry: TransferEntry): boolean =>
    hasConfirmedSweepOwnership(entry) &&
    (entry.request.sweepReceipt === undefined || sweepBootBarrierOpen)
  const bindClearTransfer = async (
    stage: 'retry' | 'capacity' | 'ready',
    request: TransferRequest,
    downloadId: number,
    priorDownloadId?: number,
  ): Promise<void> => {
    try {
      await deps.clear.bindTransfer(request, downloadId, priorDownloadId)
    } catch (error) {
      trace(`${stage}-clear-bind-failed`, `${request.id}: ${String(error)}`)
      const item = request.item
      if (item === undefined) return
      try {
        await deps.clear.abandonTransfer(item.postId, request.id, priorDownloadId)
      } catch (failure) {
        trace(`${stage}-clear-bind-compensation-failed`, `${request.id}: ${String(failure)}`)
      }
    }
  }
  const assertSafe = (): void => {
    if (unsafeReason !== undefined) throw new TransferRegistryCorruptionError(unsafeReason)
  }
  const clearTimers = (): void => {
    for (const { stop } of timers.values()) stop()
    timers.clear()
  }
  const planWorkFor = (store: TransferRegistryStore): TransferRegistryWorkPlan =>
    planTransferRegistryWork({
      store,
      now: deps.clock.now(),
      sweepBootBarrierOpen,
      preparationBlocks: livePreparationBlocks,
      fetchedCleanupBlocks,
      pendingFetchedStagingCleanup,
      activeWorkKeys,
      forgetRetryAt,
      inflightWatchRetryAt,
    })
  const planWork = (): TransferRegistryWorkPlan => planWorkFor(state)
  const reconcileTimers = (plan: TransferRegistryWorkPlan): void => {
    const desired = new Map(
      plan.scheduled.filter(({ work }) => hasLocalTimer(work)).map((item) => [item.key, item]),
    )
    for (const [key, timer] of timers) {
      const next = desired.get(key)
      if (next !== undefined && sameWorkFence(timer.scheduled, next)) {
        desired.delete(key)
        continue
      }
      timer.stop()
      timers.delete(key)
    }
    for (const [key, scheduled] of desired) {
      const stop = deps.clock.schedule(
        () => {
          if (timers.get(key)?.scheduled !== scheduled) return
          timers.delete(key)
          void dispatchPlannedWork(scheduled.work)
            .catch((error) =>
              trace('planned-work-failed', `${scheduled.work.tag}: ${String(error)}`),
            )
            .finally(() => reconcilePlan())
        },
        Math.max(0, scheduled.dueAt - deps.clock.now()),
      )
      timers.set(key, { scheduled, stop })
    }
  }
  const reconcilePlan = async (): Promise<void> => {
    if (!readyForWork) return
    const plan = planWork()
    reconcileTimers(plan)
    try {
      await deps.wake.schedule(plan.wakeAt)
    } catch (error) {
      trace('wake-schedule-failed', String(error))
    }
  }
  /**
   * Chrome alarms outlive this worker; local timers do not. Before exposing
   * durable work, install a conservative alarm lease for its next plan. The
   * exact post-commit plan may move it earlier. This closes the storage-write
   * to alarm-create death cut without replaying any side effect.
   */
  const latchWakeBeforePersist = async (next: TransferRegistryStore): Promise<void> => {
    const nextWakeAt = planWorkFor(next).wakeAt
    if (nextWakeAt === undefined) return
    const now = deps.clock.now()
    const conservativeAt = Math.max(nextWakeAt, cappedDeadline(now, PROBE_INTERVAL_MS))
    // Before boot readiness, the event that created this worker may already
    // have consumed the one-shot alarm. It is not a surviving lease.
    const currentWakeAt = readyForWork ? planWork().wakeAt : undefined
    await deps.wake.schedule(
      currentWakeAt === undefined ? conservativeAt : Math.min(currentWakeAt, conservativeAt),
    )
  }
  const persist = async (next: TransferRegistryStore): Promise<void> => {
    await latchWakeBeforePersist(next)
    await deps.storage.set(next)
  }
  const commit = async (next: TransferRegistryStore): Promise<void> => {
    assertSafe()
    if (!isBoundedJson(next, MAX_TRANSFER_REGISTRY_STORE_BYTES))
      throw new RangeError('registry store size')
    await persist(next)
    state = next
    if (readyForWork) await reconcilePlan()
  }
  /** A failed mutation may have consumed an alarm/timer. Re-wake without inventing state. */
  const scheduleRecoveryWake = async (): Promise<void> => {
    if (unsafeReason !== undefined) return
    try {
      await deps.wake.schedule(cappedDeadline(deps.clock.now(), PROBE_INTERVAL_MS))
    } catch (error) {
      trace('recovery-wake-failed', String(error))
    }
  }
  const inLane = <A>(work: () => Promise<A>): Promise<A> =>
    serial.run(async () => {
      try {
        await boot
        assertSafe()
        return await work()
      } catch (error) {
        await scheduleRecoveryWake()
        throw error
      }
    })
  const rearm = async (): Promise<void> => {
    clearTimers()
    await reconcilePlan()
  }
  /**
   * Gateway staging is the durable source of truth. This worker keeps exact
   * lease retries in memory; a worker restart rebuilds them from fetchedBoot.
   */
  const driveFetchedStagingCleanup = async (
    expected?: Extract<TransferRegistryWork, { readonly tag: 'discard-fetched-staging' }>,
  ): Promise<void> => {
    const claimed = await inLane(async () => {
      const due = [...pendingFetchedStagingCleanup.entries()].filter(
        ([leaseId, pending]) =>
          pending.retryAt <= deps.clock.now() &&
          !fetchedStagingCleanupDrives.has(leaseId) &&
          (expected === undefined ||
            (expected.leaseId === leaseId && expected.pending === pending)),
      )
      for (const [leaseId] of due) fetchedStagingCleanupDrives.add(leaseId)
      return due
    })
    await Promise.all(
      claimed.map(async ([leaseId]) => {
        let cleaned = false
        try {
          await deps.discardRecoveredStaging([leaseId])
          cleaned = true
        } catch (error) {
          trace('fetched-staging-cleanup-failed', `${leaseId}: ${String(error)}`)
        }
        try {
          await inLane(async () => {
            const pending = pendingFetchedStagingCleanup.get(leaseId)
            if (pending === undefined) return
            if (cleaned) {
              pendingFetchedStagingCleanup.delete(leaseId)
              if (
                pending.requestId !== undefined &&
                ![...pendingFetchedStagingCleanup.values()].some(
                  (other) => other.requestId === pending.requestId,
                )
              ) {
                fetchedCleanupBlocks.delete(pending.requestId)
              }
            } else {
              pendingFetchedStagingCleanup.set(leaseId, {
                ...pending,
                attempt: pending.attempt + 1,
                retryAt: cappedDeadline(
                  deps.clock.now(),
                  fetchedStagingCleanupBackoffMs(pending.attempt),
                ),
              })
            }
            await reconcilePlan()
          })
        } finally {
          fetchedStagingCleanupDrives.delete(leaseId)
        }
      }),
    )
  }
  const canonicalReservations = (
    reservations: Readonly<Record<string, Aria2LaunchReservation>>,
  ): Readonly<Record<string, Aria2LaunchReservation>> => {
    const profiles: Aria2ProfileSnapshot[] = Object.values(state.profiles)
    const normalized: Record<string, Aria2LaunchReservation> = Object.create(null) as Record<
      string,
      Aria2LaunchReservation
    >
    for (const [id, reservation] of Object.entries(reservations)) {
      const existing = profiles.find((profile) => sameProfile(profile, reservation.profile))
      const profile = existing ?? reservation.profile
      if (existing === undefined) profiles.push(profile)
      normalized[id] = { ...reservation, profile }
    }
    return normalized
  }
  const projectOutsideLane = async (
    id: string,
    expectedPhase?: TransferEntry['phase'],
  ): Promise<void> => {
    const claim = await inLane(async () => {
      const entry = state.entries[id]
      const projection = entry === undefined ? undefined : terminalProjectionFromEntry(entry)
      if (
        entry?.phase.tag !== 'terminal-pending' ||
        !canRunSweepWork(entry) ||
        projection === undefined ||
        entry.phase.projectAt > deps.clock.now() ||
        (expectedPhase !== undefined && entry.phase !== expectedPhase)
      )
        return
      const claimed = deferTerminalProjection(
        state,
        id,
        cappedDeadline(deps.clock.now(), TERMINAL_PROJECT_RETRY_MS),
      )
      if (claimed.changed) await commit(claimed.state)
      const current = state.entries[id]
      if (current?.phase.tag !== 'terminal-pending') return
      return { phase: current.phase, projection }
    })
    if (claim === undefined) return
    try {
      await deps.projectTerminal(claim.projection)
    } catch (error) {
      trace('terminal-project-failed', `${id}: ${String(error)}`)
      return
    }
    await inLane(async () => {
      const current = state.entries[id]
      if (current?.phase !== claim.phase) return
      const ack = ackTerminal(state, id)
      if (ack.changed) await commit(ack.state)
    })
  }
  const pendingForgetCommand = (
    token: ForgetTransferToken,
  ):
    | {
        readonly tweetId?: string
        readonly downloadId?: number
      }
    | undefined => {
    const entry = state.entries[token.id]
    if (
      entry?.phase.tag !== 'forget-pending' ||
      entry.request.projectionId !== token.projectionId ||
      entry.createdAt !== token.createdAt ||
      entry.phase.since !== token.since
    )
      return
    return {
      ...(entry.request.item === undefined ? {} : { tweetId: entry.request.item.postId }),
      ...(entry.phase.recovery.tag === 'browser-unresolved'
        ? { downloadId: entry.phase.recovery.downloadId }
        : {}),
    }
  }
  const performForget = async (token: ForgetTransferToken): Promise<boolean> => {
    const key = transferRegistryForgetKey(token)
    const command = await inLane(async () => pendingForgetCommand(token))
    if (command === undefined) {
      forgetRetryAt.delete(key)
      return false
    }
    try {
      if (command.tweetId !== undefined)
        await deps.clear.abandonTransfer(command.tweetId, token.id, command.downloadId)
    } catch (error) {
      forgetRetryAt.set(key, cappedDeadline(deps.clock.now(), PROBE_INTERVAL_MS))
      await reconcilePlan()
      throw error
    }
    return inLane(async () => {
      const completed = completeForgetRecovery(state, token)
      forgetRetryAt.delete(key)
      if (!completed.changed) return false
      await commit(completed.state)
      return true
    })
  }
  const driveForget = (token: ForgetTransferToken): Promise<boolean> => {
    const key = transferRegistryForgetKey(token)
    const current = forgetDrives.get(key)
    if (current !== undefined) return current
    const drive = performForget(token).finally(() => {
      if (forgetDrives.get(key) === drive) forgetDrives.delete(key)
    })
    forgetDrives.set(key, drive)
    return drive
  }
  const pendingLegacyForgetCommand = (
    token: LegacyForgetTransferToken,
  ): { readonly tweetId?: string } | undefined => {
    const entry = state.legacy[token.id]
    if (
      entry?.phase.tag !== 'forget-pending' ||
      entry.downloadId !== token.downloadId ||
      entry.startedAt !== token.startedAt ||
      entry.phase.since !== token.since
    )
      return
    return entry.tweetId === undefined ? {} : { tweetId: entry.tweetId }
  }
  const performLegacyForget = async (token: LegacyForgetTransferToken): Promise<boolean> => {
    const key = transferRegistryForgetKey(token)
    const command = await inLane(async () => pendingLegacyForgetCommand(token))
    if (command === undefined) {
      forgetRetryAt.delete(key)
      return false
    }
    try {
      if (command.tweetId !== undefined)
        await deps.clear.abandonTransfer(command.tweetId, token.id, token.downloadId)
    } catch (error) {
      forgetRetryAt.set(key, cappedDeadline(deps.clock.now(), PROBE_INTERVAL_MS))
      await reconcilePlan()
      throw error
    }
    return inLane(async () => {
      const completed = completeLegacyForgetRecovery(state, token)
      forgetRetryAt.delete(key)
      if (!completed.changed) return false
      await commit(completed.state)
      return true
    })
  }
  const driveLegacyForget = (token: LegacyForgetTransferToken): Promise<boolean> => {
    const key = transferRegistryForgetKey(token)
    const current = forgetDrives.get(key)
    if (current !== undefined) return current
    const drive = performLegacyForget(token).finally(() => {
      if (forgetDrives.get(key) === drive) forgetDrives.delete(key)
    })
    forgetDrives.set(key, drive)
    return drive
  }
  const projectLegacyOutsideLane = async (
    id: string,
    expectedPhase?: TransferRegistryStore['legacy'][string]['phase'],
  ): Promise<void> => {
    const claim = await inLane(async () => {
      const entry = state.legacy[id]
      if (
        entry?.phase.tag !== 'terminal-pending' ||
        entry.phase.projectAt > deps.clock.now() ||
        (expectedPhase !== undefined && entry.phase !== expectedPhase)
      )
        return
      const phase = {
        ...entry.phase,
        projectAt: Math.max(
          entry.phase.projectAt,
          cappedDeadline(deps.clock.now(), TERMINAL_PROJECT_RETRY_MS),
        ),
      }
      await commit({
        ...state,
        legacy: {
          ...state.legacy,
          [id]: { ...entry, phase },
        },
      })
      return {
        phase,
        downloadId: entry.downloadId,
        outcome: entry.phase.outcome,
        observedAt: entry.phase.at,
        tweetId: entry.tweetId,
      }
    })
    if (claim === undefined) return
    try {
      await deps.projectLegacyTerminal(
        id,
        claim.outcome,
        claim.downloadId,
        claim.observedAt,
        claim.tweetId,
      )
      // The legacy projector is the durable terminal sink. Keep its Fetched
      // lease until it completes; a release failure replays the idempotent sink.
      await deps.releaseFetched(claim.downloadId)
    } catch (error) {
      trace('legacy-terminal-project-failed', `${id}: ${String(error)}`)
      return
    }
    await inLane(async () => {
      if (state.legacy[id]?.phase !== claim.phase) return
      const { [id]: _, ...legacy } = state.legacy
      await commit({ ...state, legacy })
    })
  }
  const terminalLegacy = async (
    id: string,
    entry: TransferRegistryStore['legacy'][string],
    outcome: 'complete' | 'failed',
  ): Promise<boolean> => {
    if (entry.phase.tag !== 'active') return false
    const at = deps.clock.now()
    await commit({
      ...state,
      legacy: {
        ...state.legacy,
        [id]: {
          ...entry,
          phase: { tag: 'terminal-pending', outcome, at, projectAt: at },
        },
      },
    })
    return true
  }
  const probeLegacy = async (
    id: string,
    downloadId: number,
    expectedPhase?: TransferRegistryStore['legacy'][string]['phase'],
  ): Promise<void> => {
    const claim = await inLane(async () => {
      const entry = state.legacy[id]
      if (
        entry?.phase.tag !== 'active' ||
        entry.downloadId !== downloadId ||
        entry.phase.nextProbeAt > deps.clock.now() ||
        (expectedPhase !== undefined && entry.phase !== expectedPhase)
      )
        return
      const phase = {
        tag: 'active' as const,
        nextProbeAt: Math.max(
          entry.phase.nextProbeAt,
          cappedDeadline(deps.clock.now(), PROBE_INTERVAL_MS),
        ),
      }
      if (phase.nextProbeAt !== entry.phase.nextProbeAt)
        await commit({
          ...state,
          legacy: {
            ...state.legacy,
            [id]: { ...entry, phase },
          },
        })
      const current = state.legacy[id]
      if (current?.phase.tag !== 'active') return
      return { phase: current.phase }
    })
    if (claim === undefined) return
    let row: BrowserDownloadRow | undefined
    try {
      row = (await deps.downloads.search(downloadId)).find(
        (candidate) => isNonNegativeSafeInteger(candidate.id) && candidate.id === downloadId,
      )
    } catch (error) {
      trace('legacy-search-failed', `${id}: ${String(error)}`)
      return
    }
    const work = await inLane(async () => {
      const entry = state.legacy[id]
      if (entry?.phase !== claim.phase) return
      if (row === undefined) {
        await commit({
          ...state,
          legacy: {
            ...state.legacy,
            [id]: { ...entry, phase: { tag: 'unresolved' } },
          },
        })
        return
      }
      const outcome = terminalFromRow(row)
      if (outcome !== undefined) {
        const changed = await terminalLegacy(id, entry, outcome)
        return changed ? { project: true as const } : undefined
      }
    })
    if (work?.project) {
      await projectLegacyOutsideLane(id)
    }
  }
  const markBrowserTerminal = async (
    entry: TransferEntry,
    terminalState: BrowserTerminalFence['state'],
    bytes?: BrowserDownloadRow,
  ): Promise<BrowserTerminalFence | undefined> => {
    if (entry.phase.tag !== 'active' && entry.phase.tag !== 'browser-unresolved') return
    const downloadId = entry.phase.downloadId
    const marked = recordBrowserTerminal(state, {
      id: entry.request.id,
      downloadId,
      state: terminalState,
      observedAt: deps.clock.now(),
      ...(isNonNegativeSafeInteger(bytes?.bytesReceived)
        ? { bytesReceived: bytes.bytesReceived }
        : {}),
      ...(isNonNegativeSafeInteger(bytes?.totalBytes) ? { totalBytes: bytes.totalBytes } : {}),
    })
    if (!marked.changed) return
    const terminalEntry = marked.state.entries[entry.request.id]
    if (
      terminalEntry?.phase.tag !== 'terminal-pending' ||
      terminalEntry.phase.evidence.tag !== 'browser'
    )
      return
    await commit(marked.state)
    return {
      id: entry.request.id,
      createdAt: terminalEntry.createdAt,
      downloadId,
      state: terminalState,
      observedAt: terminalEntry.phase.observedAt,
    }
  }
  const terminalBrowser = async (
    entry: TransferEntry,
    row: BrowserDownloadRow,
  ): Promise<BrowserTerminalFence | undefined> => {
    if (entry.phase.tag !== 'active' && entry.phase.tag !== 'browser-unresolved') return
    const outcome = terminalFromRow(row)
    if (outcome === undefined) return
    return markBrowserTerminal(entry, outcome === 'complete' ? 'complete' : 'interrupted', row)
  }
  const enrichTerminalThenProject = async (fence: BrowserTerminalFence): Promise<void> => {
    let row: BrowserDownloadRow | undefined
    try {
      row = (await deps.downloads.search(fence.downloadId)).find(
        (candidate) => isNonNegativeSafeInteger(candidate.id) && candidate.id === fence.downloadId,
      )
    } catch (error) {
      trace('browser-terminal-enrichment-search-failed', `${fence.id}: ${String(error)}`)
    }
    await inLane(async () => {
      if (row !== undefined) {
        const enriched = enrichBrowserTerminal(state, {
          ...fence,
          ...(isNonNegativeSafeInteger(row.bytesReceived)
            ? { bytesReceived: row.bytesReceived }
            : {}),
          ...(isNonNegativeSafeInteger(row.totalBytes) ? { totalBytes: row.totalBytes } : {}),
        })
        if (enriched.changed) await commit(enriched.state)
      }
    })
    await projectOutsideLane(fence.id)
  }
  const scheduleRetry = async (
    entry: TransferEntry,
    reason: string | undefined,
  ): Promise<BrowserFollowUp | undefined> => {
    if (entry.phase.tag !== 'active') return
    if (!isRetryableInterruptReason(reason)) {
      const fence = await terminalBrowser(entry, {
        id: entry.phase.downloadId,
        state: 'interrupted',
        ...(reason === undefined ? {} : { error: reason }),
      })
      return fence === undefined ? {} : { fence }
    }
    const next = scheduleInterruptedRetry(state, {
      id: entry.request.id,
      downloadId: entry.phase.downloadId,
      retryAt: cappedDeadline(deps.clock.now(), interruptBackoffMs(entry.phase.attempt)),
    })
    if (!next.changed) {
      const fence = await terminalBrowser(entry, {
        id: entry.phase.downloadId,
        state: 'interrupted',
        ...(reason === undefined ? {} : { error: reason }),
      })
      return fence === undefined ? {} : { fence }
    }
    await commit(next.state)
    return {
      releaseFetched: entry.phase.downloadId,
    }
  }
  const finishBrowserWork = async (work: BrowserFollowUp): Promise<void> => {
    if (work.releaseFetched !== undefined)
      await deps
        .releaseAutonomousFetched(work.releaseFetched)
        .catch((error) => trace('fetched-release-failed', String(error)))
    if (work.fence !== undefined) await projectOutsideLane(work.fence.id)
  }
  const terminalWorkFor = async (
    entry: TransferEntry,
    terminalState: string | undefined,
    error?: string,
  ): Promise<BrowserFollowUp | undefined> => {
    if (entry.phase.tag === 'active' && terminalState === 'interrupted') {
      const next = await scheduleRetry(entry, error)
      return next
    }
    if (terminalState !== 'complete' && terminalState !== 'interrupted') return
    const fence = await markBrowserTerminal(entry, terminalState)
    return fence === undefined ? undefined : { fence }
  }
  const finishBrowserDeltaWork = async (work: BrowserFollowUp): Promise<void> => {
    if (work.releaseFetched !== undefined)
      await deps
        .releaseAutonomousFetched(work.releaseFetched)
        .catch((error) => trace('fetched-release-failed', String(error)))
    if (work.fence !== undefined) await enrichTerminalThenProject(work.fence)
  }
  const probeBrowser = async (
    id: string,
    downloadId: number,
    expectedPhase?: TransferEntry['phase'],
  ): Promise<void> => {
    const claim = await inLane(async () => {
      const entry = state.entries[id]
      if (
        (entry?.phase.tag !== 'active' && entry?.phase.tag !== 'browser-unresolved') ||
        entry.phase.downloadId !== downloadId ||
        entry.phase.nextProbeAt > deps.clock.now() ||
        (expectedPhase !== undefined && entry.phase !== expectedPhase)
      )
        return
      const nextProbeAt = cappedDeadline(deps.clock.now(), PROBE_INTERVAL_MS)
      const claimed =
        entry.phase.tag === 'active'
          ? deferProbe(state, { id, downloadId, nextProbeAt })
          : deferUnresolvedBrowserProbe(state, {
              id,
              downloadId,
              nextProbeAt,
            })
      if (claimed.changed) await commit(claimed.state)
      const current = state.entries[id]
      if (
        (current?.phase.tag !== 'active' && current?.phase.tag !== 'browser-unresolved') ||
        current.phase.downloadId !== downloadId
      )
        return
      return { phase: current.phase }
    })
    if (claim === undefined) return
    let row: BrowserDownloadRow | undefined
    try {
      row = (await deps.downloads.search(downloadId)).find(
        (candidate) => isNonNegativeSafeInteger(candidate.id) && candidate.id === downloadId,
      )
    } catch (error) {
      trace('browser-search-failed', `${id}: ${String(error)}`)
      return
    }
    const work = await inLane(async () => {
      const entry = state.entries[id]
      if (entry?.phase !== claim.phase) return
      if (row === undefined) {
        if (entry.phase.tag === 'active') {
          const quarantined = quarantineActive(state, { id, downloadId })
          if (quarantined.changed) await commit(quarantined.state)
        }
        return {}
      }
      if (row.state === 'interrupted') {
        if (entry.phase.tag === 'active') return scheduleRetry(entry, row.error)
        const fence = await terminalBrowser(entry, row)
        return fence === undefined ? {} : { fence }
      }
      if (terminalFromRow(row) !== undefined) {
        const fence = await terminalBrowser(entry, row)
        return fence === undefined ? {} : { fence }
      }
      if (entry.phase.tag === 'browser-unresolved') {
        const live = recordBrowserLive(state, {
          id,
          downloadId,
          observedAt: deps.clock.now(),
        })
        if (live.changed) await commit(live.state)
      }
      return {}
    })
    if (work !== undefined) await finishBrowserWork(work)
  }
  const probeProfile = async (
    profileId: string,
    expectedProfile?: Aria2ProfileSnapshot,
  ): Promise<void> => {
    const claim = await inLane(async () => {
      const profile = state.profiles[profileId]
      if (
        profile === undefined ||
        profile.nextProbeAt > deps.clock.now() ||
        (expectedProfile !== undefined && profile !== expectedProfile)
      )
        return
      const candidates = Object.values(state.entries).flatMap((entry) =>
        (entry.phase.tag === 'aria2-active' || entry.phase.tag === 'aria2-unresolved') &&
        entry.phase.profileId === profileId &&
        entry.phase.gid !== undefined
          ? [
              {
                id: entry.request.id,
                gid: entry.phase.gid,
                phase: entry.phase,
              },
            ]
          : [],
      )
      if (candidates.length === 0) return
      const deferred = deferAria2ProfileProbe(
        state,
        profileId,
        cappedDeadline(deps.clock.now(), PROBE_INTERVAL_MS),
      )
      if (deferred.changed) await commit(deferred.state)
      const current = state.profiles[profileId]
      if (current === undefined) return
      return { profile: current, candidates }
    })
    if (claim === undefined) return
    for (const candidate of claim.candidates) {
      let status: Aria2Status
      try {
        // oxlint-disable-next-line no-await-in-loop -- profile failures must stop later probes.
        status = await deps.aria2.tellStatus(claim.profile, candidate.gid)
      } catch (error) {
        trace('aria2-probe-failed', `${profileId}: ${String(error)}`)
        // oxlint-disable-next-line no-await-in-loop -- the circuit mutation precedes loop exit.
        await inLane(async () => {
          if (state.profiles[profileId] !== claim.profile) return
          const unavailable = recordAria2ProfileUnavailable(state, profileId, deps.clock.now())
          if (unavailable.changed) await commit(unavailable.state)
        })
        return
      }
      // oxlint-disable-next-line no-await-in-loop -- each exact reply is applied before the next RPC.
      const shouldProject = await inLane(async () => {
        if (
          state.profiles[profileId] !== claim.profile ||
          state.entries[candidate.id]?.phase !== candidate.phase
        )
          return false
        if (!isTerminalAria2Status(status)) {
          const moved = recordAria2Progress(state, {
            id: candidate.id,
            gid: candidate.gid,
            profileId,
            status: status.status,
            observedAt: deps.clock.now(),
            completedLength: status.completedLength,
            totalLength: status.totalLength,
          })
          if (moved.changed) await commit(moved.state)
          return false
        }
        const moved = recordAria2Terminal(state, {
          id: candidate.id,
          gid: candidate.gid,
          profileId,
          status: status.status,
          completedLength: status.completedLength,
          totalLength: status.totalLength,
          observedAt: deps.clock.now(),
          ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
          ...(status.errorMessage === undefined ? {} : { errorMessage: status.errorMessage }),
        })
        if (moved.changed) await commit(moved.state)
        return moved.changed
      })
      // oxlint-disable-next-line no-await-in-loop -- projection ordering follows the durable apply.
      if (shouldProject) await projectOutsideLane(candidate.id)
    }
    await inLane(async () => {
      if (state.profiles[profileId] !== claim.profile) return
      const success = recordAria2ProfileProbeSuccess(state, profileId, claim.profile.nextProbeAt)
      if (success.changed) await commit(success.state)
    })
  }
  const runRetry = async (
    id: string,
    expectedPhase?: Extract<TransferRegistryWork, { readonly tag: 'retry-browser' }>['phase'],
  ): Promise<void> => {
    const refresh = await inLane(async () => {
      const waiting = state.entries[id]
      if (
        waiting === undefined ||
        !canRunSweepWork(waiting) ||
        (expectedPhase !== undefined && waiting.phase !== expectedPhase)
      )
        return
      const claimed = claimRetryRefresh(state, id, deps.clock.now())
      if (claimed.token === undefined) return
      await commit(claimed.state)
      const entry = state.entries[id]
      if (entry?.phase.tag !== 'retry-refreshing') return
      return { token: claimed.token, request: entry.request }
    })
    if (refresh === undefined) return
    let url: string
    try {
      url = await deps.refreshUrl(refresh.request)
    } catch (error) {
      trace('retry-url-failed', `${id}: ${String(error)}`)
      const changed = await inLane(async () => {
        const failed = failRetryRefresh(state, refresh.token, deps.clock.now())
        if (failed.changed) await commit(failed.state)
        return failed.changed
      })
      if (changed) await projectOutsideLane(id)
      return
    }
    let begun:
      | { readonly mode: 'fetched' }
      | {
          readonly mode: 'direct'
          readonly request: TransferRequest
          readonly launch: LaunchToken
        }
      | undefined
    try {
      begun = await inLane(async () => {
        const completed = completeRetryRefresh(state, refresh.token, url, deps.clock.now())
        if (completed.launch === undefined) return
        await commit(completed.state)
        const request = state.entries[id]?.request
        if (request?.mode === 'fetched') return { mode: 'fetched' as const }
        if (request?.mode !== 'direct') return
        return {
          mode: 'direct' as const,
          request,
          launch: completed.launch,
        }
      })
    } catch (error) {
      trace('retry-url-invalid', `${id}: ${String(error)}`)
      const changed = await inLane(async () => {
        const failed = failRetryRefresh(state, refresh.token, deps.clock.now())
        if (failed.changed) await commit(failed.state)
        return failed.changed
      })
      if (changed) await projectOutsideLane(id)
      return
    }
    if (begun === undefined) return
    if (begun.mode === 'fetched') {
      const work = await inLane(async () =>
        planWork().due.find(
          (
            candidate,
          ): candidate is Extract<TransferRegistryWork, { readonly tag: 'launch-fetched' }> =>
            candidate.tag === 'launch-fetched' && candidate.id === id,
        ),
      )
      // Dispatch through the planner key. A simultaneous zero-delay timer then
      // joins this exact drive instead of reserving the same capacity twice.
      if (work !== undefined) await dispatchPlannedWork(work)
      return
    }
    let retryStart:
      | { readonly tag: 'started'; readonly downloadId: number }
      | { readonly tag: 'ambiguous' }
      | { readonly tag: 'busy' }
      | { readonly tag: 'failed' }
    try {
      retryStart = await deps.startRetry('direct', begun.request, begun.launch)
    } catch (error) {
      trace('retry-start-failed', `${id}: ${String(error)}`)
      const next = await inLane(async () => {
        const retried = rescheduleRetryLaunchFailure(state, begun.launch, deps.clock.now())
        if (!retried.changed) return
        await commit(retried.state)
        return state.entries[id]
      })
      if (next?.phase.tag === 'terminal-pending') await projectOutsideLane(id)
      return
    }
    if (retryStart.tag === 'ambiguous') {
      await inLane(async () => {
        const unresolved = resolveUntrackedStartTransition(state, begun.launch, deps.clock.now())
        if (unresolved.changed) await commit(unresolved.state)
      })
      return
    }
    if (retryStart.tag === 'busy') {
      const changed = await inLane(async () => {
        const failed = failRetryStart(state, begun.launch, deps.clock.now())
        if (failed.changed) await commit(failed.state)
        return failed.changed
      })
      if (changed) await projectOutsideLane(id)
      return
    }
    if (retryStart.tag === 'failed') {
      const changed = await inLane(async () => {
        const failed = failRetryStart(state, begun.launch, deps.clock.now())
        if (failed.changed) await commit(failed.state)
        return failed.changed
      })
      if (changed) await projectOutsideLane(id)
      return
    }
    const downloadId = retryStart.downloadId
    let active: TransferEntry | undefined
    try {
      active = await inLane(async () => {
        const bound = bindStartedTransition(
          state,
          begun.launch,
          { kind: 'browser', id: downloadId },
          deps.clock.now(),
        )
        if (!bound.changed)
          throw new TransferRegistryTransitionError('retry handle bind', id, 'stale launch')
        await commit(bound.state)
        return state.entries[id]
      })
    } catch (error) {
      trace('retry-bind-persist-failed', `${id}: ${String(error)}`)
      await deps.downloads.cancel(downloadId).catch(() => undefined)
      await inLane(async () => {
        const unresolved = resolveUntrackedStartTransition(state, begun.launch, deps.clock.now(), {
          kind: 'browser',
          id: downloadId,
        })
        if (unresolved.changed) await commit(unresolved.state)
      })
      return
    }
    if (active !== undefined) {
      await bindClearTransfer('retry', begun.request, downloadId, begun.launch.priorDownloadId)
    }
  }
  /** Capacity is a proven pre-handoff miss. Retry only from durable state. */
  const driveCapacityLaunch = async (
    id: string,
    expectedPhase?: Extract<TransferRegistryWork, { readonly tag: 'launch-fetched' }>['phase'],
  ): Promise<void> => {
    const begun = await inLane(async () => {
      const waiting = state.entries[id]
      if (
        waiting === undefined ||
        (expectedPhase !== undefined && waiting.phase !== expectedPhase) ||
        !canRunSweepWork(waiting) ||
        fetchedCleanupBlocks.has(id) ||
        livePreparationBlocks.has(id) ||
        (waiting.phase.tag !== 'ready' &&
          (waiting.phase.tag !== 'fetched-capacity-wait' ||
            waiting.phase.retryAt > deps.clock.now()))
      )
        return
      const claimed = beginCapacityLaunch(state, id, deps.clock.now())
      if (claimed.launch === undefined) return
      await commit(claimed.state)
      const request = state.entries[id]?.request
      if (request === undefined || request.mode !== 'fetched') return
      return { request, launch: claimed.launch }
    })
    if (begun === undefined) return
    let reservation:
      | { readonly tag: 'reserved'; readonly leaseId: string }
      | { readonly tag: 'busy' }
      | { readonly tag: 'ambiguous' }
      | { readonly tag: 'failed' }
    try {
      reservation = await deps.reserveFetched(begun.request, begun.launch)
    } catch (error) {
      trace('capacity-reserve-failed', `${id}: ${String(error)}`)
      reservation = { tag: 'failed' }
    }
    if (reservation.tag === 'busy') {
      await inLane(async () => {
        const deferred = deferLaunchForCapacity(state, begun.launch, deps.clock.now())
        if (deferred.changed) await commit(deferred.state)
      })
      return
    }
    if (reservation.tag === 'ambiguous') {
      await inLane(async () => {
        const unresolved = resolveUntrackedStartTransition(state, begun.launch, deps.clock.now())
        if (unresolved.changed) await commit(unresolved.state)
      })
      return
    }
    if (reservation.tag === 'failed') {
      const changed = await inLane(async () => {
        const failed =
          begun.launch.priorDownloadId === undefined
            ? rejectStartTransition(state, begun.launch, deps.clock.now())
            : failRetryStart(state, begun.launch, deps.clock.now())
        if (failed.changed) await commit(failed.state)
        return failed.changed
      })
      if (changed) await projectOutsideLane(id)
      return
    }
    const armed = await inLane(async () => {
      const next = armFetchedCallTransition(
        state,
        begun.launch,
        reservation.leaseId,
        deps.clock.now(),
      )
      if (!next.changed) return false
      await commit(next.state)
      return true
    })
    if (!armed) return
    let retryStart:
      | { readonly tag: 'started'; readonly downloadId: number }
      | { readonly tag: 'ambiguous' }
      | { readonly tag: 'failed' }
    try {
      retryStart = await deps.startReservedFetched(begun.request, begun.launch, reservation.leaseId)
    } catch (error) {
      trace('capacity-start-failed', `${id}: ${String(error)}`)
      retryStart = { tag: 'ambiguous' }
    }
    if (retryStart.tag === 'ambiguous') {
      await inLane(async () => {
        const unresolved = resolveUntrackedStartTransition(state, begun.launch, deps.clock.now())
        if (unresolved.changed) await commit(unresolved.state)
      })
      return
    }
    if (retryStart.tag === 'failed') {
      const next = await inLane(async () => {
        const failed =
          begun.launch.priorDownloadId === undefined
            ? rejectStartTransition(state, begun.launch, deps.clock.now())
            : rescheduleRetryLaunchFailure(state, begun.launch, deps.clock.now())
        if (!failed.changed) return
        await commit(failed.state)
        return state.entries[id]
      })
      if (next?.phase.tag === 'terminal-pending') await projectOutsideLane(id)
      return
    }
    let active: TransferEntry | undefined
    try {
      active = await inLane(async () => {
        const bound = bindStartedTransition(
          state,
          begun.launch,
          { kind: 'browser', id: retryStart.downloadId },
          deps.clock.now(),
        )
        if (!bound.changed)
          throw new TransferRegistryTransitionError('capacity handle bind', id, 'stale launch')
        await commit(bound.state)
        return state.entries[id]
      })
    } catch (error) {
      trace('capacity-bind-persist-failed', `${id}: ${String(error)}`)
      await deps.downloads.cancel(retryStart.downloadId).catch(() => undefined)
      await inLane(async () => {
        const unresolved = resolveUntrackedStartTransition(state, begun.launch, deps.clock.now(), {
          kind: 'browser',
          id: retryStart.downloadId,
        })
        if (unresolved.changed) await commit(unresolved.state)
      })
      return
    }
    if (active !== undefined) {
      await bindClearTransfer('capacity', begun.request, retryStart.downloadId)
    }
  }
  const runCapacityLaunch = async (
    id: string,
    expectedPhase?: Extract<TransferRegistryWork, { readonly tag: 'launch-fetched' }>['phase'],
  ): Promise<void> => {
    if (capacityLaunches.has(id)) return
    capacityLaunches.add(id)
    try {
      await driveCapacityLaunch(id, expectedPhase)
    } finally {
      capacityLaunches.delete(id)
    }
  }
  const driveDirectReady = async (
    id: string,
    expectedPhase?: Extract<TransferRegistryWork, { readonly tag: 'launch-direct' }>['phase'],
  ): Promise<void> => {
    const begun = await inLane(async () => {
      const entry = state.entries[id]
      if (
        entry?.phase.tag !== 'direct-ready' ||
        (expectedPhase !== undefined && entry.phase !== expectedPhase) ||
        !canRunSweepWork(entry) ||
        livePreparationBlocks.has(id)
      )
        return
      const token = launchTokenFor(state, id)
      if (token === undefined) return
      const armed = armDirectCallTransition(state, token, deps.clock.now())
      if (!armed.changed) return
      await commit(armed.state)
      return { request: entry.request, token }
    })
    if (begun === undefined) return
    let result:
      | { readonly tag: 'started'; readonly downloadId: number }
      | { readonly tag: 'ambiguous' }
      | { readonly tag: 'busy' }
      | { readonly tag: 'failed' }
    try {
      result = await deps.startRetry('direct', begun.request, begun.token)
    } catch (error) {
      trace('ready-direct-start-failed', `${id}: ${String(error)}`)
      result = { tag: 'ambiguous' }
    }
    if (result.tag === 'ambiguous') {
      await inLane(async () => {
        const unresolved = resolveUntrackedStartTransition(state, begun.token, deps.clock.now())
        if (unresolved.changed) await commit(unresolved.state)
      })
      return
    }
    if (result.tag === 'busy' || result.tag === 'failed') {
      const changed = await inLane(async () => {
        const failed = rejectStartTransition(state, begun.token, deps.clock.now())
        if (failed.changed) await commit(failed.state)
        return failed.changed
      })
      if (changed) await projectOutsideLane(id)
      return
    }
    let active: TransferEntry | undefined
    try {
      active = await inLane(async () => {
        const bound = bindStartedTransition(
          state,
          begun.token,
          { kind: 'browser', id: result.downloadId },
          deps.clock.now(),
        )
        if (!bound.changed)
          throw new TransferRegistryTransitionError('Direct handle bind', id, 'stale launch')
        await commit(bound.state)
        return state.entries[id]
      })
    } catch (error) {
      trace('ready-direct-bind-failed', `${id}: ${String(error)}`)
      await deps.downloads.cancel(result.downloadId).catch(() => undefined)
      await inLane(async () => {
        const unresolved = resolveUntrackedStartTransition(state, begun.token, deps.clock.now(), {
          kind: 'browser',
          id: result.downloadId,
        })
        if (unresolved.changed) await commit(unresolved.state)
      })
      return
    }
    if (active !== undefined) {
      await bindClearTransfer('ready', begun.request, result.downloadId)
    }
  }
  const driveAria2Ready = async (
    id: string,
    expectedPhase?: Extract<TransferRegistryWork, { readonly tag: 'launch-aria2' }>['phase'],
  ): Promise<void> => {
    const begun = await inLane(async () => {
      const entry = state.entries[id]
      if (
        entry?.phase.tag !== 'aria2-ready' ||
        (expectedPhase !== undefined && entry.phase !== expectedPhase) ||
        !canRunSweepWork(entry) ||
        livePreparationBlocks.has(id)
      )
        return
      const token = launchTokenFor(state, id)
      const profile = state.profiles[entry.phase.profileId]
      if (token === undefined || profile === undefined) return
      const armed = armAria2CallTransition(state, token, deps.clock.now())
      if (!armed.changed) return
      await commit(armed.state)
      return {
        request: entry.request,
        token,
        profile,
        options: entry.phase.options,
      }
    })
    if (begun === undefined) return
    let result:
      | { readonly tag: 'started'; readonly gid: string }
      | { readonly tag: 'ambiguous' }
      | { readonly tag: 'failed' }
    try {
      result = await deps.startAria2(begun.request, begun.token, begun.profile, begun.options)
    } catch (error) {
      trace('ready-aria2-start-failed', `${id}: ${String(error)}`)
      result = { tag: 'ambiguous' }
    }
    if (result.tag === 'failed') {
      const changed = await inLane(async () => {
        const failed = failAria2CallDefinitely(state, begun.token, deps.clock.now())
        if (failed.changed) await commit(failed.state)
        return failed.changed
      })
      if (changed) await projectOutsideLane(id)
      return
    }
    if (result.tag === 'ambiguous' || result.gid !== begun.token.gid) {
      await inLane(async () => {
        const unresolved = markAria2CallAmbiguous(state, begun.token, deps.clock.now())
        if (unresolved.changed) await commit(unresolved.state)
      })
      return
    }
    try {
      await inLane(async () => {
        const bound = bindStartedTransition(
          state,
          begun.token,
          { kind: 'aria2', gid: result.gid },
          deps.clock.now(),
        )
        if (!bound.changed)
          throw new TransferRegistryTransitionError('aria2 handle bind', id, 'stale launch')
        await commit(bound.state)
      })
    } catch (error) {
      trace('ready-aria2-bind-failed', `${id}: ${String(error)}`)
      await inLane(async () => {
        const unresolved = markAria2ConfirmedUnbound(state, begun.token, deps.clock.now())
        if (unresolved.changed) await commit(unresolved.state)
      })
    }
  }
  const runReadyLaunch = async (
    id: string,
    expectedPhase?:
      | Extract<TransferRegistryWork, { readonly tag: 'launch-direct' }>['phase']
      | Extract<TransferRegistryWork, { readonly tag: 'launch-aria2' }>['phase'],
  ): Promise<void> => {
    if (readyLaunches.has(id)) return
    readyLaunches.add(id)
    try {
      if (expectedPhase?.tag === 'direct-ready') await driveDirectReady(id, expectedPhase)
      else if (expectedPhase?.tag === 'aria2-ready') await driveAria2Ready(id, expectedPhase)
      else {
        await driveDirectReady(id)
        await driveAria2Ready(id)
      }
    } finally {
      readyLaunches.delete(id)
    }
  }
  async function runPlannedWork(work: TransferRegistryWork): Promise<void> {
    switch (work.tag) {
      case 'launch-direct':
      case 'launch-aria2':
        await runReadyLaunch(work.id, work.phase)
        return
      case 'launch-fetched':
        await runCapacityLaunch(work.id, work.phase)
        return
      case 'retry-browser':
        await runRetry(work.id, work.phase)
        return
      case 'probe-browser':
        await probeBrowser(work.id, work.downloadId, work.phase)
        return
      case 'project-terminal':
        await projectOutsideLane(work.id, work.phase)
        return
      case 'watch-inflight':
        // This is a wake lease, never a second external call. If this worker
        // still owns the phase, final reconciliation renews it; if it died,
        // boot quarantines the persisted phase before planning work.
        await inLane(async () => {
          const entry = state.entries[work.id]
          if (entry?.phase !== work.phase) return
          inflightWatchRetryAt.set(
            transferRegistryWorkKey(work),
            cappedDeadline(deps.clock.now(), PROBE_INTERVAL_MS),
          )
        })
        return
      case 'probe-aria2-profile':
        await probeProfile(work.profileId, work.profile)
        return
      case 'forget-transfer':
        await driveForget(work.token)
        return
      case 'discard-fetched-staging':
        await driveFetchedStagingCleanup(work)
        return
      case 'probe-legacy-browser':
        await probeLegacy(work.id, work.downloadId, work.phase)
        return
      case 'project-legacy-terminal':
        await projectLegacyOutsideLane(work.id, work.phase)
        return
      case 'forget-legacy-transfer':
        await driveLegacyForget(work.token)
        return
    }
  }
  function dispatchPlannedWork(work: TransferRegistryWork): Promise<void> {
    const key = transferRegistryWorkKey(work)
    const current = activeWorkDrives.get(key)
    if (current !== undefined) return current
    const run = (async () => {
      const claimed = await inLane(async () => {
        if (activeWorkKeys.has(key)) return false
        activeWorkKeys.add(key)
        await reconcilePlan()
        return true
      })
      if (!claimed) return
      try {
        await runPlannedWork(work)
      } finally {
        activeWorkKeys.delete(key)
        await inLane(reconcilePlan)
      }
    })()
    const drive = run.finally(() => {
      if (activeWorkDrives.get(key) === drive) activeWorkDrives.delete(key)
    })
    activeWorkDrives.set(key, drive)
    return drive
  }
  const applyFetchedObservations = async (
    observations: ReadonlyArray<FetchedBootObservation>,
    orphanFetchedTerminals: number[],
  ): Promise<void> => {
    for (const observation of observations) {
      if (observation.tag !== 'staging' && observation.tag !== 'matched') continue
      const recovered = recoverFetchedObservation(state, observation, deps.clock.now())
      // Install the cleanup fence before a successful commit can expose ready
      // work to this already-running registry.
      if (observation.tag === 'staging') {
        const prior = pendingFetchedStagingCleanup.get(observation.leaseId)
        pendingFetchedStagingCleanup.set(observation.leaseId, {
          ...(prior?.requestId === undefined && recovered.accepted
            ? { requestId: observation.owner.requestId }
            : prior?.requestId === undefined
              ? {}
              : { requestId: prior.requestId }),
          attempt: prior?.attempt ?? 0,
          retryAt: Math.min(prior?.retryAt ?? deps.clock.now(), deps.clock.now()),
        })
        if (recovered.accepted) fetchedCleanupBlocks.add(observation.owner.requestId)
      }
      // oxlint-disable-next-line no-await-in-loop -- each observation reduces the state produced by its predecessor.
      if (recovered.changed) await commit(recovered.state)
      if (observation.tag === 'staging') continue
      if (!recovered.accepted && observation.terminal)
        orphanFetchedTerminals.push(observation.downloadId)
    }
  }
  const releaseOrphanFetchedTerminals = (downloadIds: ReadonlyArray<number>): Promise<void[]> =>
    Promise.all(
      downloadIds.map((downloadId) =>
        deps
          .releaseAutonomousFetched(downloadId)
          .catch((error) =>
            trace('fetched-orphan-boot-release-failed', `${downloadId}: ${String(error)}`),
          ),
      ),
    )

  const orphanFetchedTerminals: number[] = []
  let cleanupMigratedLegacy = false
  const boot = (async (): Promise<void> => {
    let raw = await deps.storage.get()
    if (raw !== undefined) {
      const current = decodeTransferRegistryStore(raw)
      if (current.ok) {
        state = current.state
        if (typeof raw === 'object' && raw !== null && 'version' in raw && raw.version === 3)
          await persist(state)
      } else {
        const migrated = migrateV2TransferRegistryStore(raw)
        if (!migrated.ok) {
          unsafeReason = current.reason
          trace('registry-corrupt', current.reason)
          throw new TransferRegistryCorruptionError(current.reason)
        }
        await persist(migrated.state)
        state = migrated.state
      }
    } else if (deps.migrateLegacy !== undefined) {
      const migrated = await deps.migrateLegacy()
      if (migrated !== undefined) {
        const checked = decodeTransferRegistryStore(migrated)
        if (!checked.ok) {
          unsafeReason = `legacy migration: ${checked.reason}`
          throw new TransferRegistryCorruptionError(unsafeReason)
        }
        await persist(checked.state)
        state = checked.state
        cleanupMigratedLegacy = true
      }
    }
    await applyFetchedObservations(deps.fetchedBoot ?? [], orphanFetchedTerminals)
    const bootNow = deps.clock.now()
    const quarantined = quarantineLaunchingOnBoot(state, bootNow)
    const rebased = rebaseClockRollbackOnBoot(quarantined.state, bootNow)
    if (quarantined.changed || rebased.changed) await commit(rebased.state)
    for (const token of listPendingForgetRecovery(state))
      forgetRetryAt.set(transferRegistryForgetKey(token), deps.clock.now())
    for (const token of listPendingLegacyForgetRecovery(state))
      forgetRetryAt.set(transferRegistryForgetKey(token), deps.clock.now())
  })()
  const bootBarrier = boot
    .then(async () => {
      if (cleanupMigratedLegacy)
        await deps.cleanupLegacy?.().catch((error) => trace('legacy-cleanup-failed', String(error)))
      await driveFetchedStagingCleanup()
      await releaseOrphanFetchedTerminals(orphanFetchedTerminals)
      readyForWork = true
      await rearm()
      return undefined
    })
    .catch((error) => {
      readyForWork = false
      clearTimers()
      throw error
    })
  void bootBarrier
    .then(async () => {
      const due = await inLane(async () =>
        planWork().due.filter(
          (work) =>
            work.tag === 'probe-browser' ||
            work.tag === 'project-terminal' ||
            work.tag === 'probe-aria2-profile' ||
            work.tag === 'forget-transfer' ||
            work.tag === 'probe-legacy-browser' ||
            work.tag === 'project-legacy-terminal' ||
            work.tag === 'forget-legacy-transfer',
        ),
      )
      await Promise.all(due.map(dispatchPlannedWork))
      return undefined
    })
    .catch((error) => trace('registry-reconcile-failed', String(error)))
  return {
    ready: () => bootBarrier,
    reconcileFetchedBoot: async (observations) => {
      const orphanTerminals: number[] = []
      await inLane(() => applyFetchedObservations(observations, orphanTerminals))
      await driveFetchedStagingCleanup()
      await releaseOrphanFetchedTerminals(orphanTerminals)
      await inLane(reconcilePlan)
    },
    prepare: (requests, reservations = {}) =>
      inLane(async () => {
        const prepared = prepareLaunches(
          state,
          requests,
          deps.clock.now(),
          canonicalReservations(reservations),
        )
        const heldIds = prepared.launches.map(({ id }) => id)
        heldIds.forEach((id) => livePreparationBlocks.add(id))
        try {
          if (prepared.launches.length > 0) await commit(prepared.state)
        } catch (error) {
          heldIds.forEach((id) => livePreparationBlocks.delete(id))
          throw error
        }
        return {
          launches: prepared.launches,
          duplicateIds: prepared.duplicateIds,
        }
      }),
    prepareGroups: (groups, reservations = {}) =>
      inLane(async () => {
        const prepared = prepareLaunchGroups(
          state,
          groups,
          deps.clock.now(),
          canonicalReservations(reservations),
        )
        const heldIds = prepared.launches.map(({ id }) => id)
        heldIds.forEach((id) => livePreparationBlocks.add(id))
        try {
          if (prepared.launches.length > 0) await commit(prepared.state)
        } catch (error) {
          heldIds.forEach((id) => livePreparationBlocks.delete(id))
          throw error
        }
        return {
          launches: prepared.launches,
          duplicateMainIds: prepared.duplicateMainIds,
        }
      }),
    releasePreparedStarts: (tokens) =>
      inLane(async () => {
        const permitted = permitPreparedLaunches(state, tokens)
        try {
          if (permitted.changed) await commit(permitted.state)
        } catch (error) {
          // No launch may follow a failed permit commit. Expose the still-durable
          // prepared rows to recovery instead of retaining a dead process lock.
          for (const token of tokens) livePreparationBlocks.delete(token.id)
          throw error
        }
        for (const token of tokens) {
          const entry = state.entries[token.id]
          if (entry?.phase.tag !== 'ready' || entry.request.mode !== 'fetched') continue
          livePreparationBlocks.delete(token.id)
        }
        await reconcilePlan()
      }),
    armAria2Call: (id, token) =>
      inLane(async () => {
        if (id !== token.id)
          throw new TransferRegistryTransitionError('aria2 arm', id, 'token id mismatch')
        const entry = state.entries[id]
        if (entry === undefined)
          throw new TransferRegistryTransitionError('aria2 arm', id, 'missing launch')
        if (!canRunSweepWork(entry))
          throw new TransferRegistryTransitionError('aria2 arm', id, 'Sweep ownership missing')
        const armed = armAria2CallTransition(state, token, deps.clock.now())
        if (!armed.changed)
          throw new TransferRegistryTransitionError('aria2 arm', id, 'stale launch')
        await commit(armed.state)
        livePreparationBlocks.delete(id)
      }),
    armDirectCall: (id, token) =>
      inLane(async () => {
        if (id !== token.id)
          throw new TransferRegistryTransitionError('Direct arm', id, 'token id mismatch')
        const entry = state.entries[id]
        if (entry === undefined)
          throw new TransferRegistryTransitionError('Direct arm', id, 'missing launch')
        if (!canRunSweepWork(entry))
          throw new TransferRegistryTransitionError('Direct arm', id, 'Sweep ownership missing')
        const armed = armDirectCallTransition(state, token, deps.clock.now())
        if (!armed.changed)
          throw new TransferRegistryTransitionError('Direct arm', id, 'stale launch')
        await commit(armed.state)
        livePreparationBlocks.delete(id)
      }),
    armFetchedCall: (id, token, leaseId) =>
      inLane(async () => {
        if (id !== token.id)
          throw new TransferRegistryTransitionError('Fetched arm', id, 'token id mismatch')
        const entry = state.entries[id]
        if (entry === undefined)
          throw new TransferRegistryTransitionError('Fetched arm', id, 'missing launch')
        if (!canRunSweepWork(entry))
          throw new TransferRegistryTransitionError('Fetched arm', id, 'Sweep ownership missing')
        const armed = armFetchedCallTransition(state, token, leaseId, deps.clock.now())
        if (!armed.changed)
          throw new TransferRegistryTransitionError('Fetched arm', id, 'stale launch')
        await commit(armed.state)
        livePreparationBlocks.delete(id)
      }),
    abandonPrepared: (tokens) =>
      inLane(async () => {
        const abandoned = abandonPrepared(state, tokens)
        if (abandoned.changed) await commit(abandoned.state)
        for (const token of tokens) livePreparationBlocks.delete(token.id)
      }),
    bindStarted: (id, token, handle) =>
      inLane(async () => {
        if (id !== token.id)
          throw new TransferRegistryTransitionError('handle bind', id, 'token id mismatch')
        const bound = bindStartedTransition(state, token, handle, deps.clock.now())
        if (!bound.changed)
          throw new TransferRegistryTransitionError('handle bind', id, 'stale launch')
        try {
          await commit(bound.state)
        } catch (error) {
          if (handle.kind === 'aria2') {
            const unresolved = markAria2ConfirmedUnbound(state, token, deps.clock.now())
            if (unresolved.changed) await commit(unresolved.state)
          }
          throw error
        }
      }),
    rejectStart: async (id, token) => {
      const shouldProject = await inLane(async () => {
        if (id !== token.id)
          throw new TransferRegistryTransitionError('start rejection', id, 'token id mismatch')
        if (state.entries[id]?.phase.tag === 'aria2-call-armed') {
          const ambiguous = markAria2CallAmbiguous(state, token, deps.clock.now())
          if (!ambiguous.changed)
            throw new TransferRegistryTransitionError('start rejection', id, 'stale launch')
          await commit(ambiguous.state)
          return
        }
        const rejected = rejectStartTransition(state, token, deps.clock.now())
        if (!rejected.changed)
          throw new TransferRegistryTransitionError('start rejection', id, 'stale launch')
        await commit(rejected.state)
        return true
      })
      if (shouldProject) await projectOutsideLane(id)
    },
    deferLaunch: (id, token) =>
      inLane(async () => {
        if (id !== token.id)
          throw new TransferRegistryTransitionError('capacity deferral', id, 'token id mismatch')
        const deferred = deferLaunchForCapacity(state, token, deps.clock.now())
        if (!deferred.changed)
          throw new TransferRegistryTransitionError('capacity deferral', id, 'stale launch')
        await commit(deferred.state)
      }),
    resolveUntrackedStart: async (id, token, handle) => {
      const cleanup = await inLane(async () => {
        const browserDownloadId = handle?.kind === 'browser' ? handle.id : undefined
        if (id !== token.id)
          return browserDownloadId === undefined
            ? undefined
            : { downloadId: browserDownloadId, quarantine: false }
        if (handle?.kind === 'aria2') {
          const unresolved = markAria2ConfirmedUnbound(state, token, deps.clock.now())
          if (unresolved.changed) await commit(unresolved.state)
          return
        }
        if (browserDownloadId !== undefined)
          return {
            downloadId: browserDownloadId,
            quarantine: isCurrentLaunch(state, token),
          }
        if (!isCurrentLaunch(state, token)) return
        const unresolved = resolveUntrackedStartTransition(state, token, deps.clock.now(), handle)
        if (unresolved.changed) await commit(unresolved.state)
      })
      if (cleanup === undefined) return
      await deps.downloads
        .cancel(cleanup.downloadId)
        .catch((error) => trace('untracked-cancel-failed', String(error)))
      if (!cleanup.quarantine) return
      await inLane(async () => {
        const unresolved = resolveUntrackedStartTransition(state, token, deps.clock.now(), {
          kind: 'browser',
          id: cleanup.downloadId,
        })
        if (unresolved.changed) await commit(unresolved.state)
      })
    },
    onDownloadChanged: async (delta) => {
      const terminalState = delta.state?.current
      const work = await inLane(
        async (): Promise<
          | { readonly tag: 'browser'; readonly work: BrowserFollowUp }
          | { readonly tag: 'legacy'; readonly id: string }
          | { readonly tag: 'unmatched-terminal'; readonly downloadId: number }
          | undefined
        > => {
          const entry = browserEntryFor(state, delta.id)
          if (entry === undefined) {
            const legacy = legacyEntryFor(state, delta.id)
            if (
              legacy !== undefined &&
              (terminalState === 'complete' || terminalState === 'interrupted')
            ) {
              const changed = await terminalLegacy(
                legacy[0],
                legacy[1],
                terminalState === 'complete' ? 'complete' : 'failed',
              )
              return changed ? { tag: 'legacy', id: legacy[0] } : undefined
            }
            return terminalState === 'complete' || terminalState === 'interrupted'
              ? { tag: 'unmatched-terminal', downloadId: delta.id }
              : undefined
          }
          const followUp = await terminalWorkFor(entry, terminalState, delta.error?.current)
          return followUp === undefined ? undefined : { tag: 'browser', work: followUp }
        },
      )
      if (work?.tag === 'unmatched-terminal') {
        let observed: FetchedTerminalTransferObservation | undefined
        try {
          observed = await deps.observeTerminalFetched(work.downloadId)
        } catch (error) {
          trace('fetched-terminal-observation-failed', `${work.downloadId}: ${String(error)}`)
          return
        }
        if (observed === undefined) {
          await deps
            .releaseAutonomousFetched(work.downloadId)
            .catch((error) =>
              trace('fetched-orphan-release-failed', `${work.downloadId}: ${String(error)}`),
            )
          return
        }
        const recovered = await inLane(
          async (): Promise<BrowserFollowUp | 'autonomous' | 'retained' | undefined> => {
            const existing = browserEntryFor(state, work.downloadId)
            if (existing !== undefined)
              return await terminalWorkFor(existing, terminalState, delta.error?.current)
            const claimed = recoverFetchedObservation(state, observed, deps.clock.now())
            if (claimed.changed) await commit(claimed.state)
            if (!claimed.accepted)
              return state.entries[observed.owner.requestId] === undefined
                ? 'autonomous'
                : 'retained'
            const bound = browserEntryFor(state, work.downloadId)
            return bound === undefined
              ? 'retained'
              : await terminalWorkFor(bound, terminalState, delta.error?.current)
          },
        )
        if (recovered === undefined || recovered === 'retained') return
        if (recovered === 'autonomous') {
          await deps
            .releaseAutonomousFetched(work.downloadId)
            .catch((error) =>
              trace('fetched-orphan-release-failed', `${work.downloadId}: ${String(error)}`),
            )
          return
        }
        await finishBrowserDeltaWork(recovered)
        return
      }
      if (work?.tag === 'legacy') {
        await projectLegacyOutsideLane(work.id)
        return
      }
      if (work?.tag !== 'browser') return
      await finishBrowserDeltaWork(work.work)
    },
    probeStuck: async () => {
      const due = await inLane(async () =>
        planWork().due.filter(
          (work) =>
            work.tag === 'probe-browser' ||
            work.tag === 'probe-aria2-profile' ||
            work.tag === 'probe-legacy-browser' ||
            work.tag === 'project-legacy-terminal',
        ),
      )
      await Promise.all([...activeWorkDrives.values(), ...due.map(dispatchPlannedWork)])
    },
    onWake: async () => {
      const due = await inLane(async () => planWork().due)
      await Promise.all([...activeWorkDrives.values(), ...due.map(dispatchPlannedWork)])
    },
    clearRecovery: () =>
      inLane(async () => ({
        active: Object.values(state.entries).flatMap((entry) =>
          entry.phase.tag === 'active'
            ? [{ request: entry.request, downloadId: entry.phase.downloadId }]
            : [],
        ),
        retryOwnedRequestIds: new Set(
          Object.values(state.entries)
            .filter(
              (entry) =>
                entry.phase.tag === 'retry-wait' ||
                entry.phase.tag === 'retry-refreshing' ||
                entry.phase.tag === 'retry-launching' ||
                entry.phase.tag === 'direct-prepared' ||
                entry.phase.tag === 'direct-ready' ||
                entry.phase.tag === 'fetched-prepared' ||
                entry.phase.tag === 'fetched-capacity-wait' ||
                entry.phase.tag === 'ready' ||
                entry.phase.tag === 'fetched-call-armed' ||
                entry.phase.tag === 'aria2-prepared' ||
                entry.phase.tag === 'aria2-ready',
            )
            .map((entry) => entry.request.id),
        ),
        legacyActive: Object.entries(state.legacy).flatMap(([id, entry]) =>
          entry.phase.tag === 'active'
            ? [
                {
                  id,
                  downloadId: entry.downloadId,
                  ...(entry.tweetId === undefined ? {} : { tweetId: entry.tweetId }),
                },
              ]
            : [],
        ),
      })),
    inspectRecovery: () =>
      inLane(async () =>
        listTransferRecovery(state).filter((item) => !livePreparationBlocks.has(item.id)),
      ),
    listPendingTerminalProjectionIds: () =>
      inLane(async () =>
        Object.values(state.entries)
          .filter((entry) => entry.phase.tag === 'terminal-pending')
          .map((entry) => entry.request.projectionId)
          .toSorted(),
      ),
    listSweepReceiptIntents: () =>
      inLane(async () =>
        Object.values(state.entries)
          .map((entry) => entry.request)
          .filter((request) => request.sweepReceipt !== undefined)
          .toSorted((left, right) => left.id.localeCompare(right.id)),
      ),
    listPreparedSweepIntents: () =>
      inLane(async () =>
        Object.values(state.entries)
          .filter(
            (entry) =>
              entry.request.sweepReceipt !== undefined &&
              hasConfirmedSweepOwnership(entry) &&
              (entry.phase.tag === 'direct-prepared' ||
                entry.phase.tag === 'fetched-prepared' ||
                entry.phase.tag === 'aria2-prepared'),
          )
          .map((entry) => entry.request)
          .toSorted((left, right) => left.id.localeCompare(right.id)),
      ),
    abandonSweepReceipt: (receiptId) =>
      inLane(async () => {
        const abandoned = abandonSweepReceiptTransition(state, receiptId)
        if (abandoned.changed) await commit(abandoned.state)
        for (const id of livePreparationBlocks)
          if (state.entries[id] === undefined) livePreparationBlocks.delete(id)
        return abandoned.changed
      }),
    confirmSweepOwnership: (clearSeedIdByReceipt) =>
      inLane(async () => {
        const confirmed = confirmSweepOwnershipTransition(state, clearSeedIdByReceipt)
        if (confirmed.changed) await commit(confirmed.state)
        return new Set(clearSeedIdByReceipt.keys())
      }),
    releaseConfirmedSweepStarts: () =>
      inLane(async () => {
        const tokens = Object.values(state.entries).flatMap((entry) => {
          if (
            entry.request.sweepReceipt === undefined ||
            !hasConfirmedSweepOwnership(entry) ||
            (entry.phase.tag !== 'direct-prepared' &&
              entry.phase.tag !== 'fetched-prepared' &&
              entry.phase.tag !== 'aria2-prepared')
          )
            return []
          const token = launchTokenFor(state, entry.request.id)
          return token === undefined ? [] : [token]
        })
        const permitted = permitPreparedLaunches(state, tokens)
        if (permitted.changed) await commit(permitted.state)
        for (const token of tokens) livePreparationBlocks.delete(token.id)
        sweepBootBarrierOpen = true
        await reconcilePlan()
      }),
    forgetRecovery: async (id) => {
      const claim = await inLane(
        async (): Promise<
          | { readonly tag: 'current'; readonly token: ForgetTransferToken }
          | {
              readonly tag: 'legacy'
              readonly token: LegacyForgetTransferToken
            }
          | undefined
        > => {
          if (livePreparationBlocks.has(id)) return
          const pending = listPendingForgetRecovery(state).find((token) => token.id === id)
          if (pending !== undefined) return { tag: 'current', token: pending }
          const begun = beginForgetRecovery(state, id, deps.clock.now())
          if (begun.token !== undefined) {
            await commit(begun.state)
            return { tag: 'current', token: begun.token }
          }
          const pendingLegacy = listPendingLegacyForgetRecovery(state).find(
            (token) => token.id === id,
          )
          if (pendingLegacy !== undefined) return { tag: 'legacy', token: pendingLegacy }
          const begunLegacy = beginLegacyForgetRecovery(state, id, deps.clock.now())
          if (begunLegacy.token === undefined) return
          await commit(begunLegacy.state)
          return { tag: 'legacy', token: begunLegacy.token }
        },
      )
      if (claim === undefined) return false
      if (claim.tag === 'current') return driveForget(claim.token)
      return driveLegacyForget(claim.token)
    },
  }
}
