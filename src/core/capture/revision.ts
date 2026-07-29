export interface CaptureRevision {
  readonly sourceRank: 1 | 2
  readonly capturedAt: number
}

/** One merge law for local rows and their pending mirror projection. */
export const incomingCaptureWins = (
  existing: CaptureRevision,
  incoming: CaptureRevision,
): boolean =>
  incoming.sourceRank > existing.sourceRank ||
  (incoming.sourceRank === existing.sourceRank && incoming.capturedAt >= existing.capturedAt)
