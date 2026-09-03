import { describe, it, expect, vi } from 'vitest'
import { Schema } from 'effect'
import {
  makeSyncOutbox,
  type AlarmPort,
  type PermissionsPort,
  type SyncOutboxDeps,
} from './sync-outbox'
import type { ConvexPort } from './convex-port'
import {
  Settings as SettingsSchema,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type Settings,
} from '@/packages/schema'
import { append, decodeOutbox, emptyOutbox, type OutboxState } from '@/packages/sync/outbox'
import { outcomeEvent } from '@/packages/sync/events'
import type { SyncStatus } from '@/packages/sync/status'

// The Cloud Sync outbox SHELL (ADR-0009/0005/0017) through its injected seams. The
// pure outbox reducer is covered in core/sync/outbox.test.ts; these tests pin the
// orchestration: the FIFO drain + first-failure-stops + backoff, the runSyncConnectionTest
// precondition ladder, the recordSync gate, and clearOutbox.

const NOW = 1_000_000
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
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

const evt = (id: string) => outcomeEvent(id, 'completed', 'dev-1', NOW)

/** Narrow a parsed JSON node to one carrying a string `requestId`, as every
 *  `SyncEvent` does. */
const hasRequestId = (value: JsonObject): value is JsonObject & { requestId: string } =>
  typeof value.requestId === 'string'

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

const okPort = () =>
  ({ mutation: vi.fn<ConvexPort['mutation']>(async () => ({})) }) satisfies ConvexPort
const grant = (v: boolean) =>
  ({
    contains: vi.fn<PermissionsPort['contains']>(async () => v),
  }) satisfies PermissionsPort
const fakeAlarms = () =>
  ({
    create: vi.fn<AlarmPort['create']>(async () => {}),
    clear: vi.fn<AlarmPort['clear']>(async () => {}),
  }) satisfies AlarmPort
// SAFETY: `fetchImpl` is only ever forwarded to `defaultConnect`, which every
// test here overrides via `connect` — this stub is never actually called, so
// its shape only needs to satisfy `typeof fetch`'s type, not its full contract.
const dummyFetch = (async () => new Response()) as typeof fetch

/** Construct the shell with safe fake seams by default; a test overrides what it asserts on. */
const makeSO = (over: Partial<SyncOutboxDeps> = {}) =>
  makeSyncOutbox({
    queueError: () => () => {},
    fetchImpl: dummyFetch,
    outbox: fakeStore<JsonValue>(null),
    status: fakeStore<SyncStatus | null>(null),
    connect: okPort,
    permissions: grant(true),
    alarms: fakeAlarms(),
    now: () => NOW,
    ...over,
  })

describe('drainOutbox', () => {
  it('drains ready events to sync:recordEvents and records an ok status', async () => {
    const outbox = fakeStore<JsonValue>(seededOutbox('e1', 'e2'))
    const status = fakeStore<SyncStatus | null>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, status, connect: () => ({ mutation }) })
    await so.drainOutbox(configured())
    expect(mutation).toHaveBeenCalledTimes(1)
    const [name, args] = mutation.mock.calls[0]!
    expect(name).toBe('sync:recordEvents')
    expect(args.secret).toBe('sek')
    expect(args.events).toHaveLength(2)
    expect(decodeOutbox(outbox.value).pending).toHaveLength(0)
    // The status reflects the POST-drain count (next.pending), not the pre-drain one.
    expect(status.value?.ok).toBe(true)
    expect(status.value?.pending).toBe(0)
    expect(status.value?.detail).toBe('Connected ✓ — metadata sync is working.')
  })

  it('stops at the first failure, arms backoff, and records a not-ok status', async () => {
    const outbox = fakeStore<JsonValue>(seededOutbox('e1'))
    const status = fakeStore<SyncStatus | null>(null)
    const alarms = fakeAlarms()
    const mutation = vi.fn<ConvexPort['mutation']>(async () => {
      throw new Error('HTTP 503')
    })
    const so = makeSO({ outbox, status, alarms, connect: () => ({ mutation }) })
    await so.drainOutbox(configured())
    expect(mutation).toHaveBeenCalledTimes(1)
    const state = decodeOutbox(outbox.value)
    expect(state.pending).toHaveLength(1) // retained — never lost
    expect(state.consecutiveFailures).toBe(1)
    expect(state.nextAttemptAt).toBe(NOW + 5000) // 5s · 2^0
    expect(status.value?.ok).toBe(false)
    expect(alarms.create).toHaveBeenCalledWith(so.syncAlarm, NOW + 5000)
    expect(alarms.clear).not.toHaveBeenCalled()
  })

  it('drains a backlog larger than one batch across multiple passes', async () => {
    // 65 events > DEFAULT_BATCH (64): the loop must take 64, drop them, and continue
    // to drain the remainder — else a post-offline backlog stalls one batch short.
    const ids = Array.from({ length: 65 }, (_, i) => `e${i}`)
    const outbox = fakeStore<JsonValue>(seededOutbox(...ids))
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, connect: () => ({ mutation }) })
    await so.drainOutbox(configured())
    expect(mutation).toHaveBeenCalledTimes(2)
    expect(mutation.mock.calls[0]![1].events).toHaveLength(64)
    expect(mutation.mock.calls[1]![1].events).toHaveLength(1)
    expect(decodeOutbox(outbox.value).pending).toHaveLength(0)
  })

  it('does nothing while in backoff (not ready)', async () => {
    const backedOff: OutboxState = {
      ...seededOutbox('e1'),
      consecutiveFailures: 1,
      nextAttemptAt: NOW + 5000,
    }
    const outbox = fakeStore<JsonValue>(backedOff)
    const alarms = fakeAlarms()
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    const so = makeSO({ outbox, alarms, connect: () => ({ mutation }) })
    await so.drainOutbox(configured())
    expect(mutation).not.toHaveBeenCalled()
    expect(alarms.create).toHaveBeenCalledWith(so.syncAlarm, NOW + 5000)
  })

  it('clears the wake alarm after the outbox drains', async () => {
    const alarms = fakeAlarms()
    const so = makeSO({ outbox: fakeStore<JsonValue>(seededOutbox('e1')), alarms })
    await so.drainOutbox(configured())
    expect(alarms.clear).toHaveBeenCalledWith(so.syncAlarm)
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
    const [name, args] = mutation.mock.calls[0]!
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
})

