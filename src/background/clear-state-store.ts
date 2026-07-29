import { storage } from 'wxt/utils/storage'
import { recoverAttemptedClear, resetBrowserSession } from '../core/clear/safety'
import {
  pruneResolvedEntry,
  recoverClearClaims,
  type ClearLogRecord,
  type ClearTombstone,
  type CompletionLedger,
  type Scope,
} from '../core/clear/ledger'
import { CLEAR_LOG_LIMIT } from '../core/schema'
import { makeSerialQueue } from '../core/serial-queue'
import {
  ClearDatabaseConflictError,
  makeIndexedDbClearBackend,
  storeTombstone,
  type ClearDurableBackend,
  type ClearTombstoneKey,
  type ObservedClearTombstone,
  type StoredClearTombstone,
} from './clear-indexed-db'
import {
  CLEAR_WORKLIST_PROJECTION_MAX,
  decodeStoredClearWorklistProjection,
  type ClearWorklistProjection,
  type StoredClearWorklistProjection,
} from './clear-worklist-projection'
import { makeClearMigration, migrationReceipt } from './clear-state-migration'
import type {
  ClearClock,
  ClearCoordinatorStorage,
  ClearCoordinatorTrace,
  ClearSessionMarkerStorage,
  ClearStorePointerStorage,
  LegacyCompletionStorage,
} from './clear-state-ports'
import { MAX_CLEAR_CLOCK_DELAY_MS } from './clear-state-ports'
import {
  ClearCoordinatorCorruptionError,
  assertTime,
  assertTweetId,
  compactState,
  decodeActiveStore,
  decodeClearSessionMarker,
  decodeIdentity,
  decodePointer,
  decodeStoredTombstone,
  domainTombstone,
  encodeActiveStore,
  entryScopes,
  isScope,
  latestTombstoneAt,
  type ClearStartupClaimMarker,
  type CoordinatorState,
} from './clear-state-codec'

export {
  ClearCoordinatorCorruptionError,
  MAX_CLEAR_ACTIVE_BYTES,
  MAX_CLEAR_ACTIVE_POSTS,
  MAX_CLEAR_MIGRATION_BYTES,
  MAX_CLEAR_REQUEST_ID_LENGTH,
  MAX_CLEAR_REQUESTS_PER_POST,
  assertDownloadId,
  assertRequestId,
  assertTime,
  assertTweetId,
  decodeClearCoordinatorStore,
  decodeClearSessionMarker,
  encodeClearCoordinatorStore,
  entryScopes,
  isDownloadId,
  isTime,
  unique,
  type ClearCoordinatorStore,
  type ClearOpenSessionMarker,
  type ClearSessionMarker,
  type ClearStartupClaimMarker,
  type ClearStorePointer,
  type CoordinatorState,
  type DecodeClearCoordinatorStore,
} from './clear-state-codec'
export type {
  ClearClock,
  ClearCoordinatorStorage,
  ClearCoordinatorTrace,
  ClearSessionMarkerStorage,
  ClearStorePointerStorage,
  LegacyCompletionStorage,
} from './clear-state-ports'

const MAX_COMMIT_ATTEMPTS = 3

export const realClock: ClearClock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > MAX_CLEAR_CLOCK_DELAY_MS)
      throw new TypeError(`Invalid Clear timer delay: ${delayMs}`)
    setTimeout(callback, delayMs)
  },
}
export const defaultStorage = (): ClearCoordinatorStorage => {
  // Migration source only. IDB is the sole live writer.
  const item = storage.defineItem<unknown>('local:clearCoordinator', {
    fallback: null,
  })
  return {
    get: () => item.getValue(),
    remove: () => item.removeValue(),
  }
}
export const defaultLegacyStorage = (): LegacyCompletionStorage => {
  // Older migration source only. Retained after pointer cutover so a stale
  // writer can never race migration cleanup and lose data.
  const item = storage.defineItem<unknown>('local:clearCompletionLedger', {
    fallback: null,
  })
  return {
    get: () => item.getValue(),
    remove: () => item.removeValue(),
  }
}
export const defaultPointerStorage = (): ClearStorePointerStorage => {
  const item = storage.defineItem<unknown>('local:clearStorePointer', {
    fallback: null,
  })
  return {
    get: () => item.getValue(),
    set: (value) => item.setValue(value),
  }
}
export const defaultSessionMarker = (): ClearSessionMarkerStorage => {
  const item = storage.defineItem<unknown>('session:clearSessionMarker', {
    fallback: null,
  })
  return {
    get: () => item.getValue(),
    set: (value) => item.setValue(value),
  }
}

