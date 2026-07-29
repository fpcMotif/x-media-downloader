import { Schema } from 'effect'
import { MAX_CAPTURE_RECORD_BYTES } from '../capture/contract'
import {
  MAX_CAPTURE_HANDLE_LENGTH,
  MAX_CAPTURE_LINKS,
  MAX_CAPTURE_URL_LENGTH,
  type TweetRecord,
} from '../capture/record-schema'
import { CaptureEpoch } from '../capture/epoch'
import { incomingCaptureWins } from '../capture/revision'
import { MAX_CLOUD_DEVICE_ID_LENGTH, MAX_SETTINGS_URL_LENGTH } from '../schema/settings'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { normalizeConvexDeploymentUrl } from './convex'

/** Count remains a second guard; the byte cap is the real storage.local bound. */
export const MAX_CAPTURE_OUTBOX_ITEMS = 2_000
export const MAX_CAPTURE_OUTBOX_BYTES = 4 * 1024 * 1024
export const MAX_CAPTURE_MIRROR_EVENT_BYTES = MAX_CAPTURE_RECORD_BYTES + 16 * 1024
export const CAPTURE_OUTBOX_VERSION = 2
export const CAPTURE_OUTBOX_BATCH = 64

const BACKOFF_BASE_MS = 5_000
const BACKOFF_CAP_MS = 300_000
const BACKOFF_CAP_FAILURE_COUNT = 7
const CAPTURE_EVENT_PREFIX = 'xmd:capture:v1:'

const nonnegativeSafeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
const Snowflake = Schema.String.check(Schema.isPattern(/^\d{1,20}$/u))
const DeviceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CLOUD_DEVICE_ID_LENGTH),
)
const Handle = Schema.String.check(Schema.isMaxLength(MAX_CAPTURE_HANDLE_LENGTH))
const Url = Schema.String.check(Schema.isMaxLength(MAX_CAPTURE_URL_LENGTH))
const CaptureLink = Schema.Struct({
  expandedUrl: Url,
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  domain: Schema.optional(Schema.String.check(Schema.isMaxLength(255))),
})
const CaptureLinks = Schema.Array(CaptureLink).check(Schema.isMaxLength(MAX_CAPTURE_LINKS))

const MAX_CAPTURE_EVENT_ID_LENGTH = captureEventId(
  'd'.repeat(MAX_CLOUD_DEVICE_ID_LENGTH),
  '9'.repeat(20),
).length
const CaptureEventId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CAPTURE_EVENT_ID_LENGTH),
)
const CaptureDestination = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SETTINGS_URL_LENGTH),
)

/**
 * One tweet's mirror-eligible projection. Device identity is durable data, not
 * late-bound Settings: a later Settings change cannot rewrite admission.
 */
export const SyncCaptureEvent = Schema.Struct({
  eventId: CaptureEventId,
  deviceId: DeviceId,
  tweetId: Snowflake,
  conversationId: Snowflake,
  inReplyToTweetId: Schema.optional(Snowflake),
  handle: Handle,
  text: Schema.String,
  createdAt: Schema.optional(nonnegativeSafeInteger),
  links: Schema.optional(CaptureLinks),
  sourceRank: Schema.Literals([1, 2]),
  at: nonnegativeSafeInteger,
})
export type SyncCaptureEvent = typeof SyncCaptureEvent.Type

const LegacySyncCaptureEvent = Schema.Struct({
  eventId: Schema.String.check(
    Schema.isMinLength(3),
    Schema.isMaxLength(MAX_CLOUD_DEVICE_ID_LENGTH + 1 + 20),
  ),
  tweetId: Snowflake,
  conversationId: Snowflake,
  inReplyToTweetId: Schema.optional(Snowflake),
  handle: Handle,
  text: Schema.String,
  createdAt: Schema.optional(nonnegativeSafeInteger),
  links: Schema.optional(CaptureLinks),
  sourceRank: Schema.Literals([1, 2]),
  at: nonnegativeSafeInteger,
})
type LegacySyncCaptureEvent = typeof LegacySyncCaptureEvent.Type

export interface CaptureOutboxItem {
  readonly generation: string
  /** Null means retained legacy work whose original destination is unknowable. */
  readonly destination: string | null
  readonly event: SyncCaptureEvent
  readonly consecutiveFailures: number
  readonly nextAttemptAt: number
}

export interface CaptureOutboxState {
  readonly version: typeof CAPTURE_OUTBOX_VERSION
  readonly generation: string
  readonly pending: ReadonlyArray<CaptureOutboxItem>
}

