import {
  decodeClearDownloadMonitorResponse,
  decodeMetricsSnapshot,
  type MetricsSnapshot,
} from '@/core/schema/download'

/** An unclaimed worker reply means no monitor data, never a rendered guess. */
export const monitorSnapshotFromReply = (value: unknown): MetricsSnapshot | null =>
  decodeMetricsSnapshot(value) ?? null

/** Clear UI state only after the exact successful reset receipt. */
export const didClearMonitor = (value: unknown): boolean => {
  const reply = decodeClearDownloadMonitorResponse(value)
  return reply?.ok === true && reply.active === 0 && reply.clearedMetrics
}
