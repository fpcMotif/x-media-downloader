import { describe, it, expect, vi } from 'vitest'
import { Schema } from 'effect'
import {
  CORRUPT_SYNC_OUTBOX_DETAIL,
  makeSyncOutbox,
  type PermissionsPort,
  type SyncOutboxDeps,
} from './sync-outbox'
import type { ConvexPort } from './convex-port'
import { Settings as SettingsSchema, type Settings } from '../core/schema'
import type { SettingsOwnershipSnapshot } from '../core/settings'
import { decodeSettingsStore } from '../core/settings/persistence'
import { append, decodeOutboxResult, emptyOutbox, type OutboxState } from '../core/sync/outbox'
import { legacySyncEventId, outcomeEvent } from '../core/sync/events'
import type { SyncStatus } from '../core/sync/status'
import { DURABLE_SIDE_EFFECT_WATCHDOG_MS, type DurableWakePort } from './durable-wake'
import { makeSettingsWriter } from './settings-writer'

// The Cloud Sync outbox SHELL (ADR-0009/0005/0017) through its injected seams. The
// pure outbox reducer is covered in core/sync/outbox.test.ts; these tests pin the
// orchestration: the FIFO drain + first-failure-stops + backoff, the runSyncConnectionTest
// precondition ladder, the recordSync gate, and Settings reconciliation.

const NOW = 1_000_000
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const baseSettings: Settings = Schema.decodeUnknownSync(SettingsSchema)({})

/** Settings with Cloud Sync configured (enabled + URL + secret + device id). */
const configured = (over: Partial<Settings> = {}): Settings => ({
  ...baseSettings,
  cloudSyncEnabled: true,
  convexUrl: 'https://x.convex.cloud',
  convexSyncSecret: 'sek',
  cloudDeviceId: 'dev-1',
  ...over,
})
const availableOwnership = (desired: Settings): SettingsOwnershipSnapshot => ({
  availability: 'available',
  runtime: desired,
  desired,
})
const recoveryOwnership = (runtime: Settings): SettingsOwnershipSnapshot => ({
  availability: 'recovery-required',
  runtime,
  reason: 'recoverable',
})

const evt = (id: string) => outcomeEvent(id, 'completed', 'dev-1', NOW)
const availableOutbox = (raw: unknown): OutboxState => {
  const decoded = decodeOutboxResult(raw)
  if (!decoded.ok) throw new Error('expected available Sync outbox')
  return decoded.state
}

/** A ready outbox state (nextAttemptAt 0) holding the given pending events. */
const seededOutbox = (...ids: string[]): OutboxState => append(emptyOutbox, ids.map(evt))

/** In-memory store box satisfying OutboxStorage/StatusStore. `delay` widens the
 *  read-modify-write window so a serialization regression surfaces as a lost update. */
function fakeStore<T>(initial: T, opts: { delay?: boolean } = {}) {
  const box = {
    value: initial,
    gets: 0,
    sets: 0,
    async get() {
      box.gets += 1
      if (opts.delay) await tick()
      return box.value
    },
    async set(value: T) {
      box.sets += 1
      if (opts.delay) await tick()
      box.value = value
    },
  }
  return box
}

const okPort = (): ConvexPort => ({ mutation: vi.fn<ConvexPort['mutation']>(async () => ({})) })
const grant = (v: boolean): PermissionsPort => ({
  contains: vi.fn<PermissionsPort['contains']>(async () => v),
})
const dummyFetch = (async () => new Response()) as unknown as typeof fetch
const fakeWake = (): DurableWakePort => ({
  create: vi.fn<DurableWakePort['create']>(async () => {}),
  clear: vi.fn<DurableWakePort['clear']>(async () => {}),
})

/** Construct the shell with safe fake seams by default; a test overrides what it asserts on. */
const makeSO = (over: Partial<SyncOutboxDeps> = {}) => {
  const {
    getSettings: getSettingsOverride,
    getSettingsOwnership: getSettingsOwnershipOverride,
    ...rest
  } = over
  const getSettings = getSettingsOverride ?? (async () => configured())
  return makeSyncOutbox({
    queueError: () => () => {},
    fetchImpl: dummyFetch,
    outbox: fakeStore<unknown>(null),
    status: fakeStore<SyncStatus | null>(null),
    connect: okPort,
    permissions: grant(true),
    now: () => NOW,
    wake: fakeWake(),
    ...rest,
    getSettings,
    getSettingsOwnership:
      getSettingsOwnershipOverride ?? (async () => availableOwnership(await getSettings())),
  })
}

