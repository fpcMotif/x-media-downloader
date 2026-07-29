import { Schema } from 'effect'
import { CLOUD_PROVIDERS } from '../schema'
import { MAX_SAVE_REQUEST_ID_LENGTH, mediaRequestId } from '../download/request-identity'
import { MAX_MEDIA_URL_LENGTH } from '../schema/media'
import { MAX_CLOUD_DEVICE_ID_LENGTH } from '../schema/settings'
import { isJsonWithinByteBudget } from '../wire/json-budget'
import { MAX_TRANSFER_FILENAME_LENGTH } from '../wire/limits'
import { boundedDiagnosticText, MAX_DIAGNOSTIC_TEXT_LENGTH } from '../diagnostic-text'
import {
  MAX_CLOUD_REMOTE_ID_LENGTH,
  type CloudProviderId,
  type RemoteAttempt,
  type UploadTarget,
} from './types'
import { cloudDeadline, cloudTime, monotonicCloudTime } from './time'
import {
  isCoherentOwnershipTransitions,
  ProviderOwnershipTransitionSchema,
} from './provider-ownership-transition'

/**
 * UploadJob ledger — the pure state machine for the client-side cloud byte path
 * (ADR-0013), adapted from the `feat/upload-job-ledger` reducer. One job per
 * (media item × connected provider):
 *
 *   pending ─claim→ uploading ─┬─ recordSuccess ──→ succeeded
 *                              ├─ recordFailure  ──→ failed ─(backoff, re-claim)─→ … → dead
 *                              ├─ recordSourceGone → skipped   (twimg 403/410 — honest, never a fake save)
 *                              └─ (SW recycle) ─ lease expires → re-claim (counts an attempt)
 *   dead/failed ─retry→ pending  (operator escape — the only sanctioned terminal regression)
 *
 * Pure: no I/O, no clock, no randomness — the background drain injects `now` and
 * real outcomes. Persisted to `local:cloudUploadJobs` and drained FIFO, mirroring
 * the metadata outbox (`src/core/sync/outbox.ts`): deterministic jobIds make the
 * at-least-once enqueue exactly-once. A lease is a fencing token (`leaseSeq`) so a
 * zombie run after a recycle can never corrupt the live claimant.
 */

export const MAX_ATTEMPTS = 5
/** Hard ledger bound. Existing jobs are authoritative; admission rejects only a
 * new idempotency key once this count is reached. */
export const MAX_UPLOAD_JOBS = 1_000
/** New durable and wire diagnostics share the runtime-wide bound. */
export const MAX_UPLOAD_ERROR_LENGTH = MAX_DIAGNOSTIC_TEXT_LENGTH
/** Read-only compatibility for rows written before diagnostics were unified. */
export const MAX_STORED_UPLOAD_ERROR_LENGTH = 16 * 1024
export const MAX_UPLOAD_REMOTE_ID_LENGTH = MAX_CLOUD_REMOTE_ID_LENGTH
export const MAX_UPLOAD_CONTENT_TYPE_LENGTH = 256
export const MAX_UPLOAD_JOB_BYTES = 40 * 1024
export const MAX_UPLOAD_LEDGER_BYTES = MAX_UPLOAD_JOBS * (MAX_UPLOAD_JOB_BYTES + 1) + 1024
export const BACKOFF_BASE_MS = 5_000
export const BACKOFF_CAP_MS = 300_000
// Lease TTL, sized to the MV3 idle service-worker cap (~5 min). Within one SW
// lifetime the upload serial queue already prevents a second concurrent drain,
// so the lease only matters ACROSS a recycle: if a large-video upload finished
// on the provider but the SW died before recording success, a fresh SW that
// re-claims the still-`uploading` job uploads it AGAIN (the resumable session
// lives only in a local var, so a re-claim restarts from byte 0 → duplicate
// remote file). A longer lease widens the post-death window in which that job
// stays unclaimable, shrinking the duplicate window — at the cost of slower
// crash-recovery (a genuinely crashed job waits the full lease before retry).
// Attempts stay capped at MAX_ATTEMPTS, so this never loops unboundedly.
export const LEASE_MS = 300_000

export const JobStatus = Schema.Literals([
  'pending',
  'uploading',
  'succeeded',
  'failed',
  'dead',
  'skipped',
])
export type JobStatus = typeof JobStatus.Type

export const CloudProvider = Schema.Literals(CLOUD_PROVIDERS)

/**
 * Version two separates canonical save-request identity from pre-v2 raw Media
 * IDs. Old rows lack platform identity, so they cannot be proved equivalent to
 * a modern request. They are retained in `legacy`, never drained or silently
 * merged, until an explicit recovery path can identify them.
 */
export const UPLOAD_LEDGER_VERSION = 4 as const
export const UPLOAD_LEDGER_STATE_VERSION = 5 as const
const V3_UPLOAD_LEDGER_VERSION = 3 as const
const V2_UPLOAD_LEDGER_VERSION = 2 as const
const UPLOAD_JOB_ID_PREFIX = 'xmd:cloud:v2:'

const boundedText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))
const boundedOptionalText = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum))
const nonnegativeSafeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
const SaveRequestId = boundedText(MAX_SAVE_REQUEST_ID_LENGTH)
const LocalJobId = boundedText(UPLOAD_JOB_ID_PREFIX.length + 16 + MAX_SAVE_REQUEST_ID_LENGTH + 8)

const UploadTargetSchema = Schema.Struct({
  path: boundedText(MAX_TRANSFER_FILENAME_LENGTH),
  folder: boundedOptionalText(MAX_TRANSFER_FILENAME_LENGTH),
  filename: boundedText(MAX_TRANSFER_FILENAME_LENGTH),
  contentType: boundedText(MAX_UPLOAD_CONTENT_TYPE_LENGTH),
})

