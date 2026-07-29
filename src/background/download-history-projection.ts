import type { HistoryAction } from '../core/history/action'
import type { MediaItem } from '../core/schema'
import { makeSerialQueue } from '../core/serial-queue'
import type { SavedIndex } from '../core/sync/saved-index'
import type { CompletedDownloadRecord, DownloadHistory } from './download-history'

export interface DownloadHistoryProjection {
  readonly seed: () => Promise<void>
  readonly projectTerminal: (projection: {
    readonly projectionId: string
    readonly actions: ReadonlyArray<HistoryAction>
    readonly completedItem?: MediaItem
  }) => Promise<void>
  readonly list: DownloadHistory['list']
  readonly listCompleted: () => Promise<ReadonlyArray<CompletedDownloadRecord>>
  readonly erase: () => Promise<void>
}

/** One lane owns durable History and both volatile indexes derived from it.
 * Clear and terminal completion therefore have one deterministic order. */
export const makeDownloadHistoryProjection = (deps: {
  readonly history: DownloadHistory
  readonly savedPosts: Pick<SavedIndex, 'replace' | 'markSaved'>
  readonly savedRequests: Pick<SavedIndex, 'replace' | 'markSaved'>
  readonly requestIdFor: (item: MediaItem) => string
  readonly pendingTerminalProjectionIds: () => Promise<ReadonlyArray<string>>
}): DownloadHistoryProjection => {
  const lane = makeSerialQueue()

  const replaceIndexes = (records: ReadonlyArray<CompletedDownloadRecord>): void => {
    deps.savedPosts.replace(records.map((record) => record.media.postId))
    deps.savedRequests.replace(records.map((record) => record.requestId))
  }

  return {
    seed: () =>
      lane.run(async () => {
        replaceIndexes(await deps.history.listCompleted())
      }),
    projectTerminal: ({ projectionId, actions, completedItem }) =>
      lane.run(async () => {
        const disposition = await deps.history.record({ projectionId, actions })
        if (disposition === 'reset-fenced') return
        if (completedItem === undefined) return
        deps.savedPosts.markSaved(completedItem.postId)
        deps.savedRequests.markSaved(deps.requestIdFor(completedItem))
      }),
    list: () => lane.run(() => deps.history.list()),
    listCompleted: () => lane.run(() => deps.history.listCompleted()),
    erase: () =>
      lane.run(async () => {
        const terminalProjectionIds = await deps.pendingTerminalProjectionIds()
        await deps.history.erase(terminalProjectionIds)
        replaceIndexes([])
      }),
  }
}