const tombstoneKey = (tombstone: ClearTombstone): ClearTombstoneKey => [
  tombstone.tweetId,
  tombstone.scope,
]
const keyText = ([tweetId, scope]: ClearTombstoneKey): string => `${tweetId}\u0000${scope}`
const exactTombstone = (left: ClearTombstone, right: ClearTombstone): boolean =>
  left.tweetId === right.tweetId &&
  left.scope === right.scope &&
  left.state === right.state &&
  left.at === right.at

const uniqueKeys = (keys: ReadonlyArray<ClearTombstoneKey>): ClearTombstoneKey[] => {
  const result = new Map<string, ClearTombstoneKey>()
  for (const key of keys) {
    assertTweetId(key[0])
    if (!isScope(key[1])) throw new TypeError(`Invalid Clear scope: ${key[1]}`)
    result.set(keyText(key), key)
  }
  return [...result.values()]
}

const allActiveKeys = (state: CoordinatorState): ClearTombstoneKey[] =>
  [...state.completion.entries].flatMap(([tweetId, entry]) =>
    entryScopes(entry).map((scope) => [tweetId, scope] as const),
  )

const flattenTombstones = (ledger: CompletionLedger): ClearTombstone[] =>
  [...ledger.tombstones.values()].flatMap((states) => Array.from(states.values()))

const hydrateTombstones = (
  state: CoordinatorState,
  observed: ReadonlyArray<ObservedClearTombstone>,
): CoordinatorState => {
  if (observed.length === 0) return state
  const tombstones = new Map(
    [...state.completion.tombstones].map(([tweetId, states]) => [tweetId, new Map(states)]),
  )
  for (const item of observed) {
    const current = tombstones.get(item.key[0])?.get(item.key[1])
    if (item.value === undefined) {
      if (current !== undefined)
        throw new ClearCoordinatorCorruptionError(
          `missing durable tombstone ${item.key[0]}/${item.key[1]}`,
        )
      continue
    }
    const decoded = decodeStoredTombstone(item.value, item.key)
    if (decoded === undefined)
      throw new ClearCoordinatorCorruptionError(`invalid tombstone ${item.key[0]}/${item.key[1]}`)
    const incoming = domainTombstone(decoded)
    const states = tombstones.get(incoming.tweetId) ?? new Map<Scope, ClearTombstone>()
    const cached = states.get(incoming.scope)
    if (cached !== undefined && !exactTombstone(cached, incoming))
      throw new ClearCoordinatorCorruptionError(
        `conflicting tombstone ${incoming.tweetId}/${incoming.scope}`,
      )
    states.set(incoming.scope, incoming)
    tombstones.set(incoming.tweetId, states)
  }
  return {
    ...state,
    completion: { ...state.completion, tombstones },
  }
}

const additions = (
  before: CoordinatorState,
  after: CoordinatorState,
  observed: ReadonlyArray<ObservedClearTombstone>,
): StoredClearTombstone[] => {
  const known = new Map<string, ClearTombstone>()
  for (const item of observed) {
    if (item.value === undefined) continue
    const decoded = decodeStoredTombstone(item.value, item.key)
    if (decoded === undefined)
      throw new ClearCoordinatorCorruptionError(`invalid tombstone ${item.key[0]}/${item.key[1]}`)
    known.set(keyText(item.key), domainTombstone(decoded))
  }
  for (const tombstone of flattenTombstones(before.completion))
    known.set(keyText(tombstoneKey(tombstone)), tombstone)
  const append: StoredClearTombstone[] = []
  for (const tombstone of flattenTombstones(after.completion)) {
    const key = keyText(tombstoneKey(tombstone))
    const current = known.get(key)
    if (current === undefined) {
      if (!observed.some((item) => keyText(item.key) === key))
        throw new ClearCoordinatorCorruptionError(
          `unobserved tombstone append ${tombstone.tweetId}/${tombstone.scope}`,
        )
      append.push(storeTombstone(tombstone))
    } else if (!exactTombstone(current, tombstone))
      throw new ClearCoordinatorCorruptionError(
        `conflicting tombstone ${tombstone.tweetId}/${tombstone.scope}`,
      )
  }
  return append
}

