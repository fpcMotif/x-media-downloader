// Codegen-free typed builders (this package must typecheck without a linked
// deployment): derive the DataModel straight from schema.ts — the same thing
// `convex codegen` would emit into `_generated/server`.
import {
  mutationGeneric,
  queryGeneric,
  paginationOptsValidator,
  type DataModelFromSchemaDefinition,
  type GenericMutationCtx,
  type MutationBuilder,
  type QueryBuilder,
} from 'convex/server'
import { v, type Infer } from 'convex/values'
import schema, { syncEventFields } from './schema'
import { assertSecret } from './auth'

type DataModel = DataModelFromSchemaDefinition<typeof schema>
type Ctx = GenericMutationCtx<DataModel>
const mutation = mutationGeneric as MutationBuilder<DataModel, 'public'>
const query = queryGeneric as QueryBuilder<DataModel, 'public'>

// The `sync_events` wire shape comes from schema.ts (single source of truth).
const syncEvent = v.object(syncEventFields)
type SyncEvent = Infer<typeof syncEvent>

// Mirrors the extension's bounded wire domain. This backend deliberately does
// not import extension code: it must typecheck and deploy on its own.
const MAX_DEVICE_ID_LENGTH = 64
const MAX_REQUEST_ID_LENGTH = 'xmd:v1:sidecar:instagram:512:'.length + 512
const MAX_SYNC_BATCH = 64
const MAX_SYNC_EVENT_BYTES = 16 * 1024
const MAX_MEDIA_POST_ID_LENGTH = 128
const MAX_MEDIA_AUTHOR_LENGTH = 256
const MAX_MEDIA_URL_LENGTH = 8 * 1024
const MAX_MEDIA_EXTENSION_LENGTH = 16
const MAX_MEDIA_INDEX = 1_023
const SYNC_EVENT_ID_V1_PREFIX = 'xmd-sync:v1:'
const MAX_SYNC_EVENT_ID_LENGTH = Math.max(
  `${SYNC_EVENT_ID_V1_PREFIX}${MAX_DEVICE_ID_LENGTH}:${'d'.repeat(MAX_DEVICE_ID_LENGTH)}:${MAX_REQUEST_ID_LENGTH}:${'r'.repeat(MAX_REQUEST_ID_LENGTH)}:completed`
    .length,
  MAX_DEVICE_ID_LENGTH + 1 + MAX_REQUEST_ID_LENGTH + 1 + 'completed'.length,
)
const encoder = new TextEncoder()
const currentMediaKeys = ['platform', 'postId', 'author', 'type', 'url', 'ext', 'index'] as const
const legacyMediaKeys = ['tweetId', 'handle', 'type', 'url', 'ext', 'index'] as const
const syncEventKinds = ['queued', 'completed', 'failed'] as const
type SyncEventIdentity = Pick<SyncEvent, 'deviceId' | 'requestId' | 'kind'>

const currentEventId = (e: SyncEventIdentity): string =>
  `${SYNC_EVENT_ID_V1_PREFIX}${e.deviceId.length}:${e.deviceId}:${e.requestId.length}:${e.requestId}:${e.kind}`

const legacyEventId = (e: SyncEventIdentity): string =>
  `${e.deviceId}/${e.requestId}/${e.kind}`

/**
 * Old installed clients send tweetId/handle. Accept that wire shape, but never
 * let it create fresh legacy storage: deploy-2 proof must remain valid while
 * those clients retry.
 */
const canonicalizeMedia = (
  media: NonNullable<SyncEvent['media']>,
): NonNullable<SyncEvent['media']> => ({
  platform: media.platform ?? 'x',
  postId: media.postId ?? media.tweetId ?? '',
  author: media.author ?? media.handle ?? '',
  type: media.type,
  url: media.url,
  ext: media.ext,
  index: media.index,
})

const canonicalizeEvent = (e: SyncEvent): SyncEvent => ({
  ...e,
  eventId: currentEventId(e),
  ...(e.media === undefined ? {} : { media: canonicalizeMedia(e.media) }),
})

const isSafeNonnegativeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0

const isBoundedText = (value: string, maximum: number, allowEmpty = false): boolean =>
  (allowEmpty || value.length > 0) && value.length <= maximum

const hasExactKeys = (value: object, keys: ReadonlyArray<string>): boolean => {
  const record = value as Record<string, unknown>
  return (
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))
  )
}

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

