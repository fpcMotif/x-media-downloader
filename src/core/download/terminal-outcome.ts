import type { HistoryAction } from '../history/action'
import type { TransferOutcome } from '../schema'
import { outcomeEvent, queuedEvent, type SyncEvent } from '../sync/events'
import { mediaRequestId } from './request-identity'
import type { ItemOutcome } from './metrics'
import { terminalOutcome } from './transfer-registry'
import type { TerminalEvidence, TransferEntry, TransferMode } from './transfer-registry-model'
import type { HistoryProjectionPolicy } from './transfer-registry-model'

/** The only terminal data allowed to leave the durable transfer owner. */
export interface TerminalProjection {
  /** Stable receipt key. Never infer this from a request id at projection time. */
  readonly projectionId: string
  /** Exact persisted correlation key for Registry, Gateway, Clear, and old Sync rows. */
  readonly requestId: string
  /** Canonical cross-platform Save Request ID for History and UI projections. */
  readonly logicalRequestId: string
  readonly createdAt: number
  readonly observedAt: number
  readonly outcome: TerminalOutcome
  readonly mode: TransferMode
  readonly historyPolicy: HistoryProjectionPolicy
  readonly filename: string
  /** Absent means an operational sidecar or metadata-free legacy row. */
  readonly item?: TransferEntry['request']['item']
  readonly evidence: TerminalEvidence
}

/** A terminal state as understood by user-facing projections. */
export type TerminalOutcome = ItemOutcome

/**
 * Strip a terminal registry entry down to the immutable truth every sink needs.
 * In particular, this does not expose an aria2 profile, URL, or RPC secret.
 */
export const terminalProjectionFromEntry = (
  entry: TransferEntry,
): TerminalProjection | undefined => {
  if (entry.phase.tag !== 'terminal-pending') return undefined
  const { request } = entry
  return {
    projectionId: request.projectionId,
    requestId: request.id,
    logicalRequestId: request.item === undefined ? request.id : mediaRequestId(request.item),
    createdAt: entry.createdAt,
    observedAt: entry.phase.observedAt,
    outcome: terminalOutcome(entry.phase.evidence),
    mode: request.mode,
    historyPolicy: request.historyPolicy,
    filename: request.filename,
    ...(request.item === undefined ? {} : { item: request.item }),
    evidence: entry.phase.evidence,
  }
}

const isSafeAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

const safeDecimal = (value: string): number | undefined => {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return undefined
  const number = Number(value)
  return isSafeAmount(number) ? number : undefined
}

/** Exact bytes are optional. Never round an aria2 decimal into a false number. */
export const historyBytesForTerminal = (
  projection: TerminalProjection,
): { readonly received: number; readonly total: number } | undefined => {
  const { evidence } = projection
  if (evidence.tag === 'browser') {
    if (!isSafeAmount(evidence.bytesReceived) || !isSafeAmount(evidence.totalBytes))
      return undefined
    return { received: evidence.bytesReceived, total: evidence.totalBytes }
  }
  if (evidence.tag === 'aria2') {
    const received = safeDecimal(evidence.completedLength)
    const total = safeDecimal(evidence.totalLength)
    return received === undefined || total === undefined ? undefined : { received, total }
  }
  return undefined
}

/**
 * One atomic History batch. Sidecars have no media identity, so they cannot
 * create or mutate a history row. Migrated rows retain only their terminal edge.
 */
export const historyActionsForTerminal = (
  projection: TerminalProjection,
): ReadonlyArray<HistoryAction> => {
  if (projection.item === undefined || projection.historyPolicy === 'off') return []
  const bytes = historyBytesForTerminal(projection)
  const terminal: HistoryAction = {
    kind: projection.outcome === 'complete' ? 'completed' : 'failed',
    requestId: projection.logicalRequestId,
    at: projection.observedAt,
    ...(bytes === undefined ? {} : { bytes }),
  }
  if (projection.historyPolicy === 'transition-only') return [terminal]
  return [
    {
      kind: 'queued',
      recordingEnabled: true,
      requestId: projection.logicalRequestId,
      item: projection.item,
      filename: projection.filename,
      at: projection.createdAt,
    },
    terminal,
  ]
}

/** One durable Sync append. A migrated row may supply only its terminal edge. */
export const syncEventsForTerminal = (
  projection: TerminalProjection,
  deviceId: string,
): ReadonlyArray<SyncEvent> => {
  if (projection.item === undefined) return []
  const syncRequestId =
    projection.historyPolicy === 'transition-only'
      ? projection.requestId
      : projection.logicalRequestId
  const terminal = outcomeEvent(
    syncRequestId,
    projection.outcome === 'complete' ? 'completed' : 'failed',
    deviceId,
    projection.observedAt,
  )
  return projection.historyPolicy === 'transition-only'
    ? [terminal]
    : [queuedEvent(projection.item, deviceId, projection.createdAt, syncRequestId), terminal]
}

/** Budget credit is intentionally lossy for unsafe aria2 values, never fatal. */
export const budgetCreditForTerminal = (
  projection: TerminalProjection,
): { readonly bytes: number; readonly count: 1 } | undefined => {
  if (projection.item === undefined || projection.outcome !== 'complete') return undefined
  if (projection.evidence.tag === 'browser')
    return {
      bytes: isSafeAmount(projection.evidence.bytesReceived)
        ? projection.evidence.bytesReceived
        : 0,
      count: 1,
    }
  if (projection.evidence.tag === 'aria2')
    return { bytes: safeDecimal(projection.evidence.completedLength) ?? 0, count: 1 }
  return undefined
}

export const backlinkForTerminal = (projection: TerminalProjection): TransferOutcome | undefined =>
  projection.item === undefined || projection.evidence.tag === 'start-failed'
    ? undefined
    : {
        _tag: 'TransferOutcome',
        requestId: projection.logicalRequestId,
        outcome: projection.outcome,
        at: projection.observedAt,
      }
