import { Schema } from 'effect'
import { describe, expect, it, vi } from 'vitest'
import type { TweetRecord } from '../core/capture/record'
import { Settings as SettingsSchema, type Settings } from '../core/schema'
import {
  MAX_CAPTURE_OUTBOX_ITEMS,
  appendCaptureEvents,
  captureEventFromRecord,
  decodeCaptureOutboxResult,
  emptyCaptureOutbox,
  markCaptureBatchFailed,
  type CaptureOutboxState,
  type SyncCaptureEvent,
} from '../core/sync/captures'
import {
  CAPTURE_OUTBOX_ALARM,
  makeCaptureOutbox,
  type CaptureMirrorAdmission,
  type LedgerStorage,
} from './capture-outbox'
import { DURABLE_SIDE_EFFECT_WATCHDOG_MS, type DurableWakePort } from './durable-wake'

const defaults: Settings = Schema.decodeUnknownSync(SettingsSchema)({})
const settings = (overrides: Partial<Settings> = {}): Settings => ({
  ...defaults,
  captureEnabled: true,
  captureMirrorEnabled: true,
  cloudSyncEnabled: false,
  convexUrl: 'https://x.convex.cloud',
  convexSyncSecret: 'secret',
  cloudDeviceId: 'current-device',
  ...overrides,
})

const DESTINATION_A = 'https://x.convex.cloud'
const DESTINATION_B = 'https://b.convex.cloud'

const record = (tweetId: string, overrides: Partial<TweetRecord> = {}): TweetRecord => ({
  tweetId,
  conversationId: tweetId,
  author: { handle: 'alice' },
  text: 'hi',
  rawText: 'hi',
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'timeline',
  sourceRank: 1,
  capturedAt: 1_000,
  ...overrides,
})

const admission: CaptureMirrorAdmission = {
  _tag: 'CaptureMirrorAdmission',
  destination: DESTINATION_A,
  deviceId: 'admitted-device',
  acceptedAt: 1_000,
}

const stateWith = (
  events: ReadonlyArray<SyncCaptureEvent>,
  destination = DESTINATION_A,
  state: CaptureOutboxState = emptyCaptureOutbox,
  at = 0,
): CaptureOutboxState => {
  const appended = appendCaptureEvents(state, events, destination, at)
  if (appended.status === 'full') throw new Error('test append was full')
  return appended.state
}

const fakeLedger = (initial: unknown = null): LedgerStorage & { value: unknown } => {
  const ledger = {
    value: initial,
    async get() {
      return ledger.value
    },
    async set(value: unknown) {
      ledger.value = value
    },
  }
  return ledger
}

const fakeWake = (): DurableWakePort => ({
  create: vi.fn<DurableWakePort['create']>(async () => {}),
  clear: vi.fn<DurableWakePort['clear']>(async () => {}),
})

const successfulMutation = () =>
  vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => ({}))

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const stateOf = (raw: unknown) => {
  const decoded = decodeCaptureOutboxResult(raw)
  if (decoded.status === 'corrupt') throw new Error('test state is corrupt')
  return decoded.state
}

