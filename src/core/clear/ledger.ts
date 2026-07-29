/** Durable completion ledger. Pure transitions; the coordinator persists them. */

import type { ClearScope, Settings } from '../schema'

export type Scope = ClearScope
/** Durable Clear states. `attempted` is deliberately terminal until a user
 * explicitly forgets it: a lost destructive reply must never be retried. */
export type ClearStatus =
  | 'none'
  | 'reserved'
  | 'attempted'
  | 'cleared'
  | 'failed'
  | 'skipped'
  | 'uncertain'

/** The auto-hook's enabled clear scopes, derived from the per-scope kill
 *  switches — the single mapping shared by ledger seeding and re-checks. The
 *  page the download happens on decides which of these is actually clicked
 *  (handleClearTweet's onScope): un-bookmark/un-like on a list page, "Not
 *  interested" on the For You feed; the off-page scopes no-op. */
export const hookScopes = (s: Settings): Scope[] => [
  ...(s.autoUnbookmarkOnSave ? (['bookmark'] as Scope[]) : []),
  ...(s.autoUnlikeOnSave ? (['like'] as Scope[]) : []),
  ...(s.autoNotInterestedOnSave ? (['notInterested'] as Scope[]) : []),
]

// ── Durable ledger ─────────────────────────────────────────────────────────

const scopes: readonly Scope[] = ['bookmark', 'like', 'notInterested']
/** Shared observed-complete window. The coordinator schedules this exact delay. */
export const SETTLE_CONFIRM_MS = 1500
const isScope = (value: unknown): value is Scope =>
  typeof value === 'string' && (scopes as readonly string[]).includes(value)
const isSnowflake = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,20}$/.test(value)
const isRequestId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0
const isSafeTime = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isDownloadId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  isObject(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const own = (value: object, key: string): boolean => Object.hasOwn(value, key)
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every((key) => keys.includes(key))
}
const record = <T>(value: T): Readonly<Record<Scope, T>> => ({
  bookmark: value,
  like: value,
  notInterested: value,
})
const cloneSet = <T>(value: ReadonlySet<T>): Set<T> => new Set(value)
const remove = <T>(value: ReadonlySet<T>, item: T): Set<T> => {
  const next = cloneSet(value)
  next.delete(item)
  return next
}
const add = <T>(value: ReadonlySet<T>, item: T): Set<T> => new Set(value).add(item)
const scopeSet = (manual: ReadonlySet<Scope>, automatic: ReadonlySet<Scope>): Set<Scope> =>
  new Set([...manual, ...automatic])

export interface HandleWitness {
  readonly downloadId: number
  readonly startedAt: number
}

export interface SettleWitness {
  readonly downloadId: number
  readonly dueAt: number
}

export interface ClearTombstone {
  readonly tweetId: string
  readonly scope: Scope
  readonly state: 'cleared' | 'uncertain'
  readonly at: number
}

/** Durable, verified Clear facts for a future Clear Log UI. */
export interface ClearLogRecord {
  readonly tweetId: string
  readonly scope: Scope
  readonly at: number
  readonly mechanism: 'dom-click'
  readonly permalink: string
}

/** The in-memory form. Only this module turns wire arrays into Sets. */
export interface CompletionLedgerEntry {
  readonly tweetId: string
  readonly manualScopes: ReadonlySet<Scope>
  readonly automaticScopes: ReadonlySet<Scope>
  /** Automatic only when "Release from every list" is currently enabled. */
  readonly crossListAutomaticScopes: ReadonlySet<Scope>
  readonly expected: ReadonlySet<string>
  readonly done: ReadonlySet<string>
  readonly failed: ReadonlySet<string>
  readonly inProgress: ReadonlySet<string>
  readonly clear: Readonly<Record<Scope, ClearStatus>>
  readonly handles: Readonly<Record<string, HandleWitness>>
  readonly settling: Readonly<Record<string, SettleWitness>>
  readonly createdAt: number
  readonly touchedAt: number
}

export interface CompletionLedger {
  readonly entries: ReadonlyMap<string, CompletionLedgerEntry>
  readonly tombstones: ReadonlyMap<string, ReadonlyMap<Scope, ClearTombstone>>
}

/** Logical active-record form. IDB owns physical storage; this also decodes legacy migration input. */
export interface StoredClearEntry {
  readonly tweetId: string
  readonly manualScopes: ReadonlyArray<Scope>
  readonly automaticScopes: ReadonlyArray<Scope>
  readonly crossListAutomaticScopes: ReadonlyArray<Scope>
  readonly expected: ReadonlyArray<string>
  readonly done: ReadonlyArray<string>
  readonly failed: ReadonlyArray<string>
  readonly inProgress: ReadonlyArray<string>
  readonly clear: Readonly<Record<Scope, ClearStatus>>
  readonly handles: Readonly<Record<string, HandleWitness>>
  readonly settling: Readonly<Record<string, SettleWitness>>
  readonly createdAt: number
  readonly touchedAt: number
}

