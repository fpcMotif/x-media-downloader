import type { Scope } from '../core/clear/ledger'

export const CLEAR_WORKLIST_PROJECTION_BATCH = 100
export const CLEAR_WORKLIST_PROJECTION_MAX = 5000

/** A recurring alarm. It is established before any outbox-producing commit. */
export interface ClearWorklistProjectionWake {
  readonly ensure: () => Promise<void> | void
}

export type ClearWorklistProjectionState = 'downloaded' | 'failed' | 'cleared'

export interface ClearWorklistProjection {
  readonly tweetId: string
  readonly scope: Scope
  readonly state: ClearWorklistProjectionState
  readonly at: number
}

export interface StoredClearWorklistProjection extends ClearWorklistProjection {
  readonly version: 1
  /** Clear active-state revision that produced this intent. */
  readonly revision: number
}

export const decodeStoredClearWorklistProjection = (
  value: unknown,
): StoredClearWorklistProjection | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const version = Reflect.get(value, 'version')
  const revision = Reflect.get(value, 'revision')
  const tweetId = Reflect.get(value, 'tweetId')
  const scope = Reflect.get(value, 'scope')
  const state = Reflect.get(value, 'state')
  const at = Reflect.get(value, 'at')
  if (
    version !== 1 ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    typeof tweetId !== 'string' ||
    !/^[0-9]{1,20}$/.test(tweetId) ||
    !['bookmark', 'like', 'notInterested'].includes(String(scope)) ||
    !['downloaded', 'failed', 'cleared'].includes(String(state)) ||
    typeof at !== 'number' ||
    !Number.isSafeInteger(at) ||
    at < 0
  )
    return undefined
  return {
    version: 1,
    revision,
    tweetId,
    scope: scope as Scope,
    state: state as ClearWorklistProjectionState,
    at,
  }
}

export const sameStoredClearWorklistProjection = (
  left: StoredClearWorklistProjection,
  right: StoredClearWorklistProjection,
): boolean =>
  left.version === right.version &&
  left.revision === right.revision &&
  left.tweetId === right.tweetId &&
  left.scope === right.scope &&
  left.state === right.state &&
  left.at === right.at