const isWithinJsonByteBudget = (value: unknown, maximum: number): boolean => {
  try {
    const json = JSON.stringify(value)
    return json !== undefined && encoder.encode(json).byteLength <= maximum
  } catch {
    return false
  }
}

const hasValidMediaPayload = (media: NonNullable<SyncEvent['media']>): boolean => {
  if (
    !['photo', 'video', 'gif'].includes(media.type) ||
    !isBoundedText(media.url, MAX_MEDIA_URL_LENGTH) ||
    !isHttpsUrl(media.url) ||
    !isBoundedText(media.ext, MAX_MEDIA_EXTENSION_LENGTH) ||
    !isSafeNonnegativeInteger(media.index) ||
    media.index > MAX_MEDIA_INDEX
  )
    return false

  if (hasExactKeys(media, currentMediaKeys)) {
    return (
      media.platform !== undefined &&
      media.postId !== undefined &&
      media.author !== undefined &&
      isBoundedText(media.postId, MAX_MEDIA_POST_ID_LENGTH) &&
      isBoundedText(media.author, MAX_MEDIA_AUTHOR_LENGTH, true)
    )
  }
  if (hasExactKeys(media, legacyMediaKeys)) {
    return (
      media.tweetId !== undefined &&
      media.handle !== undefined &&
      isBoundedText(media.tweetId, MAX_MEDIA_POST_ID_LENGTH) &&
      isBoundedText(media.handle, MAX_MEDIA_AUTHOR_LENGTH, true)
    )
  }
  return false
}

const hasValidEventPayload = (e: SyncEvent): boolean =>
  isBoundedText(e.deviceId, MAX_DEVICE_ID_LENGTH) &&
  isBoundedText(e.requestId, MAX_REQUEST_ID_LENGTH) &&
  isBoundedText(e.eventId, MAX_SYNC_EVENT_ID_LENGTH) &&
  isSafeNonnegativeInteger(e.at) &&
  (e.kind === 'queued') === (e.media !== undefined) &&
  (e.media === undefined || hasValidMediaPayload(e.media)) &&
  isWithinJsonByteBudget(e, MAX_SYNC_EVENT_BYTES) &&
  isWithinJsonByteBudget(canonicalizeEvent(e), MAX_SYNC_EVENT_BYTES)

/** Accept v0 only for records the old extension may still retry. */
const hasValidEventIdentity = (e: SyncEvent): boolean =>
  e.eventId === currentEventId(e) ||
  (!e.deviceId.includes('/') && !e.requestId.includes('/') && e.eventId === legacyEventId(e))

// A stored `sync_events` row as returned by reads (the table doc plus Convex's
// system fields). Used for the `recentEvents` return validator.
const syncEventDoc = v.object({
  _id: v.id('sync_events'),
  _creationTime: v.number(),
  ...syncEventFields,
})

const isSameLogicalEvent = (left: SyncEvent, right: SyncEvent): boolean =>
  left.deviceId === right.deviceId && left.requestId === right.requestId && left.kind === right.kind

const toWireEvent = (event: SyncEvent): SyncEvent => ({
  eventId: event.eventId,
  kind: event.kind,
  requestId: event.requestId,
  deviceId: event.deviceId,
  at: event.at,
  ...(event.media === undefined ? {} : { media: event.media }),
})

const isValidStoredEvent = (event: SyncEvent): boolean =>
  hasValidEventPayload(event) && hasValidEventIdentity(event)