export interface ClearLedgerStore {
  readonly version: 1
  readonly entries: Readonly<Record<string, StoredClearEntry>>
  readonly tombstones: Readonly<Record<string, Readonly<Partial<Record<Scope, ClearTombstone>>>>>
}

export type DecodeCompletionLedger =
  | { readonly ok: true; readonly ledger: CompletionLedger }
  | { readonly ok: false; readonly reason: string }

export const emptyCompletionLedger = (): CompletionLedger => ({
  entries: new Map(),
  tombstones: new Map(),
})

const sorted = <T extends string>(items: ReadonlySet<T>): T[] => [...items].toSorted()
const cloneEntries = (ledger: CompletionLedger): Map<string, CompletionLedgerEntry> =>
  new Map(ledger.entries)
const cloneTombstones = (ledger: CompletionLedger): Map<string, Map<Scope, ClearTombstone>> =>
  new Map([...ledger.tombstones].map(([tweetId, states]) => [tweetId, new Map(states)]))
const withEntry = (
  ledger: CompletionLedger,
  tweetId: string,
  entry: CompletionLedgerEntry | undefined,
): CompletionLedger => {
  const entries = cloneEntries(ledger)
  if (entry === undefined) entries.delete(tweetId)
  else entries.set(tweetId, entry)
  return { ...ledger, entries }
}

const entryScopes = (entry: CompletionLedgerEntry): Set<Scope> =>
  scopeSet(entry.manualScopes, entry.automaticScopes)
/** A scope seeded by both paths is explicit user intent, never auto policy. */
export const clearScopeIntent = (
  entry: CompletionLedgerEntry,
  scope: Scope,
): 'manual' | 'cross-list-automatic' | 'automatic' | undefined =>
  entry.manualScopes.has(scope)
    ? 'manual'
    : entry.crossListAutomaticScopes.has(scope)
      ? 'cross-list-automatic'
      : entry.automaticScopes.has(scope)
        ? 'automatic'
        : undefined
const terminalScope = (state: ClearStatus): boolean =>
  state === 'cleared' || state === 'skipped' || state === 'uncertain'
const isClearState = (value: unknown): value is ClearStatus =>
  typeof value === 'string' &&
  ['none', 'reserved', 'attempted', 'cleared', 'failed', 'skipped', 'uncertain'].includes(value)

const exactArray = <T>(
  value: unknown,
  check: (item: unknown) => item is T,
): { ok: true; value: Set<T> } | { ok: false } => {
  if (!Array.isArray(value) || !value.every(check)) return { ok: false }
  return { ok: true, value: new Set(value) }
}

const decodeWitnesses = (
  value: unknown,
  field: 'handles' | 'settling',
  expected: ReadonlySet<string>,
):
  | { ok: true; value: Record<string, HandleWitness> | Record<string, SettleWitness> }
  | { ok: false } => {
  if (!isPlainRecord(value)) return { ok: false }
  const output: Record<string, HandleWitness> | Record<string, SettleWitness> = {}
  for (const [requestId, witness] of Object.entries(value)) {
    if (!isRequestId(requestId) || !expected.has(requestId) || !isPlainRecord(witness))
      return { ok: false }
    const timeKey = field === 'handles' ? 'startedAt' : 'dueAt'
    const timestamp = witness[timeKey]
    if (
      !hasOnlyKeys(witness, ['downloadId', timeKey]) ||
      !isDownloadId(witness.downloadId) ||
      !isSafeTime(timestamp) ||
      (field === 'settling' && timestamp < SETTLE_CONFIRM_MS)
    ) {
      return { ok: false }
    }
    if (field === 'handles')
      output[requestId] = { downloadId: witness.downloadId, startedAt: timestamp }
    else output[requestId] = { downloadId: witness.downloadId, dueAt: timestamp }
  }
  return { ok: true, value: output }
}

