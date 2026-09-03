import { Schema } from 'effect'
import { type BackoffPolicy, expBackoffMs } from '@/packages/kernel/backoff'
import { CLOUD_PROVIDERS, type JsonValue } from '@/packages/schema'
import type { CloudProviderId, UploadOutcome, UploadTarget } from './types'

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

const UploadTargetSchema = Schema.Struct({
  path: Schema.String,
  folder: Schema.String,
  filename: Schema.String,
  contentType: Schema.String,
})

export const UploadJobSchema = Schema.Struct({
  jobId: Schema.String,
  /** `${mediaId}:${provider}` — at-least-once enqueue becomes exactly-once. */
  idempotencyKey: Schema.String,
  /** The local download request id (= media item id). */
  mediaId: Schema.String,
  provider: CloudProvider,
  /** twimg source URL — fetched only via the SSRF guard at drain time. */
  url: Schema.String,
  target: UploadTargetSchema,
  status: JobStatus,
  /** Attempts that have ended (failed or crashed). Caps the job at MAX_ATTEMPTS. */
  attempts: Schema.Number,
  /** Claimable only when `now >= nextAttemptAt`. */
  nextAttemptAt: Schema.Number,
  leaseUntil: Schema.NullOr(Schema.Number),
  /** Monotonic fencing token; each claim issues `leaseSeq + 1`. */
  leaseSeq: Schema.Number,
  verifiedAt: Schema.NullOr(Schema.Number),
  error: Schema.NullOr(Schema.String),
  remoteId: Schema.optionalKey(Schema.String),
  bytes: Schema.optionalKey(Schema.Number),
})
export type UploadJob = typeof UploadJobSchema.Type

const LedgerSchema = Schema.Array(UploadJobSchema)
export type JobLedger = ReadonlyArray<UploadJob>