/** Rebuild one materialized view from the surviving append-only facts. */
async function rebuildMediaState(ctx: Ctx, deviceId: string, requestId: string): Promise<void> {
  // Do not scan `by_device_request`: untrusted historical rows can share those
  // fields. There are only two accepted identities for each of three facts.
  const identities: string[] = []
  for (const kind of syncEventKinds) {
    const event = { deviceId, requestId, kind }
    identities.push(currentEventId(event))
    if (!deviceId.includes('/') && !requestId.includes('/')) identities.push(legacyEventId(event))
  }
  const storedEvents = (
    await Promise.all(
      identities.map((eventId) =>
        ctx.db.query('sync_events').withIndex('by_event_id', (q) => q.eq('eventId', eventId)).collect(),
      ),
    )
  ).flat()
  const validEvents = storedEvents.filter((event) => isValidStoredEvent(toWireEvent(event)))
  if (validEvents.length === 0) throw new Error('No valid sync event fact can be projected.')
  const firstFactByKind = new Map<SyncEvent['kind'], (typeof storedEvents)[number]>()
  // oxlint-disable no-underscore-dangle -- Convex system fields define stable fact order
  for (const event of validEvents.toSorted(
    (left, right) =>
      left._creationTime - right._creationTime || String(left._id).localeCompare(String(right._id)),
  )) {
    if (!firstFactByKind.has(event.kind)) firstFactByKind.set(event.kind, event)
  }
  const facts = [...firstFactByKind.values()].toSorted(
    (left, right) =>
      left.at - right.at ||
      left._creationTime - right._creationTime ||
      String(left._id).localeCompare(String(right._id)),
  )
  // oxlint-enable no-underscore-dangle
  const latest = facts.at(-1)!
  const latestStoredMedia = facts.findLast((event) => event.media !== undefined)?.media
  const latestMedia =
    latestStoredMedia === undefined ? undefined : canonicalizeMedia(latestStoredMedia)
  const platform = latestMedia?.platform
  const projection = {
    deviceId,
    requestId,
    lastKind: latest.kind,
    at: latest.at,
    tweetId: latestMedia?.postId ?? '',
    postId: latestMedia?.postId ?? '',
    author: latestMedia?.author ?? '',
    ...(platform === undefined ? {} : { platform }),
    ...(latestMedia === undefined ? {} : { media: latestMedia }),
  }
  const state = await ctx.db
    .query('media_state')
    .withIndex('by_device_request', (q) => q.eq('deviceId', deviceId).eq('requestId', requestId))
    .first()
  if (state === null) await ctx.db.insert('media_state', projection)
  else await ctx.db.replace(state._id, projection)
}

/**
 * Collapse every deployed identity alias to one canonical row. The first stored
 * payload wins, matching ordinary idempotent retry behavior.
 */
async function reconcileEventAliases(ctx: Ctx, event: SyncEvent): Promise<boolean> {
  const canonicalId = currentEventId(event)
  const currentRows = await ctx.db
    .query('sync_events')
    .withIndex('by_event_id', (q) => q.eq('eventId', canonicalId))
    .collect()
  const legacyRows =
    event.deviceId.includes('/') || event.requestId.includes('/')
      ? []
      : await ctx.db
          .query('sync_events')
          .withIndex('by_event_id', (q) => q.eq('eventId', legacyEventId(event)))
          .collect()
  const rows = [...currentRows, ...legacyRows]
  if (
    rows.some((row) => {
      const stored = toWireEvent(row)
      return !isSameLogicalEvent(stored, event) || !isValidStoredEvent(stored)
    })
  ) {
    throw new Error('Conflicting stored sync event identity.')
  }

  rows.sort(
    (left, right) =>
      left._creationTime - right._creationTime || String(left._id).localeCompare(String(right._id)),
  )
  const [first, ...duplicates] = rows
  if (first === undefined) return false
  for (const duplicate of duplicates) await ctx.db.delete(duplicate._id)
  const canonicalFirst = canonicalizeEvent(toWireEvent(first))
  if (
    first.eventId !== canonicalId ||
    (first.media !== undefined && !hasExactKeys(first.media, currentMediaKeys))
  ) {
    await ctx.db.replace(first._id, canonicalFirst)
  }
  await rebuildMediaState(ctx, event.deviceId, event.requestId)
  return true
}

/**
 * Idempotent batch ingest for the extension outbox (`POST /api/mutation`,
 * path `sync:recordEvents`). The outbox delivers at-least-once; skipping on a
 * seen `eventId` makes recording exactly-once. Batches are ≤64 events. The
 * known two-alias repair cohort needs at most three writes per event
 * (≤192 total) — far below the 16 MiB / 16k-docs mutation limits.
 *
 * Writes fail closed (ADR-0009 hardening): the deployment MUST set
 * `SYNC_SHARED_SECRET` and the caller MUST present a matching `secret`. A
 * `*.convex.cloud` URL is discoverable and is NOT a write capability, so the
 * URL alone never authorizes an insert.
 */
export const recordEvents = mutation({
  args: { events: v.array(syncEvent), secret: v.string() },
  returns: v.object({ received: v.number(), inserted: v.number() }),
  handler: async (ctx, { events, secret }) => {
    assertSecret(secret)
    if (events.length > MAX_SYNC_BATCH) throw new Error('sync event batch too large')
    for (const e of events) {
      if (!hasValidEventPayload(e)) throw new Error('Invalid sync event payload.')
      if (!hasValidEventIdentity(e)) throw new Error('Invalid sync event identity.')
    }
    let inserted = 0
    for (const input of events) {
      const e = canonicalizeEvent(input)
      if (await reconcileEventAliases(ctx, e)) continue
      await ctx.db.insert('sync_events', e)
      inserted += 1
      await rebuildMediaState(ctx, e.deviceId, e.requestId)
    }
    return { received: events.length, inserted }
  },
})