const OwnerKeySchema = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[\da-f]{64}$/u),
)
const DriveRemoteAttemptSchema = Schema.Struct({
  kind: Schema.Literal('gdrive'),
  ownerKey: OwnerKeySchema,
  fileId: boundedText(MAX_UPLOAD_REMOTE_ID_LENGTH),
})
const DropboxPreparedAttemptSchema = Schema.Struct({
  kind: Schema.Literal('dropbox'),
  phase: Schema.Literal('prepared'),
  ownerKey: OwnerKeySchema,
  stagePath: boundedText(MAX_TRANSFER_FILENAME_LENGTH * 4),
})
const DropboxStagedAttemptSchema = Schema.Struct({
  kind: Schema.Literal('dropbox'),
  phase: Schema.Literal('staged'),
  ownerKey: OwnerKeySchema,
  stagePath: boundedText(MAX_TRANSFER_FILENAME_LENGTH * 4),
  fileId: boundedText(MAX_UPLOAD_REMOTE_ID_LENGTH),
  rev: boundedText(MAX_UPLOAD_REMOTE_ID_LENGTH),
  contentHash: Schema.String.check(
    Schema.isMinLength(64),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[\da-f]{64}$/u),
  ),
  bytes: nonnegativeSafeInteger,
})
export const RemoteAttemptSchema = Schema.Union([
  DriveRemoteAttemptSchema,
  DropboxPreparedAttemptSchema,
  DropboxStagedAttemptSchema,
])

export const UploadJobSchema = Schema.Struct({
  version: Schema.Literal(UPLOAD_LEDGER_VERSION),
  jobId: LocalJobId,
  /** Versioned, injective key for at-least-once enqueue. */
  idempotencyKey: LocalJobId,
  /** Canonical global save-request identity. */
  requestId: SaveRequestId,
  provider: CloudProvider,
  /** twimg source URL — fetched only via the SSRF guard at drain time. */
  url: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_MEDIA_URL_LENGTH),
    Schema.isPattern(/^https:\/\//u),
  ),
  target: UploadTargetSchema,
  status: JobStatus,
  /** Attempts that have ended (failed or crashed). Caps the job at MAX_ATTEMPTS. */
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ATTEMPTS })),
  /** Claimable only when `now >= nextAttemptAt`. */
  nextAttemptAt: nonnegativeSafeInteger,
  leaseUntil: Schema.NullOr(nonnegativeSafeInteger),
  /** Present on new claims; lets settlement survive a backward wall-clock jump. */
  attemptStartedAt: Schema.optional(nonnegativeSafeInteger),
  /** Monotonic fencing token; each claim issues `leaseSeq + 1`. */
  leaseSeq: nonnegativeSafeInteger,
  verifiedAt: Schema.NullOr(nonnegativeSafeInteger),
  error: Schema.NullOr(boundedOptionalText(MAX_STORED_UPLOAD_ERROR_LENGTH)),
  remoteAttempt: Schema.optional(RemoteAttemptSchema),
  remoteId: Schema.optional(boundedOptionalText(MAX_UPLOAD_REMOTE_ID_LENGTH)),
  remotePath: Schema.optional(boundedText(MAX_TRANSFER_FILENAME_LENGTH)),
  bytes: Schema.optional(nonnegativeSafeInteger),
})
export type UploadJob = typeof UploadJobSchema.Type

const LedgerSchema = Schema.Array(UploadJobSchema).check(Schema.isMaxLength(MAX_UPLOAD_JOBS))
export type JobLedger = ReadonlyArray<UploadJob>

/** Exact v3 row. An in-flight row has no provider attempt identity, so migration
 * must quarantine it: remote success before the last local write is unknowable. */
const V3UploadJobSchema = Schema.Struct({
  version: Schema.Literal(V3_UPLOAD_LEDGER_VERSION),
  jobId: LocalJobId,
  idempotencyKey: LocalJobId,
  requestId: SaveRequestId,
  provider: CloudProvider,
  url: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_MEDIA_URL_LENGTH),
    Schema.isPattern(/^https:\/\//u),
  ),
  target: UploadTargetSchema,
  status: JobStatus,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ATTEMPTS })),
  nextAttemptAt: nonnegativeSafeInteger,
  leaseUntil: Schema.NullOr(nonnegativeSafeInteger),
  leaseSeq: nonnegativeSafeInteger,
  verifiedAt: Schema.NullOr(nonnegativeSafeInteger),
  error: Schema.NullOr(boundedOptionalText(MAX_STORED_UPLOAD_ERROR_LENGTH)),
  remoteId: Schema.optional(boundedOptionalText(MAX_UPLOAD_REMOTE_ID_LENGTH)),
  bytes: Schema.optional(nonnegativeSafeInteger),
})
export type V3UploadJob = typeof V3UploadJobSchema.Type
const V3LedgerSchema = Schema.Array(V3UploadJobSchema).check(Schema.isMaxLength(MAX_UPLOAD_JOBS))

/** Exact v2 row. Its aliases were admission-only data accidentally retained in
 * every durable job; v3 strips them before the ledger can run. */
const V2UploadJobSchema = Schema.Struct({
  version: Schema.Literal(V2_UPLOAD_LEDGER_VERSION),
  jobId: LocalJobId,
  idempotencyKey: LocalJobId,
  requestId: SaveRequestId,
  legacyAliases: Schema.Array(SaveRequestId).check(Schema.isMaxLength(4)),
  provider: CloudProvider,
  url: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_MEDIA_URL_LENGTH),
    Schema.isPattern(/^https:\/\//u),
  ),
  target: UploadTargetSchema,
  status: JobStatus,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ATTEMPTS })),
  nextAttemptAt: nonnegativeSafeInteger,
  leaseUntil: Schema.NullOr(nonnegativeSafeInteger),
  leaseSeq: nonnegativeSafeInteger,
  verifiedAt: Schema.NullOr(nonnegativeSafeInteger),
  error: Schema.NullOr(boundedOptionalText(MAX_STORED_UPLOAD_ERROR_LENGTH)),
  remoteId: Schema.optional(boundedOptionalText(MAX_UPLOAD_REMOTE_ID_LENGTH)),
  bytes: Schema.optional(nonnegativeSafeInteger),
})
type V2UploadJob = typeof V2UploadJobSchema.Type
const V2LedgerSchema = Schema.Array(V2UploadJobSchema).check(Schema.isMaxLength(MAX_UPLOAD_JOBS))

