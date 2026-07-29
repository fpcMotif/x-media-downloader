import { describe, expect, it } from 'vitest'
import type { TweetRecord } from '../capture/record'
import { measureJsonBytes } from '../wire/json-budget'
import {
  CAPTURE_OUTBOX_BATCH,
  MAX_CAPTURE_MIRROR_EVENT_BYTES,
  MAX_CAPTURE_OUTBOX_BYTES,
  MAX_CAPTURE_OUTBOX_ITEMS,
  appendCaptureEvents,
  captureEventFromRecord,
  captureEventId,
  decodeCaptureOutboxResult,
  earliestCaptureAttempt,
  emptyCaptureOutbox,
  markCaptureBatchDrained,
  markCaptureBatchFailed,
  purgeCaptureOutbox,
  rebaseCaptureRetryDeadlines,
  takeCaptureBatch,
  type CaptureOutboxState,
  type SyncCaptureEvent,
} from './captures'

const record = (tweetId: string, overrides: Partial<TweetRecord> = {}): TweetRecord => ({
  tweetId,
  conversationId: tweetId,
  author: { handle: 'alice' },
  text: 'hello',
  rawText: 'hello',
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'timeline',
  sourceRank: 1,
  capturedAt: 1_000,
  ...overrides,
})

const event = (tweetId = '1', at = 1_000): SyncCaptureEvent =>
  captureEventFromRecord(record(tweetId, { capturedAt: at }), 'device')

const DESTINATION_A = 'https://a.convex.cloud'
const DESTINATION_B = 'https://b.convex.cloud'

const acceptedState = (
  state: CaptureOutboxState,
  events: ReadonlyArray<SyncCaptureEvent>,
  at = 1_000,
  destination = DESTINATION_A,
): CaptureOutboxState => {
  const appended = appendCaptureEvents(state, events, destination, at)
  if (appended.status === 'full') throw new Error('test append was full')
  return appended.state
}

const stateWith = (...events: SyncCaptureEvent[]): CaptureOutboxState =>
  acceptedState(emptyCaptureOutbox, events)

describe('Capture Mirror event identity and projection', () => {
  it('uses an injective length-prefixed identity', () => {
    expect(captureEventId('a', '12')).not.toBe(captureEventId('a1', '2'))
    expect(captureEventId('a/b', '12')).not.toBe(captureEventId('a', 'b/12'))
    expect(captureEventId('device', '1')).toBe('xmd:capture:v1:6:device:1:1')
  })

  it('projects only admitted mirror fields and persists device identity', () => {
    const projected = captureEventFromRecord(
      record('9', {
        conversationId: '8',
        inReplyToTweetId: '7',
        author: { handle: 'bob' },
        text: 'expanded',
        rawText: 'local only',
        media: [{ id: 'm', type: 'photo', url: 'https://x.test/a', ext: 'jpg', index: 0 }],
        links: [{ expandedUrl: 'https://a.test', title: 'A', domain: 'a.test' }],
        source: 'tweetDetail',
        sourceRank: 2,
        capturedAt: 7_000,
      }),
      'dev',
    )

    expect(projected).toEqual({
      eventId: 'xmd:capture:v1:3:dev:1:9',
      deviceId: 'dev',
      tweetId: '9',
      conversationId: '8',
      inReplyToTweetId: '7',
      handle: 'bob',
      text: 'expanded',
      links: [{ expandedUrl: 'https://a.test', title: 'A', domain: 'a.test' }],
      sourceRank: 2,
      at: 7_000,
    })
    expect(projected).not.toHaveProperty('rawText')
    expect(projected).not.toHaveProperty('media')
  })
})