describe('drainOutbox', () => {
  it('quarantines a corrupt outbox without sending or overwriting it', async () => {
    const raw = { pending: 'corrupt' }
    const outbox = fakeStore<unknown>(raw)
    const status = fakeStore<SyncStatus | null>(null)
    const wake = fakeWake()
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, status, wake, connect: () => ({ mutation }) })

    await so.drainOutbox()

    expect(mutation).not.toHaveBeenCalled()
    expect(outbox.value).toBe(raw)
    expect(outbox.sets).toBe(0)
    expect(status.value).toEqual({
      ok: false,
      detail: CORRUPT_SYNC_OUTBOX_DETAIL,
      pending: 0,
    })
    expect(status.sets).toBe(1)
    expect(wake.create).not.toHaveBeenCalled()
    expect(wake.clear).toHaveBeenCalledWith(so.syncAlarm)
    expect(wake.clear).toHaveBeenCalledTimes(1)
  })

  it('arms a future recovery watchdog before an unresolved mutation', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('e1'))
    const wake = fakeWake()
    let release!: () => void
    const mutation = vi.fn<ConvexPort['mutation']>(
      () =>
        new Promise((resolve) => {
          release = () => resolve({})
        }),
    )
    const so = makeSO({ outbox, wake, connect: () => ({ mutation }) })

    const draining = so.drainOutbox()
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    expect(wake.create).toHaveBeenCalledWith(so.syncAlarm, NOW + DURABLE_SIDE_EFFECT_WATCHDOG_MS)

    release()
    await draining
    expect(wake.clear).toHaveBeenCalledWith(so.syncAlarm)
  })

  it('rechecks live opt-out after arming the watchdog and before sending', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('e1'))
    let currentSettings = configured()
    const wake: DurableWakePort = {
      create: vi.fn<DurableWakePort['create']>(async () => {
        currentSettings = configured({ cloudSyncEnabled: false })
      }),
      clear: vi.fn<DurableWakePort['clear']>(async () => {}),
    }
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({
      outbox,
      wake,
      getSettings: async () => currentSettings,
      connect: () => ({ mutation }),
    })

    await so.drainOutbox()

    expect(mutation).not.toHaveBeenCalled()
    expect(availableOutbox(outbox.value).pending).toHaveLength(1)
    expect(wake.clear).toHaveBeenCalledWith(so.syncAlarm)
  })

  it('preserves outbox and status when post-watchdog Settings become unavailable', async () => {
    const durable = seededOutbox('e1')
    const currentStatus: SyncStatus = { ok: false, detail: 'offline', pending: 1 }
    const outbox = fakeStore<unknown>(durable)
    const status = fakeStore<SyncStatus | null>(currentStatus)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    let reads = 0
    const so = makeSO({
      outbox,
      status,
      getSettings: async () => {
        reads += 1
        if (reads === 2) throw new Error('Settings unavailable')
        return configured()
      },
      connect: () => ({ mutation }),
    })

    await expect(so.drainOutbox()).rejects.toThrow('Settings unavailable')

    expect(mutation).not.toHaveBeenCalled()
    expect(outbox.value).toBe(durable)
    expect(status.value).toBe(currentStatus)
    expect(outbox.sets).toBe(0)
    expect(status.sets).toBe(0)
  })

  it('drains ready events to sync:recordEvents and records an ok status', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('e1', 'e2'))
    const status = fakeStore<SyncStatus | null>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, status, connect: () => ({ mutation }) })
    await so.drainOutbox()
    expect(mutation).toHaveBeenCalledTimes(1)
    const [name, args] = mutation.mock.calls[0] as [string, { events: unknown[]; secret: string }]
    expect(name).toBe('sync:recordEvents')
    expect(args.secret).toBe('sek')
    expect(args.events).toHaveLength(2)
    expect(availableOutbox(outbox.value).pending).toHaveLength(0)
    // The status reflects the POST-drain count (next.pending), not the pre-drain one.
    expect(status.value?.ok).toBe(true)
    expect(status.value?.pending).toBe(0)
    expect(status.value?.detail).toBe('Connected ✓ — metadata sync is working.')
  })

  it('drains a persisted legacy identity unchanged', async () => {
    const event = { ...evt('e1'), eventId: legacySyncEventId('dev-1', 'e1', 'completed') }
    const outbox = fakeStore<unknown>({
      pending: [event],
      consecutiveFailures: 0,
      nextAttemptAt: 0,
    })
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, connect: () => ({ mutation }) })

    await so.drainOutbox()

    const call = mutation.mock.calls[0]
    if (call === undefined) throw new Error('Expected one sync mutation.')
    const args = call[1] as { events: ReadonlyArray<{ eventId: string }> }
    expect(args.events[0]?.eventId).toBe(event.eventId)
    expect(availableOutbox(outbox.value).pending).toHaveLength(0)
  })

  it('stops at the first failure, arms backoff, and records a not-ok status', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('e1'))
    const status = fakeStore<SyncStatus | null>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => {
      throw new Error('HTTP 503')
    })
    const wake = fakeWake()
    const so = makeSO({ outbox, status, wake, connect: () => ({ mutation }) })
    await so.drainOutbox()
    expect(mutation).toHaveBeenCalledTimes(1)
    const state = availableOutbox(outbox.value)
    expect(state.pending).toHaveLength(1) // retained — never lost
    expect(state.consecutiveFailures).toBe(1)
    expect(state.nextAttemptAt).toBe(NOW + 5000) // 5s · 2^0
    expect(status.value?.ok).toBe(false)
    expect(wake.create).toHaveBeenCalledWith(so.syncAlarm, NOW + 5000)
  })

  it('drains a backlog larger than one batch across multiple passes', async () => {
    // 65 events > DEFAULT_BATCH (64): the loop must take 64, drop them, and continue
    // to drain the remainder — else a post-offline backlog stalls one batch short.
    const ids = Array.from({ length: 65 }, (_, i) => `e${i}`)
    const outbox = fakeStore<unknown>(seededOutbox(...ids))
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, connect: () => ({ mutation }) })
    await so.drainOutbox()
    expect(mutation).toHaveBeenCalledTimes(2)
    expect((mutation.mock.calls[0]![1] as { events: unknown[] }).events).toHaveLength(64)
    expect((mutation.mock.calls[1]![1] as { events: unknown[] }).events).toHaveLength(1)
    expect(availableOutbox(outbox.value).pending).toHaveLength(0)
  })

  it('stops before the next batch when sync is disabled mid-drain', async () => {
    const ids = Array.from({ length: 65 }, (_, i) => `e${i}`)
    const outbox = fakeStore<unknown>(seededOutbox(...ids))
    const wake = fakeWake()
    const firstBatchStarted = deferred()
    const firstBatchCanFinish = deferred()
    let currentSettings = configured()
    const mutation = vi.fn<ConvexPort['mutation']>(async () => {
      if (mutation.mock.calls.length === 1) {
        firstBatchStarted.resolve()
        await firstBatchCanFinish.promise
      }
      return {}
    })
    const so = makeSO({
      outbox,
      wake,
      getSettings: async () => currentSettings,
      connect: () => ({ mutation }),
    })

    const draining = so.drainOutbox()
    await firstBatchStarted.promise
    currentSettings = configured({ cloudSyncEnabled: false })
    firstBatchCanFinish.resolve()
    await draining

    expect(mutation).toHaveBeenCalledTimes(1)
    expect(availableOutbox(outbox.value).pending).toHaveLength(1)
    expect(wake.clear).toHaveBeenCalledWith(so.syncAlarm)
  })

  it('uses a rotated secret for the next batch', async () => {
    const ids = Array.from({ length: 65 }, (_, i) => `e${i}`)
    const outbox = fakeStore<unknown>(seededOutbox(...ids))
    const firstBatchStarted = deferred()
    const firstBatchCanFinish = deferred()
    let currentSettings = configured({ convexSyncSecret: 'old-secret' })
    const secrets: string[] = []
    const mutation = vi.fn<ConvexPort['mutation']>(async (_name, args) => {
      secrets.push((args as { secret: string }).secret)
      if (mutation.mock.calls.length === 1) {
        firstBatchStarted.resolve()
        await firstBatchCanFinish.promise
      }
      return {}
    })
    const connect = vi.fn<(settings: Settings) => ConvexPort>((settings) => {
      expect(settings).toBe(currentSettings)
      return { mutation }
    })
    const so = makeSO({
      outbox,
      getSettings: async () => currentSettings,
      connect,
    })

    const draining = so.drainOutbox()
    await firstBatchStarted.promise
    currentSettings = configured({ convexSyncSecret: 'new-secret' })
    firstBatchCanFinish.resolve()
    await draining

    expect(connect).toHaveBeenCalledTimes(2)
    expect(secrets).toEqual(['old-secret', 'new-secret'])
    expect(availableOutbox(outbox.value).pending).toHaveLength(0)
  })

  it('does nothing while in backoff (not ready)', async () => {
    const backedOff: OutboxState = {
      ...seededOutbox('e1'),
      consecutiveFailures: 1,
      nextAttemptAt: NOW + 5000,
    }
    const outbox = fakeStore<unknown>(backedOff)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, connect: () => ({ mutation }) })
    await so.drainOutbox()
    expect(mutation).not.toHaveBeenCalled()
  })

  it('re-arms persisted backoff on boot without retrying early', async () => {
    const outbox = fakeStore<unknown>({
      ...seededOutbox('e1'),
      consecutiveFailures: 1,
      nextAttemptAt: NOW + 5000,
    })
    const wake = fakeWake()
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, wake, connect: () => ({ mutation }) })
    await so.reconcileSettings()
    await so.outboxQueue.run(async () => {})
    expect(mutation).not.toHaveBeenCalled()
    expect(wake.create).toHaveBeenCalledWith(so.syncAlarm, NOW + 5000)
  })

  it('rebases a persisted deadline after rollback in a new worker', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('e1'))
    const firstMutation = vi.fn<ConvexPort['mutation']>(async () => {
      throw new Error('offline')
    })
    const first = makeSO({
      outbox,
      now: () => NOW,
      connect: () => ({ mutation: firstMutation }),
    })
    await first.drainOutbox()
    expect(availableOutbox(outbox.value).nextAttemptAt).toBe(NOW + 5000)

    const rolledBackNow = 1_000
    const wake = fakeWake()
    const restartedMutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const restarted = makeSO({
      outbox,
      wake,
      now: () => rolledBackNow,
      connect: () => ({ mutation: restartedMutation }),
    })

    await restarted.reconcileSettings()
    await restarted.outboxQueue.run(async () => {})

    expect(restartedMutation).not.toHaveBeenCalled()
    expect(availableOutbox(outbox.value).nextAttemptAt).toBe(rolledBackNow + 5000)
    expect(vi.mocked(wake.create).mock.calls[0]).toEqual([
      restarted.syncAlarm,
      rolledBackNow + DURABLE_SIDE_EFFECT_WATCHDOG_MS,
    ])
    expect(wake.create).toHaveBeenCalledWith(restarted.syncAlarm, rolledBackNow + 5000)
  })

  it('preserves pending work and clears the alarm when sync is incomplete', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('e1'))
    const wake = fakeWake()
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const incomplete = configured({ convexSyncSecret: '' })
    const getSettings = vi.fn<() => Promise<Settings>>(async () => incomplete)
    const current = makeSO({ outbox, wake, connect: () => ({ mutation }), getSettings })

    await current.reconcileSettings()
    current.onWake()
    await current.outboxQueue.run(async () => {})

    expect(mutation).not.toHaveBeenCalled()
    expect(availableOutbox(outbox.value).pending).toHaveLength(1)
    expect(wake.clear).toHaveBeenCalledWith(current.syncAlarm)
  })

  it('fails closed when a consumed drain alarm cannot be replaced', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('e1'))
    const wake: DurableWakePort = {
      create: vi.fn<DurableWakePort['create']>(async () => {
        throw new Error('alarms unavailable')
      }),
      clear: vi.fn<DurableWakePort['clear']>(async () => {}),
    }
    const report = vi.fn<(error: unknown) => void>()
    const queueError = vi.fn<SyncOutboxDeps['queueError']>((label) =>
      label === 'sync-outbox-wake' ? report : () => {},
    )
    const mutation = vi.fn<ConvexPort['mutation']>(async () => {
      throw new Error('503')
    })
    const so = makeSO({ outbox, wake, queueError, connect: () => ({ mutation }) })
    await so.drainOutbox()
    expect(availableOutbox(outbox.value).nextAttemptAt).toBe(0)
    expect(mutation).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledWith(expect.any(Error))
  })
})

