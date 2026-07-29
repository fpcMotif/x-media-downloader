/**
 * Durable sweep worklist — the persistent "flag" behind the one-by-one
 * download+clear sweep. A pure projection of each swept tweet's lifecycle, keyed
 * by tweetId, so the sweep survives scrolling, popup close, and SW recycle, and
 * never re-touches a post it already cleared.
 *
 * Lifecycle: `queued` (enqueued for download) → `downloaded` (bytes verified by
 * the background's Settle gate) → `cleared` (un-bookmarked/un-liked and the flip
 * verified) | `failed` (download permanently failed → never clears). `cleared`
 * is terminal — the worklist never regresses out of it, which is what makes a
 * re-run skip already-handled posts.
 *
 * Pure + storage-agnostic on purpose: the background is the single writer and
 * backs this with `storage.local` today, but it is meant to move to Convex sync
 * as the state store later — that swap should be a backend change at the I/O
 * boundary, not a rewrite of this logic. Every function returns the SAME
 * reference when nothing changes, so callers can skip a write cheaply.
 */
import { Schema } from 'effect'
import { ClearScope, TweetSnowflake } from '../schema'
import { measureJsonBytes } from '../wire/json-budget'

export const SweepState = Schema.Literals(['queued', 'downloaded', 'cleared', 'failed'])
export type SweepState = typeof SweepState.Type

export const SweepEntry = Schema.Struct({
  tweetId: TweetSnowflake,
  scope: ClearScope,
  state: SweepState,
  at: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  /** Highest Clear outbox revision already applied to this scope. */
  projectionRevision: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  ),
})
export type SweepEntry = typeof SweepEntry.Type

export const SweepWorklist = Schema.Record(Schema.String, SweepEntry)
export type SweepWorklist = typeof SweepWorklist.Type

export const emptyWorklist: SweepWorklist = {}

export const SWEEP_WORKLIST_STORE_VERSION = 2 as const
export const MAX_SWEEP_WORKLIST_ENTRIES = 5000
export const MAX_SWEEP_WORKLIST_BYTES = 2 * 1024 * 1024

export interface StoredSweepWorklist {
  readonly version: typeof SWEEP_WORKLIST_STORE_VERSION
  readonly entries: SweepWorklist
}

export type StoredSweepWorklistDecode =
  | { readonly kind: 'absent'; readonly worklist: SweepWorklist }
  | { readonly kind: 'current'; readonly worklist: SweepWorklist }
  | { readonly kind: 'legacy'; readonly worklist: SweepWorklist }
  | { readonly kind: 'corrupt' }

/** Worklist key: scope-qualified so the SAME tweet swept under BOTH list scopes
 *  (a post that is both bookmarked AND liked) keeps an independent lifecycle per
 *  scope. Keying by bare tweetId conflated them — clearing it in one scope made a
 *  sweep of the OTHER scope skip it as already-done, so it was never un-{liked}. */
export const keyFor = (scope: ClearScope, tweetId: string): string => {
  if (!isScope(scope)) throw new TypeError('Clear Worklist scope is invalid')
  if (!isSnowflake(tweetId)) throw new TypeError('Clear Worklist tweetId must be a snowflake')
  return `${scope}:${tweetId}`
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const dataValue = (value: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor?.enumerable === true && 'value' in descriptor ? descriptor.value : undefined
}

const hasExactDataKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false
  const keys = Object.keys(value).toSorted()
  const wanted = [...expected].toSorted()
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index]))
    return false
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && 'value' in descriptor
  })
}

const isSnowflake = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,20}$/.test(value)
const isScope = (value: unknown): value is ClearScope =>
  value === 'bookmark' || value === 'like' || value === 'notInterested'
const isSweepState = (value: unknown): value is SweepState =>
  value === 'queued' || value === 'downloaded' || value === 'cleared' || value === 'failed'
const isSafeTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isSafeRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1

