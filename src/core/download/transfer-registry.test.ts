import { describe, expect, it } from 'vitest'
import {
  ackTerminal,
  armDirectCall,
  armAria2Call,
  armFetchedCall,
  beginRetryLaunch,
  beginForgetRecovery,
  beginLegacyForgetRecovery,
  beginCapacityLaunch,
  bindStarted,
  decodeTransferRegistryStore,
  deferAria2ProfileProbe,
  deferUnresolvedBrowserProbe,
  deferTerminalProjection,
  deferLaunchForCapacity,
  emptyTransferRegistryStore,
  completeForgetRecovery,
  completeLegacyForgetRecovery,
  completeRetryRefresh,
  enrichBrowserTerminal,
  failRetryStart,
  failRetryRefresh,
  MAX_ARIA2_PROFILE_RPC_URL_LENGTH,
  MAX_ARIA2_PROFILE_SECRET_LENGTH,
  MAX_TRANSFER_REGISTRY_MEDIA_ITEM_BYTES,
  MAX_TRANSFER_REGISTRY_FILENAME_LENGTH,
  MAX_TRANSFER_REGISTRY_STORE_BYTES,
  MAX_TRANSFER_REGISTRY_URL_LENGTH,
  failRetryWait,
  forgetTransferRecovery,
  isCurrentLaunch,
  listTransferRecovery,
  listPendingForgetRecovery,
  listPendingLegacyForgetRecovery,
  markAria2CallAmbiguous,
  markAria2ConfirmedUnbound,
  permitPreparedLaunches,
  prepareLaunches as prepareLaunchesCore,
  prepareLaunchGroups,
  planActiveReconciliation,
  quarantineLaunchingOnBoot,
  rebaseClockRollbackOnBoot,
  claimRetryRefresh,
  recordAria2ProfileProbeSuccess,
  recordAria2ProfileUnavailable,
  recordAria2Progress,
  recordAria2Terminal,
  recordBrowserLive,
  recordBrowserTerminal,
  recoverFetchedObservation,
  rejectStart,
  rescheduleRetryLaunchFailure,
  resolveUntrackedStart,
  scheduleInterruptedRetry,
  terminalOutcome,
  type TransferRegistryStore,
  type TransferRequest,
} from './transfer-registry'
import { mediaRequestId, sidecarRequestId } from './request-identity'
import { MAX_TRANSFER_REGISTRY_ID_LENGTH } from '../wire/limits'
import {
  decodeV2TransferRegistryStore,
  migrateV2TransferRegistryStore,
  v2ProjectionId,
} from './transfer-registry-v2-migration'
import { isBoundedJson } from './transfer-registry-model'

const request = (over: Partial<TransferRequest> = {}): TransferRequest => ({
  id: 'media-1',
  projectionId: 'project-media-1',
  url: 'https://video.example/a.mp4',
  filename: 'a.mp4',
  mode: 'direct',
  historyPolicy: 'record',
  ...over,
})
const profile = {
  profileId: 'local',
  rpcUrl: 'http://127.0.0.1:6800/jsonrpc',
  secret: 'secret',
}
const options = { split: 4 }
const reservation = { 'media-1': { profile, gid: '0000000000000001', options } }
const wireStore = (
  transferRequest: TransferRequest,
  phase: Record<string, unknown>,
  profiles: Record<string, unknown> = {},
) => ({
  version: 4,
  entries: {
    [transferRequest.id]: {
      request: transferRequest,
      createdAt: 1,
      phase,
    },
  },
  profiles,
  legacy: {},
})
const prepareLaunches = (...input: Parameters<typeof prepareLaunchesCore>) => {
  const prepared = prepareLaunchesCore(...input)
  let state = permitPreparedLaunches(prepared.state, prepared.launches).state
  for (const token of prepared.launches)
    if (state.entries[token.id]?.request.mode === 'direct')
      state = armDirectCall(state, token, input[2]).state
  return { ...prepared, state }
}

