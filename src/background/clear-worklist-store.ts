import { storage } from 'wxt/utils/storage'
import type { Scope } from '../core/clear/ledger'
import {
  MAX_SWEEP_WORKLIST_ENTRIES,
  activeSweepEntryCount,
  capWorklist,
  capWorklistRetaining,
  decodeStoredWorklist,
  encodeWorklist,
  enqueue,
  isCleared,
  keyFor,
  isActiveSweepEntry,
  markState,
  type StoredSweepWorklist,
  type SweepEntry,
  type SweepWorklist,
} from '../core/clear/worklist'
import { makeSerialQueue } from '../core/serial-queue'
import type { StoredClearWorklistProjection } from './clear-worklist-projection'

export const SWEEP_WORKLIST_MAX = MAX_SWEEP_WORKLIST_ENTRIES

const assertCapacity = (count: number): void => {
  if (count > SWEEP_WORKLIST_MAX) throw new RangeError('Clear Worklist active capacity exceeded')
}

const seedRevisionAlreadyApplied = (
  entry: SweepEntry | undefined,
  worklistRevision: number,
): boolean =>
  entry?.state === 'cleared' ||
  (entry?.projectionRevision !== undefined && entry.projectionRevision >= worklistRevision)

/** One durable port for the scope-qualified sweep lifecycle. */
export interface ClearWorklistStorage {
  get(): Promise<unknown>
  set(value: StoredSweepWorklist): Promise<void>
}

export class ClearWorklistCorruptionError extends Error {
  override readonly name = 'ClearWorklistCorruptionError'

  constructor() {
    super('Clear Worklist storage is corrupt')
  }
}

export interface ClearWorklistStore {
  /** Applies one durable outbox row. Missing or causally newer sweep work is untouched. */
  readonly applyProjection: (
    projection: StoredClearWorklistProjection,
  ) => Promise<'applied' | 'already-applied'>
  /** Read-only sweep planning. Ownership is persisted only after Clear seed commits. */
  readonly selectSweepPosts: <I>(
    scope: Scope,
    posts: ReadonlyArray<{ readonly tweetId: string; readonly items: ReadonlyArray<I> }>,
  ) => Promise<{
    posts: ReadonlyArray<{ readonly tweetId: string; readonly items: ReadonlyArray<I> }>
    skipped: number
  }>
  /** Persist ownership only for tweets already accepted by a durable Clear seed. */
  readonly claimSeededSweepPosts: (
    scope: Scope,
    tweetIds: ReadonlyArray<string>,
    worklistRevision: number,
  ) => Promise<{
    claimed: number
    skipped: number
    /** A newer Clear terminal projection owns this post; never restart its sweep. */
    terminalTweetIds: ReadonlyArray<string>
  }>
  /** Boot repair only. Replays a missed seeded claim without regressing a newer projection. */
  readonly ensureSeededSweepPosts: (
    scope: Scope,
    tweetIds: ReadonlyArray<string>,
    worklistRevision: number,
  ) => Promise<'owned' | 'terminal'>
}

/**
 * Owns the durable sweep worklist's single-writer lane. Each mutation reads and
 * decodes storage inside that lane, so it sees the preceding write even when MV3
 * events interleave. `run` preserves failures for the caller while the queue
 * recovers for the next mutation.
 */
