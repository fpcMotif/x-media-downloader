import { Schema } from 'effect'
import { DownloadRecord, applyOutcome } from './record'

/** Beyond this many records the oldest are ring-evicted. */
export const DEFAULT_HISTORY_CAP = 500

const DownloadStoreSchema = Schema.Struct({ records: Schema.Array(DownloadRecord) })

/** The durable local download history (newest-first), the local twin of `media_state`. */
export type DownloadStore = typeof DownloadStoreSchema.Type

export const emptyStore: DownloadStore = { records: [] }

/** Decode stored history; fall back to empty on a SchemaError (corrupt data). */
export function decodeStore(raw: unknown): DownloadStore {
  try {
    return Schema.decodeUnknownSync(DownloadStoreSchema)(raw)
  } catch {
    return emptyStore
  }
}

const isTerminal = (s: DownloadRecord['status']): boolean => s === 'completed' || s === 'failed'

/**
 * Insert or update a record by `requestId`, newest-first, ring-evicting beyond `cap`.
 * Monotonic: a `queued` upsert never regresses an already-terminal record.
 */
export function upsert(
  store: DownloadStore,
  record: DownloadRecord,
  cap: number = DEFAULT_HISTORY_CAP,
): DownloadStore {
  let existing: DownloadRecord | undefined
  const others = store.records.filter((r) => {
    if (r.requestId === record.requestId) {
      existing = r
      return false
    }
    return true
  })
  const effective =
    existing !== undefined && isTerminal(existing.status) && record.status === 'queued'
      ? existing
      : record
  return { records: [effective, ...others].slice(0, cap) }
}

/**
 * Apply a terminal outcome to an existing record in place; no-op if the request is
 * unknown. Monotonic: once a record is terminal, a later contradictory outcome
 * (e.g. a cross-recycle boot reconcile recording `failed` after `completed` was
 * already mirrored) does NOT regress it — the first terminal wins.
 */
export function applyTransition(
  store: DownloadStore,
  requestId: string,
  kind: 'completed' | 'failed',
  at: number,
  bytes?: { received: number; total: number },
): DownloadStore {
  let changed = false
  const records = store.records.map((r) => {
    if (r.requestId !== requestId || isTerminal(r.status)) return r
    changed = true
    return applyOutcome(r, kind, at, bytes)
  })
  return changed ? { records } : store
}
