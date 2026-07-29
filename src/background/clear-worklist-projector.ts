import { makeSerialQueue } from '../core/serial-queue'
import type { ClearCoordinatorTrace, ClearStateStore } from './clear-state-store'
import { CLEAR_WORKLIST_PROJECTION_BATCH } from './clear-worklist-projection'
import type { StoredClearWorklistProjection } from './clear-worklist-projection'

const MAX_BATCHES_PER_DRAIN = 10

export interface ClearWorklistProjector {
  /** Best-effort flush. A recurring owner alarm retries every durable row. */
  readonly drain: () => Promise<void>
}

export const makeClearWorklistProjector = (input: {
  readonly store: Pick<ClearStateStore, 'listWorklistProjections' | 'ackWorklistProjection'>
  readonly sink: (projection: StoredClearWorklistProjection) => Promise<void> | void
  readonly ensureWake: () => Promise<void> | void
  readonly trace: (stage: string, context?: ClearCoordinatorTrace) => void
  readonly onError?: (error: unknown) => void
}): ClearWorklistProjector => {
  const serial = makeSerialQueue(input.onError)

  const drainImpl = async (): Promise<void> => {
    try {
      for (let batch = 0; batch < MAX_BATCHES_PER_DRAIN; batch += 1) {
        // oxlint-disable-next-line no-await-in-loop -- each batch observes exact acks from the last.
        const rows = await input.store.listWorklistProjections()
        if (rows.length === 0) return
        try {
          // oxlint-disable-next-line no-await-in-loop -- every nonempty batch proves a future wake.
          await input.ensureWake()
        } catch (error) {
          input.trace('clear-projection-wake-error', {
            detail: error instanceof Error ? error.message : String(error),
          })
          return
        }
        let stale = false
        for (const row of rows) {
          try {
            // oxlint-disable-next-line no-await-in-loop -- storage.local has one serialized writer.
            await input.sink(row)
            // oxlint-disable-next-line no-await-in-loop -- exact ack follows its persisted projection.
            if ((await input.store.ackWorklistProjection(row)) === 'stale') stale = true
          } catch (error) {
            input.trace('clear-projection-error', {
              tweetId: row.tweetId,
              detail: `${row.scope}/${row.state}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            })
            return
          }
        }
        if (rows.length < CLEAR_WORKLIST_PROJECTION_BATCH && !stale) return
      }
    } catch (error) {
      input.trace('clear-projection-read-error', {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return {
    drain: async () => await serial.run(drainImpl),
  }
}