/** Exact pre-v2 record. Keep its old shape so migration cannot invent identity. */
const LegacyUploadJobSchema = Schema.Struct({
  jobId: boundedText(MAX_SAVE_REQUEST_ID_LENGTH + ':dropbox'.length),
  idempotencyKey: boundedText(MAX_SAVE_REQUEST_ID_LENGTH + ':dropbox'.length),
  mediaId: SaveRequestId,
  provider: CloudProvider,
  url: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_MEDIA_URL_LENGTH),
    Schema.isPattern(/^https:\/\//u),
  ),
  target: UploadTargetSchema,
  status: JobStatus,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ATTEMPTS })),
  nextAttemptAt: nonnegativeSafeInteger,
  leaseUntil: Schema.NullOr(nonnegativeSafeInteger),
  leaseSeq: nonnegativeSafeInteger,
  verifiedAt: Schema.NullOr(nonnegativeSafeInteger),
  error: Schema.NullOr(boundedOptionalText(MAX_STORED_UPLOAD_ERROR_LENGTH)),
  remoteId: Schema.optional(boundedOptionalText(MAX_UPLOAD_REMOTE_ID_LENGTH)),
  bytes: Schema.optional(nonnegativeSafeInteger),
})
export type LegacyUploadJob = typeof LegacyUploadJobSchema.Type

const OwnershipTransitionsSchema = Schema.Array(ProviderOwnershipTransitionSchema).check(
  Schema.isMaxLength(CLOUD_PROVIDERS.length),
)

export const UploadLedgerStateSchema = Schema.Struct({
  version: Schema.Literal(UPLOAD_LEDGER_STATE_VERSION),
  jobs: LedgerSchema,
  /** Preserved, blocked records with ambiguous pre-v2 raw Media IDs. */
  legacy: Schema.Array(LegacyUploadJobSchema).check(Schema.isMaxLength(MAX_UPLOAD_JOBS)),
  /** Preserved v3 rows that may already have created a remote object but lack
   * the provider identity needed to prove it. They are never drained or retried. */
  quarantine: V3LedgerSchema,
  /** Write-ahead ownership intent. It blocks provider work until Settings proves
   * whether replacement committed or aborted. */
  ownershipTransitions: OwnershipTransitionsSchema,
})
export type UploadLedgerState = typeof UploadLedgerStateSchema.Type

const V4UploadLedgerStateSchema = Schema.Struct({
  version: Schema.Literal(UPLOAD_LEDGER_VERSION),
  jobs: LedgerSchema,
  legacy: Schema.Array(LegacyUploadJobSchema).check(Schema.isMaxLength(MAX_UPLOAD_JOBS)),
  quarantine: V3LedgerSchema,
})

export interface UploadJobSpec {
  /** Canonical global save-request identity. */
  readonly requestId: string
  readonly provider: CloudProviderId
  readonly url: string
  readonly target: UploadTarget
}

export interface ClaimResult {
  readonly ledger: JobLedger
  readonly claimed: boolean
  readonly token?: number
  readonly reason?: string
}

export interface TransitionResult {
  readonly ledger: JobLedger
  readonly changed: boolean
}

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['succeeded', 'dead', 'skipped'])

export const isTerminal = (job: UploadJob): boolean => TERMINAL.has(job.status)

/** Injective local key. Delimiters inside request IDs cannot collide. */
export const idempotencyKeyFor = (requestId: string, provider: CloudProviderId): string =>
  `${UPLOAD_JOB_ID_PREFIX}${requestId.length}:${requestId}:${provider}`

export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))

/**
 * Bound impossible future deadlines from durable job facts. This works in a
 * fresh worker: pending has no wait, failed has at most its backoff, and an
 * in-flight attempt has at most one lease.
 */
export function rebaseUploadDeadlines(ledger: JobLedger, now: number): TransitionResult {
  cloudTime(now)
  let changed = false
  const rebased = ledger.map((job) => {
    if (isTerminal(job)) return job
    const maximumDelay =
      job.status === 'uploading' ? LEASE_MS : job.status === 'failed' ? backoffMs(job.attempts) : 0
    const maximumDeadline = cloudDeadline(now, maximumDelay)
    const leaseTooFar = job.leaseUntil !== null && job.leaseUntil > maximumDeadline
    if (job.nextAttemptAt <= maximumDeadline && !leaseTooFar) return job
    changed = true
    return {
      ...job,
      nextAttemptAt: Math.min(job.nextAttemptAt, maximumDeadline),
      leaseUntil: job.leaseUntil === null ? null : Math.min(job.leaseUntil, maximumDeadline),
      ...(job.status === 'uploading' && job.attemptStartedAt !== undefined
        ? { attemptStartedAt: Math.min(job.attemptStartedAt, now) }
        : {}),
    }
  })
  return changed ? { ledger: rebased, changed: true } : { ledger, changed: false }
}

export type LedgerDecodeResult =
  | { readonly ok: true; readonly ledger: JobLedger }
  | { readonly ok: false }