describe('transfer registry v4', () => {
  it('persists a replayable Direct pre-call state before its exact arm', () => {
    const prepared = prepareLaunchesCore(emptyTransferRegistryStore, [request()], 1)
    expect(prepared.state.entries['media-1']?.phase).toEqual({
      tag: 'direct-prepared',
      attempt: 0,
      since: 1,
    })
    const permitted = permitPreparedLaunches(prepared.state, prepared.launches)
    expect(permitted.state.entries['media-1']?.phase).toEqual({
      tag: 'direct-ready',
      attempt: 0,
      since: 1,
    })
    expect(
      armDirectCall(permitted.state, prepared.launches[0]!, 2).state.entries['media-1']?.phase,
    ).toEqual({ tag: 'launching', attempt: 0, since: 1 })
  })

  it('permits one exact prepared batch atomically', () => {
    const prepared = prepareLaunchesCore(
      emptyTransferRegistryStore,
      [
        request(),
        request({
          id: 'media-2',
          projectionId: 'project-media-2',
          mode: 'fetched',
        }),
      ],
      1,
    )
    const stale = prepared.launches.map((token, index) =>
      index === 0 ? token : { ...token, since: token.since + 1 },
    )

    expect(() => permitPreparedLaunches(prepared.state, stale)).toThrow(
      'stale prepared launch: media-2',
    )
    expect(prepared.state.entries['media-1']?.phase.tag).toBe('direct-prepared')
    expect(prepared.state.entries['media-2']?.phase.tag).toBe('fetched-prepared')

    const permitted = permitPreparedLaunches(prepared.state, prepared.launches)
    expect(permitted.state.entries['media-1']?.phase.tag).toBe('direct-ready')
    expect(permitted.state.entries['media-2']?.phase.tag).toBe('ready')
    expect(permitPreparedLaunches(permitted.state, prepared.launches).changed).toBe(false)
  })

  it('decodes each wire version without upgrading impossible v3 state', () => {
    const legacyDirect = wireStore(request(), { tag: 'launching', attempt: 0, since: 1 })
    expect(decodeTransferRegistryStore({ ...legacyDirect, version: 3 })).toEqual({
      ok: true,
      state: legacyDirect,
    })
    const ariaProfile = { ...profile, failureCount: 0, nextProbeAt: 1 }
    const v4Only = [
      wireStore(request(), { tag: 'direct-prepared', attempt: 0, since: 1 }),
      wireStore(request(), { tag: 'direct-ready', attempt: 0, since: 1 }),
      wireStore(request({ mode: 'fetched' }), { tag: 'fetched-prepared', attempt: 0, since: 1 }),
      wireStore(
        request({ mode: 'aria2' }),
        {
          tag: 'aria2-prepared',
          attempt: 0,
          since: 1,
          profileId: profile.profileId,
          gid: reservation['media-1'].gid,
          options,
        },
        { [profile.profileId]: ariaProfile },
      ),
      wireStore(
        request({ mode: 'aria2' }),
        {
          tag: 'aria2-ready',
          attempt: 0,
          since: 1,
          profileId: profile.profileId,
          gid: reservation['media-1'].gid,
          options,
        },
        { [profile.profileId]: ariaProfile },
      ),
    ]
    for (const state of v4Only) {
      expect(decodeTransferRegistryStore(state).ok).toBe(true)
      expect(decodeTransferRegistryStore({ ...state, version: 3 })).toMatchObject({
        ok: false,
        reason: 'invalid entry: media-1',
      })
    }
  })

  it('reserves durable Sweep ownership for v4 stores', () => {
    const intent = request({
      sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' },
    })
    const prepared = prepareLaunchesCore(emptyTransferRegistryStore, [intent], 1)
    const permitted = permitPreparedLaunches(prepared.state, prepared.launches).state
    const armed = armDirectCall(permitted, prepared.launches[0]!, 2).state
    const confirmed = {
      ...armed,
      entries: {
        ...armed.entries,
        'media-1': {
          ...armed.entries['media-1']!,
          sweepOwnership: { receiptId: 'sweep-1', clearSeedId: 7 },
        },
      },
    }

    expect(decodeTransferRegistryStore(confirmed).ok).toBe(true)
    expect(decodeTransferRegistryStore({ ...confirmed, version: 3 })).toMatchObject({
      ok: false,
      reason: 'invalid entry: media-1',
    })
  })

  it('rejects mixed or partially owned Sweep receipt groups', () => {
    const item = {
      id: 'media-1',
      platform: 'x' as const,
      postId: '123',
      author: 'alice',
      type: 'photo' as const,
      url: 'https://pbs.twimg.com/media/a.jpg',
      ext: 'jpg',
      index: 0,
    }
    const receipt = { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' as const }
    const mainId = mediaRequestId(item)
    const sidecarId = sidecarRequestId(item)
    const main = request({ id: mainId, item, sweepReceipt: receipt })
    const sidecar = request({
      id: sidecarId,
      projectionId: 'sidecar-projection',
      url: 'data:application/json,{}',
      filename: 'a.json',
      historyPolicy: 'off',
      sweepReceipt: receipt,
    })
    const group = () => ({
      version: 4,
      entries: {
        [mainId]: {
          request: { ...main, sweepReceipt: { ...receipt } },
          createdAt: 1,
          phase: { tag: 'launching', attempt: 0, since: 1 },
        },
        [sidecarId]: {
          request: { ...sidecar, sweepReceipt: { ...receipt } },
          createdAt: 1,
          phase: { tag: 'launching', attempt: 0, since: 1 },
        },
      },
      profiles: {},
      legacy: {},
    })

    expect(decodeTransferRegistryStore(group()).ok).toBe(true)

    const mixedTuple = group()
    mixedTuple.entries[sidecarId]!.request.sweepReceipt.tweetId = '456'
    expect(decodeTransferRegistryStore(mixedTuple)).toMatchObject({
      ok: false,
      reason: 'invalid Sweep receipt group: sweep-1',
    })

    const partialOwnership = group()
    Object.assign(partialOwnership.entries[mainId]!, {
      sweepOwnership: { receiptId: 'sweep-1', clearSeedId: 7 },
    })
    expect(decodeTransferRegistryStore(partialOwnership)).toMatchObject({
      ok: false,
      reason: 'invalid Sweep receipt group: sweep-1',
    })

    const owned = group()
    for (const entry of Object.values(owned.entries))
      Object.assign(entry, {
        sweepOwnership: { receiptId: 'sweep-1', clearSeedId: 7 },
      })
    expect(decodeTransferRegistryStore(owned).ok).toBe(true)

    const mixedSeed = group()
    Object.assign(mixedSeed.entries[mainId]!, {
      sweepOwnership: { receiptId: 'sweep-1', clearSeedId: 7 },
    })
    Object.assign(mixedSeed.entries[sidecarId]!, {
      sweepOwnership: { receiptId: 'sweep-1', clearSeedId: 8 },
    })
    expect(decodeTransferRegistryStore(mixedSeed)).toMatchObject({
      ok: false,
      reason: 'invalid Sweep receipt group: sweep-1',
    })

    const wrongPost = group()
    wrongPost.entries[mainId]!.request.sweepReceipt.tweetId = '456'
    wrongPost.entries[sidecarId]!.request.sweepReceipt.tweetId = '456'
    expect(decodeTransferRegistryStore(wrongPost)).toMatchObject({
      ok: false,
      reason: 'Sweep receipt post mismatch: sweep-1',
    })
  })

  it('persists strict manual-sweep provenance on every artifact intent', () => {
    const intent = request({
      sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' },
    })
    expect(
      decodeTransferRegistryStore({
        version: 3,
        entries: {
          'media-1': {
            request: intent,
            createdAt: 1,
            phase: { tag: 'launching', attempt: 0, since: 1 },
          },
        },
        profiles: {},
        legacy: {},
      }),
    ).toMatchObject({ ok: true })

    expect(
      decodeTransferRegistryStore({
        version: 3,
        entries: {
          'media-1': {
            request: {
              ...intent,
              sweepReceipt: { ...intent.sweepReceipt, scope: 'notInterested' },
            },
            createdAt: 1,
            phase: { tag: 'launching', attempt: 0, since: 1 },
          },
        },
        profiles: {},
        legacy: {},
      }),
    ).toMatchObject({ ok: false })
  })

  it('requires canonical global IDs for new non-X requests but decodes legacy rows', () => {
    const item = {
      id: 'shared',
      platform: 'instagram' as const,
      postId: 'post-1',
      author: 'alice',
      type: 'photo' as const,
      url: 'https://scontent.cdninstagram.com/v/t51.82787-15/shared.jpg',
      ext: 'jpg',
      index: 0,
    }
    expect(() =>
      prepareLaunches(emptyTransferRegistryStore, [request({ id: item.id, item })], 1),
    ).toThrow('noncanonical request id')

    const canonicalId = 'xmd:v1:media:instagram:6:shared'
    const canonical = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ id: canonicalId, item })],
      1,
    )
    expect(decodeTransferRegistryStore(canonical.state).ok).toBe(true)

    const legacy = {
      ...canonical.state,
      entries: {
        shared: {
          ...canonical.state.entries[canonicalId]!,
          request: {
            ...canonical.state.entries[canonicalId]!.request,
            id: 'shared',
            projectionId: 'legacy-project-shared',
          },
        },
      },
    }
    expect(decodeTransferRegistryStore(legacy).ok).toBe(true)
    expect(prepareLaunches(legacy, [request({ id: canonicalId, item })], 2).duplicateIds).toEqual([
      canonicalId,
    ])
    expect(
      decodeTransferRegistryStore({
        ...canonical.state,
        entries: {
          ...canonical.state.entries,
          shared: legacy.entries.shared,
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: `duplicate logical request: ${canonicalId}`,
    })
  })

  it('never commits a fresh sidecar when its media group is already owned', () => {
    const item = {
      id: 'media-1',
      platform: 'x' as const,
      postId: '123',
      author: 'alice',
      type: 'photo' as const,
      url: 'https://pbs.twimg.com/media/a.jpg',
      ext: 'jpg',
      index: 0,
    }
    const mainId = mediaRequestId(item)
    const main = request({ id: mainId, item, projectionId: 'main-projection' })
    const sidecarId = sidecarRequestId(item)
    const sidecar = request({
      id: sidecarId,
      projectionId: 'sidecar-projection',
      url: 'data:application/json,{}',
      filename: 'a.json',
      historyPolicy: 'off',
    })
    const owned = prepareLaunches(emptyTransferRegistryStore, [main], 1).state

    const prepared = prepareLaunchGroups(owned, [{ mainId, requests: [main, sidecar] }], 2)

    expect(prepared).toMatchObject({ launches: [], duplicateMainIds: [mainId] })
    expect(prepared.state).toBe(owned)
    expect(prepared.state.entries[sidecarId]).toBeUndefined()
    expect(decodeTransferRegistryStore(prepared.state).ok).toBe(true)
  })

  it('persists Fetched readiness, capacity wait, and the exact armed lease', () => {
    const prepared = prepareLaunches(emptyTransferRegistryStore, [request({ mode: 'fetched' })], 10)
    const token = prepared.launches[0]!
    expect(prepared.state.entries['media-1']?.phase).toEqual({
      tag: 'ready',
      attempt: 0,
      since: 10,
    })
    expect(beginCapacityLaunch(prepared.state, 'media-1', 11)).toEqual({
      state: prepared.state,
      launch: token,
    })
    expect(bindStarted(prepared.state, token, { kind: 'browser', id: 7 }, 11)).toEqual({
      state: prepared.state,
      changed: false,
    })
    const deferred = deferLaunchForCapacity(prepared.state, token, 20)
    expect(deferred.state.entries['media-1']?.phase).toEqual({
      tag: 'fetched-capacity-wait',
      attempt: 0,
      retryAt: 5020,
    })
    expect(decodeTransferRegistryStore(deferred.state)).toEqual({
      ok: true,
      state: deferred.state,
    })
    expect(beginCapacityLaunch(deferred.state, 'media-1', 5019).launch).toBeUndefined()
    const reopened = beginCapacityLaunch(deferred.state, 'media-1', 5020)
    expect(reopened.launch).toEqual({
      id: 'media-1',
      attempt: 0,
      since: 5020,
    })
    expect(reopened.state.entries['media-1']?.phase).toEqual({
      tag: 'ready',
      attempt: 0,
      since: 5020,
    })
    const armed = armFetchedCall(reopened.state, reopened.launch!, 'lease-1', 5021)
    expect(armed.state.entries['media-1']?.phase).toEqual({
      tag: 'fetched-call-armed',
      attempt: 0,
      since: 5020,
      armedAt: 5021,
      leaseId: 'lease-1',
    })
    expect(decodeTransferRegistryStore(armed.state)).toEqual({ ok: true, state: armed.state })
    expect(
      bindStarted(armed.state, reopened.launch!, { kind: 'browser', id: 7 }, 5022).state.entries[
        'media-1'
      ]?.phase,
    ).toMatchObject({ tag: 'active', downloadId: 7 })
  })
  it('recovers only the exact Fetched lease before boot quarantine', () => {
    const prepared = prepareLaunches(emptyTransferRegistryStore, [request({ mode: 'fetched' })], 1)
    const token = prepared.launches[0]!
    const owner = {
      tag: 'transfer' as const,
      requestId: 'media-1',
      projectionId: 'project-media-1',
      attempt: 0,
      since: 1,
    }
    const staging = {
      tag: 'staging' as const,
      leaseId: 'lease-1',
      owner,
    }
    expect(recoverFetchedObservation(prepared.state, staging, 2)).toEqual({
      state: prepared.state,
      changed: false,
      accepted: true,
    })
    expect(quarantineLaunchingOnBoot(prepared.state, 2)).toEqual({
      state: prepared.state,
      changed: false,
    })

    const armed = armFetchedCall(prepared.state, token, 'lease-1', 2).state
    expect(isCurrentLaunch(armed, token)).toBe(true)
    expect(recoverFetchedObservation(armed, { ...staging, leaseId: 'lease-2' }, 3).accepted).toBe(
      false,
    )
    const reopened = recoverFetchedObservation(armed, staging, 3)
    expect(reopened).toMatchObject({
      changed: true,
      accepted: true,
      state: { entries: { 'media-1': { phase: { tag: 'ready', attempt: 0, since: 1 } } } },
    })

    const matched = {
      tag: 'matched' as const,
      leaseId: 'lease-1',
      owner,
      downloadId: 7,
      terminal: false,
    }
    expect(recoverFetchedObservation(armed, { ...matched, leaseId: 'lease-2' }, 3).accepted).toBe(
      false,
    )
    expect(recoverFetchedObservation(armed, matched, 3)).toMatchObject({
      changed: true,
      accepted: true,
      state: { entries: { 'media-1': { phase: { tag: 'active', downloadId: 7 } } } },
    })
    expect(
      recoverFetchedObservation(
        armed,
        { ...matched, terminal: true, terminalState: 'complete' },
        4,
      ),
    ).toMatchObject({
      changed: true,
      accepted: true,
      state: {
        entries: {
          'media-1': {
            phase: {
              tag: 'terminal-pending',
              evidence: { tag: 'browser', downloadId: 7, state: 'complete' },
            },
          },
        },
      },
    })
    expect(quarantineLaunchingOnBoot(armed, 3).state.entries['media-1']?.phase).toEqual({
      tag: 'unresolved-launch',
      attempt: 0,
      since: 1,
      reason: 'worker-restart',
    })
  })
  it('rejects a Fetched observation for a Direct row', () => {
    const prepared = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    expect(
      recoverFetchedObservation(
        prepared.state,
        {
          tag: 'staging',
          leaseId: 'lease-1',
          owner: {
            tag: 'transfer',
            requestId: 'media-1',
            projectionId: 'project-media-1',
            attempt: 0,
            since: 1,
          },
        },
        2,
      ).accepted,
    ).toBe(false)
  })
  it('caps whole stores by UTF-8 bytes before decode, migration, or prepare', () => {
    const exact = { value: 'é' }
    const exactBytes = new TextEncoder().encode(JSON.stringify(exact)).byteLength
    expect(isBoundedJson(exact, exactBytes)).toBe(true)
    expect(isBoundedJson(exact, exactBytes - 1)).toBe(false)
    let getterRead = false
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: () => {
        getterRead = true
        return 'unsafe'
      },
    })
    let deep: unknown = null
    for (let index = 0; index < 129; index += 1) deep = [deep]
    expect(isBoundedJson(accessor, 100)).toBe(false)
    expect(getterRead).toBe(false)
    expect(isBoundedJson(deep, MAX_TRANSFER_REGISTRY_STORE_BYTES)).toBe(false)

    const oversized = 'x'.repeat(MAX_TRANSFER_REGISTRY_STORE_BYTES + 1)
    expect(decodeTransferRegistryStore({ padding: oversized })).toMatchObject({
      ok: false,
      reason: 'registry size',
    })
    const v2 = { version: 2, entries: {}, legacy: {}, padding: oversized }
    expect(decodeV2TransferRegistryStore(v2)).toEqual({
      ok: false,
      reason: 'registry size',
    })
    expect(migrateV2TransferRegistryStore(v2)).toMatchObject({
      ok: false,
      reason: 'registry size',
    })

    const oversizedState = {
      ...emptyTransferRegistryStore,
      entries: {
        old: {
          request: request({
            id: 'old',
            projectionId: 'project-old',
            url: oversized,
          }),
          createdAt: 1,
          phase: { tag: 'launching' as const, attempt: 0, since: 1 },
        },
      },
    }
    expect(() =>
      prepareLaunches(oversizedState, [request({ id: 'new', projectionId: 'project-new' })], 2),
    ).toThrow('registry store size')
  })

  it('lists only redacted uncertain rows and forget unlocks an explicit later save', () => {
    const prepared = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const unresolved = quarantineLaunchingOnBoot(prepared.state, 2).state
    expect(listTransferRecovery(unresolved)).toEqual([
      {
        id: 'media-1',
        kind: 'unresolved-launch',
        mode: 'direct',
        createdAt: 1,
      },
    ])
    expect(JSON.stringify(listTransferRecovery(unresolved))).not.toContain('video.example')
    const forgotten = forgetTransferRecovery(unresolved, 'media-1')
    expect(forgotten.changed).toBe(true)
    expect(
      prepareLaunches(forgotten.state, [request({ projectionId: 'project-new' })], 3).launches,
    ).toHaveLength(1)
    expect(forgetTransferRecovery(prepared.state, 'media-1').changed).toBe(false)
  })
  it('lists only non-Sweep prepared holds and fences their Clear-side forget', () => {
    const direct = prepareLaunchesCore(emptyTransferRegistryStore, [request()], 1)
    expect(listTransferRecovery(direct.state)).toEqual([
      {
        id: 'media-1',
        kind: 'prepared-launch',
        mode: 'direct',
        createdAt: 1,
      },
    ])
    const begun = beginForgetRecovery(direct.state, 'media-1', 2)
    expect(begun.state.entries['media-1']?.phase).toEqual({
      tag: 'forget-pending',
      since: 2,
      recovery: { tag: 'direct-prepared', attempt: 0, since: 1 },
    })
    expect(decodeTransferRegistryStore(begun.state)).toEqual({ ok: true, state: begun.state })

    const aria = prepareLaunchesCore(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    const forgettingAria = beginForgetRecovery(aria.state, 'media-1', 2)
    expect(decodeTransferRegistryStore(forgettingAria.state)).toEqual({
      ok: true,
      state: forgettingAria.state,
    })
    expect(
      completeForgetRecovery(forgettingAria.state, forgettingAria.token!).state.profiles,
    ).toEqual({})

    const swept = prepareLaunchesCore(
      emptyTransferRegistryStore,
      [
        request({
          sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' },
        }),
      ],
      1,
    )
    expect(listTransferRecovery(swept.state)).toEqual([])
    expect(beginForgetRecovery(swept.state, 'media-1', 2)).toEqual({ state: swept.state })

    const hostileSweepForget = {
      ...begun.state,
      entries: {
        'media-1': {
          ...begun.state.entries['media-1']!,
          request: {
            ...begun.state.entries['media-1']!.request,
            sweepReceipt: { receiptId: 'sweep-1', tweetId: '123', scope: 'bookmark' as const },
          },
        },
      },
    }
    expect(decodeTransferRegistryStore(hostileSweepForget).ok).toBe(false)
  })
  it('keeps an aria2 GID owned while its prepared or unresolved forget is pending', () => {
    const prepared = prepareLaunchesCore(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    const armed = armAria2Call(
      permitPreparedLaunches(prepared.state, prepared.launches).state,
      prepared.launches[0]!,
      2,
    ).state
    const unresolved = markAria2CallAmbiguous(armed, prepared.launches[0]!, 3).state
    const collidingRequest = request({
      id: 'media-2',
      projectionId: 'project-media-2',
      mode: 'aria2',
    })
    const collidingReservation = {
      'media-2': { profile, gid: '0000000000000001', options },
    }

    for (const held of [prepared.state, unresolved]) {
      const forgetting = beginForgetRecovery(held, 'media-1', 4)
      expect(decodeTransferRegistryStore(forgetting.state).ok).toBe(true)
      expect(() =>
        prepareLaunchesCore(forgetting.state, [collidingRequest], 5, collidingReservation),
      ).toThrow('duplicate aria2 gid')
    }
  })
  it('lists and forgets every prepared artifact before a grouped save unlocks', () => {
    const item = {
      id: 'media-1',
      platform: 'x' as const,
      postId: '123',
      author: 'alice',
      type: 'photo' as const,
      url: 'https://pbs.twimg.com/media/a.jpg',
      ext: 'jpg',
      index: 0,
    }
    const mainId = mediaRequestId(item)
    const sidecarId = sidecarRequestId(item)
    const main = request({ id: mainId, item, projectionId: 'main-projection' })
    const sidecar = request({
      id: sidecarId,
      projectionId: 'sidecar-projection',
      url: 'data:application/json,{}',
      filename: 'a.json',
      historyPolicy: 'off',
    })
    const groups = [{ mainId, requests: [main, sidecar] }]
    const prepared = prepareLaunchGroups(emptyTransferRegistryStore, groups, 1)

    expect(listTransferRecovery(prepared.state)).toEqual([
      {
        id: mainId,
        kind: 'prepared-launch',
        mode: 'direct',
        createdAt: 1,
      },
      {
        id: sidecarId,
        kind: 'prepared-launch',
        mode: 'direct',
        createdAt: 1,
      },
    ])

    const mainForget = beginForgetRecovery(prepared.state, mainId, 2)
    const sidecarHeld = completeForgetRecovery(mainForget.state, mainForget.token!).state
    expect(prepareLaunchGroups(sidecarHeld, groups, 3)).toMatchObject({
      launches: [],
      duplicateMainIds: [mainId],
    })

    const sidecarForget = beginForgetRecovery(sidecarHeld, sidecarId, 4)
    const cleared = completeForgetRecovery(sidecarForget.state, sidecarForget.token!).state
    expect(prepareLaunchGroups(cleared, groups, 5)).toMatchObject({
      launches: [{ id: mainId }, { id: sidecarId }],
      duplicateMainIds: [],
    })
  })
  it('fences a durable forget until its exact Clear-side completion', () => {
    const prepared = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const unresolved = quarantineLaunchingOnBoot(prepared.state, 2).state
    const begun = beginForgetRecovery(unresolved, 'media-1', 3)
    expect(begun.token).toEqual({
      id: 'media-1',
      projectionId: 'project-media-1',
      createdAt: 1,
      since: 3,
    })
    expect(listTransferRecovery(begun.state)).toEqual([
      {
        id: 'media-1',
        kind: 'forget-pending',
        mode: 'direct',
        createdAt: 1,
      },
    ])
    expect(listPendingForgetRecovery(begun.state)).toEqual([begun.token])
    expect(decodeTransferRegistryStore(begun.state)).toEqual({ ok: true, state: begun.state })
    expect(completeForgetRecovery(begun.state, { ...begun.token!, projectionId: 'stale' })).toEqual(
      { state: begun.state, changed: false },
    )
    expect(quarantineLaunchingOnBoot(begun.state, 4)).toEqual({
      state: begun.state,
      changed: false,
    })
    expect(completeForgetRecovery(begun.state, begun.token!).changed).toBe(true)
  })
  it('rejects forget commands that predate every preserved recovery phase', () => {
    const ariaProfiles = {
      local: { ...profile, failureCount: 0, nextProbeAt: 6 },
    }
    const cases = [
      {
        request: request(),
        recovery: { tag: 'direct-prepared', attempt: 0, since: 6 },
        profiles: {},
      },
      {
        request: request({ mode: 'fetched' }),
        recovery: { tag: 'fetched-prepared', attempt: 0, since: 6 },
        profiles: {},
      },
      {
        request: request({ mode: 'aria2' }),
        recovery: {
          tag: 'aria2-prepared',
          attempt: 0,
          since: 6,
          profileId: 'local',
          gid: '0000000000000001',
          options,
        },
        profiles: ariaProfiles,
      },
      {
        request: request(),
        recovery: {
          tag: 'unresolved-launch',
          attempt: 0,
          since: 6,
          reason: 'worker-restart',
        },
        profiles: {},
      },
      {
        request: request(),
        recovery: {
          tag: 'browser-unresolved',
          attempt: 0,
          since: 6,
          reason: 'worker-restart',
          downloadId: 7,
          nextProbeAt: 7,
        },
        profiles: {},
      },
      {
        request: request({ mode: 'aria2' }),
        recovery: {
          tag: 'aria2-unresolved',
          since: 6,
          reason: 'call-ambiguous',
          profileId: 'local',
          gid: '0000000000000001',
        },
        profiles: ariaProfiles,
      },
    ] as const

    for (const item of cases)
      expect(
        decodeTransferRegistryStore(
          wireStore(
            item.request,
            { tag: 'forget-pending', since: 5, recovery: item.recovery },
            item.profiles,
          ),
        ),
      ).toMatchObject({ ok: false, reason: 'invalid entry: media-1' })
  })
  it('fences a legacy forget across the Clear-side completion', () => {
    const unresolved: TransferRegistryStore = {
      ...emptyTransferRegistryStore,
      legacy: {
        legacy: {
          downloadId: 7,
          startedAt: 1,
          tweetId: 'post-1',
          phase: { tag: 'unresolved' },
        },
      },
    }
    const begun = beginLegacyForgetRecovery(unresolved, 'legacy', 3)
    expect(begun.token).toEqual({
      id: 'legacy',
      downloadId: 7,
      startedAt: 1,
      since: 3,
    })
    expect(listTransferRecovery(begun.state)).toEqual([
      {
        id: 'legacy',
        kind: 'forget-pending',
        mode: 'legacy',
        createdAt: 1,
      },
    ])
    expect(listPendingLegacyForgetRecovery(begun.state)).toEqual([begun.token])
    expect(decodeTransferRegistryStore(begun.state)).toEqual({
      ok: true,
      state: begun.state,
    })
    expect(
      completeLegacyForgetRecovery(begun.state, {
        ...begun.token!,
        downloadId: 8,
      }).changed,
    ).toBe(false)
    expect(completeLegacyForgetRecovery(begun.state, begun.token!).changed).toBe(true)
  })
  it('fences retry URL refresh, launches only after its exact reply, and replays it on boot', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const active = bindStarted(plan.state, plan.launches[0]!, { kind: 'browser', id: 9 }, 2).state
    const waiting = scheduleInterruptedRetry(active, {
      id: 'media-1',
      downloadId: 9,
      retryAt: 4,
    }).state
    expect(claimRetryRefresh(waiting, 'media-1', 3)).toEqual({ state: waiting })
    const claimed = claimRetryRefresh(waiting, 'media-1', 4)
    expect(claimed.token).toEqual({
      id: 'media-1',
      projectionId: 'project-media-1',
      createdAt: 1,
      attempt: 1,
      since: 4,
      priorDownloadId: 9,
    })
    expect(decodeTransferRegistryStore(claimed.state)).toEqual({ ok: true, state: claimed.state })
    expect(
      completeRetryRefresh(
        claimed.state,
        { ...claimed.token!, priorDownloadId: 8 },
        'https://video.example/new.mp4',
        5,
      ),
    ).toEqual({ state: claimed.state })
    const completed = completeRetryRefresh(
      claimed.state,
      claimed.token!,
      'https://video.example/new.mp4',
      5,
    )
    expect(completed.launch).toEqual({ id: 'media-1', attempt: 1, since: 5, priorDownloadId: 9 })
    expect(completed.state.entries['media-1']?.request.url).toBe('https://video.example/new.mp4')
    expect(quarantineLaunchingOnBoot(claimed.state, 6).state.entries['media-1']?.phase).toEqual({
      tag: 'retry-wait',
      attempt: 1,
      retryAt: 6,
      priorDownloadId: 9,
    })
    expect(
      failRetryRefresh(claimed.state, claimed.token!, 5).state.entries['media-1']?.phase,
    ).toMatchObject({
      tag: 'terminal-pending',
      evidence: { tag: 'browser', downloadId: 9, state: 'interrupted' },
    })
  })
  it('requires a profile snapshot before an aria2 launch', () => {
    expect(() =>
      prepareLaunches(emptyTransferRegistryStore, [request({ mode: 'aria2' })], 1),
    ).toThrow('reservation required')
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    expect(plan.state.profiles.local).toMatchObject({
      ...profile,
      failureCount: 0,
      nextProbeAt: 1,
    })
    expect(plan.state.entries['media-1']?.phase).toEqual({
      tag: 'aria2-ready',
      attempt: 0,
      since: 1,
      profileId: 'local',
      gid: '0000000000000001',
      options,
    })
  })

  it('arms before addUri, then binds to active, never terminal', () => {
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    const armed = armAria2Call(plan.state, plan.launches[0]!, 2).state
    expect(armed.entries['media-1']?.phase).toMatchObject({
      tag: 'aria2-call-armed',
      armedAt: 2,
    })
    const next = bindStarted(
      armed,
      plan.launches[0]!,
      { kind: 'aria2', gid: '0000000000000001' },
      3,
    ).state
    expect(next.entries['media-1']?.phase).toEqual({
      tag: 'aria2-active',
      gid: '0000000000000001',
      profileId: 'local',
      startedAt: 3,
    })
  })

  it('requires a canonical nonzero reservation and scopes GID uniqueness to one endpoint', () => {
    expect(() =>
      prepareLaunches(emptyTransferRegistryStore, [request({ mode: 'aria2' })], 1, {
        'media-1': { profile, gid: '0000000000000000', options },
      }),
    ).toThrow('invalid aria2 reservation')
    for (const rpcUrl of [
      'not-a-url',
      'ftp://example.com/jsonrpc',
      'http://user:password@example.com/jsonrpc',
    ])
      expect(() =>
        prepareLaunches(emptyTransferRegistryStore, [request({ mode: 'aria2' })], 1, {
          'media-1': {
            profile: { ...profile, rpcUrl },
            gid: '0000000000000001',
            options,
          },
        }),
      ).toThrow('invalid aria2 reservation')
    expect(() =>
      prepareLaunches(emptyTransferRegistryStore, [request({ mode: 'aria2' })], 1, {
        'media-1': {
          profile: { ...profile, profileId: 'toString' },
          gid: '0000000000000001',
          options,
        },
      }),
    ).toThrow('invalid aria2 reservation')
    const duplicateProfile = { ...profile, profileId: 'duplicate' }
    expect(() =>
      prepareLaunches(
        emptyTransferRegistryStore,
        [
          request({ id: 'a', projectionId: 'project-a', mode: 'aria2' }),
          request({ id: 'b', projectionId: 'project-b', mode: 'aria2' }),
        ],
        1,
        {
          a: { profile, gid: '0000000000000001', options },
          b: { profile: duplicateProfile, gid: '0000000000000002', options },
        },
      ),
    ).toThrow('already owned by local')
    const other = {
      ...profile,
      profileId: 'other',
      rpcUrl: 'http://127.0.0.1:6801/jsonrpc',
    }
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [
        request({ id: 'a', projectionId: 'project-a', mode: 'aria2' }),
        request({ id: 'b', projectionId: 'project-b', mode: 'aria2' }),
      ],
      1,
      {
        a: { profile, gid: '0000000000000001', options },
        b: { profile: other, gid: '0000000000000001', options },
      },
    )
    expect(Object.keys(plan.state.profiles)).toEqual(['local', 'other'])
    expect(() =>
      prepareLaunches(
        emptyTransferRegistryStore,
        [
          request({ id: 'a', projectionId: 'project-a', mode: 'aria2' }),
          request({ id: 'b', projectionId: 'project-b', mode: 'aria2' }),
        ],
        1,
        {
          a: {
            profile: { ...profile, rpcUrl: 'HTTP://EXAMPLE.COM:80/jsonrpc' },
            gid: '0000000000000001',
            options,
          },
          b: {
            profile: {
              ...profile,
              profileId: 'alias',
              rpcUrl: 'http://example.com/jsonrpc',
              secret: 'different',
            },
            gid: '0000000000000001',
            options,
          },
        },
      ),
    ).toThrow('duplicate aria2 gid')
  })

  it('records strict aria2 progress and terminal evidence', () => {
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    const active = bindStarted(
      armAria2Call(plan.state, plan.launches[0]!, 2).state,
      plan.launches[0]!,
      { kind: 'aria2', gid: '0000000000000001' },
      3,
    ).state
    expect(() =>
      recordAria2Progress(active, {
        id: 'media-1',
        gid: '0000000000000001',
        profileId: 'local',
        status: 'active',
        observedAt: 4,
        completedLength: '01',
        totalLength: '10',
      }),
    ).toThrow('invalid aria2 progress')
    expect(() =>
      recordAria2Progress(active, {
        id: 'media-1',
        gid: '0000000000000001',
        profileId: 'local',
        status: 'active',
        observedAt: 4,
        completedLength: '1'.repeat(33),
        totalLength: '10',
      }),
    ).toThrow('invalid aria2 progress')
    expect(() =>
      recordAria2Progress(active, {
        id: 'media-1',
        gid: '0000000000000001',
        profileId: 'local',
        status: 'active',
        observedAt: 4,
        completedLength: '1',
      }),
    ).toThrow('invalid aria2 progress')
    const terminal = recordAria2Terminal(active, {
      id: 'media-1',
      gid: '0000000000000001',
      profileId: 'local',
      status: 'complete',
      completedLength: '10',
      totalLength: '10',
      observedAt: 3,
    }).state
    const phase = terminal.entries['media-1']?.phase
    expect(phase).toMatchObject({
      tag: 'terminal-pending',
      observedAt: 3,
      evidence: { tag: 'aria2', gid: '0000000000000001', status: 'complete' },
    })
    expect(
      terminalOutcome((phase as Extract<typeof phase, { tag: 'terminal-pending' }>).evidence),
    ).toBe('complete')
    expect(() =>
      recordAria2Terminal(active, {
        id: 'media-1',
        gid: '0000000000000001',
        profileId: 'local',
        status: 'unknown' as never,
        completedLength: '10',
        totalLength: '10',
        observedAt: 3,
      }),
    ).toThrow('invalid aria2 terminal')
    expect(() =>
      recordAria2Terminal(active, {
        id: 'media-1',
        gid: '0000000000000001',
        profileId: 'local',
        status: 'error',
        completedLength: '1',
        totalLength: '1',
        observedAt: 3,
        errorCode: '1'.repeat(33),
      }),
    ).toThrow('invalid aria2 terminal')
    expect(() =>
      recordAria2Terminal(active, {
        id: 'media-1',
        gid: '0000000000000001',
        profileId: 'local',
        status: 'error',
        completedLength: '1',
        totalLength: '1',
        observedAt: 3,
        errorMessage: 'x'.repeat(1025),
      }),
    ).toThrow('invalid aria2 terminal')
  })

  it('keeps browser retry semantics and exact browser receipts', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const active = bindStarted(plan.state, plan.launches[0]!, { kind: 'browser', id: 9 }, 2).state
    const retry = scheduleInterruptedRetry(active, {
      id: 'media-1',
      downloadId: 9,
      retryAt: 4,
    }).state
    expect(retry.entries['media-1']?.phase).toEqual({
      tag: 'retry-wait',
      attempt: 1,
      retryAt: 4,
      priorDownloadId: 9,
    })
    const complete = recordBrowserTerminal(active, {
      id: 'media-1',
      downloadId: 9,
      state: 'complete',
      bytesReceived: 42,
      totalBytes: 64,
      observedAt: 5,
    }).state
    expect(complete.entries['media-1']?.phase).toMatchObject({
      evidence: {
        tag: 'browser',
        downloadId: 9,
        state: 'complete',
        bytesReceived: 42,
        totalBytes: 64,
      },
    })
    expect(
      recordBrowserTerminal(active, {
        id: 'media-1',
        downloadId: 9,
        state: 'unknown' as never,
        observedAt: 5,
      }),
    ).toEqual({ state: active, changed: false })
  })

  it('enriches only the exact pending browser terminal fence', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const active = bindStarted(plan.state, plan.launches[0]!, { kind: 'browser', id: 9 }, 2).state
    const terminal = recordBrowserTerminal(active, {
      id: 'media-1',
      downloadId: 9,
      state: 'complete',
      observedAt: 5,
    }).state
    const fence = {
      id: 'media-1',
      createdAt: 1,
      downloadId: 9,
      state: 'complete' as const,
      observedAt: 5,
    }
    const enriched = enrichBrowserTerminal(terminal, {
      ...fence,
      bytesReceived: 42,
      totalBytes: 64,
    })
    expect(enriched.state.entries['media-1']?.phase).toMatchObject({
      tag: 'terminal-pending',
      evidence: {
        tag: 'browser',
        downloadId: 9,
        state: 'complete',
        bytesReceived: 42,
        totalBytes: 64,
      },
      observedAt: 5,
      projectAt: 5,
    })
    for (const stale of [
      { ...fence, createdAt: 2, bytesReceived: 99 },
      { ...fence, downloadId: 10, bytesReceived: 99 },
      { ...fence, state: 'interrupted' as const, bytesReceived: 99 },
      { ...fence, observedAt: 6, bytesReceived: 99 },
    ])
      expect(enrichBrowserTerminal(terminal, stale)).toEqual({
        state: terminal,
        changed: false,
      })
  })

  it('reschedules definite browser launch failures, then terminalizes at the bound', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const active = bindStarted(plan.state, plan.launches[0]!, { kind: 'browser', id: 9 }, 2).state
    let retry = scheduleInterruptedRetry(active, {
      id: 'media-1',
      downloadId: 9,
      retryAt: 4,
    }).state
    for (const expectedAttempt of [2, 3]) {
      const retryAt = retry.entries['media-1']?.phase
      if (retryAt?.tag !== 'retry-wait') throw new Error('expected retry wait')
      const begun = beginRetryLaunch(retry, 'media-1', retryAt.retryAt)
      expect(begun.launch).toMatchObject({
        attempt: expectedAttempt - 1,
        priorDownloadId: 9,
      })
      retry = rescheduleRetryLaunchFailure(begun.state, begun.launch!, retryAt.retryAt).state
      expect(retry.entries['media-1']?.phase).toMatchObject({
        tag: 'retry-wait',
        attempt: expectedAttempt,
        priorDownloadId: 9,
      })
    }
    const retryAt = retry.entries['media-1']?.phase
    if (retryAt?.tag !== 'retry-wait') throw new Error('expected retry wait')
    const begun = beginRetryLaunch(retry, 'media-1', retryAt.retryAt)
    const terminal = rescheduleRetryLaunchFailure(begun.state, begun.launch!, retryAt.retryAt).state
    expect(terminal.entries['media-1']?.phase).toMatchObject({
      tag: 'terminal-pending',
      evidence: { tag: 'browser', downloadId: 9, state: 'interrupted' },
    })
  })

  it('keeps exact browser evidence when retry preparation fails', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const active = bindStarted(plan.state, plan.launches[0]!, { kind: 'browser', id: 9 }, 2).state
    const retry = scheduleInterruptedRetry(active, {
      id: 'media-1',
      downloadId: 9,
      retryAt: 4,
    }).state
    expect(failRetryWait(retry, 'media-1', 5).state.entries['media-1']?.phase).toMatchObject({
      tag: 'terminal-pending',
      evidence: { tag: 'browser', downloadId: 9, state: 'interrupted' },
    })
    expect(
      rejectStart(plan.state, plan.launches[0]!, 2).state.entries['media-1']?.phase,
    ).toMatchObject({
      tag: 'terminal-pending',
      evidence: { tag: 'start-failed' },
    })
  })

  it('keeps the prior browser evidence when a retry start definitely fails', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const active = bindStarted(plan.state, plan.launches[0]!, { kind: 'browser', id: 9 }, 2).state
    const retry = scheduleInterruptedRetry(active, {
      id: 'media-1',
      downloadId: 9,
      retryAt: 4,
    }).state
    const begun = beginRetryLaunch(retry, 'media-1', 4)

    expect(
      failRetryStart(begun.state, begun.launch!, 5).state.entries['media-1']?.phase,
    ).toMatchObject({
      tag: 'terminal-pending',
      evidence: { tag: 'browser', downloadId: 9, state: 'interrupted' },
    })
  })

  it('waits until due and requires a distinct retry handle', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const active = bindStarted(plan.state, plan.launches[0]!, { kind: 'browser', id: 9 }, 2).state
    const retry = scheduleInterruptedRetry(active, {
      id: 'media-1',
      downloadId: 9,
      retryAt: 10,
    }).state
    expect(beginRetryLaunch(retry, 'media-1', 9)).toEqual({ state: retry })
    const begun = beginRetryLaunch(retry, 'media-1', 10)
    expect(begun.state.entries['media-1']?.phase).toEqual({
      tag: 'retry-launching',
      attempt: 1,
      since: 10,
      priorDownloadId: 9,
    })
    expect(() => bindStarted(begun.state, begun.launch!, { kind: 'browser', id: 9 }, 11)).toThrow(
      'reused prior downloadId',
    )
    expect(
      bindStarted(begun.state, begun.launch!, { kind: 'browser', id: 10 }, 11).state.entries[
        'media-1'
      ]?.phase,
    ).toEqual({
      tag: 'active',
      downloadId: 10,
      attempt: 1,
      startedAt: 11,
      nextProbeAt: 11,
    })
  })

  it('saturates computed deadlines at MAX_SAFE_INTEGER', () => {
    const atMax = Number.MAX_SAFE_INTEGER
    const browser = prepareLaunches(emptyTransferRegistryStore, [request()], atMax)
    const active = bindStarted(
      browser.state,
      browser.launches[0]!,
      { kind: 'browser', id: 9 },
      atMax,
    ).state
    const retry = scheduleInterruptedRetry(active, {
      id: 'media-1',
      downloadId: 9,
      retryAt: atMax,
    }).state
    const begun = beginRetryLaunch(retry, 'media-1', atMax)
    expect(
      rescheduleRetryLaunchFailure(begun.state, begun.launch!, atMax).state.entries['media-1']
        ?.phase,
    ).toMatchObject({ tag: 'retry-wait', retryAt: atMax, priorDownloadId: 9 })
    expect(
      planActiveReconciliation(active, {
        rowsByDownloadId: new Map([[9, { state: 'interrupted', error: 'NETWORK_FAILED' }]]),
        threwDownloadIds: new Set(),
        now: atMax,
      }).state.entries['media-1']?.phase,
    ).toMatchObject({ tag: 'retry-wait', retryAt: atMax })
    const aria = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      atMax,
      reservation,
    ).state
    expect(recordAria2ProfileUnavailable(aria, 'local', atMax).state.profiles.local).toMatchObject({
      nextProbeAt: atMax,
      failureCount: 1,
    })
  })

  it('keeps valid boot bytes and omits Chrome unknown bytes on terminal reconciliation', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const active = bindStarted(plan.state, plan.launches[0]!, { kind: 'browser', id: 9 }, 2).state
    const complete = planActiveReconciliation(active, {
      rowsByDownloadId: new Map([[9, { state: 'complete', bytesReceived: 42, totalBytes: 64 }]]),
      threwDownloadIds: new Set(),
      now: 3,
    }).state
    expect(complete.entries['media-1']?.phase).toMatchObject({
      evidence: { tag: 'browser', bytesReceived: 42, totalBytes: 64 },
    })
    const interrupted = planActiveReconciliation(active, {
      rowsByDownloadId: new Map([
        [
          9,
          {
            state: 'interrupted',
            error: 'USER_CANCELED',
            bytesReceived: 42,
            totalBytes: -1,
          },
        ],
      ]),
      threwDownloadIds: new Set(),
      now: 3,
    }).state
    expect(interrupted.entries['media-1']?.phase).toMatchObject({
      evidence: { tag: 'browser', state: 'interrupted', bytesReceived: 42 },
    })
    expect(interrupted.entries['media-1']?.phase).not.toMatchObject({
      evidence: { totalBytes: expect.anything() },
    })
  })

  it('reattaches only an exact unresolved browser handle after boot proof', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const unresolved = resolveUntrackedStart(plan.state, plan.launches[0]!, 2, {
      kind: 'browser',
      id: 9,
    }).state
    expect(unresolved.entries['media-1']?.phase).toMatchObject({
      tag: 'browser-unresolved',
      downloadId: 9,
      nextProbeAt: 2,
    })
    const deferred = deferUnresolvedBrowserProbe(unresolved, {
      id: 'media-1',
      downloadId: 9,
      nextProbeAt: 8,
    }).state
    expect(deferred.entries['media-1']?.phase).toMatchObject({
      nextProbeAt: 8,
    })
    expect(
      recordBrowserLive(unresolved, {
        id: 'media-1',
        downloadId: 10,
        observedAt: 3,
      }),
    ).toEqual({
      state: unresolved,
      changed: false,
    })
    const live = recordBrowserLive(unresolved, {
      id: 'media-1',
      downloadId: 9,
      observedAt: 3,
    }).state
    expect(live.entries['media-1']?.phase).toEqual({
      tag: 'active',
      downloadId: 9,
      attempt: 0,
      startedAt: 3,
      nextProbeAt: 3,
    })
    expect(decodeTransferRegistryStore(live)).toEqual({
      ok: true,
      state: live,
    })
  })

  it('rejects duplicate handles while recording an untracked browser start', () => {
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [
        request({ id: 'a', projectionId: 'project-a' }),
        request({ id: 'b', projectionId: 'project-b' }),
      ],
      1,
    )
    const first = bindStarted(
      plan.state,
      plan.launches.find((token) => token.id === 'a')!,
      { kind: 'browser', id: 9 },
      2,
    ).state
    expect(() =>
      resolveUntrackedStart(first, plan.launches.find((token) => token.id === 'b')!, 2, {
        kind: 'browser',
        id: 9,
      }),
    ).toThrow('duplicate browser downloadId')
  })

  it('uses exact start-failed evidence and preserves projection deadlines', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const failed = rejectStart(plan.state, plan.launches[0]!, 2).state
    expect(failed.entries['media-1']?.phase).toEqual({
      tag: 'terminal-pending',
      evidence: { tag: 'start-failed' },
      observedAt: 2,
      projectAt: 2,
    })
    expect(
      deferTerminalProjection(failed, 'media-1', 8).state.entries['media-1']?.phase,
    ).toMatchObject({ projectAt: 8 })
  })

  it('keeps no-handle browser ambiguity deadline-free across boot', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const booted = quarantineLaunchingOnBoot(plan.state, 2).state
    expect(booted.entries['media-1']?.phase).toEqual({
      tag: 'unresolved-launch',
      attempt: 0,
      since: 1,
      reason: 'worker-restart',
    })
    expect(decodeTransferRegistryStore(booted)).toEqual({
      ok: true,
      state: booted,
    })
  })

  it('rebases rollback-stranded boot work by phase without reopening ambiguous handoffs', () => {
    const old = 1_000_000
    const now = 10
    const store: TransferRegistryStore = {
      version: 4,
      entries: {
        capacity: {
          request: request({ id: 'capacity', projectionId: 'project-capacity', mode: 'fetched' }),
          createdAt: old,
          phase: { tag: 'fetched-capacity-wait', attempt: 0, retryAt: old },
        },
        retry: {
          request: request({ id: 'retry', projectionId: 'project-retry' }),
          createdAt: old,
          phase: { tag: 'retry-wait', attempt: 1, retryAt: old, priorDownloadId: 7 },
        },
        active: {
          request: request({ id: 'active', projectionId: 'project-active' }),
          createdAt: old,
          phase: { tag: 'active', downloadId: 8, attempt: 0, startedAt: old, nextProbeAt: old },
        },
        unresolved: {
          request: request({ id: 'unresolved', projectionId: 'project-unresolved' }),
          createdAt: old,
          phase: {
            tag: 'browser-unresolved',
            attempt: 0,
            since: old,
            reason: 'worker-restart',
            downloadId: 9,
            nextProbeAt: old,
          },
        },
        terminal: {
          request: request({ id: 'terminal', projectionId: 'project-terminal' }),
          createdAt: old,
          phase: {
            tag: 'terminal-pending',
            evidence: { tag: 'start-failed' },
            observedAt: old,
            projectAt: old,
          },
        },
        ready: {
          request: request({ id: 'ready', projectionId: 'project-ready' }),
          createdAt: old,
          phase: { tag: 'direct-ready', attempt: 0, since: old },
        },
        armed: {
          request: request({ id: 'armed', projectionId: 'project-armed' }),
          createdAt: old,
          phase: { tag: 'launching', attempt: 0, since: old },
        },
        aria: {
          request: request({ id: 'aria', projectionId: 'project-aria', mode: 'aria2' }),
          createdAt: old,
          phase: {
            tag: 'aria2-active',
            gid: '0000000000000001',
            profileId: 'local',
            startedAt: old,
          },
        },
        forgetting: {
          request: request({ id: 'forgetting', projectionId: 'project-forgetting' }),
          createdAt: old,
          phase: {
            tag: 'forget-pending',
            since: old,
            recovery: {
              tag: 'browser-unresolved',
              attempt: 0,
              since: old,
              reason: 'worker-restart',
              downloadId: 10,
              nextProbeAt: old,
            },
          },
        },
      },
      profiles: {
        local: {
          ...profile,
          failureCount: 3,
          nextProbeAt: old,
        },
      },
      legacy: {
        'legacy-active': {
          downloadId: 11,
          startedAt: old,
          phase: { tag: 'active', nextProbeAt: old },
        },
        'legacy-terminal': {
          downloadId: 12,
          startedAt: old,
          phase: { tag: 'terminal-pending', outcome: 'complete', at: old, projectAt: old },
        },
        'legacy-forgetting': {
          downloadId: 13,
          startedAt: old,
          phase: { tag: 'forget-pending', since: old },
        },
      },
    }
    const quarantined = quarantineLaunchingOnBoot(store, now).state
    const rebased = rebaseClockRollbackOnBoot(quarantined, now)

    expect(rebased.changed).toBe(true)
    expect(rebased.state.entries.capacity?.phase).toMatchObject({ retryAt: now + 5_000 })
    expect(rebased.state.entries.retry?.phase).toMatchObject({ retryAt: now + 2_000 })
    expect(rebased.state.entries.active?.phase).toMatchObject({ startedAt: now, nextProbeAt: now })
    expect(rebased.state.entries.unresolved?.phase).toMatchObject({ since: now, nextProbeAt: now })
    expect(rebased.state.entries.terminal?.phase).toMatchObject({ observedAt: now, projectAt: now })
    expect(rebased.state.entries.ready?.phase).toMatchObject({ since: now })
    expect(rebased.state.entries.armed?.phase).toEqual({
      tag: 'unresolved-launch',
      attempt: 0,
      since: now,
      reason: 'worker-restart',
    })
    expect(rebased.state.entries.aria?.phase).toMatchObject({ startedAt: now })
    expect(rebased.state.entries.forgetting?.phase).toMatchObject({
      since: now,
      recovery: { since: now, nextProbeAt: now },
    })
    expect(rebased.state.profiles.local).toMatchObject({ failureCount: 3, nextProbeAt: now })
    expect(rebased.state.legacy['legacy-active']).toMatchObject({
      startedAt: now,
      phase: { tag: 'active', nextProbeAt: now },
    })
    expect(rebased.state.legacy['legacy-terminal']?.phase).toMatchObject({
      at: now,
      projectAt: now,
    })
    expect(rebased.state.legacy['legacy-forgetting']?.phase).toMatchObject({ since: now })
    expect(decodeTransferRegistryStore(rebased.state)).toEqual({ ok: true, state: rebased.state })
  })

  it('backs off profiles, resets a probe circuit, and prunes only after ack', () => {
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    const unavailable = recordAria2ProfileUnavailable(plan.state, 'local', 5).state
    expect(unavailable.profiles.local).toMatchObject({
      failureCount: 1,
      nextProbeAt: 1005,
    })
    const claimed = deferAria2ProfileProbe(unavailable, 'local', 1500).state
    expect(claimed.profiles.local).toMatchObject({
      failureCount: 1,
      nextProbeAt: 1500,
    })
    const recovered = recordAria2ProfileProbeSuccess(claimed, 'local', 2000).state
    expect(recovered.profiles.local).toMatchObject({
      failureCount: 0,
      nextProbeAt: 2000,
    })
    const active = bindStarted(
      armAria2Call(recovered, plan.launches[0]!, 2).state,
      plan.launches[0]!,
      { kind: 'aria2', gid: '0000000000000001' },
      3,
    ).state
    const ended = recordAria2Terminal(active, {
      id: 'media-1',
      gid: '0000000000000001',
      profileId: 'local',
      status: 'removed',
      completedLength: '0',
      totalLength: '0',
      observedAt: 3,
    }).state
    expect(ackTerminal(ended, 'media-1').state.profiles).toEqual({})
  })

  it('replays ready aria2 intent on boot, but quarantines an armed call', () => {
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    const ready = quarantineLaunchingOnBoot(plan.state, 9).state
    expect(ready.entries['media-1']?.phase).toEqual(plan.state.entries['media-1']?.phase)
    expect(ready.profiles).toEqual(plan.state.profiles)
    expect(decodeTransferRegistryStore(ready).ok).toBe(true)
    const armed = armAria2Call(plan.state, plan.launches[0]!, 2).state
    expect(quarantineLaunchingOnBoot(armed, 9).state.entries['media-1']?.phase).toEqual({
      tag: 'aria2-unresolved',
      since: 2,
      reason: 'call-ambiguous',
      profileId: 'local',
      gid: '0000000000000001',
    })
    const legacyLaunching: TransferRegistryStore = {
      ...plan.state,
      entries: {
        'media-1': {
          ...plan.state.entries['media-1']!,
          phase: {
            tag: 'aria2-launching',
            attempt: 0,
            since: 1,
            profileId: 'local',
            gid: '0000000000000001',
          },
        },
      },
    }
    expect(
      quarantineLaunchingOnBoot(legacyLaunching, 9).state.entries['media-1']?.phase,
    ).toMatchObject({
      tag: 'terminal-pending',
      evidence: { tag: 'start-failed' },
    })
  })

  it('only terminalizes an unarmed aria2 failure and otherwise quarantines it', () => {
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    const rejected = rejectStart(plan.state, plan.launches[0]!, 2).state
    expect(rejected.entries['media-1']?.phase).toMatchObject({
      tag: 'terminal-pending',
      evidence: { tag: 'start-failed' },
    })
    expect(rejected.profiles).toEqual({})
    expect(decodeTransferRegistryStore(rejected).ok).toBe(true)
    const armed = armAria2Call(plan.state, plan.launches[0]!, 2).state
    expect(rejectStart(armed, plan.launches[0]!, 3)).toEqual({
      state: armed,
      changed: false,
    })
    const ambiguous = markAria2CallAmbiguous(armed, plan.launches[0]!, 3).state
    expect(ambiguous.entries['media-1']?.phase).toMatchObject({
      tag: 'aria2-unresolved',
      reason: 'call-ambiguous',
      profileId: 'local',
      gid: '0000000000000001',
    })
    expect(
      markAria2ConfirmedUnbound(armed, plan.launches[0]!, 3).state.entries['media-1']?.phase,
    ).toMatchObject({
      tag: 'aria2-unresolved',
      reason: 'confirmed-unbound',
    })
    expect(
      recordAria2Progress(ambiguous, {
        id: 'media-1',
        gid: '0000000000000001',
        profileId: 'local',
        status: 'active',
        observedAt: 4,
        completedLength: '1',
        totalLength: '2',
      }).state.entries['media-1']?.phase,
    ).toMatchObject({
      tag: 'aria2-active',
      startedAt: 4,
      progress: { completedLength: '1' },
    })
    expect(
      recordAria2Terminal(ambiguous, {
        id: 'media-1',
        gid: '0000000000000001',
        profileId: 'local',
        status: 'complete',
        completedLength: '2',
        totalLength: '2',
        observedAt: 4,
      }).state.entries['media-1']?.phase,
    ).toMatchObject({
      tag: 'terminal-pending',
      evidence: { tag: 'aria2', status: 'complete' },
    })
  })

  it('accepts only the exact retry Fetched owner and rejects the old handle', () => {
    const prepared = prepareLaunches(emptyTransferRegistryStore, [request({ mode: 'fetched' })], 1)
    const initial = bindStarted(
      armFetchedCall(prepared.state, prepared.launches[0]!, 'lease-0', 1).state,
      prepared.launches[0]!,
      { kind: 'browser', id: 7 },
      2,
    ).state
    const waiting = scheduleInterruptedRetry(initial, {
      id: 'media-1',
      downloadId: 7,
      retryAt: 3,
    }).state
    const retry = beginRetryLaunch(waiting, 'media-1', 3)
    const capacity = deferLaunchForCapacity(retry.state, retry.launch!, 4).state
    expect(capacity.entries['media-1']?.phase).toEqual({
      tag: 'fetched-capacity-wait',
      attempt: 1,
      retryAt: 5004,
      priorDownloadId: 7,
    })
    const reopened = beginCapacityLaunch(capacity, 'media-1', 5004)
    const armed = armFetchedCall(reopened.state, reopened.launch!, 'lease-1', 5004).state
    expect(decodeTransferRegistryStore(armed)).toEqual({ ok: true, state: armed })
    const owner = {
      tag: 'transfer' as const,
      requestId: 'media-1',
      projectionId: 'project-media-1',
      attempt: 1,
      since: 5004,
      priorDownloadId: 7,
    }
    expect(
      recoverFetchedObservation(
        armed,
        {
          tag: 'matched',
          leaseId: 'lease-1',
          owner,
          downloadId: 7,
          terminal: false,
        },
        5005,
      ).accepted,
    ).toBe(false)
    expect(
      recoverFetchedObservation(
        armed,
        {
          tag: 'matched',
          leaseId: 'lease-1',
          owner,
          downloadId: 8,
          terminal: false,
        },
        5005,
      ).state.entries['media-1']?.phase,
    ).toMatchObject({ tag: 'active', downloadId: 8, attempt: 1 })
  })
})