describe('Capture outbox codec', () => {
  it('round-trips exact current state and treats absence as empty', () => {
    const state = stateWith(event())
    expect(decodeCaptureOutboxResult(JSON.parse(JSON.stringify(state)))).toEqual({
      status: 'available',
      state,
    })
    expect(decodeCaptureOutboxResult(null)).toEqual({
      status: 'available',
      state: emptyCaptureOutbox,
    })
  })

  it('keeps corruption visible to durable writers', () => {
    const corrupt = { version: 1, generation: 0, pending: 'lost' }
    expect(decodeCaptureOutboxResult(corrupt)).toEqual({ status: 'corrupt' })
  })

  it('rejects excess, forged, duplicate, stale-generation, and oversized state', () => {
    const valid = stateWith(event())
    const item = valid.pending[0]!
    const corrupt = [
      { ...valid, extra: true },
      { ...valid, pending: [{ ...item, extra: true }] },
      {
        ...valid,
        pending: [{ ...item, event: { ...item.event, eventId: 'forged' } }],
      },
      { ...valid, pending: [item, item] },
      { ...valid, pending: [{ ...item, generation: 'stale' }] },
      { ...valid, pending: [{ ...item, destination: 'https://A.convex.cloud/' }] },
      { ...valid, padding: 'x'.repeat(MAX_CAPTURE_OUTBOX_BYTES) },
    ]
    for (const raw of corrupt)
      expect(decodeCaptureOutboxResult(raw)).toEqual({
        status: 'corrupt',
      })
  })

  it('rejects persisted state that cannot grow its retry metadata safely', () => {
    const baseText = 'x'.repeat(240 * 1024)
    const events = Array.from({ length: 16 }, (_, index) =>
      captureEventFromRecord(
        record(String(index + 1), { text: baseText, capturedAt: index + 1 }),
        'device',
      ),
    )
    const base: CaptureOutboxState = {
      ...emptyCaptureOutbox,
      pending: events.map((capture) => ({
        generation: emptyCaptureOutbox.generation,
        destination: DESTINATION_A,
        event: capture,
        consecutiveFailures: 0,
        nextAttemptAt: 0,
      })),
    }
    const baseBytes = measureJsonBytes(base, MAX_CAPTURE_OUTBOX_BYTES)
    if (baseBytes === undefined) throw new Error('test base exceeded the outbox cap')
    const growth = MAX_CAPTURE_OUTBOX_BYTES - baseBytes - 1
    const growthPerEvent = Math.floor(growth / events.length)
    const remainder = growth % events.length
    const pending = []
    for (const [index, item] of base.pending.entries())
      pending.push({
        ...item,
        event: {
          ...item.event,
          text: `${item.event.text}${'x'.repeat(growthPerEvent + (index === 0 ? remainder : 0))}`,
        },
      })
    const nearLimit: CaptureOutboxState = {
      ...base,
      pending,
    }

    expect(growth).toBeGreaterThan(0)
    expect(measureJsonBytes(nearLimit, MAX_CAPTURE_OUTBOX_BYTES)).toBe(MAX_CAPTURE_OUTBOX_BYTES - 1)
    expect(
      nearLimit.pending.every(
        (item) => measureJsonBytes(item.event, MAX_CAPTURE_MIRROR_EVENT_BYTES) !== undefined,
      ),
    ).toBe(true)
    expect(decodeCaptureOutboxResult(nearLimit)).toEqual({ status: 'corrupt' })
  })

  it('migrates only slash-free legacy device identities', () => {
    const current = event()
    const { deviceId: _deviceId, ...withoutDevice } = current
    const legacy = { ...withoutDevice, eventId: 'legacy-device/1' }
    expect(decodeCaptureOutboxResult([legacy])).toMatchObject({
      status: 'available',
      state: {
        pending: [
          {
            destination: null,
            event: {
              eventId: 'legacy-device/1',
              deviceId: 'legacy-device',
            },
          },
        ],
      },
    })

    expect(decodeCaptureOutboxResult([{ ...legacy, eventId: 'legacy/device/1' }])).toEqual({
      status: 'corrupt',
    })
  })

  it('migrates the numbered v1 erase generation into a non-colliding namespace', () => {
    const current = event()
    expect(
      decodeCaptureOutboxResult({
        version: 1,
        generation: 7,
        pending: [
          {
            generation: 7,
            event: current,
            consecutiveFailures: 0,
            nextAttemptAt: 0,
          },
        ],
      }),
    ).toEqual({
      status: 'available',
      state: {
        version: 2,
        generation: 'legacy:7',
        pending: [
          {
            generation: 'legacy:7',
            destination: null,
            event: current,
            consecutiveFailures: 0,
            nextAttemptAt: 0,
          },
        ],
      },
    })
  })

  it('retains legacy retry metadata but leaves its unknown destination unbound', () => {
    const current = event()
    const { deviceId: _deviceId, ...withoutDevice } = current
    const retry = {
      pending: [
        {
          event: { ...withoutDevice, eventId: 'legacy-device/1' },
          consecutiveFailures: 2,
          nextAttemptAt: 8_000,
        },
      ],
    }

    expect(decodeCaptureOutboxResult(retry)).toMatchObject({
      status: 'available',
      state: {
        version: 2,
        generation: 'legacy:0',
        pending: [
          {
            destination: null,
            consecutiveFailures: 2,
            nextAttemptAt: 8_000,
            event: { deviceId: 'legacy-device' },
          },
        ],
      },
    })
    expect(
      decodeCaptureOutboxResult({
        pending: [
          {
            ...retry.pending[0],
            event: { ...retry.pending[0]!.event, eventId: 'legacy-device/2' },
          },
        ],
      }),
    ).toEqual({ status: 'corrupt' })
    expect(
      decodeCaptureOutboxResult({
        pending: [
          {
            ...retry.pending[0],
            event: {
              ...retry.pending[0]!.event,
              text: 'x'.repeat(MAX_CAPTURE_MIRROR_EVENT_BYTES),
            },
          },
        ],
      }),
    ).toEqual({ status: 'corrupt' })
  })
})

