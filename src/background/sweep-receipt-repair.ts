import type { ClearCoordinator } from './clear-coordinator'
import type { ClearWorklistStore } from './clear-worklist-store'
import type { SweepReceiptStore } from './sweep-receipt-store'
import type { TransferRegistry } from './transfer-registry'
import { planClearSeed } from '../core/clear/seed'
import type { Settings } from '../core/schema'
import type { TransferRequest } from '../core/download/transfer-registry'

const sameIds = (expected: ReadonlyArray<string>, actual: ReadonlySet<string>): boolean =>
  expected.length === actual.size && expected.every((id) => actual.has(id))

const requestsFor = (
  receipt: Awaited<ReturnType<SweepReceiptStore['listRecoverable']>>[number],
  intents: ReadonlyArray<TransferRequest>,
): ReadonlyArray<TransferRequest> =>
  intents.filter(
    (request) =>
      request.sweepReceipt?.receiptId === receipt.receiptId &&
      request.sweepReceipt.tweetId === receipt.tweetId &&
      request.sweepReceipt.scope === receipt.scope,
  )

export interface SweepReceiptRepair {
  /** Clear must not reconcile an ambiguous Registry request as abandoned. */
  readonly protectedRequestIds: ReadonlySet<string>
  /** Registry may resume only these fully repaired pre-call intents. */
  readonly clearSeedIdByReceipt: ReadonlyMap<string, number>
}

/** Repairs only durable ownership. It never retries a Registry launch. */
export const repairSweepReceipts = async (input: {
  readonly receipts: SweepReceiptStore
  readonly registry: Pick<TransferRegistry, 'abandonSweepReceipt' | 'listSweepReceiptIntents'>
  readonly clear: Pick<ClearCoordinator, 'seed'>
  readonly worklist: Pick<ClearWorklistStore, 'ensureSeededSweepPosts'>
  readonly settings: Settings
  readonly now: () => number
}): Promise<SweepReceiptRepair> => {
  const receipts = await input.receipts.listRecoverable()
  const intents = await input.registry.listSweepReceiptIntents()
  const protectedRequestIds = new Set<string>()
  const clearSeedIdByReceipt = new Map<string, number>()
  const abandonThenFail = async (
    receipt: Awaited<ReturnType<SweepReceiptStore['listRecoverable']>>[number],
    reason: string,
  ): Promise<void> => {
    const abandoned = await input.registry.abandonSweepReceipt(receipt.receiptId)
    if (!abandoned) {
      const remaining = await input.registry.listSweepReceiptIntents()
      if (remaining.some((request) => request.sweepReceipt?.receiptId === receipt.receiptId))
        throw new Error(`Sweep Registry intent cannot be abandoned: ${receipt.receiptId}`)
    }
    await input.receipts.markFailed({ receiptId: receipt.receiptId, reason, at: input.now() })
  }
  const abandonThenDiscard = async (receiptId: string): Promise<void> => {
    const abandoned = await input.registry.abandonSweepReceipt(receiptId)
    if (!abandoned) {
      const remaining = await input.registry.listSweepReceiptIntents()
      if (remaining.some((request) => request.sweepReceipt?.receiptId === receiptId))
        throw new Error(`Sweep Registry intent cannot be abandoned: ${receiptId}`)
    }
    await input.receipts.discardAbandoned(receiptId)
  }
  // oxlint-disable no-await-in-loop -- each receipt transition is a durable serialized handoff.
  for (const receipt of receipts) {
    if (receipt.state === 'seeded') {
      const ownership = await input.worklist.ensureSeededSweepPosts(
        receipt.scope,
        [receipt.tweetId],
        receipt.clearSeedId,
      )
      if (ownership === 'terminal') {
        await abandonThenDiscard(receipt.receiptId)
        continue
      }
      receipt.requestIds.forEach((id) => protectedRequestIds.add(id))
      clearSeedIdByReceipt.set(receipt.receiptId, receipt.clearSeedId)
      continue
    }
    const requests = requestsFor(receipt, intents)
    const mediaById = new Map(
      requests.flatMap((request) =>
        request.item === undefined ? [] : [[request.id, request.item] as const],
      ),
    )
    if (
      !sameIds(receipt.itemIds, new Set(mediaById.keys())) ||
      [...mediaById.values()].some((item) => item.postId !== receipt.tweetId) ||
      requests.some((request) => request.sweepReceipt === undefined)
    ) {
      await abandonThenFail(receipt, 'missing or partial Registry Sweep intent')
      continue
    }
    const verdict = planClearSeed({
      requests,
      mediaById,
      settings: input.settings,
      sweep: { scope: receipt.scope },
      clearExpect: [{ tweetId: receipt.tweetId, requestIds: receipt.itemIds }],
    })
    if (verdict.decision === 'skip') {
      await abandonThenFail(receipt, `clear-${verdict.reason}`)
      continue
    }
    const seeded = await input.clear.seed({
      byTweet: verdict.byTweet,
      startingByTweet: verdict.startingByTweet,
      manualScopes: verdict.manualScopes,
      automaticScopes: verdict.automaticScopes,
      crossListAutomaticScopes: verdict.crossListAutomaticScopes,
    })
    const owned = seeded.trackedByTweet.get(receipt.tweetId)
    if (owned === undefined || !sameIds(receipt.itemIds, owned))
      throw new Error(`Sweep Clear seed did not own ${receipt.receiptId}`)
    await input.receipts.markSeeded({
      receiptId: receipt.receiptId,
      requestIds: receipt.itemIds,
      clearSeedId: seeded.worklistRevision,
      at: input.now(),
    })
    const ownership = await input.worklist.ensureSeededSweepPosts(
      receipt.scope,
      [receipt.tweetId],
      seeded.worklistRevision,
    )
    if (ownership === 'terminal') {
      await abandonThenDiscard(receipt.receiptId)
      continue
    }
    receipt.itemIds.forEach((id) => protectedRequestIds.add(id))
    clearSeedIdByReceipt.set(receipt.receiptId, seeded.worklistRevision)
  }
  // oxlint-enable no-await-in-loop
  return { protectedRequestIds, clearSeedIdByReceipt }
}