const isCoherentLedger = (ledger: JobLedger): boolean => {
  const jobIds = new Set<string>()
  const idempotencyKeys = new Set<string>()
  const logicalJobs = new Set<string>()
  for (const job of ledger) {
    const derived = idempotencyKeyFor(job.requestId, job.provider)
    if (
      !isJsonWithinByteBudget(job, MAX_UPLOAD_JOB_BYTES) ||
      job.version !== UPLOAD_LEDGER_VERSION ||
      job.jobId !== derived ||
      job.idempotencyKey !== derived ||
      (job.remoteAttempt !== undefined && job.remoteAttempt.kind !== job.provider) ||
      (job.remotePath !== undefined && job.status !== 'succeeded') ||
      (job.attemptStartedAt !== undefined && job.status !== 'uploading') ||
      jobIds.has(job.jobId) ||
      idempotencyKeys.has(job.idempotencyKey) ||
      logicalJobs.has(derived)
    ) {
      return false
    }
    jobIds.add(job.jobId)
    idempotencyKeys.add(job.idempotencyKey)
    logicalJobs.add(derived)
  }
  return true
}

const migrateV2Jobs = (jobs: ReadonlyArray<V2UploadJob>): ReadonlyArray<V3UploadJob> =>
  jobs.map(({ legacyAliases: _legacyAliases, version: _version, ...job }) => ({
    ...job,
    version: V3_UPLOAD_LEDGER_VERSION,
  }))

const migrateV3Jobs = (
  rows: ReadonlyArray<V3UploadJob>,
): { readonly jobs: JobLedger; readonly quarantine: ReadonlyArray<V3UploadJob> } => {
  const jobs: UploadJob[] = []
  const quarantine: V3UploadJob[] = []
  for (const row of rows) {
    if (row.status === 'uploading') {
      quarantine.push(row)
      continue
    }
    const { version: _version, ...job } = row
    jobs.push({ ...job, version: UPLOAD_LEDGER_VERSION })
  }
  return { jobs, quarantine }
}

const isCoherentV3Ledger = (ledger: ReadonlyArray<V3UploadJob>): boolean => {
  const ids = new Set<string>()
  for (const job of ledger) {
    const derived = idempotencyKeyFor(job.requestId, job.provider)
    if (
      !isJsonWithinByteBudget(job, MAX_UPLOAD_JOB_BYTES) ||
      job.version !== V3_UPLOAD_LEDGER_VERSION ||
      job.jobId !== derived ||
      job.idempotencyKey !== derived ||
      ids.has(job.jobId)
    )
      return false
    ids.add(job.jobId)
  }
  return true
}

const isCoherentLegacyLedger = (legacy: ReadonlyArray<LegacyUploadJob>): boolean => {
  const ids = new Set<string>()
  for (const job of legacy) {
    const derived = `${job.mediaId}:${job.provider}`
    if (
      !isJsonWithinByteBudget(job, MAX_UPLOAD_JOB_BYTES) ||
      job.jobId !== derived ||
      job.idempotencyKey !== derived ||
      ids.has(job.jobId)
    )
      return false
    ids.add(job.jobId)
  }
  return true
}

/**
 * Pre-v2 rows stored only a raw MediaItem ID. X is the sole platform whose
 * canonical current request ID can be proved from that row: its old source URL
 * must be an exact X media host and its final URL key must equal the stored ID.
 * Every other row stays quarantined. This is evidence, not a host-name guess.
 */
const provenXRequestId = (job: LegacyUploadJob): string | undefined => {
  let url: URL
  try {
    url = new URL(job.url)
  } catch {
    return undefined
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname !== 'pbs.twimg.com' && url.hostname !== 'video.twimg.com')
  )
    return undefined
  const segment = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
  const dot = segment.lastIndexOf('.')
  const mediaKey = dot < 0 ? segment : segment.slice(0, dot)
  if (mediaKey === '' || mediaKey !== job.mediaId) return undefined
  return mediaRequestId({ platform: 'x', id: job.mediaId })
}

const migrateProvenLegacy = (
  legacy: ReadonlyArray<LegacyUploadJob>,
  existing: ReadonlyArray<{ readonly jobId: string }> = [],
): Pick<UploadLedgerState, 'jobs' | 'legacy'> => {
  const jobs: UploadJob[] = []
  const quarantined: LegacyUploadJob[] = []
  const ids = new Set(existing.map((job) => job.jobId))
  for (const old of legacy) {
    const requestId = provenXRequestId(old)
    const jobId = requestId === undefined ? undefined : idempotencyKeyFor(requestId, old.provider)
    if (requestId === undefined || jobId === undefined || ids.has(jobId)) {
      quarantined.push(old)
      continue
    }
    ids.add(jobId)
    jobs.push({
      ...old,
      version: UPLOAD_LEDGER_VERSION,
      jobId,
      idempotencyKey: jobId,
      requestId,
    })
  }
  return { jobs, legacy: quarantined }
}

const isCoherentQuarantine = (rows: ReadonlyArray<V3UploadJob>): boolean =>
  rows.every((row) => row.status === 'uploading') && isCoherentV3Ledger(rows)

const hasCrossStateDuplicate = (
  jobs: JobLedger,
  quarantine: ReadonlyArray<V3UploadJob>,
): boolean => {
  const ids = new Set(jobs.map((job) => job.jobId))
  return quarantine.some((job) => ids.has(job.jobId))
}

const historicalState = (
  rows: ReadonlyArray<V3UploadJob>,
  legacy: ReadonlyArray<LegacyUploadJob>,
): UploadLedgerState | undefined => {
  if (
    rows.length + legacy.length > MAX_UPLOAD_JOBS ||
    !isCoherentV3Ledger(rows) ||
    !isCoherentLegacyLedger(legacy)
  )
    return undefined
  const migratedV3 = migrateV3Jobs(rows)
  const migratedLegacy = migrateProvenLegacy(legacy, [...migratedV3.jobs, ...migratedV3.quarantine])
  const state: UploadLedgerState = {
    version: UPLOAD_LEDGER_STATE_VERSION,
    jobs: [...migratedV3.jobs, ...migratedLegacy.jobs],
    legacy: migratedLegacy.legacy,
    quarantine: migratedV3.quarantine,
    ownershipTransitions: [],
  }
  return state.jobs.length + state.legacy.length + state.quarantine.length <= MAX_UPLOAD_JOBS
    ? state
    : undefined
}

