import { isTrulyCompleteDurable, type ClearLogRecord } from '../core/clear/ledger'
import {
  makeClearCompletionLifecycle,
  type SeedClearInput,
  type SeedClearResult,
} from './clear-completion-lifecycle'
import { makeClearDestructiveDrive } from './clear-destructive-drive'
import type {
  ClearDownloadSearch,
  ClearSettingsAuthority,
  ClearTabs,
  ClearWakePort,
} from './clear-ports'
import {
  defaultLegacyStorage,
  defaultPointerStorage,
  defaultSessionMarker,
  defaultStorage,
  defaultClearBackend,
  makeClearStateStore,
  realClock,
  unique,
  type ClearClock,
  type ClearCoordinatorStorage,
  type ClearCoordinatorTrace,
  type ClearSessionMarkerStorage,
  type ClearStorePointerStorage,
  type ClearStateStore,
  type LegacyCompletionStorage,
} from './clear-state-store'
import type { ClearDurableBackend } from './clear-indexed-db'
import { makeClearWorklistProjector } from './clear-worklist-projector'
import type { ClearWorklistProjectionWake } from './clear-worklist-projection'
import type { StoredClearWorklistProjection } from './clear-worklist-projection'

export {
  ClearCoordinatorCorruptionError,
  decodeClearCoordinatorStore,
  decodeClearSessionMarker,
  encodeClearCoordinatorStore,
  type ClearCoordinatorStorage,
  type ClearCoordinatorStore,
  type ClearSessionMarker,
  type ClearSessionMarkerStorage,
  type ClearStorePointer,
  type ClearStorePointerStorage,
  type CoordinatorState,
  type DecodeClearCoordinatorStore,
  type LegacyCompletionStorage,
} from './clear-state-store'
export type { SeedClearInput, SeedClearResult } from './clear-completion-lifecycle'
export type {
  ClearDownloadRow,
  ClearDownloadSearch,
  ClearSettingsAuthority,
  ClearTabs,
  ClearWakePort,
} from './clear-ports'
export type { ClearClock } from './clear-state-store'
export type { ClearDurableBackend } from './clear-indexed-db'

export interface ClearCoordinatorDeps {
  readonly storage?: ClearCoordinatorStorage
  readonly legacyStorage?: LegacyCompletionStorage
  readonly pointerStorage?: ClearStorePointerStorage
  readonly sessionMarker?: ClearSessionMarkerStorage
  readonly backend?: ClearDurableBackend
  readonly newStoreId?: () => string
  /** Owns every durable settle and destructive-safety deadline. */
  readonly wake: ClearWakePort
  /** Arms the durable Worklist projection outbox before a Clear commit. */
  readonly projectionWake: ClearWorklistProjectionWake
  readonly clock?: ClearClock
  readonly postTerminalDelay?: () => number
  readonly downloadSearch: ClearDownloadSearch
  readonly tabs: ClearTabs
  readonly settings: ClearSettingsAuthority
  readonly onError?: (error: unknown) => void
  readonly trace?: (stage: string, context?: ClearCoordinatorTrace) => void
  /** Required durable Worklist sink. A missing JS caller fails before outbox ack. */
  readonly projectScopeState: (projection: StoredClearWorklistProjection) => Promise<void> | void
}
export interface ClearCoordinator {
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
  /** Recover durable completion evidence, open a proven external session, then drive ready Clears. */
  readonly resumeOnBoot: (input: {
    readonly retryOwnedRequestIds: ReadonlySet<string>
    readonly adoptExternalSession: boolean
  }) => Promise<void>
  readonly onVisibilityPulse: (tabId: number, tweetIds: ReadonlyArray<string>) => Promise<void>
  readonly onBrowserStartup: () => Promise<void>
  readonly onSafetyWake: (input: {
    readonly retryOwnedRequestIds: ReadonlySet<string>
  }) => Promise<void>
  readonly onProjectionWake: () => Promise<void>
  readonly listClearLog: () => Promise<ReadonlyArray<ClearLogRecord>>
}