const decodeEntry = (tweetId: string, value: unknown): CompletionLedgerEntry | undefined => {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      'tweetId',
      'manualScopes',
      'automaticScopes',
      'crossListAutomaticScopes',
      'expected',
      'done',
      'failed',
      'inProgress',
      'clear',
      'handles',
      'settling',
      'createdAt',
      'touchedAt',
    ])
  )
    return undefined
  if (
    value.tweetId !== tweetId ||
    !isSnowflake(tweetId) ||
    !isSafeTime(value.createdAt) ||
    !isSafeTime(value.touchedAt) ||
    value.touchedAt < value.createdAt
  )
    return undefined
  const manual = exactArray(value.manualScopes, isScope)
  const automatic = exactArray(value.automaticScopes, isScope)
  const crossListAutomatic = exactArray(value.crossListAutomaticScopes, isScope)
  const expected = exactArray(value.expected, isRequestId)
  const done = exactArray(value.done, isRequestId)
  const failed = exactArray(value.failed, isRequestId)
  const inProgress = exactArray(value.inProgress, isRequestId)
  if (
    !manual.ok ||
    !automatic.ok ||
    !crossListAutomatic.ok ||
    !expected.ok ||
    !done.ok ||
    !failed.ok ||
    !inProgress.ok ||
    expected.value.size === 0
  )
    return undefined
  if (scopeSet(manual.value, automatic.value).size === 0) return undefined
  if (![...crossListAutomatic.value].every((scope) => automatic.value.has(scope))) return undefined
  if (![...done.value, ...failed.value, ...inProgress.value].every((id) => expected.value.has(id)))
    return undefined
  if (
    [...done.value].some((id) => failed.value.has(id)) ||
    [...failed.value].some((id) => inProgress.value.has(id))
  )
    return undefined
  if (
    ![...expected.value].every(
      (id) => done.value.has(id) || failed.value.has(id) || inProgress.value.has(id),
    )
  )
    return undefined
  const rawClear = value.clear
  if (
    !isPlainRecord(rawClear) ||
    !hasOnlyKeys(rawClear, scopes) ||
    !scopes.every((scope) => isClearState(rawClear[scope]))
  )
    return undefined
  const clear = rawClear as Readonly<Record<Scope, ClearStatus>>
  const ownedScopes = scopeSet(manual.value, automatic.value)
  if (scopes.some((scope) => !ownedScopes.has(scope) && clear[scope] !== 'none')) return undefined
  const handles = decodeWitnesses(value.handles, 'handles', expected.value)
  const settling = decodeWitnesses(value.settling, 'settling', expected.value)
  if (!handles.ok || !settling.ok) return undefined
  const handleMap = handles.value as Record<string, HandleWitness>
  const settleMap = settling.value as Record<string, SettleWitness>
  for (const requestId of Object.keys(handleMap)) {
    if (
      own(settleMap, requestId) ||
      !inProgress.value.has(requestId) ||
      done.value.has(requestId) ||
      failed.value.has(requestId)
    )
      return undefined
  }
  for (const requestId of Object.keys(settleMap)) {
    if (
      !inProgress.value.has(requestId) ||
      !done.value.has(requestId) ||
      failed.value.has(requestId)
    )
      return undefined
  }
  if (
    [...done.value].some(
      (requestId) => inProgress.value.has(requestId) && settleMap[requestId] === undefined,
    )
  )
    return undefined
  return {
    tweetId,
    manualScopes: manual.value,
    automaticScopes: automatic.value,
    crossListAutomaticScopes: crossListAutomatic.value,
    expected: expected.value,
    done: done.value,
    failed: failed.value,
    inProgress: inProgress.value,
    clear,
    handles: handleMap,
    settling: settleMap,
    createdAt: value.createdAt,
    touchedAt: value.touchedAt,
  }
}

/** Strictly decode persisted data. Callers must retain the raw value on failure;
 * they must not replace it with `emptyCompletionLedger()`. */
