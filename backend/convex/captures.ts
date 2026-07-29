// Codegen-free typed builders (this package must typecheck without a linked
// deployment), mirroring uploads.ts / sync.ts.
import {
  mutationGeneric,
  paginationOptsValidator,
  queryGeneric,
  type DataModelFromSchemaDefinition,
  type MutationBuilder,
  type QueryBuilder,
} from 'convex/server'
import { v, type Infer } from 'convex/values'
import { assertSecret } from './auth'
import schema, { captureRow, captureRowFields } from './schema'

type DataModel = DataModelFromSchemaDefinition<typeof schema>
const mutation = mutationGeneric as MutationBuilder<DataModel, 'public'>
const query = queryGeneric as QueryBuilder<DataModel, 'public'>
type Capture = Infer<typeof captureRow>

const captureDoc = v.object({
  _id: v.id('tweet_captures'),
  _creationTime: v.number(),
  ...captureRowFields,
})

// Mirrors src/core/sync/captures.ts without importing extension code into the
// independently deployed backend.
const CAPTURE_ID_PREFIX = 'xmd:capture:v1:'
const MAX_CAPTURE_BATCH = 64
const MAX_DEVICE_ID_LENGTH = 64
const MAX_TWEET_ID_LENGTH = 20
const MAX_HANDLE_LENGTH = 64
const MAX_CAPTURE_LINKS = 100
const MAX_CAPTURE_URL_LENGTH = 8_192
const MAX_CAPTURE_LINK_TITLE_LENGTH = 512
const MAX_CAPTURE_LINK_DOMAIN_LENGTH = 255
const MAX_CAPTURE_EVENT_BYTES = 256 * 1024 + 16 * 1024
const MAX_CAPTURE_BATCH_BYTES = 4 * 1024 * 1024
const SNOWFLAKE = /^\d{1,20}$/u
const encoder = new TextEncoder()

const captureIdFor = (deviceId: string, tweetId: string): string =>
  `${CAPTURE_ID_PREFIX}${deviceId.length}:${deviceId}:${tweetId.length}:${tweetId}`

const legacyCaptureIdFor = (deviceId: string, tweetId: string): string => `${deviceId}/${tweetId}`

const MAX_CAPTURE_ID_LENGTH = captureIdFor(
  'd'.repeat(MAX_DEVICE_ID_LENGTH),
  '9'.repeat(MAX_TWEET_ID_LENGTH),
).length

const isBoundedText = (value: string, maximum: number, allowEmpty = false): boolean =>
  (allowEmpty || value.length > 0) && value.length <= maximum

const isSafeNonnegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0

const isWithinJsonByteBudget = (value: unknown, maximum: number): boolean => {
  try {
    const json = JSON.stringify(value)
    return json !== undefined && encoder.encode(json).byteLength <= maximum
  } catch {
    return false
  }
}

const hasValidCaptureIdentity = (capture: Capture): boolean =>
  capture.captureId === captureIdFor(capture.deviceId, capture.tweetId) ||
  (!capture.deviceId.includes('/') &&
    capture.captureId === legacyCaptureIdFor(capture.deviceId, capture.tweetId))

const canonicalizeCapture = (capture: Capture): Capture => ({
  captureId: captureIdFor(capture.deviceId, capture.tweetId),
  deviceId: capture.deviceId,
  tweetId: capture.tweetId,
  conversationId: capture.conversationId,
  handle: capture.handle,
  text: capture.text,
  sourceRank: capture.sourceRank,
  at: capture.at,
  ...(capture.inReplyToTweetId === undefined ? {} : { inReplyToTweetId: capture.inReplyToTweetId }),
  ...(capture.createdAt === undefined ? {} : { createdAt: capture.createdAt }),
  ...(capture.links === undefined ? {} : { links: capture.links }),
})