export function makeClearWorklistStore(
  deps: {
    readonly storage?: ClearWorklistStorage
    readonly onError?: (error: unknown) => void
    readonly now?: () => number
  } = {},
): ClearWorklistStore {
  const worklist = deps.storage ?? defaultStorage()
  const now = deps.now ?? (() => Date.now())
  const queue = makeSerialQueue(deps.onError)

  const read = async (): Promise<SweepWorklist> => {
    const decoded = decodeStoredWorklist(await worklist.get())
    if (decoded.kind === 'corrupt') throw new ClearWorklistCorruptionError()
    return decoded.worklist
  }
  const write = (value: SweepWorklist): Promise<void> => worklist.set(encodeWorklist(value))

  const applyProjection: ClearWorklistStore['applyProjection'] = (projection) =>
    queue.run(async () => {
      const key = keyFor(projection.scope, projection.tweetId)
      const current = await read()
      const existing = current[key]
      if (existing === undefined) {
        assertCapacity(activeSweepEntryCount(current) + 1)
        const next = capWorklistRetaining(
          {
            ...current,
            [key]: {
              tweetId: projection.tweetId,
              scope: projection.scope,
              state: projection.state,
              at: projection.at,
              projectionRevision: projection.revision,
            },
          },
          SWEEP_WORKLIST_MAX,
          key,
        )
        await write(next)
        return 'applied'
      }
      if (
        existing.projectionRevision !== undefined &&
        existing.projectionRevision >= projection.revision
      )
        return 'already-applied'
      if (existing.state === 'cleared') return 'already-applied'
      if (existing.state === projection.state) {
        await write({
          ...current,
          [key]: { ...existing, projectionRevision: projection.revision },
        })
        return 'applied'
      }
      if (!isActiveSweepEntry(existing) && projection.state === 'downloaded')
        assertCapacity(activeSweepEntryCount(current) + 1)
      const marked = markState(
        current,
        projection.tweetId,
        projection.scope,
        projection.state,
        projection.at,
      )
      if (marked === current) return 'already-applied'
      const next = {
        ...marked,
        [key]: { ...marked[key]!, projectionRevision: projection.revision },
      }
      await write(next)
      return 'applied'
    })

  const claimSeededSweepPosts = async (
    scope: Scope,
    tweetIds: ReadonlyArray<string>,
    worklistRevision: number,
  ): Promise<{ claimed: number; skipped: number; terminalTweetIds: ReadonlyArray<string> }> =>
    queue.run(async () => {
      if (new Set(tweetIds).size !== tweetIds.length)
        throw new TypeError('Seeded Sweep tweets must be unique')
      if (
        !Number.isSafeInteger(worklistRevision) ||
        worklistRevision < 1 ||
        worklistRevision > Number.MAX_SAFE_INTEGER
      )
        throw new TypeError('Seeded Sweep revision must be a positive safe integer')
      for (const tweetId of tweetIds) keyFor(scope, tweetId)
      let next = await read()
      let prospectiveActive = activeSweepEntryCount(next)
      for (const tweetId of tweetIds) {
        const existing = next[keyFor(scope, tweetId)]
        if (
          !seedRevisionAlreadyApplied(existing, worklistRevision) &&
          !isActiveSweepEntry(existing)
        )
          prospectiveActive += 1
      }
      assertCapacity(prospectiveActive)
      let claimed = 0
      let skipped = 0
      const terminalTweetIds: string[] = []
      const at = now()
      for (const tweetId of tweetIds) {
        const key = keyFor(scope, tweetId)
        if (seedRevisionAlreadyApplied(next[key], worklistRevision)) {
          skipped += 1
          if (next[key]?.state === 'cleared') terminalTweetIds.push(tweetId)
          continue
        }
        next = enqueue(next, tweetId, scope, at)
        const queued = next[key]
        if (queued === undefined) throw new Error(`Could not claim Sweep tweet ${tweetId}`)
        next = {
          ...next,
          [key]: {
            ...queued,
            projectionRevision: Math.max(queued.projectionRevision ?? 0, worklistRevision),
          },
        }
        claimed += 1
      }
      if (claimed > 0) await write(capWorklist(next, SWEEP_WORKLIST_MAX))
      return { claimed, skipped, terminalTweetIds }
    })

  const selectSweepPosts = async <I>(
    scope: Scope,
    posts: ReadonlyArray<{ readonly tweetId: string; readonly items: ReadonlyArray<I> }>,
  ): Promise<{
    posts: ReadonlyArray<{ readonly tweetId: string; readonly items: ReadonlyArray<I> }>
    skipped: number
  }> =>
    queue.run(async () => {
      for (const post of posts) keyFor(scope, post.tweetId)
      const current = await read()
      const selected = posts.filter((post) => !isCleared(current, post.tweetId, scope))
      return { posts: selected, skipped: posts.length - selected.length }
    })

  const ensureSeededSweepPosts: ClearWorklistStore['ensureSeededSweepPosts'] = (
    scope,
    tweetIds,
    worklistRevision,
  ) =>
    queue.run(async () => {
      if (new Set(tweetIds).size !== tweetIds.length)
        throw new TypeError('Seeded Sweep tweets must be unique')
      if (!Number.isSafeInteger(worklistRevision) || worklistRevision < 1)
        throw new TypeError('Seeded Sweep revision must be a positive safe integer')
      for (const tweetId of tweetIds) keyFor(scope, tweetId)
      let next = await read()
      let prospectiveActive = activeSweepEntryCount(next)
      for (const tweetId of tweetIds) {
        const existing = next[keyFor(scope, tweetId)]
        if (
          !seedRevisionAlreadyApplied(existing, worklistRevision) &&
          !isActiveSweepEntry(existing)
        )
          prospectiveActive += 1
      }
      assertCapacity(prospectiveActive)
      let changed = false
      const at = now()
      let terminal = false
      for (const tweetId of tweetIds) {
        const key = keyFor(scope, tweetId)
        const existing = next[key]
        if (seedRevisionAlreadyApplied(existing, worklistRevision)) {
          terminal ||= existing?.state === 'cleared'
          continue
        }
        next = enqueue(next, tweetId, scope, at)
        next = {
          ...next,
          [key]: {
            ...next[key]!,
            projectionRevision: Math.max(next[key]!.projectionRevision ?? 0, worklistRevision),
          },
        }
        changed = true
      }
      if (changed) await write(capWorklist(next, SWEEP_WORKLIST_MAX))
      return terminal ? 'terminal' : 'owned'
    })

  return { applyProjection, selectSweepPosts, claimSeededSweepPosts, ensureSeededSweepPosts }
}

function defaultStorage(): ClearWorklistStorage {
  const item = storage.defineItem<unknown>('local:clearWorklist', { fallback: null })
  return {
    get: () => item.getValue(),
    set: (value) => item.setValue(value),
  }
}