export const decodeCompletionLedger = (value: unknown): DecodeCompletionLedger => {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['version', 'entries', 'tombstones']) ||
    value.version !== 1 ||
    !isPlainRecord(value.entries) ||
    !isPlainRecord(value.tombstones)
  ) {
    return { ok: false, reason: 'invalid ledger envelope' }
  }
  const entries = new Map<string, CompletionLedgerEntry>()
  for (const [tweetId, rawEntry] of Object.entries(value.entries)) {
    const entry = decodeEntry(tweetId, rawEntry)
    if (entry === undefined) return { ok: false, reason: `invalid entry ${tweetId}` }
    entries.set(tweetId, entry)
  }
  const witnessedDownloadIds = new Set<number>()
  for (const entry of entries.values()) {
    for (const witness of [...Object.values(entry.handles), ...Object.values(entry.settling)]) {
      if (witnessedDownloadIds.has(witness.downloadId)) {
        return { ok: false, reason: `duplicate download witness ${witness.downloadId}` }
      }
      witnessedDownloadIds.add(witness.downloadId)
    }
  }
  const tombstones = new Map<string, Map<Scope, ClearTombstone>>()
  for (const [tweetId, rawStates] of Object.entries(value.tombstones)) {
    if (!isSnowflake(tweetId) || !isPlainRecord(rawStates))
      return { ok: false, reason: `invalid tombstones ${tweetId}` }
    const states = new Map<Scope, ClearTombstone>()
    for (const [scope, rawTombstone] of Object.entries(rawStates)) {
      if (
        !isScope(scope) ||
        !isPlainRecord(rawTombstone) ||
        !hasOnlyKeys(rawTombstone, ['tweetId', 'scope', 'state', 'at']) ||
        rawTombstone.tweetId !== tweetId ||
        rawTombstone.scope !== scope ||
        (rawTombstone.state !== 'cleared' && rawTombstone.state !== 'uncertain') ||
        !isSafeTime(rawTombstone.at)
      ) {
        return { ok: false, reason: `invalid tombstone ${tweetId}/${scope}` }
      }
      const active = entries.get(tweetId)
      if (
        active !== undefined &&
        entryScopes(active).has(scope) &&
        active.clear[scope] !== rawTombstone.state
      )
        return { ok: false, reason: `overlapping tombstone ${tweetId}/${scope}` }
      states.set(scope, { tweetId, scope, state: rawTombstone.state, at: rawTombstone.at })
    }
    if (states.size === 0) return { ok: false, reason: `empty tombstones ${tweetId}` }
    tombstones.set(tweetId, states)
  }
  for (const [tweetId, entry] of entries) {
    for (const scope of entryScopes(entry)) {
      const state = entry.clear[scope]
      if (
        (state === 'cleared' || state === 'uncertain') &&
        tombstones.get(tweetId)?.get(scope)?.state !== state
      )
        return { ok: false, reason: `missing terminal tombstone ${tweetId}/${scope}` }
    }
  }
  return { ok: true, ledger: { entries, tombstones } }
}

/** Compatibility name for the storage boundary. */
export const decodeClearLedgerStore = decodeCompletionLedger

/** Canonical wire output. Sets become stable, duplicate-free arrays here only. */
export const encodeCompletionLedger = (ledger: CompletionLedger): ClearLedgerStore => {
  const entries: Record<string, StoredClearEntry> = {}
  for (const [tweetId, entry] of [...ledger.entries].toSorted(([a], [b]) => a.localeCompare(b))) {
    entries[tweetId] = {
      tweetId,
      manualScopes: sorted(entry.manualScopes),
      automaticScopes: sorted(entry.automaticScopes),
      crossListAutomaticScopes: sorted(entry.crossListAutomaticScopes),
      expected: sorted(entry.expected),
      done: sorted(entry.done),
      failed: sorted(entry.failed),
      inProgress: sorted(entry.inProgress),
      clear: { ...entry.clear },
      handles: Object.fromEntries(
        Object.entries(entry.handles).toSorted(([a], [b]) => a.localeCompare(b)),
      ),
      settling: Object.fromEntries(
        Object.entries(entry.settling).toSorted(([a], [b]) => a.localeCompare(b)),
      ),
      createdAt: entry.createdAt,
      touchedAt: entry.touchedAt,
    }
  }
  const tombstones: Record<string, Partial<Record<Scope, ClearTombstone>>> = {}
  for (const [tweetId, states] of [...ledger.tombstones].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    tombstones[tweetId] = Object.fromEntries([...states].toSorted(([a], [b]) => a.localeCompare(b)))
  }
  return { version: 1, entries, tombstones }
}

/** Compatibility name for the storage boundary. */
export const encodeClearLedgerStore = encodeCompletionLedger

export interface SeedCompletionEntry {
  readonly tweetId: string
  /** Every request that must be terminal before Clear is eligible. */
  readonly expected: ReadonlyArray<string>
  /** Requests started by this seed. Must be a subset of `expected`. */
  readonly starting: ReadonlyArray<string>
  readonly manualScopes: ReadonlyArray<Scope>
  readonly automaticScopes: ReadonlyArray<Scope>
  readonly crossListAutomaticScopes?: ReadonlyArray<Scope>
  readonly at: number
}

/**
 * Seed only widens scopes and cannot resurrect a tombstoned Clear scope.
 * `expected` adds prerequisites; `starting` restarts transfers. A restarted
 * request loses old terminal state and witnesses, so stale events cannot
 * complete its replacement.
 */