export type LedgerStateDecodeResult =
  | { readonly ok: true; readonly state: UploadLedgerState; readonly migrationNeeded: boolean }
  | { readonly ok: false }

/**
 * Strict state decode. A raw v2 array is a harmless interrupted envelope
 * migration. A raw pre-v2 array becomes blocked `legacy` data: no inferred
 * platform, no automatic upload, and no duplicate canonical enqueue.
 */
export function decodeLedgerStateResult(raw: unknown): LedgerStateDecodeResult {
  const empty: UploadLedgerState = {
    version: UPLOAD_LEDGER_STATE_VERSION,
    jobs: [],
    legacy: [],
    quarantine: [],
    ownershipTransitions: [],
  }
  if (raw === null || raw === undefined) return { ok: true, state: empty, migrationNeeded: false }
  if (!isJsonWithinByteBudget(raw, MAX_UPLOAD_LEDGER_BYTES)) return { ok: false }
  try {
    const state = Schema.decodeUnknownSync(UploadLedgerStateSchema, {
      onExcessProperty: 'error',
    })(raw)
    if (
      state.jobs.length + state.legacy.length + state.quarantine.length > MAX_UPLOAD_JOBS ||
      !isCoherentLedger(state.jobs) ||
      !isCoherentLegacyLedger(state.legacy) ||
      !isCoherentQuarantine(state.quarantine) ||
      hasCrossStateDuplicate(state.jobs, state.quarantine) ||
      !isCoherentOwnershipTransitions(state.ownershipTransitions)
    )
      return { ok: false }
    const migrated = migrateProvenLegacy(state.legacy, [...state.jobs, ...state.quarantine])
    return {
      ok: true,
      state: { ...state, jobs: [...state.jobs, ...migrated.jobs], legacy: migrated.legacy },
      migrationNeeded: migrated.jobs.length > 0,
    }
  } catch {
    // Continue with the v4 state envelope.
  }
  try {
    const v4 = Schema.decodeUnknownSync(V4UploadLedgerStateSchema, {
      onExcessProperty: 'error',
    })(raw)
    if (
      v4.jobs.length + v4.legacy.length + v4.quarantine.length > MAX_UPLOAD_JOBS ||
      !isCoherentLedger(v4.jobs) ||
      !isCoherentLegacyLedger(v4.legacy) ||
      !isCoherentQuarantine(v4.quarantine) ||
      hasCrossStateDuplicate(v4.jobs, v4.quarantine)
    )
      return { ok: false }
    const migrated = migrateProvenLegacy(v4.legacy, [...v4.jobs, ...v4.quarantine])
    return {
      ok: true,
      state: {
        version: UPLOAD_LEDGER_STATE_VERSION,
        jobs: [...v4.jobs, ...migrated.jobs],
        legacy: migrated.legacy,
        quarantine: v4.quarantine,
        ownershipTransitions: [],
      },
      migrationNeeded: true,
    }
  } catch {
    // Continue with strictly bounded historical formats below.
  }
  try {
    const v3 = Schema.decodeUnknownSync(
      Schema.Struct({
        version: Schema.Literal(V3_UPLOAD_LEDGER_VERSION),
        jobs: V3LedgerSchema,
        legacy: Schema.Array(LegacyUploadJobSchema).check(Schema.isMaxLength(MAX_UPLOAD_JOBS)),
      }),
      { onExcessProperty: 'error' },
    )(raw)
    const state = historicalState(v3.jobs, v3.legacy)
    return state === undefined ? { ok: false } : { ok: true, state, migrationNeeded: true }
  } catch {
    // Continue with a v2 envelope.
  }
  try {
    const v2 = Schema.decodeUnknownSync(
      Schema.Struct({
        version: Schema.Literal(V2_UPLOAD_LEDGER_VERSION),
        jobs: V2LedgerSchema,
        legacy: Schema.Array(LegacyUploadJobSchema).check(Schema.isMaxLength(MAX_UPLOAD_JOBS)),
      }),
      { onExcessProperty: 'error' },
    )(raw)
    const state = historicalState(migrateV2Jobs(v2.jobs), v2.legacy)
    return state === undefined ? { ok: false } : { ok: true, state, migrationNeeded: true }
  } catch {
    // A raw v2 array is the interrupted envelope migration below.
  }
  try {
    const v2 = Schema.decodeUnknownSync(V2LedgerSchema, { onExcessProperty: 'error' })(raw)
    const state = historicalState(migrateV2Jobs(v2), [])
    return state === undefined ? { ok: false } : { ok: true, state, migrationNeeded: true }
  } catch {
    // Continue with a raw v4 array.
  }
  try {
    const jobs = Schema.decodeUnknownSync(LedgerSchema, { onExcessProperty: 'error' })(raw)
    if (!isCoherentLedger(jobs)) return { ok: false }
    return { ok: true, state: { ...empty, jobs }, migrationNeeded: true }
  } catch {
    // Continue with a raw v3 array.
  }
  try {
    const v3 = Schema.decodeUnknownSync(V3LedgerSchema, { onExcessProperty: 'error' })(raw)
    const state = historicalState(v3, [])
    return state === undefined ? { ok: false } : { ok: true, state, migrationNeeded: true }
  } catch {
    // This is the pre-v2 shape. It has no platform, so preserve but quarantine it.
  }
  try {
    const legacy = Schema.decodeUnknownSync(Schema.Array(LegacyUploadJobSchema), {
      onExcessProperty: 'error',
    })(raw)
    if (legacy.length > MAX_UPLOAD_JOBS || !isCoherentLegacyLedger(legacy)) return { ok: false }
    const migrated = migrateProvenLegacy(legacy)
    return {
      ok: true,
      state: { ...empty, ...migrated },
      migrationNeeded: true,
    }
  } catch {
    return { ok: false }
  }
}

/** Strict durable decode. `null`/`undefined` are the valid pre-ledger state;
 * malformed persisted data is distinct so callers can quarantine it. */