describe('v4 strict codec', () => {
  it('normalizes pre-arm Fetched v3 phases without reopening an ambiguous call', () => {
    const prepared = prepareLaunches(emptyTransferRegistryStore, [request({ mode: 'fetched' })], 1)
    const oldLaunching = structuredClone(prepared.state) as unknown as {
      entries: { 'media-1': { phase: unknown } }
    }
    oldLaunching.entries['media-1'].phase = { tag: 'launching', attempt: 0, since: 1 }
    expect(decodeTransferRegistryStore(oldLaunching)).toMatchObject({
      ok: true,
      state: {
        entries: {
          'media-1': {
            phase: {
              tag: 'unresolved-launch',
              attempt: 0,
              since: 1,
              reason: 'worker-restart',
            },
          },
        },
      },
    })

    const oldWait = structuredClone(prepared.state) as unknown as {
      entries: { 'media-1': { phase: unknown } }
    }
    oldWait.entries['media-1'].phase = { tag: 'launch-wait', attempt: 0, retryAt: 5 }
    expect(decodeTransferRegistryStore(oldWait)).toMatchObject({
      ok: true,
      state: {
        entries: {
          'media-1': {
            phase: { tag: 'fetched-capacity-wait', attempt: 0, retryAt: 5 },
          },
        },
      },
    })
  })

  it('rejects malformed, wrong-mode, or duplicate Fetched lease phases', () => {
    type RawFetchedStore = {
      entries: Record<
        string,
        {
          request: { mode: string }
          phase: {
            armedAt: number
            leaseId: string
            extra?: boolean
          }
        }
      >
    }
    const prepared = prepareLaunches(
      emptyTransferRegistryStore,
      [
        request({ id: 'a', projectionId: 'project-a', mode: 'fetched' }),
        request({ id: 'b', projectionId: 'project-b', mode: 'fetched' }),
      ],
      1,
    )
    const first = armFetchedCall(prepared.state, prepared.launches[0]!, 'lease-a', 2).state
    const armed = armFetchedCall(first, prepared.launches[1]!, 'lease-b', 2).state
    expect(decodeTransferRegistryStore(armed)).toEqual({ ok: true, state: armed })

    for (const mutate of [
      (raw: RawFetchedStore) => {
        raw.entries.a!.request.mode = 'direct'
      },
      (raw: RawFetchedStore) => {
        raw.entries.a!.phase.armedAt = 0
      },
      (raw: RawFetchedStore) => {
        raw.entries.a!.phase.extra = true
      },
      (raw: RawFetchedStore) => {
        raw.entries.b!.phase.leaseId = 'lease-a'
      },
    ]) {
      const raw = structuredClone(armed) as unknown as RawFetchedStore
      mutate(raw)
      expect(decodeTransferRegistryStore(raw).ok).toBe(false)
    }
  })

  it('accepts exact field bounds and rejects oversized durable request or profile fields', () => {
    const bounded = request({
      id: 'i'.repeat(MAX_TRANSFER_REGISTRY_ID_LENGTH),
      projectionId: 'receipt',
      url: `https://x/${'u'.repeat(MAX_TRANSFER_REGISTRY_URL_LENGTH - 10)}`,
      filename: 'f'.repeat(MAX_TRANSFER_REGISTRY_FILENAME_LENGTH),
    })
    const valid = prepareLaunches(emptyTransferRegistryStore, [bounded], 1).state
    expect(decodeTransferRegistryStore(valid).ok).toBe(true)

    const oversizedStore = JSON.parse(JSON.stringify(valid)) as {
      entries: { [key: string]: { request: { filename: string } } }
    }
    oversizedStore.entries[bounded.id]!.request.filename = 'f'.repeat(
      MAX_TRANSFER_REGISTRY_FILENAME_LENGTH + 1,
    )
    expect(decodeTransferRegistryStore(oversizedStore).ok).toBe(false)

    const oversizedItem = JSON.parse(JSON.stringify(valid)) as {
      entries: {
        [key: string]: { request: { item?: Record<string, unknown> } }
      }
    }
    oversizedItem.entries[bounded.id]!.request.item = {
      id: bounded.id,
      platform: 'x',
      postId: 'post-1',
      author: 'a'.repeat(MAX_TRANSFER_REGISTRY_MEDIA_ITEM_BYTES),
      type: 'photo',
      url: 'https://x/a.jpg',
      ext: 'jpg',
      index: 0,
    }
    expect(decodeTransferRegistryStore(oversizedItem).ok).toBe(false)

    expect(() =>
      prepareLaunches(
        emptyTransferRegistryStore,
        [request({ url: 'u'.repeat(MAX_TRANSFER_REGISTRY_URL_LENGTH + 1) })],
        1,
      ),
    ).toThrow('invalid new request')
    expect(() =>
      prepareLaunches(emptyTransferRegistryStore, [request({ mode: 'aria2' })], 1, {
        'media-1': {
          profile: {
            ...profile,
            rpcUrl: 'r'.repeat(MAX_ARIA2_PROFILE_RPC_URL_LENGTH + 1),
            secret: 's'.repeat(MAX_ARIA2_PROFILE_SECRET_LENGTH + 1),
          },
          gid: '0000000000000001',
          options,
        },
      }),
    ).toThrow('invalid aria2 reservation')
  })

  it('rejects duplicate aria2 credential snapshots without leaking secrets', () => {
    const other = {
      ...profile,
      profileId: 'other',
      rpcUrl: 'http://127.0.0.1:6801/jsonrpc',
    }
    const valid = prepareLaunches(
      emptyTransferRegistryStore,
      [
        request({ id: 'a', projectionId: 'project-a', mode: 'aria2' }),
        request({ id: 'b', projectionId: 'project-b', mode: 'aria2' }),
      ],
      1,
      {
        a: { profile, gid: '0000000000000001', options },
        b: { profile: other, gid: '0000000000000001', options },
      },
    ).state
    const duplicate = JSON.parse(JSON.stringify(valid)) as {
      profiles: { other: { rpcUrl: string; secret: string } }
    }
    duplicate.profiles.other.rpcUrl = profile.rpcUrl
    duplicate.profiles.other.secret = profile.secret
    const decoded = decodeTransferRegistryStore(duplicate)
    expect(decoded.ok).toBe(false)
    expect(JSON.stringify(decoded)).not.toContain(profile.secret)
  })

  it('rejects duplicate aria2 GIDs across canonical endpoint aliases on decode', () => {
    const valid = prepareLaunches(
      emptyTransferRegistryStore,
      [
        request({ id: 'a', projectionId: 'project-a', mode: 'aria2' }),
        request({ id: 'b', projectionId: 'project-b', mode: 'aria2' }),
      ],
      1,
      {
        a: {
          profile: { ...profile, rpcUrl: 'http://example.com/jsonrpc' },
          gid: '0000000000000001',
          options,
        },
        b: {
          profile: {
            ...profile,
            profileId: 'other',
            rpcUrl: 'http://example.com:81/jsonrpc',
            secret: 'different',
          },
          gid: '0000000000000001',
          options,
        },
      },
    ).state
    const aliased = JSON.parse(JSON.stringify(valid)) as {
      profiles: { other: { rpcUrl: string } }
    }
    aliased.profiles.other.rpcUrl = 'HTTP://EXAMPLE.COM:80/jsonrpc'
    expect(decodeTransferRegistryStore(aliased)).toMatchObject({
      ok: false,
      reason: 'duplicate aria2 gid',
    })
  })

  it('accepts only shared wire-valid projection receipts', () => {
    const valid = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ projectionId: 'x'.repeat(256) })],
      1,
    ).state
    expect(decodeTransferRegistryStore(valid).ok).toBe(true)
    for (const projectionId of ['x'.repeat(257), ' receipt', 'receipt ']) {
      const raw = JSON.parse(JSON.stringify(valid)) as {
        entries: { 'media-1': { request: { projectionId: string } } }
      }
      raw.entries['media-1'].request.projectionId = projectionId
      expect(decodeTransferRegistryStore(raw).ok).toBe(false)
    }
  })

  it('round-trips exact retry lineage and rejects missing prior handles', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const active = bindStarted(plan.state, plan.launches[0]!, { kind: 'browser', id: 9 }, 2).state
    const waiting = scheduleInterruptedRetry(active, {
      id: 'media-1',
      downloadId: 9,
      retryAt: 4,
    }).state
    expect(decodeTransferRegistryStore(waiting)).toEqual({
      ok: true,
      state: waiting,
    })
    const launching = beginRetryLaunch(waiting, 'media-1', 4).state
    expect(decodeTransferRegistryStore(launching)).toEqual({
      ok: true,
      state: launching,
    })
    const missingPrior = JSON.parse(JSON.stringify(launching)) as {
      entries: { 'media-1': { phase: Record<string, unknown> } }
    }
    delete missingPrior.entries['media-1'].phase.priorDownloadId
    expect(decodeTransferRegistryStore(missingPrior).ok).toBe(false)
  })

  it('round-trips aria2 active status/progress and rejects extra keys', () => {
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    const active = bindStarted(
      armAria2Call(plan.state, plan.launches[0]!, 2).state,
      plan.launches[0]!,
      { kind: 'aria2', gid: '0000000000000001' },
      3,
    ).state
    const withProgress = recordAria2Progress(active, {
      id: 'media-1',
      gid: '0000000000000001',
      profileId: 'local',
      status: 'active',
      observedAt: 4,
      completedLength: '1',
      totalLength: '2',
    }).state
    expect(decodeTransferRegistryStore(withProgress)).toEqual({
      ok: true,
      state: withProgress,
    })
    const extra = JSON.parse(JSON.stringify(withProgress)) as {
      entries: { 'media-1': { phase: Record<string, unknown> } }
    }
    extra.entries['media-1'].phase.extra = true
    expect(decodeTransferRegistryStore(extra).ok).toBe(false)
    const longDecimal = JSON.parse(JSON.stringify(withProgress)) as {
      entries: {
        'media-1': { phase: { progress: { completedLength: string } } }
      }
    }
    longDecimal.entries['media-1'].phase.progress.completedLength = '1'.repeat(33)
    expect(decodeTransferRegistryStore(longDecimal).ok).toBe(false)
    const errored = recordAria2Terminal(active, {
      id: 'media-1',
      gid: '0000000000000001',
      profileId: 'local',
      status: 'error',
      completedLength: '1',
      totalLength: '1',
      observedAt: 4,
      errorMessage: 'x',
    }).state
    const longMessage = JSON.parse(JSON.stringify(errored)) as {
      entries: { 'media-1': { phase: { evidence: { errorMessage: string } } } }
    }
    longMessage.entries['media-1'].phase.evidence.errorMessage = 'x'.repeat(1025)
    expect(decodeTransferRegistryStore(longMessage).ok).toBe(false)
  })

  it('round-trips both browser byte fields and rejects malformed values', () => {
    const plan = prepareLaunches(emptyTransferRegistryStore, [request()], 1)
    const active = bindStarted(plan.state, plan.launches[0]!, { kind: 'browser', id: 9 }, 2).state
    const done = recordBrowserTerminal(active, {
      id: 'media-1',
      downloadId: 9,
      state: 'complete',
      bytesReceived: 42,
      totalBytes: 64,
      observedAt: 3,
    }).state
    expect(decodeTransferRegistryStore(done)).toEqual({
      ok: true,
      state: done,
    })
    const malformed = JSON.parse(JSON.stringify(done)) as {
      entries: { 'media-1': { phase: { evidence: { totalBytes: number } } } }
    }
    malformed.entries['media-1'].phase.evidence.totalBytes = -1
    expect(decodeTransferRegistryStore(malformed).ok).toBe(false)
  })

  it('enforces the aria2-unresolved exact-key matrix', () => {
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    const unresolved = markAria2CallAmbiguous(
      armAria2Call(plan.state, plan.launches[0]!, 2).state,
      plan.launches[0]!,
      3,
    ).state
    expect(decodeTransferRegistryStore(unresolved).ok).toBe(true)
    const missingProfile = JSON.parse(JSON.stringify(unresolved)) as {
      entries: { 'media-1': { phase: Record<string, unknown> } }
    }
    delete missingProfile.entries['media-1'].phase.profileId
    expect(decodeTransferRegistryStore(missingProfile).ok).toBe(false)
    const legacyWithGid = JSON.parse(JSON.stringify(unresolved)) as {
      entries: { 'media-1': { phase: Record<string, unknown> } }
    }
    legacyWithGid.entries['media-1'].phase.reason = 'legacy-false-handoff'
    expect(decodeTransferRegistryStore(legacyWithGid).ok).toBe(false)
  })

  it('round-trips valid state and fails closed on orphan profiles or duplicate gids', () => {
    const plan = prepareLaunches(
      emptyTransferRegistryStore,
      [request({ mode: 'aria2' })],
      1,
      reservation,
    )
    expect(decodeTransferRegistryStore(plan.state)).toEqual({
      ok: true,
      state: plan.state,
    })
    expect(
      decodeTransferRegistryStore({
        ...plan.state,
        profiles: {
          ...plan.state.profiles,
          spare: {
            profileId: 'spare',
            rpcUrl: 'x',
            secret: '',
            failureCount: 0,
            nextProbeAt: 1,
          },
        },
      }).ok,
    ).toBe(false)
    const two = prepareLaunches(
      emptyTransferRegistryStore,
      [
        request({ id: 'a', projectionId: 'project-a', mode: 'aria2' }),
        request({ id: 'b', projectionId: 'project-b', mode: 'aria2' }),
      ],
      1,
      {
        a: { profile, gid: '0000000000000001', options },
        b: { profile, gid: '0000000000000002', options },
      },
    )
    const armed = armAria2Call(two.state, two.launches[0]!, 2).state
    expect(() =>
      bindStarted(armed, two.launches[0]!, { kind: 'aria2', gid: '0000000000000002' }, 3),
    ).toThrow('reserved gid')
  })
})

