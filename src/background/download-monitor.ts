import { storage } from 'wxt/utils/storage'
import {
  decodeMetricsSnapshot,
  MAX_TRACE_DETAIL_LENGTH,
  MAX_TRACE_STAGE_LENGTH,
  type DownloadTraceEntry,
  type MetricsSnapshot,
} from '../core/schema/download'
import { boundedDiagnosticText } from '../core/diagnostic-text'
import {
  emptyMetrics,
  extendTotal,
  recordOutcome,
  recordSample,
  snapshot,
  type MetricsState,
} from '../core/download/metrics'
import type { TerminalProjection } from '../core/download/terminal-outcome'

const MAX_TRACE_EVENTS = 12

const ZERO_SNAPSHOT: MetricsSnapshot = {
  total: 0,
  completed: 0,
  failed: 0,
  active: 0,
  retries: 0,
  concurrencyCap: 0,
  bytesReceived: 0,
  bytesTotal: 0,
  throughputBps: 0,
  elapsedMs: 0,
}

const batchSettled = (state: MetricsState): boolean => state.completed + state.failed >= state.total

const boundedElapsed = (value: number): number =>
  Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value))) : 0

/** Internal diagnostics share the same contract as decoded content traces.
 * Normalize here so no browser/provider error can poison the whole snapshot. */
const normalizeTrace = (event: DownloadTraceEntry): DownloadTraceEntry => {
  const { stage, elapsedMs, detail, ...rest } = event
  return {
    ...rest,
    stage: boundedDiagnosticText(stage === '' ? 'unknown' : stage, MAX_TRACE_STAGE_LENGTH),
    ...(elapsedMs === undefined ? {} : { elapsedMs: boundedElapsed(elapsedMs) }),
    ...(detail === undefined
      ? {}
      : { detail: boundedDiagnosticText(detail, MAX_TRACE_DETAIL_LENGTH) }),
  }
}

export interface MetricsSnapshotStore {
  /** Session storage is untrusted on every worker boot. */
  readonly get: () => Promise<unknown>
  readonly set: (value: MetricsSnapshot | null) => Promise<void>
}

export interface BrowserProgressPort {
  readonly search: (query: { readonly id: number }) => Promise<
    ReadonlyArray<{
      readonly id: number
      readonly bytesReceived: number
      readonly totalBytes: number
    }>
  >
}

export interface DownloadMonitor {
  /** Append an arbitrary trace event. Diagnostics never gain authority. */
  readonly recordTrace: (event: DownloadTraceEntry) => void
  readonly traceBackground: (
    stage: string,
    opts?: Omit<DownloadTraceEntry, 'source' | 'stage' | 't'>,
  ) => void
  /** Persist the current advisory projection. */
  readonly persist: (now: number) => Promise<void>
  /** Persist without letting a telemetry write affect durable transfer truth. */
  readonly persistBestEffort: (stage: string, now: number) => Promise<void>
  readonly read: (now: number) => Promise<MetricsSnapshot>
  /** Begin one accepted launch batch. Registry remains the transfer authority. */
  readonly beginBatch: (input: {
    readonly requestIds: ReadonlyArray<string>
    readonly concurrencyCap: number
    readonly at: number
  }) => void
  readonly restoreBrowserTransfer: (downloadId: number, requestId: string) => void
  readonly bindBrowserTransfer: (downloadId: number, requestId: string) => void
  readonly elapsedSinceRequest: (requestId: string, now: number, fallback: number) => number
  readonly recordStarted: (requestId: string, at: number) => void
  readonly recordTerminal: (
    requestId: string,
    outcome: 'complete' | 'failed',
    at: number,
  ) => Promise<void>
  readonly traceTerminal: (projection: TerminalProjection) => void
  readonly traceLegacyTerminal: (input: {
    readonly requestId: string
    readonly outcome: 'complete' | 'failed'
    readonly downloadId: number
    readonly at: number
  }) => Promise<void>
  /**
   * A terminal delta commits durable Registry work before any telemetry I/O.
   * Non-terminal sampling remains advisory but is awaited before its ordinary
   * Registry update, preserving the existing progress ordering.
   */
  readonly onBrowserDelta: (input: {
    readonly downloadId: number
    readonly terminal: boolean
    readonly at: number
    readonly commitDurable: () => Promise<void>
  }) => Promise<void>
  /** Clears only advisory monitor state. Registry and Clear state are untouched. */
  readonly reset: () => Promise<{
    readonly active: number
    /** A launch batch still owns queued work with no browser handle yet. */
    readonly pending: boolean
    readonly cleared: boolean
  }>
}