export function decodeLedgerResult(raw: unknown): LedgerDecodeResult {
  const decoded = decodeLedgerStateResult(raw)
  return decoded.ok ? { ok: true, ledger: decoded.state.jobs } : { ok: false }
}

/** True when a new request could be the same raw-ID legacy record. Block it. */
export const legacyConflict = (
  state: UploadLedgerState,
  legacyAliases: ReadonlyArray<string>,
  provider: CloudProviderId,
): LegacyUploadJob | undefined =>
  state.legacy.find((job) => job.provider === provider && legacyAliases.includes(job.mediaId))

/** Canonical v3 in-flight rows are known logical jobs but have no safe remote
 * identity. A same-job enqueue must remain blocked until explicit recovery. */
export const quarantineConflict = (
  state: UploadLedgerState,
  requestId: string,
  provider: CloudProviderId,
): V3UploadJob | undefined =>
  state.quarantine.find((job) => job.provider === provider && job.requestId === requestId)

const replaceJob = (ledger: JobLedger, job: UploadJob): JobLedger =>
  ledger.map((j) => (j.jobId === job.jobId ? job : j))

/**
 * Append one job per (requestId, provider), or REFRESH an existing one. Keyed by
 * idempotencyKey so the at-least-once enqueue is exactly-once, BUT a re-enqueue is
 * not a blind no-op: it carries a FRESH source URL (and target), and twimg video
 * URLs link-rot. So:
 *   - `succeeded` → no-op (already uploaded; never re-upload).
 *   - `uploading` → no-op (a drain holds the lease; the fencing token + crash
 *      recovery own its lifecycle — don't disturb a live transfer).
 *   - anything else (`pending`/`failed`/`skipped`/`dead`) → re-arm to `pending`
 *      with the new url+target, attempts/backoff reset and error cleared.
 * The last rule is the fix for the pinned-URL bug: without it the idempotent no-op
 * left a failed/skipped job stuck on its expired URL forever, so neither a backoff
 * retry nor a fresh re-download could ever succeed.
 */
export function enqueue(ledger: JobLedger, spec: UploadJobSpec, now: number): JobLedger {
  cloudTime(now)
  const requestId = spec.requestId
  const idempotencyKey = idempotencyKeyFor(requestId, spec.provider)
  const existing = ledger.find((j) => j.idempotencyKey === idempotencyKey)
  if (existing !== undefined) {
    if (existing.status === 'succeeded' || existing.status === 'uploading') return ledger
    const { attemptStartedAt: _attemptStartedAt, ...dormant } = existing
    const revived: UploadJob = {
      ...dormant,
      url: spec.url,
      // Once provider identity exists, placement is frozen. Retargeting the same
      // logical attempt could move or create the proven blob under a new name.
      target: existing.remoteAttempt === undefined ? spec.target : existing.target,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      error: null,
    }
    return replaceJob(ledger, revived)
  }
  const job: UploadJob = {
    version: UPLOAD_LEDGER_VERSION,
    jobId: idempotencyKey,
    idempotencyKey,
    requestId,
    provider: spec.provider,
    url: spec.url,
    target: spec.target,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    leaseUntil: null,
    leaseSeq: 0,
    verifiedAt: null,
    error: null,
  }
  return [...ledger, job]
}

export type EnqueueAdmission =
  | { readonly admitted: true; readonly added: boolean; readonly ledger: JobLedger }
  | { readonly admitted: false; readonly added: false; readonly ledger: JobLedger }

/** Admit without sacrificing durable work. Existing keys may refresh at the
 * bound because they do not grow the ledger; only new keys are rejected. */
export function enqueueBounded(
  ledger: JobLedger,
  spec: UploadJobSpec,
  now: number,
  maxJobs = MAX_UPLOAD_JOBS,
): EnqueueAdmission {
  const requestId = spec.requestId
  const exists = ledger.some(
    (job) => job.idempotencyKey === idempotencyKeyFor(requestId, spec.provider),
  )
  if (!exists && ledger.length >= Math.max(0, maxJobs)) {
    return { admitted: false, added: false, ledger }
  }
  return { admitted: true, added: !exists, ledger: enqueue(ledger, spec, now) }
}

/** Forget every job owned by a disconnected provider. This includes terminal
 * records: they describe another account and must not survive a reconnect. */
export function removeProviderJobs(ledger: JobLedger, provider: CloudProviderId): JobLedger {
  const next = ledger.filter((job) => job.provider !== provider)
  return next.length === ledger.length ? ledger : next
}

/** pending/failed claimable when due; an `uploading` job only once its lease expired (crash recovery). */
export const isClaimable = (job: UploadJob, now: number): boolean =>
  (job.status === 'pending' || job.status === 'failed' || job.status === 'uploading') &&
  job.attempts < MAX_ATTEMPTS &&
  now >= job.nextAttemptAt &&
  (job.leaseUntil === null || job.leaseUntil <= now)

export const readyJobs = (ledger: JobLedger, now: number): JobLedger =>
  ledger.filter((j) => isClaimable(j, now))

/** Drop terminal/succeeded jobs to keep the persisted ledger bounded. */
export const pruneTerminal = (ledger: JobLedger): JobLedger => ledger.filter((j) => !isTerminal(j))

/** Keep every live job + the most-recent `maxTerminal` terminal jobs, so the
 *  ledger stays bounded but the popup can still show a recent "N uploaded" count.
 *  Returns the same reference when nothing is dropped (cheap no-op). */
export function capLedger(ledger: JobLedger, maxTerminal = 50): JobLedger {
  const terminalCount = ledger.reduce((n, j) => (isTerminal(j) ? n + 1 : n), 0)
  if (terminalCount <= maxTerminal) return ledger
  let toDrop = terminalCount - maxTerminal
  // Drop oldest terminal jobs first (insertion order); keep all live jobs.
  return ledger.filter((j) => {
    if (toDrop > 0 && isTerminal(j)) {
      toDrop -= 1
      return false
    }
    return true
  })
}