describe('runSyncConnectionTest — precondition ladder', () => {
  it('fails when the deployment URL is empty', async () => {
    const res = await makeSO().runSyncConnectionTest(configured({ convexUrl: '' }))
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('Enter the Convex deployment URL first.')
  })

  it('fails when the secret is empty', async () => {
    const res = await makeSO().runSyncConnectionTest(configured({ convexSyncSecret: '' }))
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('Enter the sync secret first.')
  })

  it('fails when the URL is malformed', async () => {
    const res = await makeSO().runSyncConnectionTest(configured({ convexUrl: 'not a url' }))
    expect(res.ok).toBe(false)
    expect(res.detail).toBe("That doesn't look like a valid URL.")
  })

  it('fails when the host permission is not granted', async () => {
    const permissions = grant(false)
    const res = await makeSO({ permissions }).runSyncConnectionTest(configured())
    expect(permissions.contains).toHaveBeenCalledWith(['https://x.convex.cloud/*'])
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('Grant access to the deployment first (button above).')
  })

  it('treats a throwing permission probe as not granted', async () => {
    const permissions: PermissionsPort = {
      contains: vi.fn<PermissionsPort['contains']>(async () => {
        throw new Error('probe blew up')
      }),
    }
    const res = await makeSO({ permissions }).runSyncConnectionTest(configured())
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('Grant access to the deployment first (button above).')
  })

  it('passes the zero-write probe and persists an ok status through the queue', async () => {
    const status = fakeStore<SyncStatus | null>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ status, connect: () => ({ mutation }) })
    const res = await so.runSyncConnectionTest(configured())
    expect(res.ok).toBe(true)
    // zero-write: an EMPTY events batch is sent.
    const [name, args] = mutation.mock.calls[0] as [string, { events: unknown[] }]
    expect(name).toBe('sync:recordEvents')
    expect(args.events).toHaveLength(0)
    await tick() // the status write is pushed onto the outbox queue
    expect(status.value?.ok).toBe(true)
  })

  it('reports and persists a not-ok status when the probe fails', async () => {
    const status = fakeStore<SyncStatus | null>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => {
      throw new Error('HTTP 401')
    })
    const res = await makeSO({ status, connect: () => ({ mutation }) }).runSyncConnectionTest(
      configured(),
    )
    expect(res.ok).toBe(false)
    await tick() // the status write is pushed onto the outbox queue
    // The SAME not-ok verdict is persisted (catch-branch queue.push), not just returned.
    expect(status.value).toEqual(res)
  })

  it('does not send a stale URL or secret after a deferred permission check', async () => {
    const permission = deferred()
    let current = configured()
    const permissions: PermissionsPort = {
      contains: async () => {
        await permission.promise
        return true
      },
    }
    const status = fakeStore<SyncStatus | null>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({
      status,
      permissions,
      getSettings: async () => current,
      connect: () => ({ mutation }),
    })

    const testing = so.runSyncConnectionTest(current)
    current = configured({ convexUrl: 'https://new.convex.cloud', convexSyncSecret: 'new-secret' })
    permission.resolve()

    await expect(testing).resolves.toMatchObject({
      ok: false,
      detail: 'Sync settings changed. Try again.',
    })
    expect(mutation).not.toHaveBeenCalled()
    expect(status.value).toBeNull()
  })

  it('does not write a stale test status after Sync turns off during the probe', async () => {
    let current = configured()
    const reply = deferred()
    const status = fakeStore<SyncStatus | null>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => {
      await reply.promise
      return {}
    })
    const so = makeSO({
      status,
      getSettings: async () => current,
      connect: () => ({ mutation }),
    })

    const testing = so.runSyncConnectionTest(current)
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce())
    current = configured({ cloudSyncEnabled: false })
    reply.resolve()

    await expect(testing).resolves.toMatchObject({
      ok: false,
      detail: 'Sync settings changed. Try again.',
    })
    await so.outboxQueue.run(async () => {})
    expect(status.value).toBeNull()
  })

  it('lets the latest identical connection test own session status', async () => {
    let rejectFirst!: (error: Error) => void
    let calls = 0
    const status = fakeStore<SyncStatus | null>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(() => {
      calls += 1
      if (calls === 1)
        return new Promise((_, reject: (error: Error) => void) => {
          rejectFirst = reject
        })
      return Promise.resolve({})
    })
    const so = makeSO({ status, connect: () => ({ mutation }) })

    const first = so.runSyncConnectionTest(configured())
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce())
    const second = await so.runSyncConnectionTest(configured())
    await so.outboxQueue.run(async () => {})
    expect(status.value).toEqual(second)

    rejectFirst(new Error('HTTP 500'))
    await expect(first).resolves.toMatchObject({ ok: false })
    await so.outboxQueue.run(async () => {})
    expect(status.value).toEqual(second)
  })
})