describe('Capture outbox reducer', () => {
  it('deduplicates within one destination but preserves the same event for another', () => {
    const original = event()
    const destinationA = stateWith(original)
    const both = acceptedState(destinationA, [original], 2_000, DESTINATION_B)
    const replacedA = acceptedState(
      both,
      [captureEventFromRecord(record('1', { text: 'new A', capturedAt: 3_000 }), 'device')],
      3_000,
      DESTINATION_A,
    )

    expect(replacedA.pending).toHaveLength(2)
    expect(replacedA.pending).toEqual([
      expect.objectContaining({ destination: DESTINATION_B }),
      expect.objectContaining({
        destination: DESTINATION_A,
        event: expect.objectContaining({ text: 'new A' }),
      }),
    ])
    expect(takeCaptureBatch(replacedA, DESTINATION_A, 3_000)).toHaveLength(1)
    expect(takeCaptureBatch(replacedA, DESTINATION_B, 3_000)).toHaveLength(1)
  })

  it('uses the local rank-then-capturedAt law for pending mirror work', () => {
    const rich = captureEventFromRecord(
      record('1', {
        sourceRank: 2,
        source: 'tweetDetail',
        text: 'rich',
        capturedAt: 2_000,
      }),
      'device',
    )
    const thinLaterAdmission = captureEventFromRecord(
      record('1', { sourceRank: 1, text: 'thin', capturedAt: 3_000 }),
      'device',
    )
    const olderRichRetry = captureEventFromRecord(
      record('1', {
        sourceRank: 2,
        source: 'tweetDetail',
        text: 'old retry',
        capturedAt: 1_000,
      }),
      'device',
    )
    const state = acceptedState(emptyCaptureOutbox, [rich], 10_000)
    const afterThin = acceptedState(state, [thinLaterAdmission], 20_000)
    const afterOldRetry = acceptedState(afterThin, [olderRichRetry], 30_000)

    expect(afterOldRetry.pending).toEqual(state.pending)
    expect(afterOldRetry.pending[0]?.event).toMatchObject({
      text: 'rich',
      sourceRank: 2,
      at: 2_000,
    })
    expect(afterOldRetry.pending[0]?.nextAttemptAt).toBe(10_000)
  })

  it('replaces the same Tweet but rejects a new unique event when count is full', () => {
    const events = Array.from({ length: MAX_CAPTURE_OUTBOX_ITEMS }, (_, index) =>
      event(String(index + 1), index + 1),
    )
    const state = acceptedState(emptyCaptureOutbox, events)

    expect(state.pending).toHaveLength(MAX_CAPTURE_OUTBOX_ITEMS)
    expect(state.pending[0]?.event.tweetId).toBe('1')
    expect(
      appendCaptureEvents(
        state,
        [event(String(MAX_CAPTURE_OUTBOX_ITEMS + 1))],
        DESTINATION_A,
        9_000,
      ),
    ).toEqual({ status: 'full' })
    const replaced = acceptedState(
      state,
      [captureEventFromRecord(record('2', { text: 'new', capturedAt: 9_000 }), 'device')],
      9_000,
    )
    expect(replaced.pending).toHaveLength(MAX_CAPTURE_OUTBOX_ITEMS)
    expect(replaced.pending.at(-1)?.event).toMatchObject({ tweetId: '2', text: 'new' })
  })

  it('also caps whole-state bytes without dropping the newest valid event', () => {
    const text = 'x'.repeat(240 * 1024)
    const events = Array.from({ length: 24 }, (_, index) =>
      captureEventFromRecord(record(String(index + 1), { text, capturedAt: index + 1 }), 'device'),
    )
    const appended = appendCaptureEvents(emptyCaptureOutbox, events, DESTINATION_A, 1_000)

    expect(appended).toEqual({ status: 'full' })
    expect(emptyCaptureOutbox.pending).toEqual([])
  })

  it('rejects a non-canonical destination without changing state', () => {
    expect(
      appendCaptureEvents(emptyCaptureOutbox, [event()], 'https://A.convex.cloud/', 1_000),
    ).toEqual({ status: 'full' })
    expect(emptyCaptureOutbox.pending).toEqual([])
  })

  it('rejects malformed or over-budget runtime events atomically', () => {
    const malformed = { ...event(), sourceRank: 3 }
    const oversized = { ...event(), text: 'x'.repeat(MAX_CAPTURE_MIRROR_EVENT_BYTES) }

    expect(appendCaptureEvents(emptyCaptureOutbox, [malformed], DESTINATION_A, 1_000)).toEqual({
      status: 'full',
    })
    expect(appendCaptureEvents(emptyCaptureOutbox, [oversized], DESTINATION_A, 1_000)).toEqual({
      status: 'full',
    })
    expect(emptyCaptureOutbox.pending).toEqual([])
  })

  it('bounds batch selection and computes the earliest eligible wake', () => {
    const events = Array.from({ length: CAPTURE_OUTBOX_BATCH + 1 }, (_, index) =>
      event(String(index + 1), index + 1),
    )
    const destinationA = acceptedState(emptyCaptureOutbox, events, 1_000)
    const both = acceptedState(destinationA, [event('100', 2_000)], 2_000, DESTINATION_B)

    expect(takeCaptureBatch(both, DESTINATION_A, 1_000, 0)).toEqual([])
    expect(takeCaptureBatch(both, DESTINATION_A, 1_000, -1)).toHaveLength(CAPTURE_OUTBOX_BATCH)
    expect(takeCaptureBatch(both, DESTINATION_A, 1_000, 10_000)).toHaveLength(CAPTURE_OUTBOX_BATCH)
    expect(earliestCaptureAttempt(both, DESTINATION_A)).toBe(1_000)
    expect(earliestCaptureAttempt(both, DESTINATION_B)).toBe(2_000)
    expect(earliestCaptureAttempt(both, 'https://missing.convex.cloud')).toBeUndefined()
  })

  it('backs off exact current-generation ids and ignores stale completions', () => {
    const state = stateWith(event('1'), event('2'))
    const batch = takeCaptureBatch(state, DESTINATION_A, 1_000)
    const ids = batch.map((item) => item.event.eventId)
    const failed = markCaptureBatchFailed(state, state.generation, DESTINATION_A, [ids[0]!], 1_000)
    expect(failed.pending[0]).toMatchObject({
      consecutiveFailures: 1,
      nextAttemptAt: 6_000,
    })
    expect(markCaptureBatchDrained(failed, 'stale', DESTINATION_A, ids)).toBe(failed)
    expect(markCaptureBatchDrained(failed, state.generation, DESTINATION_A, ids).pending).toEqual(
      [],
    )
    expect(markCaptureBatchDrained(failed, state.generation, DESTINATION_A, ['missing'])).toBe(
      failed,
    )
    expect(markCaptureBatchFailed(failed, state.generation, DESTINATION_A, ids, -1)).toBe(failed)
  })

  it('rebases implausible persisted deadlines after wall-clock rollback', () => {
    const admitted = stateWith(event())
    const failed = markCaptureBatchFailed(
      admitted,
      admitted.generation,
      DESTINATION_A,
      [event().eventId],
      1_000_000,
    )

    expect(rebaseCaptureRetryDeadlines(failed, 1_000, 30_000)).toEqual({
      ...failed,
      pending: [{ ...failed.pending[0]!, nextAttemptAt: 6_000 }],
    })
    expect(rebaseCaptureRetryDeadlines(failed, 1_004_000, 30_000)).toBe(failed)
  })

  it('purges pending work and increments the erase generation', () => {
    const state = stateWith(event())
    const purged = purgeCaptureOutbox(state, 'erase:1')

    expect(purged).toEqual({ version: 2, generation: 'erase:1', pending: [] })
    expect(
      markCaptureBatchDrained(purged, state.generation, DESTINATION_A, [event().eventId]),
    ).toBe(purged)
  })

  it('requires a fresh bounded erase generation', () => {
    expect(() => purgeCaptureOutbox(emptyCaptureOutbox, 'initial')).toThrow('generation is invalid')
    expect(() => purgeCaptureOutbox(emptyCaptureOutbox, 'bad generation')).toThrow(
      'generation is invalid',
    )
  })
})