export interface UploadJobSpec {
  readonly mediaId: string
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

export const idempotencyKeyFor = (mediaId: string, provider: CloudProviderId): string =>
  `${mediaId}:${provider}`

const UPLOAD_BACKOFF = {
  baseMs: BACKOFF_BASE_MS,
  capMs: BACKOFF_CAP_MS,
} satisfies BackoffPolicy

/**
 * Delay before the next upload attempt.
 *
 * @param attempts - Attempts already ENDED — 1-BASED against the ladder, matching
 * the `attempts` field it is fed from: the first failure passes 1 and waits 5s, so
 * 0 and 1 share that base. Doubles per attempt, capped at 5 min — a cap
 * {@link MAX_ATTEMPTS} keeps out of reach, since the last delay a live job can draw
 * is 40s at `attempts` 4. Contrast the 0-based `interruptBackoffMs` in
 * `@/packages/download`.
 */
export const backoffMs = (attempts: number): number => expBackoffMs(attempts - 1, UPLOAD_BACKOFF)

/** Decode a persisted ledger; fall back to empty on corrupt data (outbox idiom). */
export function decodeLedger(raw: JsonValue): JobLedger {
  try {
    return Schema.decodeUnknownSync(LedgerSchema)(raw ?? [])
  } catch {
    return []
  }
}

const replaceJob = (ledger: JobLedger, job: UploadJob): JobLedger =>
  ledger.map((j) => (j.jobId === job.jobId ? job : j))

/**
 * Append one job per (mediaId, provider), or REFRESH an existing one. Keyed by
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
  const idempotencyKey = idempotencyKeyFor(spec.mediaId, spec.provider)
  const existing = ledger.find((j) => j.idempotencyKey === idempotencyKey)
  if (existing !== undefined) {
    if (existing.status === 'succeeded' || existing.status === 'uploading') return ledger
    const revived: UploadJob = {
      ...existing,
      url: spec.url,
      target: spec.target,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      error: null,
    }
    return replaceJob(ledger, revived)
  }
  const job: UploadJob = {
    jobId: idempotencyKey,
    idempotencyKey,
    mediaId: spec.mediaId,
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
  const lease = Math.max(1, leaseMs)
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
    const dead: UploadJob = {
      ...job,
      status: 'dead',
      attempts,
      leaseUntil: null,
      error: 'crashed: attempts exhausted',
    }
    return { ledger: replaceJob(ledger, dead), claimed: false, reason: 'exhausted' }
  }
  const leaseSeq = job.leaseSeq + 1
  const started: UploadJob = {
    ...job,
    status: 'uploading',
    attempts,
    leaseSeq,
    leaseUntil: now + lease,
    nextAttemptAt: now + lease,
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

/** uploading → succeeded. */
export function recordSuccess(
  ledger: JobLedger,
  jobId: string,
  token: number,
  now: number,
  result: { readonly bytes: number; readonly remoteId?: string },
): TransitionResult {
  return onHeldLease(ledger, jobId, token, (job) => ({
    ...job,
    status: 'succeeded',
    leaseUntil: null,
    verifiedAt: now,
    error: null,
    bytes: result.bytes,
    ...(result.remoteId !== undefined ? { remoteId: result.remoteId } : {}),
  }))
}

/** uploading → failed (with backoff) or → dead at MAX_ATTEMPTS. */
export function recordFailure(
  ledger: JobLedger,
  jobId: string,
  token: number,
  now: number,
  reason: string,
): TransitionResult {
  return onHeldLease(ledger, jobId, token, (job) => {
    const attempts = job.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      return { ...job, status: 'dead', attempts, leaseUntil: null, error: reason }
    }
    return {
      ...job,
      status: 'failed',
      attempts,
      leaseUntil: null,
      nextAttemptAt: now + backoffMs(attempts),
      error: reason,
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
  return onHeldLease(ledger, jobId, token, (job) => ({
    ...job,
    status: 'skipped',
    leaseUntil: null,
    error: reason,
  }))
}

/** Consume one provider outcome: dispatch to the right transition and return the
 *  settled job so the caller stops re-finding it. Same CAS-lease semantics as the
 *  underlying transitions (stale token ⇒ ledger unchanged, `settled` reflects the
 *  stored job as-is). */
export function applyUploadOutcome(
  ledger: JobLedger,
  jobId: string,
  token: number,
  now: number,
  outcome: UploadOutcome,
) {
  let next: JobLedger
  if (outcome.kind === 'success') {
    next = recordSuccess(ledger, jobId, token, now, {
      bytes: outcome.bytes,
      ...(outcome.remoteId !== undefined ? { remoteId: outcome.remoteId } : {}),
    }).ledger
  } else if (outcome.kind === 'sourceGone') {
    next = recordSourceGone(ledger, jobId, token, outcome.reason).ledger
  } else {
    next = recordFailure(ledger, jobId, token, now, outcome.reason).ledger
  }
  return { ledger: next, settled: next.find((j) => j.jobId === jobId) }
}

/** Operator escape: move a `dead`/`failed` job back to `pending`. */
export function retry(ledger: JobLedger, jobId: string, now: number): TransitionResult {
  const job = ledger.find((j) => j.jobId === jobId)
  if (job === undefined || (job.status !== 'dead' && job.status !== 'failed')) {
    return { ledger, changed: false }
  }
  const reset: UploadJob = {
    ...job,
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    leaseUntil: null,
    error: null,
  }
  return { ledger: replaceJob(ledger, reset), changed: true }
}

/** A `type` alias, not an `interface`: nested inside `CloudUploadStatus`, which
 *  crosses the background↔popup message boundary as a `JsonValue` — only a
 *  `type`'s object-literal shape gets TypeScript's implicit index signature
 *  there. */
export type UploadSummary = {
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
  /** Wire idempotency key `${deviceId}/${mediaId}/${provider}` (distinct from the
   *  local `jobId`); last-write-wins by `at` on the backend `by_job` index. */
  jobId: Schema.String,
  deviceId: Schema.String,
  /** The local download request id (= media item id). */
  requestId: Schema.String,
  provider: CloudProvider,
  status: JobStatus,
  attempts: Schema.Number,
  at: Schema.Number,
  remotePath: Schema.String,
  bytes: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.String),
})
export type WireUploadJob = typeof WireUploadJob.Type

/** Project a settled UploadJob into its Convex mirror payload. `deviceId` and `now`
 *  are injected (no clock/storage here, matching the reducer's purity). */
export function toWireUploadJob(job: UploadJob, deviceId: string, now: number): WireUploadJob {
  return {
    jobId: `${deviceId}/${job.mediaId}/${job.provider}`,
    deviceId,
    requestId: job.mediaId,
    provider: job.provider,
    status: job.status,
    attempts: job.attempts,
    at: now,
    remotePath: job.target.path,
    ...(job.bytes !== undefined ? { bytes: job.bytes } : {}),
    ...(job.error !== null ? { error: job.error } : {}),
  }
}