/**
 * Compare-and-set claim: issue a fresh fencing token + lease, or refuse if a live
 * lease is held. Reclaiming a crashed `uploading` job consumes one attempt (and
 * dies at MAX_ATTEMPTS), so a crash loop is bounded.
 */
export function claim(
  ledger: JobLedger,
  jobId: string,
  now: number,
  leaseMs: number = LEASE_MS,
): ClaimResult {
  cloudTime(now)
  const lease = Math.max(1, leaseMs)
  cloudDeadline(now, lease)
  const job = ledger.find((j) => j.jobId === jobId)
  if (job === undefined) return { ledger, claimed: false, reason: 'not found' }
  if (isTerminal(job)) return { ledger, claimed: false, reason: job.status }
  if (job.status === 'uploading' && job.leaseUntil !== null && job.leaseUntil > now) {
    return { ledger, claimed: false, reason: `lease held ${job.leaseUntil - now}ms` }
  }
  if (now < job.nextAttemptAt) {
    return { ledger, claimed: false, reason: `backoff ${job.nextAttemptAt - now}ms` }
  }
  const attempts = job.status === 'uploading' ? job.attempts + 1 : job.attempts
  if (job.status === 'uploading' && attempts >= MAX_ATTEMPTS) {
    const { attemptStartedAt: _attemptStartedAt, ...held } = job
    const dead: UploadJob = {
      ...held,
      status: 'dead',
      attempts,
      leaseUntil: null,
      error: 'crashed: attempts exhausted',
    }
    return { ledger: replaceJob(ledger, dead), claimed: false, reason: 'exhausted' }
  }
  if (job.leaseSeq >= Number.MAX_SAFE_INTEGER) {
    const { attemptStartedAt: _attemptStartedAt, ...held } = job
    const dead: UploadJob = {
      ...held,
      status: 'dead',
      leaseUntil: null,
      error: 'lease sequence exhausted',
    }
    return { ledger: replaceJob(ledger, dead), claimed: false, reason: 'exhausted' }
  }
  const leaseSeq = job.leaseSeq + 1
  const leaseUntil = cloudDeadline(now, lease)
  const started: UploadJob = {
    ...job,
    status: 'uploading',
    attempts,
    leaseSeq,
    leaseUntil,
    nextAttemptAt: leaseUntil,
    attemptStartedAt: now,
    error: null,
  }
  return { ledger: replaceJob(ledger, started), claimed: true, token: leaseSeq }
}

const onHeldLease = (
  ledger: JobLedger,
  jobId: string,
  token: number,
  fn: (job: UploadJob) => UploadJob,
): TransitionResult => {
  const job = ledger.find((j) => j.jobId === jobId)
  if (job === undefined || job.status !== 'uploading' || job.leaseSeq !== token) {
    return { ledger, changed: false }
  }
  return { ledger: replaceJob(ledger, fn(job)), changed: true }
}

const boundedError = (reason: string): string => boundedDiagnosticText(reason)

const acceptedRemoteAttempt = (
  attempt: RemoteAttempt,
  provider: CloudProviderId,
): RemoteAttempt | undefined => {
  try {
    const decoded = Schema.decodeUnknownSync(RemoteAttemptSchema, {
      onExcessProperty: 'error',
    })(attempt)
    return decoded.kind === provider ? decoded : undefined
  } catch {
    return undefined
  }
}

/** Bind provider identity while the claim is held. This transition must be
 * persisted before any byte write. Existing identity is immutable. */
export function bindRemoteAttempt(
  ledger: JobLedger,
  jobId: string,
  token: number,
  attempt: RemoteAttempt,
): TransitionResult {
  const job = ledger.find((candidate) => candidate.jobId === jobId)
  const accepted = job === undefined ? undefined : acceptedRemoteAttempt(attempt, job.provider)
  if (
    job === undefined ||
    job.status !== 'uploading' ||
    job.leaseSeq !== token ||
    job.remoteAttempt !== undefined ||
    accepted === undefined
  )
    return { ledger, changed: false }
  return { ledger: replaceJob(ledger, { ...job, remoteAttempt: accepted }), changed: true }
}

/** Persist provider progress before the next provider side effect. The only
 * legal progress today is Dropbox prepared → staged with the same identity. */
export function recordRemoteProgress(
  ledger: JobLedger,
  jobId: string,
  token: number,
  attempt: RemoteAttempt,
): TransitionResult {
  const job = ledger.find((candidate) => candidate.jobId === jobId)
  const current = job?.remoteAttempt
  const accepted = job === undefined ? undefined : acceptedRemoteAttempt(attempt, job.provider)
  if (
    job === undefined ||
    job.status !== 'uploading' ||
    job.leaseSeq !== token ||
    current?.kind !== 'dropbox' ||
    current.phase !== 'prepared' ||
    accepted?.kind !== 'dropbox' ||
    accepted.phase !== 'staged' ||
    accepted.ownerKey !== current.ownerKey ||
    accepted.stagePath !== current.stagePath
  )
    return { ledger, changed: false }
  return { ledger: replaceJob(ledger, { ...job, remoteAttempt: accepted }), changed: true }
}

/** uploading → succeeded. */
export function recordSuccess(
  ledger: JobLedger,
  jobId: string,
  token: number,
  now: number,
  result: {
    readonly bytes: number
    readonly remotePath: string
    readonly remoteId?: string
  },
): TransitionResult {
  cloudTime(now)
  const remotePath = result.remotePath
  if (
    !Number.isSafeInteger(result.bytes) ||
    result.bytes < 0 ||
    remotePath.length === 0 ||
    remotePath.length > MAX_TRANSFER_FILENAME_LENGTH ||
    (result.remoteId !== undefined &&
      (result.remoteId.length === 0 || result.remoteId.length > MAX_UPLOAD_REMOTE_ID_LENGTH))
  )
    return { ledger, changed: false }
  return onHeldLease(ledger, jobId, token, (job) => {
    const { attemptStartedAt: _attemptStartedAt, ...held } = job
    return {
      ...held,
      status: 'succeeded',
      leaseUntil: null,
      verifiedAt: monotonicCloudTime(now, job.attemptStartedAt ?? now),
      error: null,
      bytes: result.bytes,
      ...(result.remoteId !== undefined ? { remoteId: result.remoteId } : {}),
      remotePath,
    }
  })
}

