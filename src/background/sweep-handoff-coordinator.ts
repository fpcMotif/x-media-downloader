// oxlint-disable no-await-in-loop -- each Sweep receipt transition is one ordered durable handoff.
import { Effect } from 'effect'
import { mediaRequestId } from '../core/download/request-identity'
import type { MediaItem, SweepEnqueueResponse, SweepScope } from '../core/schema'
import { makeSerialQueue } from '../core/serial-queue'
import type { ClearCoordinator } from './clear-coordinator'
import type { ClearWorklistStore } from './clear-worklist-store'
import { sweepEnqueueFailureResponse } from './sweep-enqueue-response'
import { repairSweepReceipts, type SweepReceiptRepair } from './sweep-receipt-repair'
import type { SweepReceiptStore } from './sweep-receipt-store'
import type {
  SweepClearSeedOutcome,
  SweepLaunchReceipt,
  TransferLaunchCoordinator,
} from './transfer-launch-coordinator'
import type { TransferRegistry } from './transfer-registry'

type SweepPost = {
  readonly tweetId: string
  readonly items: ReadonlyArray<MediaItem>
}

const sameIds = (expected: ReadonlyArray<string>, actual: ReadonlySet<string>): boolean =>
  expected.length === actual.size && expected.every((id) => actual.has(id))

export interface SweepHandoffCoordinator {
  /** Returns queued only after Registry has durable ownership. */
  readonly enqueue: (
    scope: SweepScope,
    posts: ReadonlyArray<SweepPost>,
  ) => Promise<SweepEnqueueResponse>
  /** Repairs, confirms, acknowledges, then runs the required release policy in one lane. */
  readonly recoverThroughRelease: (
    release: (repair: SweepReceiptRepair) => Promise<void>,
  ) => Promise<void>
}

/**
 * One owner for the Sweep cross-store handoff:
 * receipt set -> Registry preparation -> Clear seed -> Worklist -> Registry permit.
 * Any pre-permit interruption leaves receipts for this same lane to repair.
 */