export const seedCompletionEntry = (
  ledger: CompletionLedger,
  input: SeedCompletionEntry,
): CompletionLedger => {
  if (
    !isSnowflake(input.tweetId) ||
    !isSafeTime(input.at) ||
    input.expected.length === 0 ||
    !input.expected.every(isRequestId) ||
    !input.starting.every(isRequestId) ||
    !input.starting.every((requestId) => input.expected.includes(requestId)) ||
    !input.manualScopes.every(isScope) ||
    !input.automaticScopes.every(isScope)
  )
    return ledger
  const crossListAutomaticScopes = input.crossListAutomaticScopes ?? []
  if (
    !crossListAutomaticScopes.every(isScope) ||
    !crossListAutomaticScopes.every((scope) => input.automaticScopes.includes(scope))
  )
    return ledger
  const tombstoned = ledger.tombstones.get(input.tweetId)
  const manualScopes = new Set(input.manualScopes.filter((scope) => !tombstoned?.has(scope)))
  const automaticScopes = new Set(input.automaticScopes.filter((scope) => !tombstoned?.has(scope)))
  const crossListScopes = new Set(
    crossListAutomaticScopes.filter((scope) => automaticScopes.has(scope)),
  )
  const previous = ledger.entries.get(input.tweetId)
  if (previous === undefined) {
    if (scopeSet(manualScopes, automaticScopes).size === 0) return ledger
    const expected = new Set(input.expected)
    return withEntry(ledger, input.tweetId, {
      tweetId: input.tweetId,
      manualScopes,
      automaticScopes,
      crossListAutomaticScopes: crossListScopes,
      expected,
      done: new Set(),
      failed: new Set(),
      inProgress: new Set(expected),
      clear: record('none'),
      handles: {},
      settling: {},
      createdAt: input.at,
      touchedAt: input.at,
    })
  }
  const starting = new Set(input.starting)
  const expected = new Set([...previous.expected, ...input.expected])
  const newlyExpected = new Set(
    input.expected.filter((requestId) => !previous.expected.has(requestId)),
  )
  const ordinaryAutomaticScopes = new Set([
    ...[...previous.automaticScopes].filter(
      (scope) => !previous.crossListAutomaticScopes.has(scope),
    ),
    ...[...automaticScopes].filter((scope) => !crossListScopes.has(scope)),
  ])
  const nextAutomaticScopes = new Set([...previous.automaticScopes, ...automaticScopes])
  const nextCrossListAutomaticScopes = new Set(
    [...previous.crossListAutomaticScopes, ...crossListScopes].filter(
      (scope) => nextAutomaticScopes.has(scope) && !ordinaryAutomaticScopes.has(scope),
    ),
  )
  const clear: Record<Scope, ClearStatus> = { ...previous.clear }
  for (const scope of scopeSet(manualScopes, automaticScopes)) {
    // `skipped` is read-only evidence, not an irreversible click. A later
    // explicit save may follow a user re-bookmark/re-like, so rearm it.
    if (clear[scope] === 'skipped') clear[scope] = 'none'
  }
  const handles = Object.fromEntries(
    Object.entries(previous.handles).filter(([requestId]) => !starting.has(requestId)),
  )
  const settling = Object.fromEntries(
    Object.entries(previous.settling).filter(([requestId]) => !starting.has(requestId)),
  )
  const next: CompletionLedgerEntry = {
    ...previous,
    manualScopes: new Set([...previous.manualScopes, ...manualScopes]),
    automaticScopes: nextAutomaticScopes,
    crossListAutomaticScopes: nextCrossListAutomaticScopes,
    expected,
    clear,
    done: new Set([...previous.done].filter((requestId) => !starting.has(requestId))),
    failed: new Set([...previous.failed].filter((requestId) => !starting.has(requestId))),
    inProgress: new Set([...previous.inProgress, ...newlyExpected, ...starting]),
    handles,
    settling,
    touchedAt: Math.max(previous.touchedAt, input.at),
  }
  return withEntry(ledger, input.tweetId, next)
}

const updateEntry = (
  ledger: CompletionLedger,
  tweetId: string,
  at: number,
  update: (entry: CompletionLedgerEntry) => CompletionLedgerEntry | undefined,
): CompletionLedger => {
  if (!isSafeTime(at)) return ledger
  const entry = ledger.entries.get(tweetId)
  if (entry === undefined) return ledger
  const next = update(entry)
  if (next === undefined) return ledger
  return withEntry(ledger, tweetId, { ...next, touchedAt: Math.max(entry.touchedAt, at) })
}

const witnessMatches = (
  entry: CompletionLedgerEntry,
  requestId: string,
  downloadId: number,
): boolean =>
  entry.handles[requestId]?.downloadId === downloadId ||
  entry.settling[requestId]?.downloadId === downloadId