const attempted = (
  ledger: CompletionLedger,
): Array<{ readonly tweetId: string; readonly scope: Scope }> =>
  [...ledger.entries].flatMap(([tweetId, entry]) =>
    entryScopes(entry).flatMap((scope) =>
      entry.clear[scope] === 'attempted' ? [{ tweetId, scope }] : [],
    ),
  )

export interface ClearStateStore {
  readonly initialize: () => Promise<void>
  /**
   * The transition may rerun after a CAS conflict. It must be synchronous,
   * deterministic, retry-safe, and free of I/O or other external effects.
   * Run effects only after this promise resolves.
   */
  readonly turn: <T>(
    keys: ReadonlyArray<ClearTombstoneKey>,
    transition: (state: CoordinatorState) => {
      readonly state: CoordinatorState
      readonly value: T
      readonly worklist?: ReadonlyArray<ClearWorklistProjection>
    },
  ) => Promise<T>
  readonly turnWithRevision: <T>(
    keys: ReadonlyArray<ClearTombstoneKey>,
    transition: (state: CoordinatorState) => {
      readonly state: CoordinatorState
      readonly value: T
      readonly worklist?: ReadonlyArray<ClearWorklistProjection>
    },
  ) => Promise<{ readonly value: T; readonly revision: number }>
  readonly snapshot: () => Promise<CoordinatorState>
  readonly listClearLog: () => Promise<ReadonlyArray<ClearLogRecord>>
  readonly listWorklistProjections: () => Promise<ReadonlyArray<StoredClearWorklistProjection>>
  readonly ackWorklistProjection: (
    expected: StoredClearWorklistProjection,
  ) => Promise<'acked' | 'missing' | 'stale'>
  /** Establishes the recurring outbox wake before any irreversible producer effect. */
  readonly armWorklistWake: () => Promise<void>
  /**
   * Samples recovery jitter once, outside a retryable turn. The returned
   * transition is pure and may be replayed after a CAS conflict.
   */
  readonly prepareRecovery: (at: number) => (state: CoordinatorState) => CoordinatorState
  readonly activeTombstoneKeys: () => Promise<ReadonlyArray<ClearTombstoneKey>>
  readonly isGateOpen: () => boolean
  readonly onBrowserStartup: () => Promise<boolean>
  readonly adoptExternalSession: () => Promise<void>
}