describe('recordSync — gating', () => {
  it('does nothing when Cloud Sync is not configured', async () => {
    const outbox = fakeStore<JsonValue>(null)
    makeSO({ outbox }).recordSync(configured({ cloudSyncEnabled: false }), [evt('e1')])
    await tick()
    expect(outbox.gets).toBe(0)
    expect(outbox.sets).toBe(0)
  })

  it('does nothing for an empty event batch', async () => {
    const outbox = fakeStore<JsonValue>(null)
    makeSO({ outbox }).recordSync(configured(), [])
    await tick()
    expect(outbox.sets).toBe(0)
  })

  it('appends and drains when configured', async () => {
    const outbox = fakeStore<JsonValue>(null)
    const mutation = vi.fn<ConvexPort['mutation']>(async () => ({}))
    makeSO({ outbox, connect: () => ({ mutation }) }).recordSync(configured(), [evt('e1')])
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    expect(decodeOutbox(outbox.value).pending).toHaveLength(0) // appended then drained
  })

  it('serializes interleaved recordSync calls so neither event is lost', async () => {
    const outbox = fakeStore<JsonValue>(null, { delay: true })
    const sent: string[] = []
    const mutation = vi.fn<ConvexPort['mutation']>(async (_name, args) => {
      // This mock only ever answers the `recordSync` path under test, whose
      // `sync:recordEvents` call always sends `{ events: SyncEvent[], secret }` —
      // asserted by the two interleaved `recordSync` calls below, never arbitrary JSON.
      const { events } = args
      if (Array.isArray(events))
        for (const e of events) if (isJsonObject(e) && hasRequestId(e)) sent.push(e.requestId)
      return {}
    })
    const so = makeSO({ outbox, connect: () => ({ mutation }) })
    so.recordSync(configured(), [evt('a')])
    so.recordSync(configured(), [evt('b')])
    // Deterministic flush: run() chains onto the same serial queue, so it resolves
    // only after both recordSync tasks (append + drain) have run — no timing race.
    await so.outboxQueue.run(async () => {})
    expect(sent).toContain('a')
    expect(sent).toContain('b')
  })
})

describe('clearOutbox / getSyncStatus', () => {
  it('clearOutbox clears both the durable outbox and the ephemeral status', async () => {
    const outbox = fakeStore<JsonValue>(seededOutbox('e1'))
    const status = fakeStore<SyncStatus | null>({ ok: true, detail: 'x', pending: 0 })
    const alarms = fakeAlarms()
    const so = makeSO({ outbox, status, alarms })
    so.clearOutbox()
    await tick()
    expect(outbox.value).toBeNull()
    expect(status.value).toBeNull()
    expect(alarms.clear).toHaveBeenCalledWith(so.syncAlarm)
  })

  it('getSyncStatus reads the status store', async () => {
    const status = fakeStore<SyncStatus | null>({ ok: true, detail: 'ok', pending: 3 })
    expect(await makeSO({ status }).getSyncStatus()).toEqual({ ok: true, detail: 'ok', pending: 3 })
  })
})