/**
 * Newest-first event ledger, cursor-paginated (never fetch 10k rows at once).
 * Reads fail closed on the same shared secret as the writes (ADR-0009 hardening):
 * a discoverable `*.convex.cloud` URL must NOT expose the sync ledger (media
 * urls/tweetIds/handles, device + request ids) to an unauthenticated caller.
 */
export const recentEvents = query({
  args: { paginationOpts: paginationOptsValidator, secret: v.string() },
  returns: v.object({
    page: v.array(syncEventDoc),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(v.literal('SplitRecommended'), v.literal('SplitRequired'), v.null()),
    ),
  }),
  handler: (ctx, { paginationOpts, secret }) => {
    assertSecret(secret)
    return ctx.db.query('sync_events').withIndex('by_at').order('desc').paginate(paginationOpts)
  },
})

// The overlay sweep keeps ~30 articles mounted; the cap is generous headroom and a
// guard against an unbounded point-lookup fan-out from a malformed caller.
const DOWNLOADED_AMONG_CAP = 128

const assertLookupIdentities = (
  operation: string,
  identities: ReadonlyArray<string>,
  maximumLength: number,
): void => {
  if (identities.some((identity) => !isBoundedText(identity, maximumLength)))
    throw new Error(`${operation}: invalid identity`)
}

/**
 * Membership query for the timeline "Saved" status: of the given tweetIds, which
 * have at least one completed X `media_state` row on ANY device. Current rows use
 * the platform-qualified `by_platform_post` index; the bounded `by_tweet` fallback
 * admits only unbackfilled rows with no platform, never an explicit non-X row.
 * Reads fail closed on the same shared secret as the rest of the ledger.
 */
export const downloadedAmong = query({
  args: { secret: v.string(), tweetIds: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { secret, tweetIds }) => {
    assertSecret(secret)
    if (tweetIds.length > DOWNLOADED_AMONG_CAP) {
      throw new Error(
        `downloadedAmong: batch too large (${tweetIds.length} > ${DOWNLOADED_AMONG_CAP})`,
      )
    }
    assertLookupIdentities('downloadedAmong', tweetIds, MAX_MEDIA_POST_ID_LENGTH)
    const out: string[] = []
    for (const tweetId of new Set(tweetIds)) {
      const currentXCompleted = await ctx.db
        .query('media_state')
        .withIndex('by_platform_post', (q) => q.eq('platform', 'x').eq('postId', tweetId))
        .filter((q) => q.eq(q.field('lastKind'), 'completed'))
        .first()
      if (currentXCompleted !== null) {
        out.push(tweetId)
        continue
      }

      const legacyXCompleted = await ctx.db
        .query('media_state')
        .withIndex('by_tweet', (q) => q.eq('tweetId', tweetId))
        .filter((q) =>
          q.and(q.eq(q.field('lastKind'), 'completed'), q.eq(q.field('platform'), undefined)),
        )
        .first()
      if (legacyXCompleted !== null) out.push(tweetId)
    }
    return out
  },
})

/**
 * Membership query for per-item duplicate detection: of the given canonical
 * Save Request IDs, which have at least one `completed` `media_state` row on
 * ANY device. Parallel to `downloadedAmong`, which answers the coarser
 * post-level "Saved" badge question and must not be reused here.
 */
export const downloadedRequestIdsAmong = query({
  args: { secret: v.string(), requestIds: v.array(v.string()) },
  returns: v.array(v.string()),
  handler: async (ctx, { secret, requestIds }) => {
    assertSecret(secret)
    if (requestIds.length > DOWNLOADED_AMONG_CAP) {
      throw new Error(
        `downloadedRequestIdsAmong: batch too large (${requestIds.length} > ${DOWNLOADED_AMONG_CAP})`,
      )
    }
    assertLookupIdentities('downloadedRequestIdsAmong', requestIds, MAX_REQUEST_ID_LENGTH)
    const out: string[] = []
    for (const requestId of new Set(requestIds)) {
      const completed = await ctx.db
        .query('media_state')
        .withIndex('by_request_id', (q) => q.eq('requestId', requestId))
        .filter((q) => q.eq(q.field('lastKind'), 'completed'))
        .first()
      if (completed !== null) out.push(requestId)
    }
    return out
  },
})