const decodePersistedEntry = (
  value: unknown,
  allowProjectionRevision: boolean,
): SweepEntry | undefined => {
  if (!isPlainRecord(value)) return undefined
  const hasRevision = Object.hasOwn(value, 'projectionRevision')
  if (hasRevision && !allowProjectionRevision) return undefined
  if (
    !hasExactDataKeys(
      value,
      hasRevision
        ? ['tweetId', 'scope', 'state', 'at', 'projectionRevision']
        : ['tweetId', 'scope', 'state', 'at'],
    )
  )
    return undefined
  const tweetId = dataValue(value, 'tweetId')
  const scope = dataValue(value, 'scope')
  const state = dataValue(value, 'state')
  const at = dataValue(value, 'at')
  const projectionRevision = hasRevision ? dataValue(value, 'projectionRevision') : undefined
  if (!isSnowflake(tweetId) || !isScope(scope) || !isSweepState(state) || !isSafeTime(at))
    return undefined
  if (hasRevision) {
    if (!isSafeRevision(projectionRevision)) return undefined
    return {
      tweetId,
      scope,
      state,
      at,
      projectionRevision,
    }
  }
  return {
    tweetId,
    scope,
    state,
    at,
  }
}

const entriesEqual = (left: SweepEntry, right: SweepEntry): boolean =>
  left.tweetId === right.tweetId &&
  left.scope === right.scope &&
  left.state === right.state &&
  left.at === right.at &&
  left.projectionRevision === right.projectionRevision

const decodeEntries = (
  raw: unknown,
  legacy: boolean,
  measuredValue: unknown,
): SweepWorklist | undefined => {
  if (!isPlainRecord(raw)) return undefined
  const keys = Object.keys(raw)
  if (
    keys.length > MAX_SWEEP_WORKLIST_ENTRIES ||
    measureJsonBytes(measuredValue, MAX_SWEEP_WORKLIST_BYTES) === undefined
  )
    return undefined

  const out: Record<string, SweepEntry> = {}
  for (const rawKey of keys) {
    const entry = decodePersistedEntry(dataValue(raw, rawKey), !legacy)
    if (entry === undefined) return undefined
    const canonicalKey = keyFor(entry.scope, entry.tweetId)
    if (
      (!legacy && rawKey !== canonicalKey) ||
      (legacy && rawKey !== entry.tweetId && rawKey !== canonicalKey)
    )
      return undefined
    const existing = out[canonicalKey]
    if (existing !== undefined && !entriesEqual(existing, entry)) return undefined
    out[canonicalKey] = existing ?? entry
  }
  return out
}

/** Decode the exact v2 envelope or the one safe unversioned legacy map. */
export const decodeStoredWorklist = (raw: unknown): StoredSweepWorklistDecode => {
  if (raw === null || raw === undefined) return { kind: 'absent', worklist: emptyWorklist }
  try {
    if (!isPlainRecord(raw)) return { kind: 'corrupt' }
    if (Object.hasOwn(raw, 'version')) {
      if (!hasExactDataKeys(raw, ['version', 'entries'])) return { kind: 'corrupt' }
      if (dataValue(raw, 'version') !== SWEEP_WORKLIST_STORE_VERSION) return { kind: 'corrupt' }
      const worklist = decodeEntries(dataValue(raw, 'entries'), false, raw)
      return worklist === undefined ? { kind: 'corrupt' } : { kind: 'current', worklist }
    }
    const worklist = decodeEntries(raw, true, raw)
    return worklist === undefined ? { kind: 'corrupt' } : { kind: 'legacy', worklist }
  } catch {
    return { kind: 'corrupt' }
  }
}

/** Encode only the strict bounded v2 storage shape. */
export const encodeWorklist = (worklist: SweepWorklist): StoredSweepWorklist => {
  const encoded: StoredSweepWorklist = {
    version: SWEEP_WORKLIST_STORE_VERSION,
    entries: worklist,
  }
  if (decodeStoredWorklist(encoded).kind !== 'current')
    throw new TypeError('Clear Worklist cannot be persisted')
  return encoded
}

/** Has this tweet already been cleared IN THIS SCOPE? The ONLY state a re-run must
 *  skip — and only for the same list, so the other scope still gets swept. */
export const isCleared = (wl: SweepWorklist, tweetId: string, scope: ClearScope): boolean =>
  wl[keyFor(scope, tweetId)]?.state === 'cleared'

/** Take responsibility for a (tweet, scope) at `queued`, unless that scope is
 *  already `cleared` (terminal — never re-queue a list we removed it from).
 *  Re-queues `failed`/stale entries so a re-run retries them. */
