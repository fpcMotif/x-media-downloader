import { Data, Effect } from 'effect'
import type { AdmissionGate } from './admission-gate'
import type { ClearCoordinator } from './clear-coordinator'
import type { CloudUpload } from './cloud-upload'
import type { DownloadMonitor } from './download-monitor'
import { cloudUploadIntentsFor } from './transfer-cloud-admission'
import type { TransferRegistry } from './transfer-registry'
import { planClearSeed } from '../core/clear/seed'
import { makeAria2RpcPort, makeAria2Strategy } from '../core/download/aria2'
import { makeFetchServiceLive } from '../core/fetch-service'
import type { SkipReason } from '../core/download/admission'
import { planDownloads } from '../core/download/destination'
import { makeDownloadQueueCore } from '../core/download/queue'
import { mediaRequestId } from '../core/download/request-identity'
import { browserTransferModeForInitialRequest } from '../core/download/transfer-mode'
import {
  makeDirectStrategy,
  makeSchemeRoutingStrategy,
  type DownloadStrategy,
  type DownloadsPort,
} from '../core/download/strategy'
import type { Aria2LaunchReservation, TransferRequest } from '../core/download/transfer-registry'
import { DownloadError } from '../core/errors'
import type { Settings, MediaItem, QueueUpdate } from '../core/schema'
import type { Scope } from '../core/clear/ledger'

type LaunchSkipReason = Exclude<SkipReason, 'duplicate'> | 'unsafe-url'
type ClearExpect = ReadonlyArray<{
  readonly tweetId: string
  readonly requestIds: ReadonlyArray<string>
}>
class StartedCommitError extends Data.TaggedError('StartedCommitError')<{
  readonly message: string
  readonly cause: unknown
}> {}

export interface SweepLaunchReceipt {
  readonly receiptId: string
  readonly tweetId: string
  readonly scope: 'bookmark' | 'like'
  readonly itemIds: ReadonlyArray<string>
}

/** The handoff owner decides whether Clear still has authority for this Sweep. */
export type SweepClearSeedOutcome =
  | { readonly tag: 'owned' }
  | { readonly tag: 'terminal-skip'; readonly reason: string }

export interface TransferLaunchCoordinator {
  readonly launch: (input: {
    readonly items: ReadonlyArray<MediaItem>
    readonly sweep?: { readonly scope: Scope }
    /** Durable receipt provenance. A manual Sweep cannot start without every post receipt. */
    readonly sweepReceipts?: ReadonlyArray<SweepLaunchReceipt>
    readonly clearExpect?: ClearExpect
    /** Persists Worklist ownership after Clear seed and before any transfer starts. */
    readonly onClearSeeded?: (
      trackedByTweet: ReadonlyMap<string, ReadonlySet<string>>,
      worklistRevision: number,
    ) => Promise<void | SweepClearSeedOutcome>
  }) => Effect.Effect<QueueUpdate>
}

export interface TransferLaunchCoordinatorDeps {
  readonly settings: () => Promise<Settings>
  readonly admission: AdmissionGate
  readonly registry: () => TransferRegistry | undefined
  readonly clear: Pick<ClearCoordinator, 'seed' | 'bindStarted' | 'failUnbound'>
  readonly cloud: Pick<CloudUpload, 'recordCloudUploads'>
  readonly monitor: Pick<
    DownloadMonitor,
    | 'beginBatch'
    | 'persistBestEffort'
    | 'bindBrowserTransfer'
    | 'elapsedSinceRequest'
    | 'recordStarted'
  >
  readonly trace: (
    stage: string,
    input?: {
      readonly itemId?: string
      readonly elapsedMs?: number
      readonly detail?: string
    },
  ) => void
  readonly validateMediaUrls: (item: MediaItem) => void
  readonly newProjectionId: () => string
  readonly newAria2Gid: () => string
  readonly download: DownloadsPort['download']
  readonly fetchImpl: typeof fetch
}