const BACKFILL_TWEET_ID_PAGE_SIZE = 128
const cursor = v.optional(v.union(v.string(), v.null()))
const migrationProgress = v.object({
  isDone: v.boolean(),
  continueCursor: v.string(),
})

/**
 * One bounded page of the `tweetId` migration. Start without `cursor`, then
 * repeat with `continueCursor` until `isDone`. Idempotent: only missing or
 * empty fields are patched. Secret-gated like every write.
 */
export const backfillTweetId = mutation({
  args: { cursor, secret: v.string() },
  returns: v.object({ patched: v.number(), ...migrationProgress.fields }),
  handler: async (ctx, { cursor: migrationCursor, secret }) => {
    assertSecret(secret)
    let patched = 0
    const page = await ctx.db.query('media_state').paginate({
      numItems: BACKFILL_TWEET_ID_PAGE_SIZE,
      cursor: migrationCursor ?? null,
    })
    for (const row of page.page) {
      const fromMedia = row.media?.tweetId
      if (
        (row.tweetId === undefined || row.tweetId === '') &&
        fromMedia !== undefined &&
        fromMedia !== ''
      ) {
        await ctx.db.patch(row._id, { tweetId: fromMedia })
        patched += 1
      }
    }
    return {
      patched,
      isDone: page.isDone,
      continueCursor: page.continueCursor,
    }
  },
})

/**
 * Multi-platform migration, deploy 1 of 2 (see the `media`/`media_state`
 * comments in schema.ts): fill `postId`/`platform`/`author` on `media_state`
 * rows written before those columns existed, and the legacy media embedded in
 * `sync_events`. Every old row is X-only by construction. Each invocation
 * reads bounded pages from both tables; callers repeat returned cursors until
 * both are done, then run the server-owned verification audit before deploy 2.
 */
const PLATFORM_BACKFILL_PAGE_SIZE = 128

const mediaNeedsPlatformBackfill = (value: SyncEvent['media']): boolean =>
  value !== undefined &&
  (value.platform === undefined || value.postId === undefined || value.author === undefined)

const stateNeedsPlatformBackfill = (row: {
  readonly platform?: 'x' | 'instagram' | 'threads'
  readonly postId?: string
  readonly author?: string
  readonly media?: SyncEvent['media']
}): boolean =>
  row.platform === undefined ||
  row.postId === undefined ||
  row.author === undefined ||
  mediaNeedsPlatformBackfill(row.media)

const migratedMedia = (value: NonNullable<SyncEvent['media']>, fallbackPostId: string) => ({
  ...value,
  platform: value.platform ?? ('x' as const),
  postId: value.postId ?? value.tweetId ?? fallbackPostId,
  author: value.author ?? value.handle ?? '',
})

export const backfillPlatformFields = mutation({
  args: {
    secret: v.string(),
    mediaStateCursor: cursor,
    syncEventsCursor: cursor,
  },
  returns: v.object({
    patched: v.number(),
    mediaState: migrationProgress,
    syncEvents: migrationProgress,
  }),
  handler: async (ctx, { secret, mediaStateCursor, syncEventsCursor }) => {
    assertSecret(secret)
    let patched = 0
    const [states, events] = await Promise.all([
      ctx.db.query('media_state').paginate({
        numItems: PLATFORM_BACKFILL_PAGE_SIZE,
        cursor: mediaStateCursor ?? null,
      }),
      ctx.db.query('sync_events').paginate({
        numItems: PLATFORM_BACKFILL_PAGE_SIZE,
        cursor: syncEventsCursor ?? null,
      }),
    ])
    // oxlint-disable no-await-in-loop, no-underscore-dangle -- bounded ordered migration writes
    for (const row of states.page) {
      if (!stateNeedsPlatformBackfill(row)) continue
      const postId = row.postId ?? row.tweetId ?? row.media?.postId ?? row.media?.tweetId ?? ''
      const author = row.author ?? row.media?.author ?? row.media?.handle ?? ''
      await ctx.db.patch(row._id, {
        postId,
        author,
        platform: row.platform ?? 'x',
        ...(row.media === undefined ? {} : { media: migratedMedia(row.media, postId) }),
      })
      patched += 1
    }
    for (const row of events.page) {
      if (!mediaNeedsPlatformBackfill(row.media)) continue
      await ctx.db.patch(row._id, { media: migratedMedia(row.media!, '') })
      patched += 1
    }
    // oxlint-enable no-await-in-loop, no-underscore-dangle
    return {
      patched,
      mediaState: {
        isDone: states.isDone,
        continueCursor: states.continueCursor,
      },
      syncEvents: {
        isDone: events.isDone,
        continueCursor: events.continueCursor,
      },
    }
  },
})