export const enqueue = (
  wl: SweepWorklist,
  tweetId: string,
  scope: ClearScope,
  at: number,
): SweepWorklist => {
  const key = keyFor(scope, tweetId)
  if (!isSafeTime(at)) throw new TypeError('Clear Worklist time must be a safe integer')
  const existing = wl[key]
  if (existing?.state === 'cleared') return wl
  return {
    ...wl,
    [key]: {
      tweetId,
      scope,
      state: 'queued',
      at,
      ...(existing?.projectionRevision === undefined
        ? {}
        : { projectionRevision: existing.projectionRevision }),
    },
  }
}

/** Advance an EXISTING (tweet, scope) entry's state. No-op when that scope isn't
 *  tracked (so a normal, non-sweep download never creates a worklist entry) or is
 *  already `cleared` (terminal). Returns the same reference when nothing changes. */
export const markState = (
  wl: SweepWorklist,
  tweetId: string,
  scope: ClearScope,
  state: SweepState,
  at: number,
): SweepWorklist => {
  const key = keyFor(scope, tweetId)
  if (!isSweepState(state)) throw new TypeError('Clear Worklist state is invalid')
  if (!isSafeTime(at)) throw new TypeError('Clear Worklist time must be a safe integer')
  const existing = wl[key]
  if (existing === undefined || existing.state === 'cleared' || existing.state === state) return wl
  return { ...wl, [key]: { ...existing, state, at } }
}

/** Counts per state, for the popup's status line. */
export const summarize = (wl: SweepWorklist): Record<SweepState, number> => {
  const counts: Record<SweepState, number> = { queued: 0, downloaded: 0, cleared: 0, failed: 0 }
  for (const e of Object.values(wl)) counts[e.state] += 1
  return counts
}

export const isActiveSweepEntry = (entry: SweepEntry | undefined): boolean =>
  entry?.state === 'queued' || entry?.state === 'downloaded'

export const activeSweepEntryCount = (worklist: SweepWorklist): number =>
  Object.values(worklist).filter(isActiveSweepEntry).length

const newestTerminalEntries = (
  entries: ReadonlyArray<readonly [string, SweepEntry]>,
): ReadonlyArray<readonly [string, SweepEntry]> =>
  entries
    .filter(([, entry]) => !isActiveSweepEntry(entry))
    .toSorted(
      ([leftKey, left], [rightKey, right]) =>
        right.at - left.at || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0),
    )

/** Bound the map: the `cleared`/`failed` history grows without limit otherwise.
 *  NEVER evict an in-flight entry (`queued`/`downloaded`) — losing its durable
 *  state mid-sweep is the one harmful eviction; cap only TERMINAL entries (oldest
 *  first), leaving room for all active ones. Same reference when within bounds. */
export const capWorklist = (wl: SweepWorklist, max: number): SweepWorklist => {
  if (!Number.isSafeInteger(max) || max < 0)
    throw new RangeError('Clear Worklist max must be a nonnegative safe integer')
  const entries = Object.entries(wl)
  if (entries.length <= max) return wl
  const active = entries.filter(([, entry]) => isActiveSweepEntry(entry))
  if (active.length > max) throw new RangeError('Clear Worklist active capacity exceeded')
  const terminal = newestTerminalEntries(entries)
  return Object.fromEntries([...active, ...terminal.slice(0, max - active.length)])
}

/**
 * Bound the map while retaining one just-applied entry. A reconstructed old
 * terminal is durable evidence, so a newer terminal must be evicted instead.
 */
export const capWorklistRetaining = (
  worklist: SweepWorklist,
  max: number,
  protectedKey: string,
): SweepWorklist => {
  if (!Number.isSafeInteger(max) || max < 0)
    throw new RangeError('Clear Worklist max must be a nonnegative safe integer')
  if (Object.keys(worklist).length <= max) return worklist
  const protectedEntry = worklist[protectedKey]
  if (protectedEntry === undefined || isActiveSweepEntry(protectedEntry))
    return capWorklist(worklist, max)
  const active = Object.entries(worklist).filter(([, entry]) => isActiveSweepEntry(entry))
  if (active.length + 1 > max) throw new RangeError('Clear Worklist active capacity exceeded')
  return Object.fromEntries([
    ...active,
    [protectedKey, protectedEntry] as const,
    ...newestTerminalEntries(
      Object.entries(worklist).filter(([key]) => key !== protectedKey),
    ).slice(0, max - active.length - 1),
  ])
}