describe('recordSync — gating', () => {
  it('rejects a corrupt durable append without overwriting pending bytes', async () => {
    const raw = { pending: 'corrupt' }
    const outbox = fakeStore<unknown>(raw)
    const status = fakeStore<SyncStatus | null>(null)
    const wake = fakeWake()
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, status, wake, connect: () => ({ mutation }) })

    await expect(so.recordSync([evt('e1')])).rejects.toThrow(CORRUPT_SYNC_OUTBOX_DETAIL)

    expect(mutation).not.toHaveBeenCalled()
    expect(outbox.value).toBe(raw)
    expect(outbox.sets).toBe(0)
    expect(status.value?.detail).toBe(CORRUPT_SYNC_OUTBOX_DETAIL)
    expect(wake.clear).toHaveBeenCalledWith(so.syncAlarm)
  })

  it('does nothing and resolves immediately when Cloud Sync is not configured', async () => {
    const outbox = fakeStore<unknown>(null)
    await makeSO({
      outbox,
      getSettings: async () => configured({ cloudSyncEnabled: false }),
    }).recordSync([evt('e1')])
    expect(outbox.gets).toBe(0)
    expect(outbox.sets).toBe(0)
  })

  it('does nothing for an empty event batch', async () => {
    const outbox = fakeStore<unknown>(null)
    await makeSO({ outbox }).recordSync([])
    expect(outbox.sets).toBe(0)
  })

  it('rejects events from a stale device identity', async () => {
    const outbox = fakeStore<unknown>(null)
    const so = makeSO({
      outbox,
      getSettings: async () => configured({ cloudDeviceId: 'dev-2' }),
    })

    await so.recordSync([evt('e1')])

    expect(outbox.gets).toBe(0)
    expect(outbox.sets).toBe(0)
  })

  it('acknowledges the durable append before a slow network drain finishes', async () => {
    const outbox = fakeStore<unknown>(null)
    let release: (() => void) | undefined
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const mutation = vi.fn<ConvexPort['mutation']>(
      () =>
        new Promise((resolve) => {
          markStarted?.()
          release = () => resolve({})
        }),
    )
    const so = makeSO({ outbox, connect: () => ({ mutation }) })
    await so.recordSync([evt('e1')])
    expect(availableOutbox(outbox.value).pending).toHaveLength(1)
    await started
    release?.()
    await so.outboxQueue.run(async () => {})
    expect(availableOutbox(outbox.value).pending).toHaveLength(0)
  })

  it('appends and drains when configured', async () => {
    const outbox = fakeStore<unknown>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, connect: () => ({ mutation }) })
    await so.recordSync([evt('e1')])
    await so.outboxQueue.run(async () => {})
    expect(mutation).toHaveBeenCalledTimes(1)
    expect(availableOutbox(outbox.value).pending).toHaveLength(0) // appended then drained
  })

  it('arms a watchdog before an append, then reconciles the exact retry wake', async () => {
    const outbox = fakeStore<unknown>(null)
    const order: string[] = []
    const originalSet = outbox.set
    outbox.set = async (value) => {
      order.push('outbox')
      await originalSet(value)
    }
    const wake: DurableWakePort = {
      create: async () => {
        order.push('wake')
      },
      clear: async () => {},
    }
    const so = makeSO({
      outbox,
      wake,
      connect: () => ({ mutation: async () => new Promise(() => {}) }),
    })

    await so.recordSync([evt('death-cut')])
    expect(order.slice(0, 2)).toEqual(['wake', 'outbox'])
    expect(availableOutbox(outbox.value).pending).toEqual([evt('death-cut')])
  })

  it('fails closed before an append when its watchdog cannot be armed', async () => {
    const outbox = fakeStore<unknown>(null)
    const wake: DurableWakePort = {
      create: async () => {
        throw new Error('alarm unavailable')
      },
      clear: async () => {},
    }
    const so = makeSO({ outbox, wake })

    await expect(so.recordSync([evt('no-wake')])).rejects.toThrow('alarm unavailable')
    expect(outbox.value).toBeNull()
  })

  it('does not append after an ordered opt-out lands during watchdog I/O', async () => {
    const outbox = fakeStore<unknown>(null)
    let releaseWake!: () => void
    const wake: DurableWakePort = {
      create: () =>
        new Promise<void>((resolve) => {
          releaseWake = resolve
        }),
      clear: async () => {},
    }
    const so = makeSO({ outbox, wake })

    const recording = so.recordSync([evt('withdrawn')])
    await vi.waitFor(() => expect(releaseWake).toBeTypeOf('function'))
    so.onSettingsCommitted(configured({ cloudSyncEnabled: false }))
    releaseWake()
    await recording
    await so.outboxQueue.run(async () => {})

    expect(outbox.value).toBeNull()
  })

  it('serializes interleaved recordSync calls so neither event is lost', async () => {
    const outbox = fakeStore<unknown>(null, { delay: true })
    const sent: string[] = []
    const mutation = vi.fn<ConvexPort['mutation']>(async (_name, args) => {
      for (const e of (args as { events: ReadonlyArray<{ requestId: string }> }).events)
        sent.push(e.requestId)
      return {}
    })
    const so = makeSO({ outbox, connect: () => ({ mutation }) })
    const first = so.recordSync([evt('a')])
    const second = so.recordSync([evt('b')])
    await Promise.all([first, second])
    // Both appends have now scheduled their ordered drains, so this queue flush
    // waits for every write and send without a timing race.
    await so.outboxQueue.run(async () => {})
    expect(sent).toContain('a')
    expect(sent).toContain('b')
  })
})