const sampleDelay =
  (deps: ClearCoordinatorDeps): (() => number) =>
  () => {
    const delay = deps.postTerminalDelay?.() ?? 2000 + Math.floor(Math.random() * 2001)
    if (!Number.isSafeInteger(delay) || delay < 2000 || delay > 4000)
      throw new TypeError(`Invalid Clear post-terminal delay: ${delay}`)
    return delay
  }

export function makeClearCoordinator(deps: ClearCoordinatorDeps): ClearCoordinator {
  const clock = deps.clock ?? realClock
  const trace = (stage: string, context?: ClearCoordinatorTrace): void => {
    try {
      deps.trace?.(stage, context)
    } catch {
      /* diagnostics cannot change authority */
    }
  }
  const postTerminalDelay = sampleDelay(deps)
  const store: ClearStateStore = makeClearStateStore({
    storage: deps.storage ?? defaultStorage(),
    legacyStorage: deps.legacyStorage ?? defaultLegacyStorage(),
    pointerStorage: deps.pointerStorage ?? defaultPointerStorage(),
    sessionMarker: deps.sessionMarker ?? defaultSessionMarker(),
    backend: deps.backend ?? defaultClearBackend(),
    clock,
    samplePostTerminalDelay: postTerminalDelay,
    newStoreId: deps.newStoreId ?? (() => crypto.randomUUID()),
    ensureWorklistWake: deps.projectionWake.ensure,
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
    trace,
  })
  const projector = makeClearWorklistProjector({
    store,
    sink: async (projection) => await deps.projectScopeState(projection),
    ensureWake: store.armWorklistWake,
    trace,
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
  })
  const project = projector.drain
  const driver = makeClearDestructiveDrive({
    store,
    clock,
    wake: deps.wake,
    tabs: deps.tabs,
    settings: deps.settings,
    trace,
    project,
    ensureProjectionWake: store.armWorklistWake,
    postTerminalDelay,
    ...(deps.onError === undefined ? {} : { onError: deps.onError }),
  })
  const lifecycle = makeClearCompletionLifecycle({
    store,
    clock,
    wake: deps.wake,
    downloadSearch: deps.downloadSearch,
    trace,
    project,
    onReady: async (tweetIds) =>
      await driver.driveReady(tweetIds === undefined ? {} : { tweetIds }),
  })
  const onVisibilityPulse: ClearCoordinator['onVisibilityPulse'] = async (tabId, tweetIds) => {
    if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError(`Invalid tab id: ${tabId}`)
    if (tweetIds.length > 100 || !unique(tweetIds))
      throw new TypeError('Visibility pulse must contain at most 100 unique tweet ids')
    tweetIds.forEach((tweetId) => {
      if (!/^[0-9]{1,20}$/.test(tweetId)) throw new TypeError(`Invalid X tweet id: ${tweetId}`)
    })
    await store.initialize()
    if (!store.isGateOpen()) await store.adoptExternalSession()
    const state = await store.snapshot()
    const eligible = tweetIds.filter((tweetId) => {
      const entry = state.completion.entries.get(tweetId)
      return entry !== undefined && isTrulyCompleteDurable(entry)
    })
    if (eligible.length > 0) await driver.driveReady({ onlyTabId: tabId, tweetIds: eligible })
  }
  return {
    seed: lifecycle.seed,
    bindStarted: lifecycle.bindStarted,
    rebindPersistedHandle: lifecycle.rebindPersistedHandle,
    failUnbound: lifecycle.failUnbound,
    abandonTransfer: lifecycle.abandonTransfer,
    recordTerminal: lifecycle.recordTerminal,
    resumeOnBoot: async ({ retryOwnedRequestIds, adoptExternalSession }) => {
      await project()
      await lifecycle.reconcileOnBoot({ retryOwnedRequestIds })
      if (adoptExternalSession) await store.adoptExternalSession()
      await driver.driveReady()
    },
    onVisibilityPulse,
    onBrowserStartup: async () => {
      const opened = await store.onBrowserStartup()
      await project()
      if (opened) await driver.driveReady()
    },
    onSafetyWake: async ({ retryOwnedRequestIds }) => {
      await project()
      await lifecycle.probeDueSettles({ retryOwnedRequestIds })
      await driver.onSafetyWake()
    },
    onProjectionWake: project,
    listClearLog: lifecycle.listClearLog,
  }
}