const CaptureOutboxItemSchema = Schema.Struct({
  generation: CaptureEpoch,
  destination: Schema.NullOr(CaptureDestination),
  event: SyncCaptureEvent,
  consecutiveFailures: nonnegativeSafeInteger,
  nextAttemptAt: nonnegativeSafeInteger,
})
const CaptureOutboxStateSchema = Schema.Struct({
  version: Schema.Literals([CAPTURE_OUTBOX_VERSION]),
  generation: CaptureEpoch,
  pending: Schema.Array(CaptureOutboxItemSchema).check(
    Schema.isMaxLength(MAX_CAPTURE_OUTBOX_ITEMS),
  ),
})
const V1CaptureOutboxItemSchema = Schema.Struct({
  generation: nonnegativeSafeInteger,
  event: SyncCaptureEvent,
  consecutiveFailures: nonnegativeSafeInteger,
  nextAttemptAt: nonnegativeSafeInteger,
})
const V1CaptureOutboxStateSchema = Schema.Struct({
  version: Schema.Literals([1]),
  generation: nonnegativeSafeInteger,
  pending: Schema.Array(V1CaptureOutboxItemSchema).check(
    Schema.isMaxLength(MAX_CAPTURE_OUTBOX_ITEMS),
  ),
})

const LegacyRetryItem = Schema.Struct({
  event: LegacySyncCaptureEvent,
  consecutiveFailures: nonnegativeSafeInteger,
  nextAttemptAt: nonnegativeSafeInteger,
})
const LegacyRetryState = Schema.Struct({
  pending: Schema.Array(LegacyRetryItem).check(Schema.isMaxLength(MAX_CAPTURE_OUTBOX_ITEMS)),
})
const LegacyLedger = Schema.Array(LegacySyncCaptureEvent).check(
  Schema.isMaxLength(MAX_CAPTURE_OUTBOX_ITEMS),
)

export const emptyCaptureOutbox: CaptureOutboxState = {
  version: CAPTURE_OUTBOX_VERSION,
  generation: 'initial',
  pending: [],
}

const optionalEntry = <K extends string, V>(key: K, value: V | undefined): Record<K, V> | object =>
  value === undefined ? {} : ({ [key]: value } as Record<K, V>)

/** Injective identity. Delimiters inside either input cannot collide. */
export function captureEventId(deviceId: string, tweetId: string): string {
  return `${CAPTURE_EVENT_PREFIX}${deviceId.length}:${deviceId}:${tweetId.length}:${tweetId}`
}

const legacyCaptureEventId = (deviceId: string, tweetId: string): string => `${deviceId}/${tweetId}`

const eventIdentityVersion = (
  eventId: string,
  deviceId: string,
  tweetId: string,
): 'current' | 'legacy' | undefined =>
  eventId === captureEventId(deviceId, tweetId)
    ? 'current'
    : !deviceId.includes('/') && eventId === legacyCaptureEventId(deviceId, tweetId)
      ? 'legacy'
      : undefined

const decodeExact = <A>(schema: Schema.ConstraintDecoder<A>, raw: unknown): A | undefined => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(raw)
  } catch {
    return undefined
  }
}

const decodeCurrentEvent = (
  raw: unknown,
  allowLegacyIdentity: boolean,
): SyncCaptureEvent | undefined => {
  if (!isJsonWithinByteBudget(raw, MAX_CAPTURE_MIRROR_EVENT_BYTES)) return undefined
  const event = decodeExact(SyncCaptureEvent, raw)
  if (event === undefined) return undefined
  const identity = eventIdentityVersion(event.eventId, event.deviceId, event.tweetId)
  return identity === 'current' || (allowLegacyIdentity && identity === 'legacy')
    ? event
    : undefined
}

const migrateLegacyEvent = (event: LegacySyncCaptureEvent): SyncCaptureEvent | undefined => {
  if (!isJsonWithinByteBudget(event, MAX_CAPTURE_MIRROR_EVENT_BYTES)) return undefined
  const suffix = `/${event.tweetId}`
  if (!event.eventId.endsWith(suffix)) return undefined
  const deviceId = event.eventId.slice(0, -suffix.length)
  if (
    deviceId.length === 0 ||
    deviceId.length > MAX_CLOUD_DEVICE_ID_LENGTH ||
    deviceId.includes('/') ||
    event.eventId !== legacyCaptureEventId(deviceId, event.tweetId)
  )
    return undefined
  return { ...event, deviceId }
}

/** Project one accepted Tweet Record using its immutable mirror admission. */
export function captureEventFromRecord(record: TweetRecord, deviceId: string): SyncCaptureEvent {
  return {
    eventId: captureEventId(deviceId, record.tweetId),
    deviceId,
    tweetId: record.tweetId,
    conversationId: record.conversationId,
    ...optionalEntry('inReplyToTweetId', record.inReplyToTweetId),
    handle: record.author.handle,
    text: record.text,
    ...optionalEntry('createdAt', record.createdAt),
    ...optionalEntry(
      'links',
      record.links.length === 0
        ? undefined
        : record.links.map((link) => ({
            expandedUrl: link.expandedUrl,
            ...optionalEntry('title', link.title),
            ...optionalEntry('domain', link.domain),
          })),
    ),
    sourceRank: record.sourceRank,
    at: record.capturedAt,
  }
}

