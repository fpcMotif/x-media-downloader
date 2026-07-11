/**
 * Request Meta Reconcile — the boot-time plan for `requestMetaById` (background.ts's
 * in-memory url/filename/item map, keyed by request id) surviving an MV3 SW recycle.
 *
 * `requestMetaById` is retry-essential: `scheduleInterruptRetry`/`fireInterruptRetry`
 * read it to re-fire an interrupted browser download. It dies with the worker
 * (ADR-0002). Two durable ledgers already restore SOME of it on boot:
 * `session:interruptRetries` (via `rehydrateInterruptRetries`, for ids the retry
 * queue owns) and — via THIS module — `session:requestMeta`, for ids `session:transfers`
 * re-seeds as still-in-progress. `TrackedTransfer` deliberately stays narrow (its own
 * module doc: downloadId → terminal outcome) rather than widening to carry meta, so
 * this sibling record exists instead.
 *
 * Pure: no `chrome.*`, no storage I/O. The background entrypoint reads/writes
 * `session:requestMeta` and feeds this module's plan.
 */
import { Schema } from 'effect'
import { MediaItem } from '../schema'

const PersistedRequestMetaSchema = Schema.Struct({
  url: Schema.String,
  filename: Schema.String,
  item: Schema.optional(MediaItem),
})
export type PersistedRequestMeta = typeof PersistedRequestMetaSchema.Type

const RequestMetaStoreSchema = Schema.Record(Schema.String, PersistedRequestMetaSchema)
/** The persisted `session:requestMeta` shape: request id → retry-essential meta. */
export type RequestMetaStore = typeof RequestMetaStoreSchema.Type

export const emptyRequestMetaStore: RequestMetaStore = {}

/** Tolerant decode of persisted JSON → store. A corrupt/foreign shape never
 *  throws — it falls back to empty, mirroring `history/store.ts`'s `decodeStore`. */
export function decodeRequestMetaStore(raw: unknown): RequestMetaStore {
  try {
    return Schema.decodeUnknownSync(RequestMetaStoreSchema)(raw)
  } catch {
    return emptyRequestMetaStore
  }
}

export interface MetaReconcilePlan {
  /** Restore into `requestMetaById`: re-seeded transfers whose meta the retry
   *  queue does NOT already own. */
  readonly restore: ReadonlyArray<readonly [string, PersistedRequestMeta]>
  /** Ids this record must not restore: true orphans (no live owner — the GC
   *  target) plus retry-owned ids (`session:interruptRetries` restores those).
   *  The shell applies the plan by rewriting the store from the live map, so a
   *  retry-owned id rehydrate holds in memory stays mirrored until settle reaps
   *  it — only orphans actually disappear from the store. */
  readonly prune: ReadonlyArray<string>
}

/**
 * Plan the `session:requestMeta` boot reconcile (ADR-0002 companion to
 * `planBootReconcile`/`partitionOwnership`). Given the ids `reconcileTransfersOnBoot`
 * is re-seeding, the retry queue's owned ids (the dual-ledger tie-break — `rehydrateInterruptRetries`
 * runs first and is authoritative for those), and the persisted record, decide what
 * to restore into `requestMetaById` and what to prune from the persisted record.
 *
 * A retry-owned id is NEVER restored here, even if it also appears in `reSeedIds` —
 * `rehydrateInterruptRetries` already restored its meta straight from
 * `session:interruptRetries`, so restoring it again from this sibling record would
 * make the retry queue's ownership a second source of truth instead of the sole
 * driver. Its persisted entry lands in `prune` (never `restore`); since the shell
 * rewrites the store from the live map, it stays mirrored while the retry is
 * pending and is reaped at settle.
 */
export function planMetaReconcile(input: {
  readonly reSeedIds: ReadonlyArray<string>
  readonly retryOwnedIds: ReadonlySet<string>
  readonly persisted: RequestMetaStore
}): MetaReconcilePlan {
  const reSeedSet = new Set(input.reSeedIds)
  const restore: Array<readonly [string, PersistedRequestMeta]> = []
  const prune: string[] = []
  for (const [id, meta] of Object.entries(input.persisted)) {
    if (input.retryOwnedIds.has(id)) {
      prune.push(id)
    } else if (reSeedSet.has(id)) {
      restore.push([id, meta])
    } else {
      prune.push(id)
    }
  }
  return { restore, prune }
}
