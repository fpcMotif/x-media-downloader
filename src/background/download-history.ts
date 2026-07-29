import { makeSerialQueue } from '../core/serial-queue'
import type { HistoryAction } from '../core/history/action'
import type { DownloadRecord } from '../core/history/record'
import { recordFromMediaItem } from '../core/history/record'
import { isTransferProjectionId } from '../core/wire/identity'
import {
  DEFAULT_HISTORY_CAP,
  applyTransition,
  decodeStoredHistory,
  isHistoryProjectionFenced,
  resetHistory,
  upsert,
  type DownloadStore,
} from '../core/history/store'

export type CompletedDownloadRecord = DownloadRecord & { readonly status: 'completed' }

export interface HistoryProjection {
  readonly projectionId: string
  readonly actions: ReadonlyArray<HistoryAction>
}

export type HistoryProjectionDisposition = 'applied' | 'reset-fenced'

export interface DownloadHistory {
  /** Persist one Registry projection. Its stable identity survives terminal replay. */
  readonly record: (projection: HistoryProjection) => Promise<HistoryProjectionDisposition>
  readonly list: () => Promise<ReadonlyArray<DownloadRecord>>
  readonly listCompleted: () => Promise<ReadonlyArray<CompletedDownloadRecord>>
  /** Clear records and fence terminal projections already owned by Registry. */
  readonly erase: (terminalProjectionIds: ReadonlyArray<string>) => Promise<void>
}

export interface DownloadHistoryStorage {
  readonly get: () => Promise<unknown>
  readonly set: (store: DownloadStore) => Promise<void>
}

const isCompleted = (record: DownloadRecord): record is CompletedDownloadRecord =>
  record.status === 'completed'

const isAdmitted = (action: HistoryAction): boolean =>
  action.kind !== 'queued' || action.recordingEnabled

/** Owns every durable History operation on one FIFO lane. */
export function makeDownloadHistory(deps: {
  readonly storage: DownloadHistoryStorage
  readonly onError?: (error: unknown) => void
  readonly cap?: number
}): DownloadHistory {
  const queue = makeSerialQueue(deps.onError)
  const cap = deps.cap ?? DEFAULT_HISTORY_CAP
  const read = async (persistLegacy = false): Promise<DownloadStore> => {
    const decoded = decodeStoredHistory(await deps.storage.get())
    if (decoded.kind === 'corrupt') throw new Error('Download History is corrupt')
    if (persistLegacy && decoded.kind === 'legacy') await deps.storage.set(decoded.store)
    return decoded.store
  }

  return {
    async record({ projectionId, actions }) {
      if (!isTransferProjectionId(projectionId))
        throw new TypeError('History projection id is invalid')
      const admitted = actions.filter(isAdmitted)
      return queue.run(async () => {
        let store = await read()
        if (isHistoryProjectionFenced(store, projectionId)) return 'reset-fenced' as const
        if (admitted.length === 0) return 'applied' as const
        // A recycled worker can receive an admission and its terminal outcome in
        // one batch while the durable row is absent. Rebuild every admission
        // before projecting terminals so this remains idempotent regardless of
        // action order in that batch.
        for (const queuedAction of admitted.filter((candidate) => candidate.kind === 'queued'))
          store = upsert(
            store,
            recordFromMediaItem(
              queuedAction.item,
              queuedAction.filename,
              queuedAction.at,
              queuedAction.requestId,
            ),
            cap,
          )
        for (const terminalAction of admitted.filter((candidate) => candidate.kind !== 'queued'))
          store = applyTransition(
            store,
            terminalAction.requestId,
            terminalAction.kind,
            terminalAction.at,
            terminalAction.bytes,
          )
        await deps.storage.set(store)
        return 'applied' as const
      })
    },
    list: () => queue.run(async () => (await read(true)).records),
    listCompleted: () => queue.run(async () => (await read(true)).records.filter(isCompleted)),
    erase: (terminalProjectionIds) =>
      queue.run(() => deps.storage.set(resetHistory(terminalProjectionIds))),
  }
}