describe('Settings reconciliation / getSyncStatus', () => {
  it('quarantines a corrupt boot outbox and clears its alarm', async () => {
    const raw = { pending: 'corrupt' }
    const outbox = fakeStore<unknown>(raw)
    const status = fakeStore<SyncStatus | null>(null)
    const wake = fakeWake()
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, status, wake, connect: () => ({ mutation }) })

    await so.reconcileSettings()
    await so.outboxQueue.run(async () => {})

    expect(mutation).not.toHaveBeenCalled()
    expect(outbox.value).toBe(raw)
    expect(outbox.sets).toBe(0)
    expect(status.value?.detail).toBe(CORRUPT_SYNC_OUTBOX_DETAIL)
    expect(wake.create).not.toHaveBeenCalled()
    expect(wake.clear).toHaveBeenCalledWith(so.syncAlarm)
  })

  it('never re-arms a corrupt outbox after an alarm wake', async () => {
    const raw = { pending: 'corrupt' }
    const outbox = fakeStore<unknown>(raw)
    const wake = fakeWake()
    const so = makeSO({ outbox, wake })

    so.onWake()
    await so.outboxQueue.run(async () => {})

    expect(outbox.value).toBe(raw)
    expect(wake.create).not.toHaveBeenCalled()
    expect(wake.clear).toHaveBeenCalledWith(so.syncAlarm)
    expect(wake.clear).toHaveBeenCalledTimes(1)
  })

  it('an available committed opt-out clears the durable outbox and status', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('e1'))
    const status = fakeStore<SyncStatus | null>({ ok: true, detail: 'x', pending: 0 })
    const disabled = configured({ cloudSyncEnabled: false })
    const so = makeSO({
      outbox,
      status,
      getSettings: async () => disabled,
      getSettingsOwnership: async () => availableOwnership(disabled),
    })

    await so.reconcileSettings()

    expect(outbox.value).toBeNull()
    expect(status.value).toBeNull()
  })

  it('boot recovery preserves the durable outbox and status while removing its wake', async () => {
    const durable = seededOutbox('e1')
    const currentStatus: SyncStatus = { ok: false, detail: 'offline', pending: 1 }
    const outbox = fakeStore<unknown>(durable)
    const status = fakeStore<SyncStatus | null>(currentStatus)
    const wake = fakeWake()
    const runtime = configured({ cloudSyncEnabled: false })
    const so = makeSO({
      outbox,
      status,
      wake,
      getSettings: async () => runtime,
      getSettingsOwnership: async () => recoveryOwnership(runtime),
    })

    await so.reconcileSettings()

    expect(outbox.value).toBe(durable)
    expect(status.value).toBe(currentStatus)
    expect(outbox.sets).toBe(0)
    expect(status.sets).toBe(0)
    expect(wake.clear).toHaveBeenCalledWith(so.syncAlarm)
  })

  it('fresh-reads intent after a blocked stale watch reconciliation', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('e1'))
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const queueBlocked = deferred()
    let currentSettings = configured({ cloudSyncEnabled: false })
    let ownership = availableOwnership(currentSettings)
    const so = makeSO({
      outbox,
      getSettings: async () => currentSettings,
      getSettingsOwnership: async () => ownership,
      connect: () => ({ mutation }),
    })

    so.outboxQueue.push(() => queueBlocked.promise)
    const reconciling = so.reconcileSettings()
    currentSettings = configured()
    ownership = availableOwnership(currentSettings)
    queueBlocked.resolve()
    await reconciling
    await so.outboxQueue.run(async () => {})

    expect(mutation).toHaveBeenCalledOnce()
    expect(availableOutbox(outbox.value).pending).toHaveLength(0)
  })

  it('fences a committed opt-out before a later opt-in can append', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('old'))
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const queueBlocked = deferred()
    let raw: unknown = { version: 1, revision: 1, settings: configured() }
    const writer = makeSettingsWriter({
      get: async () => raw,
      set: async (next) => {
        raw = next
      },
    })
    const so = makeSO({
      outbox,
      getSettings: async () => decodeSettingsStore(raw).settings,
      connect: () => ({ mutation }),
    })
    writer.onCommit(so.onSettingsCommitted)

    so.outboxQueue.push(() => queueBlocked.promise)
    so.onWake() // stale storage ON wake queued before the OFF command
    await writer.update({ cloudSyncEnabled: false })
    const enabled = await writer.update({ cloudSyncEnabled: true })
    const appended = so.recordSync([evt('new')])

    queueBlocked.resolve()
    await appended
    await so.outboxQueue.run(async () => {})

    expect(mutation).toHaveBeenCalledOnce()
    expect(mutation).toHaveBeenCalledWith('sync:recordEvents', {
      events: [evt('new')],
      secret: enabled.convexSyncSecret,
    })
  })

  it('treats a stale storage opt-out notification as a wake, not a clear command', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('new'))
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, connect: () => ({ mutation }) })

    // The old OFF watch arrives after SettingsWriter has committed ON. Watches
    // carry no authority, so it may only wake the normal live drain.
    so.onWake()
    await so.outboxQueue.run(async () => {})

    expect(mutation).toHaveBeenCalledOnce()
    expect(mutation).toHaveBeenCalledWith('sync:recordEvents', {
      events: [evt('new')],
      secret: 'sek',
    })
  })

  it('a confirmed repair resumes the preserved outbox', async () => {
    const durable = seededOutbox('e1')
    const outbox = fakeStore<unknown>(durable)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    let currentSettings = configured({ cloudSyncEnabled: false })
    let ownership: SettingsOwnershipSnapshot = recoveryOwnership(currentSettings)
    const so = makeSO({
      outbox,
      getSettings: async () => currentSettings,
      getSettingsOwnership: async () => ownership,
      connect: () => ({ mutation }),
    })

    await so.reconcileSettings()
    expect(outbox.value).toBe(durable)

    currentSettings = configured()
    ownership = availableOwnership(currentSettings)
    await so.reconcileSettings()
    await so.outboxQueue.run(async () => {})

    expect(mutation).toHaveBeenCalledOnce()
    expect(availableOutbox(outbox.value).pending).toHaveLength(0)
  })

  it('a confirmed reset makes the default opt-out destructive', async () => {
    const durable = seededOutbox('e1')
    const outbox = fakeStore<unknown>(durable)
    const status = fakeStore<SyncStatus | null>({ ok: false, detail: 'offline', pending: 1 })
    let currentSettings = configured({ cloudSyncEnabled: false })
    let ownership: SettingsOwnershipSnapshot = recoveryOwnership(currentSettings)
    const so = makeSO({
      outbox,
      status,
      getSettings: async () => currentSettings,
      getSettingsOwnership: async () => ownership,
    })

    await so.reconcileSettings()
    expect(outbox.value).toBe(durable)

    currentSettings = { ...baseSettings }
    ownership = availableOwnership(currentSettings)
    await so.reconcileSettings()

    expect(outbox.value).toBeNull()
    expect(status.value).toBeNull()
  })

  it('does not append a stale record after an ordered explicit opt-out', async () => {
    const outbox = fakeStore<unknown>(seededOutbox('old'))
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const queueBlocked = deferred()
    let currentSettings = configured()
    const so = makeSO({
      outbox,
      getSettings: async () => currentSettings,
      connect: () => ({ mutation }),
    })

    so.outboxQueue.push(() => queueBlocked.promise)
    const reconciling = so.reconcileSettings()
    const staleRecord = so.recordSync([evt('stale')])
    currentSettings = configured({ cloudSyncEnabled: false })
    queueBlocked.resolve()
    await Promise.all([reconciling, staleRecord])

    expect(outbox.value).toBeNull()
    expect(mutation).not.toHaveBeenCalled()
  })

  it('getSyncStatus reads the status store', async () => {
    const status = fakeStore<SyncStatus | null>({ ok: true, detail: 'ok', pending: 3 })
    expect(await makeSO({ status }).getSyncStatus()).toEqual({ ok: true, detail: 'ok', pending: 3 })
  })
})