const witnessOwner = (
  ledger: CompletionLedger,
  downloadId: number,
): { readonly tweetId: string; readonly requestId: string } | undefined => {
  for (const [tweetId, entry] of ledger.entries) {
    for (const [requestId, witness] of Object.entries(entry.handles)) {
      if (witness.downloadId === downloadId) return { tweetId, requestId }
    }
    for (const [requestId, witness] of Object.entries(entry.settling)) {
      if (witness.downloadId === downloadId) return { tweetId, requestId }
    }
  }
  return undefined
}

/** A retry replaces its handle. Later terminals for the old browser id are no-ops. */
export const bindCompletionHandle = (
  ledger: CompletionLedger,
  input: {
    readonly tweetId: string
    readonly requestId: string
    readonly downloadId: number
    readonly at: number
  },
): CompletionLedger =>
  (() => {
    const owner = witnessOwner(ledger, input.downloadId)
    if (
      owner !== undefined &&
      (owner.tweetId !== input.tweetId || owner.requestId !== input.requestId)
    )
      return ledger
    return updateEntry(ledger, input.tweetId, input.at, (entry) => {
      if (
        !isRequestId(input.requestId) ||
        !isDownloadId(input.downloadId) ||
        !entry.expected.has(input.requestId)
      )
        return undefined
      if (
        entry.handles[input.requestId]?.downloadId === input.downloadId ||
        entry.settling[input.requestId]?.downloadId === input.downloadId
      )
        return undefined
      const handles = {
        ...entry.handles,
        [input.requestId]: { downloadId: input.downloadId, startedAt: input.at },
      }
      const settling = { ...entry.settling }
      delete settling[input.requestId]
      return {
        ...entry,
        handles,
        settling,
        done: remove(entry.done, input.requestId),
        failed: remove(entry.failed, input.requestId),
        inProgress: add(entry.inProgress, input.requestId),
      }
    })
  })()

/** Restore only a persisted live handle. Boot must never reopen terminal evidence. */
export const rebindPersistedHandle = (
  ledger: CompletionLedger,
  input: {
    readonly tweetId: string
    readonly requestId: string
    readonly downloadId: number
    readonly priorDownloadId?: number
    readonly at: number
  },
): CompletionLedger => {
  if (input.priorDownloadId !== undefined && !isDownloadId(input.priorDownloadId)) return ledger
  const owner = witnessOwner(ledger, input.downloadId)
  if (owner !== undefined) return ledger
  return updateEntry(ledger, input.tweetId, input.at, (entry) => {
    const current = entry.handles[input.requestId]
    if (
      !isRequestId(input.requestId) ||
      !isDownloadId(input.downloadId) ||
      !entry.expected.has(input.requestId) ||
      !entry.inProgress.has(input.requestId) ||
      entry.done.has(input.requestId) ||
      entry.failed.has(input.requestId) ||
      (current !== undefined &&
        (input.priorDownloadId === undefined || current.downloadId !== input.priorDownloadId)) ||
      entry.settling[input.requestId] !== undefined
    )
      return undefined
    return {
      ...entry,
      handles: {
        ...entry.handles,
        [input.requestId]: { downloadId: input.downloadId, startedAt: input.at },
      },
    }
  })
}

/** Complete is observed, not authorized. It trades a handle for one settle witness. */
export const observeCompletion = (
  ledger: CompletionLedger,
  input: {
    readonly tweetId: string
    readonly requestId: string
    readonly downloadId: number
    readonly at: number
  },
): CompletionLedger =>
  updateEntry(ledger, input.tweetId, input.at, (entry) => {
    if (
      !isRequestId(input.requestId) ||
      !isDownloadId(input.downloadId) ||
      input.at > Number.MAX_SAFE_INTEGER - SETTLE_CONFIRM_MS ||
      entry.handles[input.requestId]?.downloadId !== input.downloadId
    )
      return undefined
    const handles = { ...entry.handles }
    delete handles[input.requestId]
    return {
      ...entry,
      handles,
      settling: {
        ...entry.settling,
        [input.requestId]: {
          downloadId: input.downloadId,
          dueAt: input.at + SETTLE_CONFIRM_MS,
        },
      },
      done: add(entry.done, input.requestId),
    }
  })

export const settleCompletion = (
  ledger: CompletionLedger,
  input: {
    readonly tweetId: string
    readonly requestId: string
    readonly downloadId: number
    readonly at: number
  },
): CompletionLedger =>
  updateEntry(ledger, input.tweetId, input.at, (entry) => {
    const witness = entry.settling[input.requestId]
    if (
      !isRequestId(input.requestId) ||
      !isDownloadId(input.downloadId) ||
      witness?.downloadId !== input.downloadId ||
      input.at < witness.dueAt
    )
      return undefined
    const settling = { ...entry.settling }
    delete settling[input.requestId]
    return { ...entry, settling, inProgress: remove(entry.inProgress, input.requestId) }
  })