export const makeClearStateStore = (input: {
  readonly storage: ClearCoordinatorStorage
  readonly legacyStorage: LegacyCompletionStorage
  readonly pointerStorage: ClearStorePointerStorage
  readonly sessionMarker: ClearSessionMarkerStorage
  readonly backend: ClearDurableBackend
  readonly clock: ClearClock
  readonly samplePostTerminalDelay: () => number
  readonly newStoreId: () => string
  readonly ensureWorklistWake: () => Promise<void> | void
  readonly onError?: (error: unknown) => void
  readonly trace: (stage: string, context?: ClearCoordinatorTrace) => void
}): ClearStateStore => {
  const serial = makeSerialQueue(input.onError)
  let initialization: Promise<void> | undefined
  let current: CoordinatorState | undefined
  let currentLastTerminalAt = -1
  let currentRevision = 0
  let gateOpen = false
  let worklistWakeArmed = false
  const migration = makeClearMigration({
    storage: input.storage,
    legacyStorage: input.legacyStorage,
    pointerStorage: input.pointerStorage,
    backend: input.backend,
    trace: input.trace,
  })

  const armWorklistWake = async (): Promise<void> => {
    if (worklistWakeArmed) return
    await input.ensureWorklistWake()
    worklistWakeArmed = true
  }

  const applySessionMarker = (state: CoordinatorState, raw: unknown): void => {
    const markerEpoch = decodeClearSessionMarker(raw)?.browserSessionEpoch
    const stateEpoch = state.safety.browserSessionEpoch
    gateOpen = markerEpoch === stateEpoch
  }

  const recoverWithDelay = (
    state: CoordinatorState,
    at: number,
    postTerminalDelay: number,
  ): CoordinatorState => {
    const logicalAt = Math.max(at, state.safety.attemptAts.at(-1) ?? 0)
    let safety = state.safety
    for (const claim of attempted(state.completion)) {
      const next = recoverAttemptedClear(safety, logicalAt, postTerminalDelay)
      if (next === undefined)
        throw new ClearCoordinatorCorruptionError(
          `cannot recover attempted ${claim.tweetId}/${claim.scope}`,
        )
      safety = next
    }
    let completion = recoverClearClaims(state.completion, logicalAt)
    for (const tweetId of completion.entries.keys())
      completion = pruneResolvedEntry(completion, tweetId, logicalAt)
    return completion === state.completion && safety === state.safety
      ? state
      : { completion, safety }
  }
  const prepareRecovery: ClearStateStore['prepareRecovery'] = (at) => {
    assertTime(at)
    const postTerminalDelay = input.samplePostTerminalDelay()
    return (state) => recoverWithDelay(state, at, postTerminalDelay)
  }
  const recover = (state: CoordinatorState, at: number): CoordinatorState =>
    prepareRecovery(at)(state)

  const readObserved = async (
    keys: ReadonlyArray<ClearTombstoneKey>,
  ): Promise<ReadonlyArray<ObservedClearTombstone>> => {
    const observed = await input.backend.readTombstones(uniqueKeys(keys))
    return observed.map((item) => {
      if (item.value === undefined) return item
      const decoded = decodeStoredTombstone(item.value, item.key)
      if (decoded === undefined)
        throw new ClearCoordinatorCorruptionError(`invalid tombstone ${item.key[0]}/${item.key[1]}`)
      return { key: item.key, value: decoded }
    })
  }

  const validateDurableTombstones = (
    state: CoordinatorState,
    observed: ReadonlyArray<ObservedClearTombstone>,
    lastTerminalAt: number,
  ): CoordinatorState => {
    const hydrated = hydrateTombstones(state, observed)
    const byKey = new Map(observed.map((item) => [keyText(item.key), item.value]))
    for (const item of observed) {
      if (item.value === undefined) continue
      const durable = domainTombstone(item.value)
      const cached = state.completion.tombstones.get(durable.tweetId)?.get(durable.scope)
      if (cached === undefined || !exactTombstone(cached, durable))
        throw new ClearCoordinatorCorruptionError(
          `uncached durable tombstone ${durable.tweetId}/${durable.scope}`,
        )
    }
    for (const [tweetId, tombstones] of state.completion.tombstones)
      for (const [scope, cached] of tombstones) {
        const durable = byKey.get(keyText([tweetId, scope]))
        if (durable === undefined || !exactTombstone(cached, domainTombstone(durable)))
          throw new ClearCoordinatorCorruptionError(`missing durable tombstone ${tweetId}/${scope}`)
      }
    if (latestTombstoneAt(hydrated.completion) > lastTerminalAt)
      throw new ClearCoordinatorCorruptionError('active tombstone exceeds terminal watermark')
    return hydrated
  }

  const reloadCurrent = async (): Promise<void> => {
    const at = input.clock.now()
    assertTime(at)
    const loaded = await input.backend.load()
    const identity = decodeIdentity(loaded.identity)
    if (identity === undefined)
      throw new ClearCoordinatorCorruptionError('invalid Clear database identity')
    const pointer = decodePointer(await input.pointerStorage.get())
    if (pointer?.storeId !== identity.storeId)
      throw new ClearCoordinatorCorruptionError('Clear database pointer mismatch')
    const decoded = decodeActiveStore(loaded.active, at)
    const state = compactState(decoded.state)
    const observed = await readObserved(allActiveKeys(state))
    validateDurableTombstones(state, observed, decoded.lastTerminalAt)
    current = state
    currentLastTerminalAt = decoded.lastTerminalAt
    currentRevision = decoded.revision
    applySessionMarker(state, await input.sessionMarker.get())
  }

  const commitTransition = async <T>(
    keys: ReadonlyArray<ClearTombstoneKey>,
    transition: (state: CoordinatorState) => {
      readonly state: CoordinatorState
      readonly value: T
      readonly worklist?: ReadonlyArray<ClearWorklistProjection>
    },
  ): Promise<{ readonly value: T; readonly revision: number }> => {
    // oxlint-disable no-await-in-loop -- each retry must load the CAS winner before deciding again.
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const base = requireCurrent()
      const observed = await readObserved(keys)
      const hydrated = hydrateTombstones(base, observed)
      const result = transition(hydrated)
      const intents = result.worklist ?? []
      if (intents.length > CLEAR_WORKLIST_PROJECTION_MAX)
        throw new TypeError('Clear Worklist projection transition exceeds capacity')
      const intentKeys = new Set<string>()
      for (const intent of intents) {
        assertTweetId(intent.tweetId)
        if (!isScope(intent.scope)) throw new TypeError(`Invalid Clear scope: ${intent.scope}`)
        if (!['downloaded', 'failed', 'cleared'].includes(intent.state))
          throw new TypeError(`Invalid Clear Worklist projection state: ${intent.state}`)
        assertTime(intent.at)
        const intentKey = keyText([intent.tweetId, intent.scope])
        if (intentKeys.has(intentKey))
          throw new TypeError(`Duplicate Clear Worklist projection: ${intentKey}`)
        intentKeys.add(intentKey)
      }
      const append = additions(hydrated, result.state, observed)
      const lastTerminalAt = append.reduce(
        (latest, tombstone) => Math.max(latest, tombstone.at),
        currentLastTerminalAt,
      )
      const next = compactState(result.state)
      const candidate = encodeActiveStore(next, lastTerminalAt, currentRevision)
      const before = encodeActiveStore(base, currentLastTerminalAt, currentRevision)
      const changed =
        intents.length > 0 ||
        append.length > 0 ||
        JSON.stringify(candidate) !== JSON.stringify(before)
      if (changed)
        try {
          if (intents.length > 0) await armWorklistWake()
          const worklist = intents.map(
            (intent): StoredClearWorklistProjection => ({
              version: 1,
              revision: currentRevision + 1,
              tweetId: intent.tweetId,
              scope: intent.scope,
              state: intent.state,
              at: intent.at,
            }),
          )
          await input.backend.commit({
            expectedRevision: currentRevision,
            active: encodeActiveStore(next, lastTerminalAt, currentRevision + 1),
            observed,
            append,
            worklist,
          })
        } catch (error) {
          if (!(error instanceof ClearDatabaseConflictError)) throw error
          await reloadCurrent()
          if (attempt === MAX_COMMIT_ATTEMPTS) throw error
          continue
        }
      current = next
      currentLastTerminalAt = lastTerminalAt
      if (changed) currentRevision += 1
      return { value: result.value, revision: currentRevision }
    }
    // oxlint-enable no-await-in-loop
    throw new Error('Clear transition retry exhausted')
  }

  /**
   * Completes one fixed startup claim. The bound prefix belongs to the prior
   * browser session. Attempts appended after the claim survive every CAS retry.
   */
  const commitStartupClaim = async (claim: ClearStartupClaimMarker): Promise<number> => {
    // oxlint-disable no-await-in-loop -- a conflict must load the winner before retrying safely.
    for (let attempt = 1; attempt <= MAX_COMMIT_ATTEMPTS; attempt += 1) {
      const base = requireCurrent()
      const baseEpoch = base.safety.browserSessionEpoch
      if (baseEpoch >= claim.browserSessionEpoch) return baseEpoch
      if (
        baseEpoch + 1 !== claim.browserSessionEpoch ||
        currentRevision < claim.baseRevision ||
        claim.baseAttemptAts.length > base.safety.attemptAts.length ||
        claim.baseAttemptAts.some((attemptAt, index) => base.safety.attemptAts[index] !== attemptAt)
      )
        throw new ClearCoordinatorCorruptionError('invalid pending Clear startup epoch')
      const reset = resetBrowserSession(base.safety)
      if (reset === undefined || reset.browserSessionEpoch !== claim.browserSessionEpoch)
        throw new Error('Clear browser-session epoch exhausted')
      const safety = {
        ...reset,
        attemptAts: base.safety.attemptAts.slice(claim.baseAttemptAts.length),
      }
      const next = compactState({ ...base, safety })
      try {
        await input.backend.commit({
          expectedRevision: currentRevision,
          active: encodeActiveStore(next, currentLastTerminalAt, currentRevision + 1),
          observed: [],
          append: [],
        })
      } catch (error) {
        if (!(error instanceof ClearDatabaseConflictError)) throw error
        await reloadCurrent()
        if (attempt === MAX_COMMIT_ATTEMPTS) throw error
        continue
      }
      current = next
      currentRevision += 1
      return claim.browserSessionEpoch
    }
    // oxlint-enable no-await-in-loop
    throw new Error('Clear startup transition retry exhausted')
  }

  const initialize = (): Promise<void> => {
    if (initialization !== undefined) return initialization
    const running = serial.run(async () => {
      const at = input.clock.now()
      assertTime(at)
      let loaded = await input.backend.load()
      let identity = decodeIdentity(loaded.identity)
      if (loaded.identity !== undefined && identity === undefined)
        throw new ClearCoordinatorCorruptionError('invalid Clear database identity')
      if (identity === undefined) {
        if (loaded.active !== undefined)
          throw new ClearCoordinatorCorruptionError('Clear database active state has no identity')
        const pointerRaw = await input.pointerStorage.get()
        if (pointerRaw !== undefined && pointerRaw !== null)
          throw new ClearCoordinatorCorruptionError('Clear database pointer has no database')
        const source = await migration.sourceState(at)
        const recovered = recover(source.state, at)
        const lastTerminalAt = latestTombstoneAt(recovered.completion)
        const compact = compactState(recovered)
        const imported = flattenTombstones(recovered.completion).map((tombstone) =>
          storeTombstone(tombstone, 'migration'),
        )
        const storeId = input.newStoreId()
        if (typeof storeId !== 'string' || storeId.length === 0 || storeId.length > 128)
          throw new TypeError('Invalid Clear database id')
        const initialActive = encodeActiveStore(compact, lastTerminalAt, 0)
        identity = {
          key: 'identity',
          version: 1,
          storeId,
          receipt: await migrationReceipt(initialActive, imported),
          source: source.source,
        }
        const created = await input.backend.bootstrap(identity, initialActive, imported)
        if (created === 'exists') {
          loaded = await input.backend.load()
          identity = decodeIdentity(loaded.identity)
          if (identity === undefined)
            throw new ClearCoordinatorCorruptionError(
              'concurrent Clear database bootstrap is invalid',
            )
        } else loaded = await input.backend.load()
      }
      const decoded = decodeActiveStore(loaded.active, at)
      const loadedState = compactState(decoded.state)
      const recoveryKeys = allActiveKeys(loadedState)
      const observed = await readObserved(recoveryKeys)
      const hydrated = validateDurableTombstones(loadedState, observed, decoded.lastTerminalAt)
      await migration.finishPointer(identity, loaded.active, decoded.revision, at)
      current = loadedState
      currentLastTerminalAt = decoded.lastTerminalAt
      currentRevision = decoded.revision
      const recovered = recover(hydrated, at)
      const append = additions(hydrated, recovered, observed)
      const nextLastTerminalAt = append.reduce(
        (latest, tombstone) => Math.max(latest, tombstone.at),
        currentLastTerminalAt,
      )
      const compact = compactState(recovered)
      const candidateActive = encodeActiveStore(compact, nextLastTerminalAt, currentRevision)
      const previousActive = encodeActiveStore(current, currentLastTerminalAt, currentRevision)
      const recoveryChanged =
        append.length > 0 || JSON.stringify(candidateActive) !== JSON.stringify(previousActive)
      if (recoveryChanged)
        await input.backend.commit({
          expectedRevision: currentRevision,
          active: encodeActiveStore(compact, nextLastTerminalAt, currentRevision + 1),
          observed,
          append,
        })
      current = compact
      currentLastTerminalAt = nextLastTerminalAt
      if (recoveryChanged) currentRevision += 1
      applySessionMarker(current, await input.sessionMarker.get())
    })
    const guarded = running.catch((error: unknown) => {
      if (initialization === guarded) initialization = undefined
      current = undefined
      currentLastTerminalAt = -1
      currentRevision = 0
      gateOpen = false
      throw error
    })
    initialization = guarded
    return guarded
  }

  const requireCurrent = (): CoordinatorState => {
    if (current === undefined) throw new Error('Clear database is not initialized')
    return current
  }

  const turnWithRevision: ClearStateStore['turnWithRevision'] = (keys, transition) =>
    initialize().then(
      async () => await serial.run(async () => await commitTransition(keys, transition)),
    )
  const turn: ClearStateStore['turn'] = async (keys, transition) =>
    (await turnWithRevision(keys, transition)).value

  const snapshot = async (): Promise<CoordinatorState> => {
    await initialize()
    return await serial.run(async () => requireCurrent())
  }

  const listClearLog = async (): Promise<ReadonlyArray<ClearLogRecord>> => {
    await initialize()
    const rows = await input.backend.listCleared(CLEAR_LOG_LIMIT)
    return rows.map((row) => {
      const tombstone = decodeStoredTombstone(row)
      if (tombstone === undefined || tombstone.state !== 'cleared')
        throw new ClearCoordinatorCorruptionError('invalid Clear Log tombstone')
      return {
        tweetId: tombstone.tweetId,
        scope: tombstone.scope,
        at: tombstone.at,
        mechanism: 'dom-click',
        permalink: `https://x.com/i/status/${tombstone.tweetId}`,
      }
    })
  }

  const listWorklistProjections = async (): Promise<
    ReadonlyArray<StoredClearWorklistProjection>
  > => {
    await initialize()
    const rows = await input.backend.listWorklistProjections()
    return rows.map((row) => {
      const projection = decodeStoredClearWorklistProjection(row)
      if (projection === undefined)
        throw new ClearCoordinatorCorruptionError('invalid Clear Worklist projection')
      return projection
    })
  }

  const ackWorklistProjection = async (
    expected: StoredClearWorklistProjection,
  ): Promise<'acked' | 'missing' | 'stale'> => {
    await initialize()
    return await input.backend.ackWorklistProjection(expected)
  }

  const adoptExternalSession = async (): Promise<void> => {
    await initialize()
    await serial.run(async () => {
      if (gateOpen) return
      const state = requireCurrent()
      const marker = decodeClearSessionMarker(await input.sessionMarker.get())
      if (marker?.browserSessionEpoch === state.safety.browserSessionEpoch) {
        if (marker.version === 2)
          await input.sessionMarker.set({
            version: 1,
            browserSessionEpoch: state.safety.browserSessionEpoch,
          })
        gateOpen = true
        return
      }
      const epoch =
        marker?.version === 2 && marker.browserSessionEpoch === state.safety.browserSessionEpoch + 1
          ? await commitStartupClaim(marker)
          : state.safety.browserSessionEpoch
      await input.sessionMarker.set({
        version: 1,
        browserSessionEpoch: epoch,
      })
      gateOpen = true
    })
  }

  const onBrowserStartup = async (): Promise<boolean> => {
    await initialize()
    return await serial.run(async () => {
      if (gateOpen) return false
      const state = requireCurrent()
      const marker = decodeClearSessionMarker(await input.sessionMarker.get())
      if (marker?.browserSessionEpoch === state.safety.browserSessionEpoch) {
        if (marker.version === 2)
          await input.sessionMarker.set({
            version: 1,
            browserSessionEpoch: state.safety.browserSessionEpoch,
          })
        gateOpen = true
        return false
      }
      const pending =
        marker?.version === 2 && marker.browserSessionEpoch === state.safety.browserSessionEpoch + 1
      const reset = pending ? undefined : resetBrowserSession(state.safety)
      if (!pending && reset === undefined) throw new Error('Clear browser-session epoch exhausted')
      const claim: ClearStartupClaimMarker = pending
        ? marker
        : {
            version: 2,
            browserSessionEpoch: reset!.browserSessionEpoch,
            baseRevision: currentRevision,
            baseAttemptAts: [...state.safety.attemptAts],
          }
      await input.sessionMarker.set(claim)
      const epoch = await commitStartupClaim(claim)
      await input.sessionMarker.set({
        version: 1,
        browserSessionEpoch: epoch,
      })
      gateOpen = true
      return true
    })
  }

  return {
    initialize,
    turn,
    turnWithRevision,
    snapshot,
    listClearLog,
    listWorklistProjections,
    ackWorklistProjection,
    armWorklistWake,
    prepareRecovery,
    activeTombstoneKeys: async () => {
      await initialize()
      return allActiveKeys(requireCurrent())
    },
    isGateOpen: () => gateOpen,
    onBrowserStartup,
    adoptExternalSession,
  }
}

export const defaultClearBackend = (): ClearDurableBackend => makeIndexedDbClearBackend()