/** uploading → failed (with backoff) or → dead at MAX_ATTEMPTS. */
export function recordFailure(
  ledger: JobLedger,
  jobId: string,
  token: number,
  now: number,
  reason: string,
): TransitionResult {
  cloudTime(now)
  return onHeldLease(ledger, jobId, token, (job) => {
    const { attemptStartedAt: _attemptStartedAt, ...held } = job
    const settledAt = monotonicCloudTime(now, job.attemptStartedAt ?? now)
    const attempts = job.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      return {
        ...held,
        status: 'dead',
        attempts,
        leaseUntil: null,
        error: boundedError(reason),
      }
    }
    return {
      ...held,
      status: 'failed',
      attempts,
      leaseUntil: null,
      nextAttemptAt: cloudDeadline(settledAt, backoffMs(attempts)),
      error: boundedError(reason),
    }
  })
}

/** uploading → skipped: the source URL is gone (twimg 403/410). Honest — never a fake save. */
export function recordSourceGone(
  ledger: JobLedger,
  jobId: string,
  token: number,
  reason: string,
): TransitionResult {
  return onHeldLease(ledger, jobId, token, (job) => {
    const { attemptStartedAt: _attemptStartedAt, ...held } = job
    return {
      ...held,
      status: 'skipped',
      leaseUntil: null,
      error: boundedError(reason),
    }
  })
}

/** Operator escape: move a `dead`/`failed` job back to `pending`. */
export function retry(ledger: JobLedger, jobId: string, now: number): TransitionResult {
  cloudTime(now)
  const job = ledger.find((j) => j.jobId === jobId)
  if (job === undefined || (job.status !== 'dead' && job.status !== 'failed')) {
    return { ledger, changed: false }
  }
  const { attemptStartedAt: _attemptStartedAt, ...dormant } = job
  const reset: UploadJob = {
    ...dormant,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    leaseUntil: null,
    error: null,
  }
  return { ledger: replaceJob(ledger, reset), changed: true }
}

export interface UploadSummary {
  readonly pending: number
  readonly uploading: number
  readonly succeeded: number
  readonly failed: number
  readonly dead: number
  readonly skipped: number
}

/** Counts by status, for the popup's upload-status line. */
export function summarize(ledger: JobLedger): UploadSummary {
  const s: UploadSummary = {
    pending: 0,
    uploading: 0,
    succeeded: 0,
    failed: 0,
    dead: 0,
    skipped: 0,
  }
  const acc = { ...s }
  for (const j of ledger) acc[j.status] += 1
  return acc
}

/**
 * The Convex control-plane mirror shape of an UploadJob (`uploads:recordUploadJobs`,
 * ADR-0013) — the single source for the outgoing wire payload, mirroring how
 * `events.ts` pairs `SyncEvent` with its constructors. The backend `upload_jobs`
 * validator (`backend/convex/schema.ts`) is the server half of this contract;
 * keeping the projection here (typed, not an inline literal) makes a client-side
 * drift a compile error instead of a silently-swallowed mirror reject. Metadata
 * only — bytes never transit Convex.
 */
export const WireUploadJob = Schema.Struct({
  /** Injective v2 device/request/provider idempotency key. */
  jobId: boundedText(
    UPLOAD_JOB_ID_PREFIX.length + MAX_CLOUD_DEVICE_ID_LENGTH + MAX_SAVE_REQUEST_ID_LENGTH + 128,
  ),
  deviceId: boundedText(MAX_CLOUD_DEVICE_ID_LENGTH),
  /** Canonical global save-request identity. */
  requestId: SaveRequestId,
  provider: CloudProvider,
  status: JobStatus,
  attempts: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: MAX_ATTEMPTS })),
  /** Monotonic durable lease revision; the backend uses this over wall time. */
  revision: nonnegativeSafeInteger,
  at: nonnegativeSafeInteger,
  remotePath: boundedText(MAX_TRANSFER_FILENAME_LENGTH),
  bytes: Schema.optional(nonnegativeSafeInteger),
  error: Schema.optional(boundedOptionalText(MAX_UPLOAD_ERROR_LENGTH)),
})
export type WireUploadJob = typeof WireUploadJob.Type

const wireJobIdFor = (deviceId: string, requestId: string, provider: CloudProviderId): string =>
  `${UPLOAD_JOB_ID_PREFIX}wire:${deviceId.length}:${deviceId}:${requestId.length}:${requestId}:${provider}`

export const isWireJobIdFor = (
  jobId: string,
  deviceId: string,
  requestId: string,
  provider: CloudProviderId,
): boolean => jobId === wireJobIdFor(deviceId, requestId, provider)

/** Project a settled UploadJob into its Convex mirror payload. `deviceId` and `now`
 *  are injected (no clock/storage here, matching the reducer's purity). */
export function toWireUploadJob(job: UploadJob, deviceId: string, now: number): WireUploadJob {
  return {
    jobId: wireJobIdFor(deviceId, job.requestId, job.provider),
    deviceId,
    requestId: job.requestId,
    provider: job.provider,
    status: job.status,
    attempts: job.attempts,
    revision: job.leaseSeq,
    at: now,
    remotePath: job.remotePath ?? job.target.path,
    ...(job.bytes !== undefined ? { bytes: job.bytes } : {}),
    ...(job.error !== null ? { error: boundedDiagnosticText(job.error) } : {}),
  }
}