const isSameCapture = (left: Capture, right: Capture): boolean =>
  left.captureId === right.captureId &&
  left.deviceId === right.deviceId &&
  left.tweetId === right.tweetId &&
  left.conversationId === right.conversationId &&
  left.inReplyToTweetId === right.inReplyToTweetId &&
  left.handle === right.handle &&
  left.text === right.text &&
  left.createdAt === right.createdAt &&
  JSON.stringify(left.links) === JSON.stringify(right.links) &&
  left.sourceRank === right.sourceRank &&
  left.at === right.at

const hasMatchingLogicalIdentity = (row: Capture, capture: Capture): boolean =>
  hasValidCaptureIdentity(row) &&
  row.deviceId === capture.deviceId &&
  row.tweetId === capture.tweetId

/** Rank first, then observation time. Input order stabilizes stored-alias ties. */
const pickStoredCaptureWinner = (captures: readonly Capture[]): Capture => {
  const [first, ...rest] = captures
  if (first === undefined) throw new Error('cannot choose capture winner from no captures')
  return rest.reduce(
    (winner, candidate) =>
      candidate.sourceRank > winner.sourceRank ||
      (candidate.sourceRank === winner.sourceRank && candidate.at > winner.at)
        ? candidate
        : winner,
    first,
  )
}

const hasValidCapturePayload = (capture: Capture): boolean =>
  isBoundedText(capture.captureId, MAX_CAPTURE_ID_LENGTH) &&
  isBoundedText(capture.deviceId, MAX_DEVICE_ID_LENGTH) &&
  SNOWFLAKE.test(capture.tweetId) &&
  SNOWFLAKE.test(capture.conversationId) &&
  (capture.inReplyToTweetId === undefined || SNOWFLAKE.test(capture.inReplyToTweetId)) &&
  isBoundedText(capture.handle, MAX_HANDLE_LENGTH, true) &&
  isBoundedText(capture.text, MAX_CAPTURE_EVENT_BYTES, true) &&
  (capture.createdAt === undefined || isSafeNonnegativeInteger(capture.createdAt)) &&
  (capture.sourceRank === 1 || capture.sourceRank === 2) &&
  isSafeNonnegativeInteger(capture.at) &&
  (capture.links === undefined ||
    (capture.links.length <= MAX_CAPTURE_LINKS &&
      capture.links.every(
        (link) =>
          isBoundedText(link.expandedUrl, MAX_CAPTURE_URL_LENGTH, true) &&
          (link.title === undefined ||
            isBoundedText(link.title, MAX_CAPTURE_LINK_TITLE_LENGTH, true)) &&
          (link.domain === undefined ||
            isBoundedText(link.domain, MAX_CAPTURE_LINK_DOMAIN_LENGTH, true)),
      ))) &&
  isWithinJsonByteBudget(capture, MAX_CAPTURE_EVENT_BYTES) &&
  isWithinJsonByteBudget(canonicalizeCapture(capture), MAX_CAPTURE_EVENT_BYTES)

/**
 * Best-effort mirror of the extension's local TweetRecord store (§9). Idempotent
 * upsert by both deployed `captureId` aliases on the `by_capture_id` index,
 * applying the §6.4 merge rule (rank-then-`at`, NOT raw last-write-wins) so a
 * later thin sighting can never overwrite a richer row. Control plane only;
 * fails closed on the secret.
 */