/** Fail and late interrupt share the same fail-closed terminal transition. */
export const failCompletion = (
  ledger: CompletionLedger,
  input: {
    readonly tweetId: string
    readonly requestId: string
    readonly downloadId: number
    readonly at: number
  },
): CompletionLedger =>
  updateEntry(ledger, input.tweetId, input.at, (entry) => {
    if (
      !isRequestId(input.requestId) ||
      !isDownloadId(input.downloadId) ||
      !witnessMatches(entry, input.requestId, input.downloadId)
    )
      return undefined
    const handles = { ...entry.handles }
    const settling = { ...entry.settling }
    delete handles[input.requestId]
    delete settling[input.requestId]
    return {
      ...entry,
      handles,
      settling,
      done: remove(entry.done, input.requestId),
      failed: add(entry.failed, input.requestId),
      inProgress: remove(entry.inProgress, input.requestId),
    }
  })

/** Fail a start that never returned a browser handle, including boot's
 * seed-before-bind gap. It cannot consume a stale terminal. */
export const failUnboundCompletion = (
  ledger: CompletionLedger,
  input: { readonly tweetId: string; readonly requestId: string; readonly at: number },
): CompletionLedger =>
  updateEntry(ledger, input.tweetId, input.at, (entry) => {
    if (
      !isRequestId(input.requestId) ||
      !entry.expected.has(input.requestId) ||
      !entry.inProgress.has(input.requestId) ||
      entry.done.has(input.requestId) ||
      entry.handles[input.requestId] !== undefined ||
      entry.settling[input.requestId] !== undefined
    )
      return undefined
    return {
      ...entry,
      failed: add(entry.failed, input.requestId),
      inProgress: remove(entry.inProgress, input.requestId),
    }
  })

export const isTrulyCompleteDurable = (entry: CompletionLedgerEntry): boolean =>
  entry.expected.size > 0 &&
  entry.failed.size === 0 &&
  entry.inProgress.size === 0 &&
  [...entry.expected].every((requestId) => entry.done.has(requestId))

export const canReserveClear = (
  ledger: CompletionLedger,
  tweetId: string,
  scope: Scope,
): boolean => {
  const entry = ledger.entries.get(tweetId)
  return (
    entry !== undefined &&
    !ledger.tombstones.get(tweetId)?.has(scope) &&
    entryScopes(entry).has(scope) &&
    isTrulyCompleteDurable(entry) &&
    (entry.clear[scope] === 'none' || entry.clear[scope] === 'failed')
  )
}

export const reserveClear = (
  ledger: CompletionLedger,
  tweetId: string,
  scope: Scope,
  at: number,
): CompletionLedger =>
  updateEntry(ledger, tweetId, at, (entry) =>
    canReserveClear(ledger, tweetId, scope)
      ? { ...entry, clear: { ...entry.clear, [scope]: 'reserved' } }
      : undefined,
  )

/** A policy recheck can release a persisted reservation before any tab send. */
export const releaseReservedClear = (
  ledger: CompletionLedger,
  tweetId: string,
  scope: Scope,
  at: number,
): CompletionLedger =>
  updateEntry(ledger, tweetId, at, (entry) =>
    entryScopes(entry).has(scope) && entry.clear[scope] === 'reserved'
      ? { ...entry, clear: { ...entry.clear, [scope]: 'failed' } }
      : undefined,
  )

/** Read-only locate found a positive inactive control. No Clear was sent. */
export const skipReadyClear = (
  ledger: CompletionLedger,
  tweetId: string,
  scope: Scope,
  at: number,
): CompletionLedger =>
  updateEntry(ledger, tweetId, at, (entry) =>
    entryScopes(entry).has(scope) &&
    !ledger.tombstones.get(tweetId)?.has(scope) &&
    isTrulyCompleteDurable(entry) &&
    (entry.clear[scope] === 'none' || entry.clear[scope] === 'failed')
      ? { ...entry, clear: { ...entry.clear, [scope]: 'skipped' } }
      : undefined,
  )

/** The caller persists `attempted` before its one destructive tab send. */
export const attemptReservedClear = (
  ledger: CompletionLedger,
  tweetId: string,
  scope: Scope,
  at: number,
): CompletionLedger =>
  updateEntry(ledger, tweetId, at, (entry) =>
    entry.clear[scope] === 'reserved' &&
    entryScopes(entry).has(scope) &&
    !ledger.tombstones.get(tweetId)?.has(scope) &&
    isTrulyCompleteDurable(entry)
      ? { ...entry, clear: { ...entry.clear, [scope]: 'attempted' } }
      : undefined,
  )