describe('v2 to v4 migration', () => {
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- local migration fixture.
  const v2 = (entries: Record<string, unknown>) => ({
    version: 2,
    entries,
    legacy: {},
  })
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- local migration fixture.
  const v2Request = (mode: 'direct' | 'fetched' | 'aria2' = 'direct', withItem = true) => ({
    id: 'media-1',
    url: 'https://x/a',
    filename: 'a',
    mode,
    ...(withItem
      ? {
          item: {
            id: 'media-1',
            platform: 'x',
            postId: 'p',
            author: 'a',
            type: 'video',
            url: 'https://x/a',
            ext: 'mp4',
            index: 0,
          },
        }
      : {}),
  })
  it('retains browser meaning and applies migrated history policy', () => {
    const migrated = migrateV2TransferRegistryStore(
      v2({
        'media-1': {
          request: v2Request(),
          createdAt: 1,
          phase: {
            tag: 'terminal-pending',
            outcome: 'complete',
            downloadId: 7,
            at: 2,
            projectAt: 3,
          },
        },
      }),
    )
    expect(migrated).toMatchObject({
      ok: true,
      state: {
        version: 4,
        entries: {
          'media-1': {
            request: { historyPolicy: 'transition-only' },
            phase: {
              evidence: { tag: 'browser', downloadId: 7, state: 'complete' },
              observedAt: 2,
            },
          },
        },
      },
    })
  })
  it('quarantines an old Fetched launch before the migrated v3 write', () => {
    const migrated = migrateV2TransferRegistryStore(
      v2({
        'media-1': {
          request: v2Request('fetched'),
          createdAt: 1,
          phase: { tag: 'launching', attempt: 0, since: 1 },
        },
      }),
    )
    expect(migrated).toMatchObject({
      ok: true,
      state: {
        entries: {
          'media-1': {
            phase: {
              tag: 'unresolved-launch',
              attempt: 0,
              since: 1,
              reason: 'worker-restart',
            },
          },
        },
      },
    })
    if (!migrated.ok) throw new Error(migrated.reason)
    expect(decodeTransferRegistryStore(migrated.state).ok).toBe(true)
  })
  it('uses same-createdAt entry ordinals for bounded unique v2 receipts', () => {
    expect(v2ProjectionId(1, 0)).toBe('v2:1:0')
    expect(v2ProjectionId(1, 0)).not.toBe(v2ProjectionId(1, 1))
    const migrated = migrateV2TransferRegistryStore(
      v2({
        a: {
          request: {
            ...v2Request(),
            id: 'a',
            item: { ...v2Request().item!, id: 'a' },
          },
          createdAt: 1,
          phase: { tag: 'launching', attempt: 0, since: 1 },
        },
        b: {
          request: {
            ...v2Request(),
            id: 'b',
            item: { ...v2Request().item!, id: 'b' },
          },
          createdAt: 1,
          phase: { tag: 'launching', attempt: 0, since: 1 },
        },
      }),
    )
    expect(migrated).toMatchObject({
      ok: true,
      state: {
        entries: {
          a: { request: { projectionId: 'v2:1:0' } },
          b: { request: { projectionId: 'v2:1:1' } },
        },
      },
    })
  })
  it('adds a due probe deadline to migrated v2 unresolved browser handles', () => {
    const migrated = migrateV2TransferRegistryStore(
      v2({
        'media-1': {
          request: v2Request(),
          createdAt: 1,
          phase: {
            tag: 'unresolved-launch',
            attempt: 0,
            since: 2,
            reason: 'worker-restart',
            downloadId: 9,
          },
        },
      }),
    )
    expect(migrated).toMatchObject({
      ok: true,
      state: {
        entries: {
          'media-1': {
            phase: { tag: 'browser-unresolved', downloadId: 9, nextProbeAt: 2 },
          },
        },
      },
    })
  })
  it('quarantines v2 retry waits that lack an exact prior handle', () => {
    const migrated = migrateV2TransferRegistryStore(
      v2({
        'media-1': {
          request: v2Request(),
          createdAt: 1,
          phase: { tag: 'retry-wait', attempt: 1, retryAt: 3 },
        },
      }),
    )
    expect(migrated).toMatchObject({
      ok: true,
      state: {
        entries: {
          'media-1': {
            phase: {
              tag: 'unresolved-launch',
              attempt: 1,
              since: 3,
              reason: 'worker-restart',
            },
          },
        },
      },
    })
  })
  it('turns lost v2 aria2 handoffs into no-projection unresolved rows', () => {
    for (const old of [
      { tag: 'launching', attempt: 0, since: 2 },
      { tag: 'terminal-pending', outcome: 'complete', at: 2, projectAt: 2 },
    ]) {
      const migrated = migrateV2TransferRegistryStore(
        v2({
          'media-1': {
            request: v2Request('aria2', false),
            createdAt: 1,
            phase: old,
          },
        }),
      )
      expect(migrated).toMatchObject({
        ok: true,
        state: {
          entries: {
            'media-1': {
              request: { historyPolicy: 'off' },
              phase: {
                tag: 'aria2-unresolved',
                reason: 'legacy-false-handoff',
              },
            },
          },
          profiles: {},
        },
      })
    }
  })
  it('rejects corruption before migration', () => {
    expect(
      migrateV2TransferRegistryStore(
        v2({
          'media-1': {
            request: v2Request(),
            createdAt: -1,
            phase: { tag: 'launching', attempt: 0, since: 1 },
          },
        }),
      ).ok,
    ).toBe(false)
  })
  it('rejects oversized v2 request fields before migration', () => {
    expect(
      migrateV2TransferRegistryStore(
        v2({
          'media-1': {
            request: {
              ...v2Request(),
              filename: 'f'.repeat(MAX_TRANSFER_REGISTRY_FILENAME_LENGTH + 1),
            },
            createdAt: 1,
            phase: { tag: 'launching', attempt: 0, since: 1 },
          },
        }),
      ).ok,
    ).toBe(false)
  })
})