/**
 * Diagnostic one-page view for the migration above. `pageRemaining` has no
 * global meaning; use the server-owned audit below for deploy-2 authority.
 */
export const platformBackfillRemaining = query({
  args: {
    secret: v.string(),
    mediaStateCursor: cursor,
    syncEventsCursor: cursor,
  },
  returns: v.object({
    pageRemaining: v.number(),
    mediaState: migrationProgress,
    syncEvents: migrationProgress,
  }),
  handler: async (ctx, { secret, mediaStateCursor, syncEventsCursor }) => {
    assertSecret(secret)
    const [states, events] = await Promise.all([
      ctx.db.query('media_state').paginate({
        numItems: PLATFORM_BACKFILL_PAGE_SIZE,
        cursor: mediaStateCursor ?? null,
      }),
      ctx.db.query('sync_events').paginate({
        numItems: PLATFORM_BACKFILL_PAGE_SIZE,
        cursor: syncEventsCursor ?? null,
      }),
    ])
    const pageRemaining =
      states.page.filter(stateNeedsPlatformBackfill).length +
      events.page.filter((event) => mediaNeedsPlatformBackfill(event.media)).length
    return {
      pageRemaining,
      mediaState: {
        isDone: states.isDone,
        continueCursor: states.continueCursor,
      },
      syncEvents: {
        isDone: events.isDone,
        continueCursor: events.continueCursor,
      },
    }
  },
})

const platformBackfillAuditResult = v.object({
  done: v.boolean(),
  complete: v.boolean(),
  remaining: v.number(),
})

/** Start a fresh, server-owned audit after the bounded backfill is done. */
export const startPlatformBackfillAudit = mutation({
  args: { secret: v.string() },
  returns: v.id('platform_backfill_audits'),
  handler: async (ctx, { secret }) => {
    assertSecret(secret)
    return ctx.db.insert('platform_backfill_audits', {
      mediaStateDone: false,
      syncEventsDone: false,
      remaining: 0,
      done: false,
    })
  },
})

/**
 * Advance exactly one bounded page of each unfinished table. Cursors and the
 * cumulative count live only in Convex, so the terminal zero result proves the
 * whole audit was clean; a caller cannot skip a dirty earlier page.
 */
export const advancePlatformBackfillAudit = mutation({
  args: { secret: v.string(), auditId: v.id('platform_backfill_audits') },
  returns: platformBackfillAuditResult,
  handler: async (ctx, { secret, auditId }) => {
    assertSecret(secret)
    const audit = await ctx.db.get(auditId)
    if (audit === null) throw new Error('Platform backfill audit not found.')
    if (audit.done) {
      return {
        done: true,
        complete: audit.remaining === 0,
        remaining: audit.remaining,
      }
    }

    const [states, events] = await Promise.all([
      audit.mediaStateDone
        ? null
        : ctx.db.query('media_state').paginate({
            numItems: PLATFORM_BACKFILL_PAGE_SIZE,
            cursor: audit.mediaStateCursor ?? null,
          }),
      audit.syncEventsDone
        ? null
        : ctx.db.query('sync_events').paginate({
            numItems: PLATFORM_BACKFILL_PAGE_SIZE,
            cursor: audit.syncEventsCursor ?? null,
          }),
    ])
    const pageRemaining =
      (states?.page.filter(stateNeedsPlatformBackfill).length ?? 0) +
      (events?.page.filter((event) => mediaNeedsPlatformBackfill(event.media)).length ?? 0)
    const mediaStateDone = audit.mediaStateDone || states!.isDone
    const syncEventsDone = audit.syncEventsDone || events!.isDone
    const remaining = audit.remaining + pageRemaining
    const done = mediaStateDone && syncEventsDone
    // oxlint-disable-next-line no-underscore-dangle -- Convex document identity
    await ctx.db.patch(audit._id, {
      mediaStateDone,
      ...(states === null ? {} : { mediaStateCursor: states.continueCursor }),
      syncEventsDone,
      ...(events === null ? {} : { syncEventsCursor: events.continueCursor }),
      remaining,
      done,
    })
    return { done, complete: done && remaining === 0, remaining }
  },
})