const validPending = (state: CaptureOutboxState, allowLegacyIdentity: boolean): boolean => {
  const eventIdsByDestination = new Map<string | null, Set<string>>()
  for (const item of state.pending) {
    const eventIds = eventIdsByDestination.get(item.destination) ?? new Set<string>()
    if (
      item.generation !== state.generation ||
      (item.destination !== null &&
        normalizeConvexDeploymentUrl(item.destination) !== item.destination) ||
      decodeCurrentEvent(item.event, allowLegacyIdentity) === undefined ||
      eventIds.has(item.event.eventId)
    )
      return false
    eventIds.add(item.event.eventId)
    eventIdsByDestination.set(item.destination, eventIds)
  }
  return true
}

const legacyGeneration = (generation: number): string => `legacy:${generation}`

const migrateLegacy = (raw: unknown): CaptureOutboxState | undefined => {
  const v1 = decodeExact(V1CaptureOutboxStateSchema, raw)
  if (v1 !== undefined) {
    const generation = legacyGeneration(v1.generation)
    const pending: CaptureOutboxItem[] = []
    for (const item of v1.pending) pending.push({ ...item, generation, destination: null })
    return { version: CAPTURE_OUTBOX_VERSION, generation, pending }
  }
  const retry = decodeExact(LegacyRetryState, raw)
  if (retry !== undefined) {
    const pending: CaptureOutboxItem[] = []
    for (const item of retry.pending) {
      const event = migrateLegacyEvent(item.event)
      if (event === undefined) return undefined
      pending.push({ ...item, generation: legacyGeneration(0), destination: null, event })
    }
    return {
      version: CAPTURE_OUTBOX_VERSION,
      generation: legacyGeneration(0),
      pending,
    }
  }
  const ledger = decodeExact(LegacyLedger, raw)
  if (ledger === undefined) return undefined
  const pending: CaptureOutboxItem[] = []
  for (const rawEvent of ledger) {
    const event = migrateLegacyEvent(rawEvent)
    if (event === undefined) return undefined
    pending.push({
      generation: legacyGeneration(0),
      destination: null,
      event,
      consecutiveFailures: 0,
      nextAttemptAt: 0,
    })
  }
  return {
    version: CAPTURE_OUTBOX_VERSION,
    generation: legacyGeneration(0),
    pending,
  }
}

export type CaptureOutboxDecodeResult =
  | { readonly status: 'available'; readonly state: CaptureOutboxState }
  | { readonly status: 'corrupt' }

const hasRetryHeadroom = (state: CaptureOutboxState): boolean =>
  isJsonWithinByteBudget(
    {
      ...state,
      pending: state.pending.map((item) => ({
        ...item,
        consecutiveFailures: Number.MAX_SAFE_INTEGER,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
      })),
    },
    MAX_CAPTURE_OUTBOX_BYTES,
  )

/** Strict persisted-state codec. Absence is empty; corruption stays visible. */
export function decodeCaptureOutboxResult(raw: unknown): CaptureOutboxDecodeResult {
  if (raw === null || raw === undefined) return { status: 'available', state: emptyCaptureOutbox }
  if (!isJsonWithinByteBudget(raw, MAX_CAPTURE_OUTBOX_BYTES)) return { status: 'corrupt' }
  const current = decodeExact(CaptureOutboxStateSchema, raw)
  if (current !== undefined)
    return validPending(current, true) && hasRetryHeadroom(current)
      ? { status: 'available', state: current }
      : { status: 'corrupt' }
  const migrated = migrateLegacy(raw)
  return migrated !== undefined && validPending(migrated, true) && hasRetryHeadroom(migrated)
    ? { status: 'available', state: migrated }
    : { status: 'corrupt' }
}

export type AppendCaptureEventsResult =
  | { readonly status: 'accepted'; readonly state: CaptureOutboxState }
  | { readonly status: 'full' }