export const recordCaptures = mutation({
  args: { captures: v.array(captureRow), secret: v.string() },
  returns: v.object({ received: v.number(), upserted: v.number() }),
  handler: async (ctx, { captures, secret }) => {
    assertSecret(secret)
    if (
      captures.length > MAX_CAPTURE_BATCH ||
      !isWithinJsonByteBudget(captures, MAX_CAPTURE_BATCH_BYTES)
    )
      throw new Error('capture batch too large')
    for (const capture of captures) {
      if (!hasValidCapturePayload(capture) || !hasValidCaptureIdentity(capture)) {
        throw new Error('invalid capture identity or payload')
      }
    }

    let upserted = 0
    // oxlint-disable no-await-in-loop, no-underscore-dangle -- ordered merges for duplicate ids
    for (const input of captures) {
      const capture = canonicalizeCapture(input)
      const canonicalRows = await ctx.db
        .query('tweet_captures')
        .withIndex('by_capture_id', (q) => q.eq('captureId', capture.captureId))
        .collect()
      const legacyRows = capture.deviceId.includes('/')
        ? []
        : await ctx.db
            .query('tweet_captures')
            .withIndex('by_capture_id', (q) =>
              q.eq('captureId', legacyCaptureIdFor(capture.deviceId, capture.tweetId)),
            )
            .collect()
      const aliases = [...canonicalRows, ...legacyRows]
      if (
        !aliases.every(
          (row) =>
            hasMatchingLogicalIdentity(row, capture) &&
            hasValidCapturePayload(canonicalizeCapture(row)),
        )
      ) {
        throw new Error('stored capture identity or payload mismatch')
      }

      const storedWinner = aliases.length === 0 ? undefined : pickStoredCaptureWinner(aliases)
      const winner =
        storedWinner === undefined ||
        capture.sourceRank > storedWinner.sourceRank ||
        (capture.sourceRank === storedWinner.sourceRank && capture.at >= storedWinner.at)
          ? capture
          : canonicalizeCapture(storedWinner)
      const survivor = canonicalRows[0] ?? legacyRows[0]
      if (survivor === undefined) {
        await ctx.db.insert('tweet_captures', capture)
        upserted += 1
        continue
      }

      let changed = false
      if (!isSameCapture(survivor, winner)) {
        await ctx.db.patch(survivor._id, winner)
        changed = true
      }
      for (const alias of aliases) {
        if (alias._id === survivor._id) continue
        await ctx.db.delete(alias._id)
        changed = true
      }
      if (changed) {
        upserted += 1
      }
    }
    // oxlint-enable no-await-in-loop, no-underscore-dangle
    return { received: captures.length, upserted }
  },
})

/**
 * Read the full Tweet Harvest mirror page-by-page so the cloud copy is usable
 * cross-device (§9). Newest-first by default (`by_at` desc); scoped to a single
 * thread via the `by_conversation` index when `conversationId` is given.
 * `deviceId` narrows to one device's rows. Reads fail closed on the same shared
 * secret as the write (ADR-0009 hardening): the mirror is not exposed to an
 * unauthenticated caller on the discoverable `*.convex.cloud` URL.
 */
export const list = query({
  args: {
    secret: v.string(),
    paginationOpts: paginationOptsValidator,
    deviceId: v.optional(v.string()),
    conversationId: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(captureDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null()),
    ),
  }),
  handler: (ctx, { secret, paginationOpts, deviceId, conversationId }) => {
    assertSecret(secret)
    if (
      (deviceId !== undefined && !isBoundedText(deviceId, MAX_DEVICE_ID_LENGTH)) ||
      (conversationId !== undefined && !SNOWFLAKE.test(conversationId))
    ) {
      throw new Error('invalid capture list filter')
    }
    if (deviceId !== undefined && conversationId !== undefined) {
      return ctx.db
        .query('tweet_captures')
        .withIndex('by_device_conversation_at', (q) =>
          q.eq('deviceId', deviceId).eq('conversationId', conversationId),
        )
        .order('desc')
        .paginate(paginationOpts)
    }
    if (deviceId !== undefined) {
      return ctx.db
        .query('tweet_captures')
        .withIndex('by_device_at', (q) => q.eq('deviceId', deviceId))
        .order('desc')
        .paginate(paginationOpts)
    }
    if (conversationId !== undefined) {
      return ctx.db
        .query('tweet_captures')
        .withIndex('by_conversation_at', (q) => q.eq('conversationId', conversationId))
        .order('desc')
        .paginate(paginationOpts)
    }
    return ctx.db.query('tweet_captures').withIndex('by_at').order('desc').paginate(paginationOpts)
  },
})