const defaultStore = (): MetricsSnapshotStore => {
  const item = storage.defineItem<MetricsSnapshot | null>('session:metrics', { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}

const defaultProgress = (): BrowserProgressPort => ({
  search: (query) => browser.downloads.search(query),
})

/**
 * Owns the best-effort monitor only: metrics, Chrome-id correlation, request
 * timing, trace history, and its session projection. Transfer Registry and
 * Clear retain all durable authority.
 */
export const makeDownloadMonitor = (
  deps: {
    readonly snapshots?: MetricsSnapshotStore
    readonly progress?: BrowserProgressPort
    readonly now?: () => number
    readonly log?: (event: DownloadTraceEntry) => void
  } = {},
): DownloadMonitor => {
  const snapshots = deps.snapshots ?? defaultStore()
  const progress = deps.progress ?? defaultProgress()
  const now = deps.now ?? Date.now
  let live: MetricsState | null = null
  let traceEvents: DownloadTraceEntry[] = []
  let generation = 0
  const requestIdByDownloadId = new Map<number, string>()
  const requestStartedAt = new Map<string, number>()
  let writes = Promise.resolve()

  const currentSnapshot = (at: number): MetricsSnapshot => {
    const base = live === null ? ZERO_SNAPSHOT : snapshot(live, at)
    return traceEvents.length === 0 ? base : { ...base, events: traceEvents }
  }

  const write = (value: MetricsSnapshot | null): Promise<void> => {
    const task = writes.then(() => snapshots.set(value))
    writes = task.catch(() => {})
    return task
  }

  /**
   * `storage.session` may survive an extension update or contain malformed
   * data. A missing value can use this worker's live projection; malformed
   * data must never create a fake active count or NaN reset decision.
   */
  const readPersisted = async (): Promise<MetricsSnapshot | null> => {
    try {
      const value = await snapshots.get()
      if (value === null) return null
      // A malformed advisory snapshot has no authority. Ignore it and let the
      // caller project this worker's live state instead of silently hiding it.
      return decodeMetricsSnapshot(value) ?? null
    } catch {
      return null
    }
  }

  const recordTrace = (event: DownloadTraceEntry): void => {
    const normalized = normalizeTrace(event)
    traceEvents = [...traceEvents, normalized].slice(-MAX_TRACE_EVENTS)
    try {
      deps.log?.(normalized)
    } catch {
      /* diagnostics never affect transfer authority */
    }
  }

  const traceBackground: DownloadMonitor['traceBackground'] = (stage, opts = {}) =>
    recordTrace({ source: 'background', stage, t: now(), ...opts })

  const persist = (at: number): Promise<void> => write(currentSnapshot(at))

  const persistBestEffort = async (stage: string, at: number): Promise<void> => {
    try {
      await persist(at)
    } catch (error) {
      traceBackground(`metrics:${stage}-persist-failed`, {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const sample = async (
    downloadId: number,
    requestId: string,
    at: number,
    expectedGeneration: number,
  ): Promise<boolean> => {
    try {
      const rows = await progress.search({ id: downloadId })
      if (expectedGeneration !== generation || live === null) return false
      for (const row of rows) {
        if (row.id === downloadId)
          live = recordSample(live, {
            id: requestId,
            bytesReceived: row.bytesReceived,
            totalBytes: row.totalBytes,
            t: at,
          })
      }
      return true
    } catch (error) {
      traceBackground('sample-search-failed', {
        detail: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  const recordTerminal: DownloadMonitor['recordTerminal'] = async (requestId, outcome, at) => {
    if (live === null) return
    live = recordOutcome(live, requestId, outcome, at)
    await persistBestEffort('terminal', at)
  }

  return {
    recordTrace,
    traceBackground,
    persist,
    persistBestEffort,
    read: async (at) => (await readPersisted()) ?? currentSnapshot(at),
    beginBatch: ({ requestIds, concurrencyCap, at }) => {
      for (const requestId of requestIds) requestStartedAt.set(requestId, at)
      // A queued sibling has no browser-progress sample yet. It still belongs
      // to this batch, so a fast terminal must not let the next batch erase it.
      if (live === null || batchSettled(live)) {
        requestIdByDownloadId.clear()
        live = emptyMetrics({ total: requestIds.length, concurrencyCap, startedAt: at })
      } else {
        live = extendTotal(live, requestIds.length, concurrencyCap)
      }
    },
    restoreBrowserTransfer: (downloadId, requestId) =>
      requestIdByDownloadId.set(downloadId, requestId),
    bindBrowserTransfer: (downloadId, requestId) =>
      requestIdByDownloadId.set(downloadId, requestId),
    elapsedSinceRequest: (requestId, at, fallback) =>
      Math.max(0, at - (requestStartedAt.get(requestId) ?? fallback)),
    recordStarted: (requestId, at) => {
      if (live !== null)
        live = recordSample(live, { id: requestId, bytesReceived: 0, totalBytes: -1, t: at })
    },
    recordTerminal,
    traceTerminal: (projection) => {
      const { evidence, observedAt, requestId, outcome } = projection
      if (evidence.tag === 'browser') requestIdByDownloadId.delete(evidence.downloadId)
      const startedAt = requestStartedAt.get(requestId) ?? observedAt
      requestStartedAt.delete(requestId)
      recordTrace({
        source: 'background',
        stage: outcome === 'complete' ? 'transfer-complete' : 'transfer-failed',
        t: observedAt,
        itemId: requestId,
        elapsedMs: Math.max(0, observedAt - startedAt),
        detail:
          evidence.tag === 'browser'
            ? `downloadId ${evidence.downloadId}`
            : evidence.tag === 'aria2'
              ? `aria2 ${evidence.gid}`
              : 'start failed',
      })
    },
    traceLegacyTerminal: async ({ requestId, outcome, downloadId, at }) => {
      requestIdByDownloadId.delete(downloadId)
      await recordTerminal(requestId, outcome, at)
      const startedAt = requestStartedAt.get(requestId) ?? at
      requestStartedAt.delete(requestId)
      recordTrace({
        source: 'background',
        stage: outcome === 'complete' ? 'legacy-transfer-complete' : 'legacy-transfer-failed',
        t: at,
        itemId: requestId,
        elapsedMs: Math.max(0, at - startedAt),
        detail: `downloadId ${downloadId}`,
      })
    },
    onBrowserDelta: async ({ downloadId, terminal, at, commitDurable }) => {
      const requestId = requestIdByDownloadId.get(downloadId)
      const observedGeneration = generation
      if (terminal) {
        await commitDurable()
        if (requestId !== undefined)
          void sample(downloadId, requestId, at, observedGeneration).then((sampled) =>
            sampled ? persistBestEffort('terminal-sample', at) : undefined,
          )
        return
      }
      if (requestId !== undefined) await sample(downloadId, requestId, at, observedGeneration)
      await commitDurable()
      if (observedGeneration === generation) await persist(at)
    },
    reset: async () => {
      const persisted = await readPersisted()
      const active = Math.max(persisted?.active ?? 0, currentSnapshot(now()).active)
      const pending = live !== null && !batchSettled(live)
      // `active` counts browser handles. A queue-owned sibling may not have a
      // handle yet, but resetting here would erase its batch before it starts.
      if (active > 0 || pending) return { active, pending, cleared: false }
      generation += 1
      requestIdByDownloadId.clear()
      requestStartedAt.clear()
      traceEvents = []
      live = null
      await write(null)
      return { active: 0, pending: false, cleared: true }
    },
  }
}