const addTombstone = (ledger: CompletionLedger, tombstone: ClearTombstone): CompletionLedger => {
  const tombstones = cloneTombstones(ledger)
  const states = tombstones.get(tombstone.tweetId) ?? new Map<Scope, ClearTombstone>()
  const current = states.get(tombstone.scope)
  if (current !== undefined) return ledger
  states.set(tombstone.scope, tombstone)
  tombstones.set(tombstone.tweetId, states)
  return { ...ledger, tombstones }
}

/** `cleared` is verified, `skipped` is a safe no-op, `uncertain` is terminal. */
export const resolveAttemptedClear = (
  ledger: CompletionLedger,
  input: {
    readonly tweetId: string
    readonly scope: Scope
    readonly result: Exclude<ClearStatus, 'none' | 'reserved' | 'attempted'>
    readonly at: number
  },
): CompletionLedger => {
  if (
    !isSafeTime(input.at) ||
    !['cleared', 'failed', 'skipped', 'uncertain'].includes(input.result)
  )
    return ledger
  const entry = ledger.entries.get(input.tweetId)
  if (entry === undefined || entry.clear[input.scope] !== 'attempted') return ledger
  const changed = withEntry(ledger, input.tweetId, {
    ...entry,
    clear: { ...entry.clear, [input.scope]: input.result },
    touchedAt: Math.max(entry.touchedAt, input.at),
  })
  return input.result === 'cleared' || input.result === 'uncertain'
    ? addTombstone(changed, {
        tweetId: input.tweetId,
        scope: input.scope,
        state: input.result,
        at: input.at,
      })
    : changed
}

/** Boot recovery never replays a reservation or a possibly-delivered send. */
export const recoverClearClaims = (ledger: CompletionLedger, at: number): CompletionLedger => {
  if (!isSafeTime(at)) return ledger
  let next = ledger
  for (const [tweetId, entry] of ledger.entries) {
    const clear: Record<Scope, ClearStatus> = { ...entry.clear }
    let changed = false
    for (const scope of entryScopes(entry)) {
      if (clear[scope] === 'reserved') {
        clear[scope] = 'failed'
        changed = true
      } else if (clear[scope] === 'attempted') {
        clear[scope] = 'uncertain'
        changed = true
      }
    }
    if (changed) {
      next = withEntry(next, tweetId, { ...entry, clear, touchedAt: Math.max(entry.touchedAt, at) })
      for (const scope of entryScopes(entry)) {
        if (clear[scope] === 'uncertain')
          next = addTombstone(next, { tweetId, scope, state: 'uncertain', at })
      }
    }
  }
  return next
}

/** Prune only terminal scope states. Failed reservations remain retryable. */
export const pruneResolvedEntry = (
  ledger: CompletionLedger,
  tweetId: string,
  at: number,
): CompletionLedger => {
  const entry = ledger.entries.get(tweetId)
  if (
    entry === undefined ||
    !isSafeTime(at) ||
    ![...entryScopes(entry)].every((scope) => terminalScope(entry.clear[scope]))
  )
    return ledger
  let next = withEntry(ledger, tweetId, undefined)
  for (const scope of entryScopes(entry)) {
    const state = entry.clear[scope]
    if (state === 'cleared' || state === 'uncertain') {
      next = addTombstone(next, { tweetId, scope, state, at: Math.max(at, entry.touchedAt) })
    }
  }
  return next
}

/**
 * Retention may remove only expired automatic download failures. Truly
 * complete/no-target rows and manual Worklist evidence remain durable.
 */
export const pruneExpiredAutomaticFailures = (
  ledger: CompletionLedger,
  expiresAt: number,
): CompletionLedger => {
  if (!isSafeTime(expiresAt)) return ledger
  let next = ledger
  for (const [tweetId, entry] of ledger.entries) {
    if (
      entry.touchedAt > expiresAt ||
      entry.failed.size === 0 ||
      entry.manualScopes.size > 0 ||
      entry.inProgress.size > 0 ||
      Object.keys(entry.handles).length > 0 ||
      Object.keys(entry.settling).length > 0
    )
      continue
    if (
      [...entryScopes(entry)].some(
        (scope) => entry.clear[scope] === 'reserved' || entry.clear[scope] === 'attempted',
      )
    )
      continue
    next = withEntry(next, tweetId, undefined)
  }
  return next
}