export const makeSweepHandoffCoordinator = (deps: {
  readonly receipts: SweepReceiptStore
  readonly worklist: Pick<
    ClearWorklistStore,
    'selectSweepPosts' | 'claimSeededSweepPosts' | 'ensureSeededSweepPosts'
  >
  readonly clear: Pick<ClearCoordinator, 'seed'>
  readonly registry: () => TransferRegistry | undefined
  readonly settings: () => Promise<Parameters<typeof repairSweepReceipts>[0]['settings']>
  readonly launch: TransferLaunchCoordinator['launch']
  /** Strictly arms a durable repair wake before any receipt or repair mutation. */
  readonly armWatchdog: () => Promise<void>
  readonly now?: () => number
  /** Runs after an ambiguous handoff without waiting for worker restart. */
  readonly requestSameLifeRepair?: () => void
  readonly onError?: (error: unknown) => void
}): SweepHandoffCoordinator => {
  const lane = makeSerialQueue(deps.onError)
  const now = deps.now ?? (() => Date.now())

  const retireAbandoned = async (receipts: ReadonlyArray<SweepLaunchReceipt>): Promise<void> => {
    const registry = deps.registry()
    if (registry === undefined) throw new Error('transfer registry is not booted')
    for (const receipt of receipts) {
      const abandoned = await registry.abandonSweepReceipt(receipt.receiptId)
      if (!abandoned) {
        const remaining = await registry.listSweepReceiptIntents()
        if (remaining.some((request) => request.sweepReceipt?.receiptId === receipt.receiptId))
          throw new Error(`Sweep Registry intent cannot be abandoned: ${receipt.receiptId}`)
      }
      await deps.receipts.discardAbandoned(receipt.receiptId)
    }
  }

  const recoverThroughRelease = async (
    release: (repair: SweepReceiptRepair) => Promise<void>,
  ): Promise<void> => {
    // An alarm can fire while enqueue owns this FIFO. Re-arm before queuing the
    // repair, so an in-flight receipt is still watched if this worker dies.
    await deps.armWatchdog()
    await lane.run(async () => {
      const registry = deps.registry()
      if (registry === undefined) throw new Error('transfer registry is not booted')
      const repair = await repairSweepReceipts({
        receipts: deps.receipts,
        registry,
        clear: deps.clear,
        worklist: deps.worklist,
        settings: await deps.settings(),
        now,
      })
      const confirmed = await registry.confirmSweepOwnership(repair.clearSeedIdByReceipt)
      for (const receiptId of confirmed) {
        const clearSeedId = repair.clearSeedIdByReceipt.get(receiptId)
        if (clearSeedId === undefined)
          throw new Error(`Registry confirmed an unknown Sweep receipt ${receiptId}`)
        await deps.receipts.ackOwned({ receiptId, clearSeedId })
      }
      await release(repair)
    })
  }

  return {
    recoverThroughRelease,
    enqueue: (scope, posts) =>
      lane.run(async () => {
        const selected = await deps.worklist.selectSweepPosts(scope, posts)
        if (selected.posts.length === 0)
          return { _tag: 'SweepEnqueueResponse', queued: 0, skipped: selected.skipped }
        // A crash after this receipt write must still have a durable wake. Unlike
        // reconciliation, this arm is strict: an alarm failure writes nothing.
        await deps.armWatchdog()
        const receipts = await deps.receipts.enqueueMany(
          selected.posts.map((post) => ({
            receiptId: crypto.randomUUID(),
            tweetId: post.tweetId,
            scope,
            itemIds: post.items.map(mediaRequestId),
            at: now(),
          })),
        )
        const items = selected.posts.flatMap((post) => [...post.items])
        const clearExpect = selected.posts.map((post) => ({
          tweetId: post.tweetId,
          requestIds: post.items.map(mediaRequestId),
        }))
        let clearSeedCommitted = false
        let durableHandoff = false
        let claimed = 0
        let claimSkipped = 0
        let terminalSkipped = false
        try {
          await Effect.runPromise(
            deps.launch({
              items,
              sweep: { scope },
              sweepReceipts: receipts,
              clearExpect,
              onClearSeeded: async (
                trackedByTweet,
                worklistRevision,
              ): Promise<SweepClearSeedOutcome> => {
                clearSeedCommitted = true
                if (
                  receipts.some((receipt) => {
                    const owned = trackedByTweet.get(receipt.tweetId)
                    return owned === undefined || !sameIds(receipt.itemIds, owned)
                  })
                ) {
                  terminalSkipped = true
                  return { tag: 'terminal-skip', reason: 'authoritative-clear-terminal' }
                }
                for (const receipt of receipts) {
                  await deps.receipts.markSeeded({
                    receiptId: receipt.receiptId,
                    requestIds: receipt.itemIds,
                    clearSeedId: worklistRevision,
                    at: now(),
                  })
                }
                const claim = await deps.worklist.claimSeededSweepPosts(
                  scope,
                  receipts.map(({ tweetId }) => tweetId),
                  worklistRevision,
                )
                claimed = claim.claimed
                claimSkipped = claim.skipped
                if (claim.terminalTweetIds.length > 0) {
                  terminalSkipped = true
                  return { tag: 'terminal-skip', reason: 'authoritative-worklist-terminal' }
                }
                const registry = deps.registry()
                if (registry === undefined) throw new Error('transfer registry is not booted')
                const confirmed = await registry.confirmSweepOwnership(
                  new Map(
                    receipts.map((receipt) => [receipt.receiptId, worklistRevision] as const),
                  ),
                )
                if (confirmed.size !== receipts.length)
                  throw new Error('Registry did not confirm every Sweep receipt')
                // Registry + Worklist now prove durable ownership. Receipt retirement is
                // replayable bookkeeping and must not make this truthful reply look skipped.
                durableHandoff = true
                for (const receipt of receipts)
                  await deps.receipts.ackOwned({
                    receiptId: receipt.receiptId,
                    clearSeedId: worklistRevision,
                  })
                return { tag: 'owned' }
              },
            }),
          )
          if (terminalSkipped) {
            await retireAbandoned(receipts)
            return {
              _tag: 'SweepEnqueueResponse',
              queued: 0,
              skipped: selected.skipped + selected.posts.length,
            }
          }
          if (!durableHandoff) {
            if (!clearSeedCommitted)
              for (const receipt of receipts)
                await deps.receipts.markFailed({
                  receiptId: receipt.receiptId,
                  reason: 'Clear seed was not committed',
                  at: now(),
                })
            return {
              _tag: 'SweepEnqueueResponse',
              queued: 0,
              skipped: selected.skipped + selected.posts.length,
            }
          }
          return {
            _tag: 'SweepEnqueueResponse',
            queued: claimed,
            skipped: selected.skipped + claimSkipped,
          }
        } catch (error) {
          if (!clearSeedCommitted) {
            for (const receipt of receipts)
              await deps.receipts
                .markFailed({
                  receiptId: receipt.receiptId,
                  reason: error instanceof Error ? error.message : String(error),
                  at: now(),
                })
                .catch(() => {})
          } else {
            deps.requestSameLifeRepair?.()
          }
          return sweepEnqueueFailureResponse({
            selectedPosts: selected.posts.length,
            selectionSkipped: selected.skipped,
            durableHandoff,
          })
        }
      }),
  }
}