/** Append one whole accepted batch. Existing pending authority is never evicted. */
export function appendCaptureEvents(
  state: CaptureOutboxState,
  events: ReadonlyArray<unknown>,
  destination: string,
  at: number,
): AppendCaptureEventsResult {
  if (
    normalizeConvexDeploymentUrl(destination) !== destination ||
    !Number.isSafeInteger(at) ||
    at < 0
  )
    return { status: 'full' }
  let pending = [...state.pending]
  for (const candidate of events) {
    const event = decodeCurrentEvent(candidate, false)
    if (event === undefined) return { status: 'full' }
    const existing = pending.find(
      (item) => item.destination === destination && item.event.eventId === event.eventId,
    )
    if (
      existing !== undefined &&
      !incomingCaptureWins(
        { sourceRank: existing.event.sourceRank, capturedAt: existing.event.at },
        { sourceRank: event.sourceRank, capturedAt: event.at },
      )
    )
      continue
    pending = [
      ...pending.filter(
        (item) => item.destination !== destination || item.event.eventId !== event.eventId,
      ),
      {
        generation: state.generation,
        destination,
        event,
        consecutiveFailures: 0,
        nextAttemptAt: at,
      },
    ]
  }
  const next = { ...state, pending }
  return pending.length <= MAX_CAPTURE_OUTBOX_ITEMS && hasRetryHeadroom(next)
    ? { status: 'accepted', state: next }
    : { status: 'full' }
}

export function takeCaptureBatch(
  state: CaptureOutboxState,
  destination: string,
  now: number,
  maximum = CAPTURE_OUTBOX_BATCH,
): ReadonlyArray<CaptureOutboxItem> {
  const limit =
    Number.isSafeInteger(maximum) && maximum >= 0
      ? Math.min(maximum, CAPTURE_OUTBOX_BATCH)
      : CAPTURE_OUTBOX_BATCH
  return state.pending
    .filter(
      (item) =>
        item.generation === state.generation &&
        item.destination === destination &&
        item.nextAttemptAt <= now,
    )
    .slice(0, limit)
}

export function markCaptureBatchDrained(
  state: CaptureOutboxState,
  generation: string,
  destination: string,
  eventIds: ReadonlyArray<string>,
): CaptureOutboxState {
  if (generation !== state.generation) return state
  const sent = new Set(eventIds)
  const pending = state.pending.filter(
    (item) => item.destination !== destination || !sent.has(item.event.eventId),
  )
  return pending.length === state.pending.length ? state : { ...state, pending }
}

export function markCaptureBatchFailed(
  state: CaptureOutboxState,
  generation: string,
  destination: string,
  eventIds: ReadonlyArray<string>,
  now: number,
): CaptureOutboxState {
  if (generation !== state.generation || !Number.isSafeInteger(now) || now < 0) return state
  const failed = new Set(eventIds)
  const next = {
    ...state,
    pending: state.pending.map((item) => {
      if (item.destination !== destination || !failed.has(item.event.eventId)) return item
      const failures = Math.min(item.consecutiveFailures + 1, Number.MAX_SAFE_INTEGER)
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** item.consecutiveFailures, BACKOFF_CAP_MS)
      return {
        ...item,
        consecutiveFailures: failures,
        nextAttemptAt: Math.min(now + delay, Number.MAX_SAFE_INTEGER),
      }
    }),
  }
  return next
}

const captureRetryDelay = (consecutiveFailures: number, readyWatchdogMs: number): number =>
  consecutiveFailures === 0
    ? readyWatchdogMs
    : consecutiveFailures >= BACKOFF_CAP_FAILURE_COUNT
      ? BACKOFF_CAP_MS
      : BACKOFF_BASE_MS * 2 ** Math.max(0, consecutiveFailures - 1)

/** Bound persisted absolute deadlines after wall-clock rollback. */
export function rebaseCaptureRetryDeadlines(
  state: CaptureOutboxState,
  now: number,
  readyWatchdogMs: number,
): CaptureOutboxState {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(readyWatchdogMs) ||
    readyWatchdogMs < 1
  )
    throw new RangeError('Capture retry rebase time is invalid')
  let changed = false
  const pending = state.pending.map((item) => {
    if (item.nextAttemptAt <= now) return item
    const bounded = Math.min(
      Number.MAX_SAFE_INTEGER,
      now + captureRetryDelay(item.consecutiveFailures, readyWatchdogMs),
    )
    if (item.nextAttemptAt <= bounded) return item
    changed = true
    return { ...item, nextAttemptAt: bounded }
  })
  return changed ? { ...state, pending } : state
}

export const earliestCaptureAttempt = (
  state: CaptureOutboxState,
  destination: string,
): number | undefined =>
  state.pending
    .filter((item) => item.destination === destination)
    .reduce<number | undefined>(
      (earliest, item) =>
        earliest === undefined || item.nextAttemptAt < earliest ? item.nextAttemptAt : earliest,
      undefined,
    )

/** Erase fence. Old queued work cannot equal the next durable generation. */
export function purgeCaptureOutbox(
  state: CaptureOutboxState,
  nextGeneration: string,
): CaptureOutboxState {
  const decodedGeneration = decodeExact(CaptureEpoch, nextGeneration)
  if (decodedGeneration === undefined || decodedGeneration === state.generation)
    throw new RangeError('Capture Mirror erase generation is invalid')
  return {
    version: CAPTURE_OUTBOX_VERSION,
    generation: decodedGeneration,
    pending: [],
  }
}