/** Builds a per-batch strategy. Settings and reserved identities must not leak between batches. */
const chooseStrategy = (
  deps: Pick<TransferLaunchCoordinatorDeps, 'download' | 'fetchImpl'>,
  settings: Settings,
  reservedAria2Gids: ReadonlyMap<string, string>,
): DownloadStrategy => {
  const direct = makeDirectStrategy({ download: deps.download })
  if (settings.downloadStrategy === 'aria2')
    return makeSchemeRoutingStrategy(
      makeAria2Strategy(
        makeAria2RpcPort({
          rpcUrl: settings.aria2RpcUrl,
          secret: settings.aria2Secret,
        }),
        {
          split: settings.aria2Split,
          ...(settings.aria2Dir ? { dir: settings.aria2Dir } : {}),
        },
        makeFetchServiceLive(deps.fetchImpl),
        (request) => reservedAria2Gids.get(request.id),
      ),
      direct,
    )
  return direct
}

export function makeTransferLaunchCoordinator(
  deps: TransferLaunchCoordinatorDeps,
): TransferLaunchCoordinator {
  const persistMonitor = async (stage: string, at: number): Promise<void> => {
    try {
      await deps.monitor.persistBestEffort(stage, at)
    } catch (error) {
      deps.trace('monitor-persist-failed', {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    launch: (input) =>
      Effect.gen(function* () {
        const receivedAt = Date.now()
        deps.trace('request-received', {
          detail: `${input.items.length} item(s)`,
        })
        const registry = deps.registry()
        if (registry === undefined) throw new Error('transfer registry is not booted')
        const receiptByMainId = new Map<string, SweepLaunchReceipt>()
        if (input.sweep !== undefined) {
          const receipts = input.sweepReceipts
          if (receipts === undefined) throw new Error('Sweep requires durable receipts')
          for (const receipt of receipts) {
            if (receipt.scope !== input.sweep.scope || receipt.itemIds.length === 0)
              throw new Error('invalid Sweep receipt')
            for (const itemId of receipt.itemIds) {
              if (receiptByMainId.has(itemId)) throw new Error('duplicate Sweep receipt media')
              receiptByMainId.set(itemId, receipt)
            }
          }
          if (
            receiptByMainId.size !== input.items.length ||
            input.items.some((item) => receiptByMainId.get(mediaRequestId(item)) === undefined)
          )
            throw new Error('Sweep receipts must exactly cover requested media')
        }

        // This is before admission because admission can HEAD-probe each item's URL.
        const unsafe = input.items.filter((item) => {
          try {
            deps.validateMediaUrls(item)
            return false
          } catch {
            return true
          }
        })
        const safeItems = input.items.filter((item) => !unsafe.includes(item))
        const settings = yield* Effect.promise(deps.settings)
        const admission = yield* Effect.promise(() => deps.admission.admit(safeItems))
        const duplicatesBeforeRegistry = admission.skipped.flatMap(({ item, reason }) =>
          reason === 'duplicate' ? [mediaRequestId(item)] : [],
        )
        const skippedBeforeRegistry: Array<{
          readonly requestId: string
          readonly reason: LaunchSkipReason
        }> = [
          ...unsafe.map((item) => ({
            requestId: mediaRequestId(item),
            reason: 'unsafe-url' as const,
          })),
          ...admission.skipped.flatMap(({ item, reason }) =>
            reason === 'duplicate' ? [] : [{ requestId: mediaRequestId(item), reason }],
          ),
        ]
        const mediaById = new Map(admission.admitted.map((item) => [mediaRequestId(item), item]))
        const groups = admission.admitted.map((item) => {
          const mainId = mediaRequestId(item)
          const downloads = planDownloads({
            template: settings.filenameTemplate,
            item,
            sidecar: settings.sidecarMetadata,
          })
          return input.sweep === undefined
            ? { mainId, downloads }
            : {
                mainId,
                downloads,
                sweepReceipt: receiptByMainId.get(mainId)!,
              }
        })
        const plannedDownloads = groups.flatMap(({ downloads }) => downloads)
        if (plannedDownloads.length === 0) {
          if (input.sweep !== undefined && (input.clearExpect?.length ?? 0) > 0)
            throw new Error('Sweep could not own every detected media request')
          return {
            _tag: 'QueueUpdate' as const,
            planned: [],
            started: [],
            deferred: [],
            duplicates: duplicatesBeforeRegistry,
            failures: [],
            skipped: skippedBeforeRegistry,
          }
        }

        const receiptByArtifactId = new Map(
          groups.flatMap(({ downloads, sweepReceipt }) =>
            sweepReceipt === undefined
              ? []
              : downloads.map(({ id }) => [id, sweepReceipt] as const),
          ),
        )
        // Planned values remain in `groups`; build new durable requests.
        // oxlint-disable-next-line oxc/no-map-spread
        const requests: TransferRequest[] = plannedDownloads.map((request) => {
          const item = mediaById.get(request.id)
          const sweepReceipt = receiptByArtifactId.get(request.id)
          const mode =
            settings.downloadStrategy === 'aria2' && !request.url.startsWith('data:')
              ? 'aria2'
              : browserTransferModeForInitialRequest(settings.downloadStrategy, request.url)
          return {
            ...request,
            projectionId: deps.newProjectionId(),
            mode,
            historyPolicy:
              item === undefined ? 'off' : settings.downloadHistoryEnabled ? 'record' : 'off',
            ...(item === undefined ? {} : { item }),
            ...(sweepReceipt === undefined
              ? {}
              : {
                  sweepReceipt: {
                    receiptId: sweepReceipt.receiptId,
                    tweetId: sweepReceipt.tweetId,
                    scope: sweepReceipt.scope,
                  },
                }),
          }
        })
        const aria2Reservations = Object.create(null) as Record<string, Aria2LaunchReservation>
        const reservedAria2Gids = new Map<string, string>()
        const aria2Requests = requests.filter((request) => request.mode === 'aria2')
        if (aria2Requests.length > 0) {
          const profile = {
            profileId: deps.newProjectionId(),
            rpcUrl: settings.aria2RpcUrl,
            secret: settings.aria2Secret,
          }
          for (const request of aria2Requests) {
            const gid = deps.newAria2Gid()
            reservedAria2Gids.set(request.id, gid)
            aria2Reservations[request.id] = {
              profile,
              gid,
              options: {
                split: settings.aria2Split,
                ...(settings.aria2Dir ? { dir: settings.aria2Dir } : {}),
              },
            }
          }
        }

        // Registry reservation is the duplicate authority and precedes Clear's durable seed.
        const requestById = new Map(requests.map((request) => [request.id, request]))
        const prepared = yield* Effect.promise(() =>
          registry.prepareGroups(
            groups.map(({ mainId, downloads }) => ({
              mainId,
              requests: downloads.map(({ id }) => requestById.get(id)!),
            })),
            aria2Reservations,
          ),
        )
        const launchTokens = prepared.launches
        const tokenById = new Map(launchTokens.map((token) => [token.id, token]))
        const launched = requests.filter((request) => tokenById.has(request.id))
        const duplicates = [...new Set([...duplicatesBeforeRegistry, ...prepared.duplicateMainIds])]
        if (input.sweep !== undefined) {
          const expected = new Set(
            (input.clearExpect ?? []).flatMap(({ requestIds }) => requestIds),
          )
          const launchedIds = new Set(launched.map((request) => request.id))
          if ([...expected].some((requestId) => !launchedIds.has(requestId))) {
            yield* Effect.promise(() => registry.abandonPrepared(launchTokens))
            throw new Error('Sweep could not own every detected media request')
          }
        }
        if (launched.length === 0) {
          deps.trace('request-deduped', {
            detail: `${prepared.duplicateMainIds.length} registry duplicate(s)`,
          })
          yield* Effect.promise(() => persistMonitor('deduped', Date.now()))
          return {
            _tag: 'QueueUpdate' as const,
            planned: [],
            started: [],
            deferred: [],
            duplicates,
            failures: [],
            skipped: skippedBeforeRegistry,
          }
        }

        let clearTracked = new Map<string, ReadonlySet<string>>()
        let sweepTerminalSkip: string | undefined
        const clearVerdict = planClearSeed({
          requests: launched,
          mediaById,
          settings,
          ...(input.sweep === undefined ? {} : { sweep: input.sweep }),
          ...(input.clearExpect === undefined ? {} : { clearExpect: input.clearExpect }),
        })
        if (clearVerdict.decision === 'skip') {
          deps.trace('clear-skip', { detail: clearVerdict.reason })
          if (input.sweep !== undefined) {
            yield* Effect.promise(() => registry.abandonPrepared(launchTokens))
            return {
              _tag: 'QueueUpdate' as const,
              planned: launched.map((request) => request.id),
              started: [],
              deferred: [],
              duplicates,
              failures: launched.map((request) => ({
                requestId: request.id,
                reason: `clear-${clearVerdict.reason}`,
              })),
              skipped: skippedBeforeRegistry,
            }
          }
        } else {
          if (clearVerdict.unclearableCount > 0)
            deps.trace('clear-skip', {
              detail: `${clearVerdict.unclearableCount} tweet(s) have no clearable status id`,
            })
          yield* Effect.promise(async () => {
            let tracked: ReadonlyMap<string, ReadonlySet<string>> | undefined
            try {
              const seeded = await deps.clear.seed({
                byTweet: clearVerdict.byTweet,
                startingByTweet: clearVerdict.startingByTweet,
                manualScopes: clearVerdict.manualScopes,
                automaticScopes: clearVerdict.automaticScopes,
                crossListAutomaticScopes: clearVerdict.crossListAutomaticScopes,
              })
              tracked = seeded.trackedByTweet
              clearTracked = new Map(tracked)
              const outcome = await input.onClearSeeded?.(tracked, seeded.worklistRevision)
              if (outcome?.tag === 'terminal-skip') sweepTerminalSkip = outcome.reason
            } catch (error) {
              if (tracked !== undefined && input.sweep === undefined) {
                const compensation = await Promise.allSettled(
                  [...tracked].flatMap(([tweetId, requestIds]) =>
                    [...requestIds].map(
                      async (requestId) => await deps.clear.failUnbound({ tweetId, requestId }),
                    ),
                  ),
                )
                const failed = compensation.find(
                  (result): result is PromiseRejectedResult => result.status === 'rejected',
                )
                if (failed !== undefined)
                  deps.trace('clear-seed-compensation-failed', {
                    detail:
                      failed.reason instanceof Error
                        ? failed.reason.message
                        : String(failed.reason),
                  })
              }
              if (tracked === undefined || input.sweep === undefined)
                await registry.abandonPrepared(prepared.launches)
              throw error
            }
          })
        }

        if (sweepTerminalSkip !== undefined) {
          const failures = yield* Effect.promise(() =>
            Promise.allSettled(
              [...clearTracked].flatMap(([tweetId, requestIds]) =>
                [...requestIds].map(
                  async (requestId) => await deps.clear.failUnbound({ tweetId, requestId }),
                ),
              ),
            ),
          )
          const failed = failures.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected',
          )
          if (failed !== undefined)
            deps.trace('clear-seed-compensation-failed', {
              detail:
                failed.reason instanceof Error ? failed.reason.message : String(failed.reason),
            })
          yield* Effect.promise(() => registry.abandonPrepared(launchTokens))
          return {
            _tag: 'QueueUpdate' as const,
            planned: launched.map((request) => request.id),
            started: [],
            deferred: [],
            duplicates,
            failures: launched.map((request) => ({
              requestId: request.id,
              reason: `clear-terminal-${sweepTerminalSkip}`,
            })),
            skipped: skippedBeforeRegistry,
          }
        }

        const strategy = chooseStrategy(deps, settings, reservedAria2Gids)
        const modeById = new Map(launched.map((request) => [request.id, request.mode]))
        const startedAt = Date.now()
        deps.monitor.beginBatch({
          requestIds: launched.map((request) => request.id),
          concurrencyCap: settings.downloadConcurrency,
          at: startedAt,
        })
        deps.trace('queue-started', {
          elapsedMs: startedAt - receivedAt,
          detail: `${launched.length} request(s), concurrency ${settings.downloadConcurrency}`,
        })
        yield* Effect.promise(() => persistMonitor('initial', startedAt))
        const cloudAdmission = yield* Effect.promise(() =>
          deps.cloud.recordCloudUploads(cloudUploadIntentsFor(launched)),
        )
        if (cloudAdmission.tag === 'unavailable')
          deps.trace('cloud-admission-unavailable', {
            detail: cloudAdmission.reason,
          })
        yield* Effect.promise(() => registry.releasePreparedStarts(launchTokens))
        const queue = makeDownloadQueueCore({
          strategy,
          concurrency: settings.downloadConcurrency,
          retryStart: () => false,
          beforeStart: (request) => {
            const token = tokenById.get(request.id)
            if (token === undefined)
              return Effect.fail(
                new DownloadError({
                  id: request.id,
                  reason: 'missing launch token',
                }),
              )
            if (modeById.get(request.id) === 'direct')
              return Effect.tryPromise({
                try: () => registry.armDirectCall(request.id, token),
                catch: (cause) => new DownloadError({ id: request.id, reason: String(cause) }),
              })
            if (modeById.get(request.id) !== 'aria2') return Effect.void
            return Effect.tryPromise({
              try: () => registry.armAria2Call(request.id, token),
              catch: (cause) => new DownloadError({ id: request.id, reason: String(cause) }),
            })
          },
          onStarted: (request, handle) => {
            const token = tokenById.get(request.id)
            if (token === undefined)
              return Effect.fail(
                new DownloadError({
                  id: request.id,
                  reason: 'missing launch token',
                }),
              )
            return Effect.tryPromise({
              try: async () => {
                await registry.bindStarted(request.id, token, handle)
                const item = mediaById.get(request.id)
                if (
                  handle.kind === 'browser' &&
                  item !== undefined &&
                  clearTracked.get(item.postId)?.has(request.id)
                )
                  try {
                    await deps.clear.bindStarted({
                      tweetId: item.postId,
                      requestId: request.id,
                      downloadId: handle.id,
                    })
                  } catch (error) {
                    deps.trace('clear-bind-failed', {
                      itemId: request.id,
                      detail: error instanceof Error ? error.message : String(error),
                    })
                    try {
                      await deps.clear.failUnbound({
                        tweetId: item.postId,
                        requestId: request.id,
                      })
                    } catch (failure) {
                      deps.trace('clear-bind-compensation-failed', {
                        itemId: request.id,
                        detail: failure instanceof Error ? failure.message : String(failure),
                      })
                    }
                  }
                deps.monitor.recordStarted(request.id, Date.now())
                if (handle.kind === 'browser') {
                  deps.monitor.bindBrowserTransfer(handle.id, request.id)
                }
              },
              catch: (cause) =>
                new StartedCommitError({
                  message: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
            })
          },
        })
        const immediate = launched.filter((request) => request.mode !== 'fetched')
        const result = yield* queue.enqueue(immediate)
        const now = Date.now()
        const started: string[] = []
        const failures: { requestId: string; reason: string }[] = []
        const deferred = launched
          .filter((request) => request.mode === 'fetched')
          .map((request) => request.id)
        for (const id of deferred)
          deps.trace('start-deferred', {
            itemId: id,
            elapsedMs: deps.monitor.elapsedSinceRequest(id, now, startedAt),
            detail: 'Fetched start is owned by the durable Registry wake.',
          })
        for (const outcome of result.outcomes) {
          const token = tokenById.get(outcome.id)
          if (token === undefined) continue
          if (!outcome.ok) {
            if (outcome.status === 'deferred') {
              yield* Effect.promise(() => registry.deferLaunch(outcome.id, token))
              deferred.push(outcome.id)
              deps.trace('start-deferred', {
                itemId: outcome.id,
                elapsedMs: deps.monitor.elapsedSinceRequest(outcome.id, now, startedAt),
                detail: outcome.error,
              })
              continue
            }
            yield* Effect.promise(() =>
              outcome.status === 'untracked-start'
                ? registry.resolveUntrackedStart(outcome.id, token, outcome.handle)
                : outcome.status === 'ambiguous-start'
                  ? registry.resolveUntrackedStart(outcome.id, token)
                  : registry.rejectStart(outcome.id, token),
            )
            failures.push({ requestId: outcome.id, reason: outcome.error })
            deps.trace(
              outcome.status === 'untracked-start' || outcome.status === 'ambiguous-start'
                ? 'untracked-start'
                : 'start-failed',
              {
                itemId: outcome.id,
                elapsedMs: deps.monitor.elapsedSinceRequest(outcome.id, now, startedAt),
                detail: outcome.error,
              },
            )
            continue
          }
          started.push(outcome.id)
          deps.trace(outcome.handle.kind === 'browser' ? 'browser-started' : 'external-started', {
            itemId: outcome.id,
            elapsedMs: deps.monitor.elapsedSinceRequest(outcome.id, now, startedAt),
            detail:
              outcome.handle.kind === 'browser'
                ? `downloadId ${outcome.handle.id}`
                : `aria2 ${outcome.handle.gid}`,
          })
        }
        yield* Effect.promise(() => persistMonitor('settled', now))
        return {
          _tag: 'QueueUpdate' as const,
          planned: launched.map(({ id }) => id),
          started,
          deferred,
          duplicates,
          failures,
          skipped: skippedBeforeRegistry,
        }
      }),
  }
}