describe('CaptureOutbox', () => {
  it('resolves admission only after the ledger and its durable wake settle', async () => {
    const ledger = fakeLedger()
    const wakeCanFinish = deferred()
    const wake = fakeWake()
    const create = vi.fn<DurableWakePort['create']>(async () => {
      if (create.mock.calls.length === 2) await wakeCanFinish.promise
    })
    wake.create = create
    const mutation = successfulMutation()
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings(),
      ledger,
      wake,
      connect: () => ({ mutation }),
      now: () => 1_000,
    })

    let resolved = false
    const enqueued = outbox.enqueueAccepted([record('1')], admission).then(() => {
      resolved = true
      return undefined
    })
    await vi.waitFor(() => expect(stateOf(ledger.value).pending).toHaveLength(1))
    expect(resolved).toBe(false)
    expect(mutation).not.toHaveBeenCalled()

    wakeCanFinish.resolve()
    await enqueued
    expect(wake.create).toHaveBeenCalledTimes(2)
    expect(wake.create).toHaveBeenNthCalledWith(
      1,
      CAPTURE_OUTBOX_ALARM,
      1_000 + DURABLE_SIDE_EFFECT_WATCHDOG_MS,
    )
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce())
  })

  it('fails closed before append when its watchdog cannot be armed', async () => {
    const ledger = fakeLedger()
    const wake = fakeWake()
    wake.create = vi.fn<DurableWakePort['create']>(async () => {
      throw new Error('alarm unavailable')
    })
    const mutation = successfulMutation()
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings(),
      ledger,
      wake,
      connect: () => ({ mutation }),
      now: () => 1_000,
      reportError: vi.fn<(error: unknown) => void>(),
    })

    await expect(outbox.enqueueAccepted([record('1')], admission)).rejects.toThrow(
      'alarm unavailable',
    )
    expect(stateOf(ledger.value).pending).toHaveLength(0)
    expect(wake.create).toHaveBeenCalledOnce()
    expect(mutation).not.toHaveBeenCalled()
  })

  it('leaves a spurious pre-armed wake harmless when the append dies', async () => {
    const order: string[] = []
    const ledger: LedgerStorage = {
      get: async () => null,
      set: async () => {
        order.push('ledger')
        throw new Error('storage unavailable')
      },
    }
    const wake = fakeWake()
    wake.create = vi.fn<DurableWakePort['create']>(async () => {
      order.push('wake')
    })
    const mutation = successfulMutation()
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings(),
      ledger,
      wake,
      connect: () => ({ mutation }),
      now: () => 1_000,
    })

    await expect(outbox.enqueueAccepted([record('1')], admission)).rejects.toThrow(
      'storage unavailable',
    )
    expect(order).toEqual(['wake', 'ledger'])

    outbox.onWake()
    await vi.waitFor(() => expect(wake.clear).toHaveBeenCalledWith(CAPTURE_OUTBOX_ALARM))
    expect(mutation).not.toHaveBeenCalled()
  })

  it('does not start a remote mutation without a confirmed watchdog wake', async () => {
    const event = captureEventFromRecord(record('1'), 'admitted-device')
    const ledger = fakeLedger(stateWith([event]))
    const wake = fakeWake()
    wake.create = vi.fn<DurableWakePort['create']>(async () => {
      throw new Error('alarm unavailable')
    })
    const mutation = successfulMutation()
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings(),
      ledger,
      wake,
      connect: () => ({ mutation }),
      now: () => 1_000,
      reportError: vi.fn<(error: unknown) => void>(),
    })

    outbox.onWake()

    await vi.waitFor(() =>
      expect(stateOf(ledger.value).pending[0]).toMatchObject({
        consecutiveFailures: 1,
        nextAttemptAt: 6_000,
      }),
    )
    expect(mutation).not.toHaveBeenCalled()
  })

  it('rechecks consent after watchdog I/O before the remote mutation', async () => {
    const ledger = fakeLedger(stateWith([captureEventFromRecord(record('1'), 'admitted-device')]))
    let currentSettings = settings()
    const wake = fakeWake()
    wake.create = vi.fn<DurableWakePort['create']>(async () => {
      currentSettings = settings({ captureMirrorEnabled: false })
    })
    const mutation = successfulMutation()
    const outbox = makeCaptureOutbox({
      getSettings: async () => currentSettings,
      ledger,
      wake,
      connect: () => ({ mutation }),
      now: () => 1_000,
    })

    outbox.onWake()
    await vi.waitFor(() => expect(wake.clear).toHaveBeenCalledWith(CAPTURE_OUTBOX_ALARM))
    expect(mutation).not.toHaveBeenCalled()
    expect(stateOf(ledger.value).pending).toHaveLength(1)
  })

  it('uses credentials reread after watchdog I/O', async () => {
    const ledger = fakeLedger(stateWith([captureEventFromRecord(record('1'), 'admitted-device')]))
    let currentSettings = settings()
    const wake = fakeWake()
    wake.create = vi.fn<DurableWakePort['create']>(async () => {
      currentSettings = settings({ convexSyncSecret: 'rotated-secret' })
    })
    const mutation = successfulMutation()
    const outbox = makeCaptureOutbox({
      getSettings: async () => currentSettings,
      ledger,
      wake,
      connect: () => ({ mutation }),
      now: () => 1_000,
    })

    outbox.onWake()
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce())
    expect(mutation.mock.calls[0]?.[1]).toMatchObject({ secret: 'rotated-secret' })
  })

  it('uses admitted identity, record capturedAt, and remains independent of Media Sync', async () => {
    const ledger = fakeLedger()
    const mutation = vi.fn<
      (
        name: string,
        args: {
          captures: ReadonlyArray<{ captureId: string; deviceId: string; at: number }>
        },
      ) => Promise<unknown>
    >(async () => ({}))
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings({ cloudSyncEnabled: false }),
      ledger,
      wake: fakeWake(),
      connect: () => ({ mutation }),
      now: () => 1_000,
    })

    await outbox.enqueueAccepted([record('1', { capturedAt: 123 })], admission)
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledOnce())

    const args = mutation.mock.calls[0]![1]
    expect(args.captures[0]).toMatchObject({
      captureId: 'xmd:capture:v1:15:admitted-device:1:1',
      deviceId: 'admitted-device',
      at: 123,
    })
    expect(stateOf(ledger.value).pending).toHaveLength(0)
  })

  it('rereads a rotated secret but keeps the admitted device for batch two', async () => {
    const events = Array.from({ length: 65 }, (_, index) =>
      captureEventFromRecord(record(String(index + 1)), 'admitted-device'),
    )
    const ledger = fakeLedger(stateWith(events))
    const firstBatchStarted = deferred()
    const firstBatchCanFinish = deferred()
    let currentSettings = settings()
    const mutation = vi.fn<
      (
        name: string,
        args: {
          captures: ReadonlyArray<{ captureId: string; deviceId: string }>
          secret: string
        },
      ) => Promise<unknown>
    >(async () => {
      if (mutation.mock.calls.length === 1) {
        firstBatchStarted.resolve()
        await firstBatchCanFinish.promise
      }
      return {}
    })
    const outbox = makeCaptureOutbox({
      getSettings: async () => currentSettings,
      ledger,
      wake: fakeWake(),
      connect: () => ({ mutation }),
      now: () => 1_000,
    })

    outbox.onWake()
    await firstBatchStarted.promise
    currentSettings = settings({
      convexSyncSecret: 'rotated-secret',
      cloudDeviceId: 'rotated-device',
    })
    firstBatchCanFinish.resolve()
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(2))

    expect(mutation.mock.calls.map((call) => call[1].secret)).toEqual(['secret', 'rotated-secret'])
    expect(mutation.mock.calls[1]![1]).toMatchObject({
      captures: [
        {
          captureId: 'xmd:capture:v1:15:admitted-device:2:65',
          deviceId: 'admitted-device',
        },
      ],
    })
    expect(stateOf(ledger.value).pending).toEqual([])
  })

  it.each([
    {
      label: 'consent is disabled',
      rotate: () => settings({ captureMirrorEnabled: false }),
    },
    {
      label: 'the deployment changes',
      rotate: () => settings({ convexUrl: DESTINATION_B }),
    },
  ])('stops before batch two when $label', async ({ rotate }) => {
    const events = Array.from({ length: 65 }, (_, index) =>
      captureEventFromRecord(record(String(index + 1)), 'admitted-device'),
    )
    const ledger = fakeLedger(stateWith(events))
    const firstBatchStarted = deferred()
    const firstBatchCanFinish = deferred()
    let currentSettings = settings()
    const mutation = vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => {
      firstBatchStarted.resolve()
      await firstBatchCanFinish.promise
      return {}
    })
    const wake = fakeWake()
    const outbox = makeCaptureOutbox({
      getSettings: async () => currentSettings,
      ledger,
      wake,
      connect: () => ({ mutation }),
      now: () => 1_000,
    })

    outbox.onWake()
    await firstBatchStarted.promise
    currentSettings = rotate()
    firstBatchCanFinish.resolve()

    await vi.waitFor(() => expect(wake.clear).toHaveBeenCalledWith(CAPTURE_OUTBOX_ALARM))
    expect(mutation).toHaveBeenCalledOnce()
    expect(stateOf(ledger.value).pending).toHaveLength(1)
  })

  it('keeps each destination copy and drains only the current destination', async () => {
    const sameEvent = captureEventFromRecord(record('1'), 'admitted-device')
    const ledger = fakeLedger(stateWith([sameEvent]))
    const admissionWakeCanFinish = deferred()
    const wake = fakeWake()
    const create = vi.fn<DurableWakePort['create']>(async () => {
      if (create.mock.calls.length === 2) await admissionWakeCanFinish.promise
    })
    wake.create = create
    let currentSettings = settings({ convexUrl: DESTINATION_B })
    const calls: Array<{ destination: string; captureId: string }> = []
    const outbox = makeCaptureOutbox({
      getSettings: async () => currentSettings,
      ledger,
      wake,
      connect: (snapshot) => ({
        mutation: async (_name, args) => {
          const captures = (args as { captures: ReadonlyArray<{ captureId: string }> }).captures
          calls.push({
            destination: snapshot.convexUrl,
            captureId: captures[0]!.captureId,
          })
          return {}
        },
      }),
      now: () => 1_000,
    })
    const destinationBAdmission = { ...admission, destination: DESTINATION_B }

    const enqueued = outbox.enqueueAccepted([record('1')], destinationBAdmission)
    await vi.waitFor(() =>
      expect(stateOf(ledger.value).pending.map((item) => item.destination)).toEqual([
        DESTINATION_A,
        DESTINATION_B,
      ]),
    )
    admissionWakeCanFinish.resolve()
    await expect(enqueued).resolves.toBe('accepted')
    await vi.waitFor(() =>
      expect(stateOf(ledger.value).pending.map((item) => item.destination)).toEqual([
        DESTINATION_A,
      ]),
    )

    currentSettings = settings({ convexUrl: DESTINATION_A })
    outbox.resumeWhenEnabled()
    await vi.waitFor(() => expect(stateOf(ledger.value).pending).toEqual([]))
    expect(calls).toEqual([
      {
        destination: DESTINATION_B,
        captureId: 'xmd:capture:v1:15:admitted-device:1:1',
      },
      {
        destination: DESTINATION_A,
        captureId: 'xmd:capture:v1:15:admitted-device:1:1',
      },
    ])
  })

  it('preserves a count-full outbox and rejects the whole new mirror batch', async () => {
    const events = Array.from({ length: MAX_CAPTURE_OUTBOX_ITEMS }, (_, index) =>
      captureEventFromRecord(record(String(index + 1)), 'admitted-device'),
    )
    const full = stateWith(events)
    const ledger = fakeLedger(full)
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings({ captureMirrorEnabled: false }),
      ledger,
      wake: fakeWake(),
    })

    await expect(
      outbox.enqueueAccepted(
        [
          record(String(MAX_CAPTURE_OUTBOX_ITEMS + 1)),
          record(String(MAX_CAPTURE_OUTBOX_ITEMS + 2)),
        ],
        admission,
      ),
    ).resolves.toBe('unavailable')
    expect(ledger.value).toBe(full)
  })

  it('preserves a byte-full outbox and rejects the whole new mirror batch', async () => {
    const largeText = 'x'.repeat(240 * 1024)
    const records = Array.from({ length: 18 }, (_, index) =>
      record(String(index + 1), { text: largeText, rawText: largeText }),
    )
    const appended = appendCaptureEvents(
      emptyCaptureOutbox,
      records
        .slice(0, -1)
        .map((candidate) => captureEventFromRecord(candidate, admission.deviceId)),
      admission.destination,
      admission.acceptedAt,
    )
    if (appended.status === 'full') throw new Error('test fixture exceeded the byte cap')
    const state = appended.state
    const ledger = fakeLedger(state)
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings({ captureMirrorEnabled: false }),
      ledger,
      wake: fakeWake(),
    })

    await expect(outbox.enqueueAccepted([records.at(-1)!], admission)).resolves.toBe('unavailable')
    expect(ledger.value).toBe(state)
  })

  it('keeps a failed batch, backs it off, and arms the next wake', async () => {
    const ledger = fakeLedger()
    const wake = fakeWake()
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings(),
      ledger,
      wake,
      connect: () => ({
        mutation: vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => {
          throw new Error('503')
        }),
      }),
      now: () => 1_000,
    })

    await outbox.enqueueAccepted([record('1')], admission)
    await vi.waitFor(() => {
      expect(stateOf(ledger.value).pending[0]).toMatchObject({
        consecutiveFailures: 1,
        nextAttemptAt: 6_000,
      })
    })
    expect(wake.create).toHaveBeenCalledWith(CAPTURE_OUTBOX_ALARM, 6_000)
  })

  it('rebases a persisted deadline after rollback in a fresh outbox', async () => {
    const ledger = fakeLedger(stateWith([captureEventFromRecord(record('1'), 'admitted-device')]))
    const first = makeCaptureOutbox({
      getSettings: async () => settings(),
      ledger,
      wake: fakeWake(),
      connect: () => ({
        mutation: async () => {
          throw new Error('offline')
        },
      }),
      now: () => 1_000_000,
    })
    first.onWake()
    await vi.waitFor(() => expect(stateOf(ledger.value).pending[0]?.nextAttemptAt).toBe(1_005_000))

    const restartedWake = fakeWake()
    const restartedMutation = successfulMutation()
    const restarted = makeCaptureOutbox({
      getSettings: async () => settings(),
      ledger,
      wake: restartedWake,
      connect: () => ({ mutation: restartedMutation }),
      now: () => 1_000,
    })
    restarted.resumeOnBoot()

    await vi.waitFor(() => expect(stateOf(ledger.value).pending[0]?.nextAttemptAt).toBe(6_000))
    await vi.waitFor(() =>
      expect(restartedWake.create).toHaveBeenCalledWith(CAPTURE_OUTBOX_ALARM, 6_000),
    )
    expect(restartedMutation).not.toHaveBeenCalled()
  })

  it('arms rollback recovery before publishing the shortened deadline', async () => {
    const event = captureEventFromRecord(record('1'), 'admitted-device')
    const queued = stateWith([event])
    const stranded = markCaptureBatchFailed(
      queued,
      queued.generation,
      DESTINATION_A,
      [event.eventId],
      1_000_000,
    )
    const order: string[] = []
    const ledger: LedgerStorage = {
      get: async () => stranded,
      set: async () => {
        order.push('ledger')
        throw new Error('worker died after alarm')
      },
    }
    const wake = fakeWake()
    wake.create = vi.fn<DurableWakePort['create']>(async () => {
      order.push('wake')
    })
    const reportError = vi.fn<(error: unknown) => void>()
    const restarted = makeCaptureOutbox({
      getSettings: async () => settings(),
      ledger,
      wake,
      connect: () => ({ mutation: successfulMutation() }),
      reportError,
      now: () => 1_000,
    })

    restarted.resumeOnBoot()

    await vi.waitFor(() => expect(reportError).toHaveBeenCalledOnce())
    expect(order).toEqual(['wake', 'ledger'])
    expect(wake.create).toHaveBeenCalledWith(CAPTURE_OUTBOX_ALARM, 6_000)
    expect(stateOf(stranded).pending[0]?.nextAttemptAt).toBe(1_005_000)
  })

  it('serializes purge after an in-flight mutation, then fences old work', async () => {
    const event = captureEventFromRecord(record('1'), 'admitted-device')
    const ledger = fakeLedger(stateWith([event]))
    const mutationStarted = deferred()
    const mutationCanFinish = deferred()
    const mutation = vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => {
      mutationStarted.resolve()
      await mutationCanFinish.promise
      return {}
    })
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings(),
      ledger,
      wake: fakeWake(),
      connect: () => ({ mutation }),
      now: () => 1_000,
      generation: () => 'erase:1',
    })

    outbox.onWake()
    await mutationStarted.promise
    let purged = false
    const purge = outbox.purge().then(() => {
      purged = true
      return undefined
    })
    await Promise.resolve()
    expect(purged).toBe(false)

    mutationCanFinish.resolve()
    await purge
    expect(stateOf(ledger.value)).toMatchObject({ generation: 'erase:1', pending: [] })
    outbox.onWake()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mutation).toHaveBeenCalledOnce()
  })

  it('does not overwrite a corrupt ledger during admission', async () => {
    const corrupt = { version: 1, generation: 2, pending: 'lost' }
    const ledger = fakeLedger(corrupt)
    const reportError = vi.fn<(error: unknown) => void>()
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings(),
      ledger,
      wake: fakeWake(),
      reportError,
    })

    await expect(outbox.enqueueAccepted([record('1')], admission)).rejects.toThrow('corrupt')
    expect(ledger.value).toBe(corrupt)
    expect(reportError).toHaveBeenCalled()
  })

  it('uses explicit erase to replace corruption with a fresh fenced epoch', async () => {
    const corrupt = { version: 1, generation: 2, pending: 'lost' }
    const ledger = fakeLedger(corrupt)
    const wake = fakeWake()
    const outbox = makeCaptureOutbox({
      ledger,
      wake,
      generation: () => 'erase:corrupt',
      getSettings: async () => settings({ captureMirrorEnabled: false }),
    })

    await expect(outbox.purge()).resolves.toBe('erase:corrupt')

    expect(stateOf(ledger.value)).toEqual({
      version: 2,
      generation: 'erase:corrupt',
      pending: [],
    })
    expect(wake.clear).toHaveBeenCalledWith(CAPTURE_OUTBOX_ALARM)
  })

  it('preserves pending work but clears its wake while current consent is off', async () => {
    const event = captureEventFromRecord(record('1'), 'admitted-device')
    const ledger = fakeLedger(stateWith([event]))
    const wake = fakeWake()
    const mutation = successfulMutation()
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings({ captureMirrorEnabled: false }),
      ledger,
      wake,
      connect: () => ({ mutation }),
      now: () => 1_000,
    })

    outbox.resumeWhenEnabled()
    await vi.waitFor(() => expect(wake.clear).toHaveBeenCalledWith(CAPTURE_OUTBOX_ALARM))
    expect(mutation).not.toHaveBeenCalled()
    expect(stateOf(ledger.value).pending).toHaveLength(1)
  })

  it('preserves another destination without arming a hot-loop alarm', async () => {
    const event = captureEventFromRecord(record('1'), 'admitted-device')
    const ledger = fakeLedger(stateWith([event]))
    const wake = fakeWake()
    const mutation = successfulMutation()
    const outbox = makeCaptureOutbox({
      getSettings: async () => settings({ convexUrl: DESTINATION_B }),
      ledger,
      wake,
      connect: () => ({ mutation }),
      now: () => 1_000,
    })

    outbox.onWake()
    await vi.waitFor(() => expect(wake.clear).toHaveBeenCalledWith(CAPTURE_OUTBOX_ALARM))
    expect(wake.create).not.toHaveBeenCalled()
    expect(mutation).not.toHaveBeenCalled()
    expect(stateOf(ledger.value).pending).toHaveLength(1)
  })
})
