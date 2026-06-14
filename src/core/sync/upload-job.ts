/**
 * UploadJob ledger — the pure state machine for the cloud-destinations byte path
 * (plan task A6; ADR-0013). One job per (Media Item × Cloud Target). A job moves
 *
 *   pending ─claim→ uploading ─┬─ recordSuccess ──→ succeeded   (HEAD-verified: landed)
 *                              ├─ recordFailure  ──→ failed ─(backoff, re-claim)─→ … → dead
 *                              ├─ recordSourceGone → skipped    (twimg 403 / link-rot)
 *                              └─ (worker crash) ─ lease expires → re-claim (counts an attempt)
 *   dead ─retry→ pending       (operator escape — the ONLY sanctioned terminal regression)
 *
 * Pure: no I/O, no provider simulation, no clock or randomness — the effectful
 * runner determines real outcomes (fetch via the SSRF guard → presigned upload →
 * out-of-band HEAD verify) and records them here. Persistence-agnostic: the same
 * reducer drives a Convex ledger or any other store. The ledger is per-owner
 * (device/user scoped upstream); jobIds are caller-supplied (e.g. a Convex doc id).
 *
 * Two invariants carry the design:
 *   1. Terminal (succeeded/dead/skipped) never regresses except via explicit retry().
 *   2. A lease is a fencing token (leaseSeq): claim() issues a fresh token; only the
 *      holder of the current token can record an outcome, so a slow/zombie worker
 *      whose lease was reclaimed can never corrupt the live claimant's run.
 */

export const MAX_ATTEMPTS = 5
export const BACKOFF_BASE_MS = 5_000
export const BACKOFF_CAP_MS = 300_000
export const LEASE_MS = 30_000

export type Provider = 's3' | 'r2' | 'dropbox' | 'gphotos'
export type JobStatus = 'pending' | 'uploading' | 'succeeded' | 'failed' | 'dead' | 'skipped'

/** Fencing token issued by claim(); a transition is applied only if it matches. */
export type LeaseToken = number

export interface UploadJob {
  readonly jobId: string
  /** `${mediaId}:${provider}` — at-least-once enqueue becomes exactly-once. */
  readonly idempotencyKey: string
  readonly mediaId: string
  readonly provider: Provider
  /**
   * Destination object key. MUST be server-derived under the owner's prefix and
   * pre-sanitized upstream (no `..`, no leading `/`) — task A3's deriveObjectKey.
   * This reducer treats it as opaque and never derives or sanitizes it.
   */
  readonly objectKey: string
  readonly status: JobStatus
  /** Attempts that have ended (failed or crashed). Caps the job at MAX_ATTEMPTS. */
  readonly attempts: number
  /** Claimable only when `now >= nextAttemptAt`. */
  readonly nextAttemptAt: number
  readonly leaseUntil: number | null
  /** Monotonic fencing token; each claim issues `leaseSeq + 1`. */
  readonly leaseSeq: number
  /** Set only after the runner's out-of-band HEAD verify (key + size) succeeds. */
  readonly verifiedAt: number | null
  readonly error: string | null
}

export type JobLedger = readonly UploadJob[]

export interface UploadJobSpec {
  readonly mediaId: string
  readonly provider: Provider
  readonly objectKey: string
}

export interface ClaimResult {
  readonly ledger: JobLedger
  readonly claimed: boolean
  /** Fencing token to pass to the matching record / renew call; set iff claimed. */
  readonly token?: LeaseToken
  readonly reason?: string
}

export interface TransitionResult {
  readonly ledger: JobLedger
  readonly changed: boolean
}

const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(['succeeded', 'dead', 'skipped'])

export const isTerminal = (job: UploadJob): boolean => TERMINAL.has(job.status)

export const idempotencyKeyFor = (mediaId: string, provider: Provider): string =>
  `${mediaId}:${provider}`

export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))

const replaceJob = (ledger: JobLedger, job: UploadJob): JobLedger =>
  ledger.map((j) => (j.jobId === job.jobId ? job : j))

/**
 * Append one job per (mediaId, provider). Idempotent by idempotencyKey, and a
 * no-op if `jobId` is already present (a duplicate id would alias `replaceJob`).
 */
export function enqueue(
  ledger: JobLedger,
  spec: UploadJobSpec,
  jobId: string,
  now: number,
): JobLedger {
  const idempotencyKey = idempotencyKeyFor(spec.mediaId, spec.provider)
  if (ledger.some((j) => j.idempotencyKey === idempotencyKey || j.jobId === jobId)) return ledger
  const job: UploadJob = {
    jobId,
    idempotencyKey,
    mediaId: spec.mediaId,
    provider: spec.provider,
    objectKey: spec.objectKey,
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

/** pending/failed are claimable when due; an `uploading` job only once its lease expired (crash recovery). */
export const isClaimable = (job: UploadJob, now: number): boolean =>
  (job.status === 'pending' || job.status === 'failed' || job.status === 'uploading') &&
  job.attempts < MAX_ATTEMPTS &&
  now >= job.nextAttemptAt &&
  (job.leaseUntil === null || job.leaseUntil <= now)

export const readyJobs = (ledger: JobLedger, now: number): JobLedger =>
  ledger.filter((j) => isClaimable(j, now))

/**
 * Compare-and-set claim: issue a fresh fencing token and a lease, or refuse if a
 * live lease is held (no double-fire). Reclaiming a crashed `uploading` job
 * consumes one attempt (and dies at MAX_ATTEMPTS), so a crash loop is bounded.
 * `leaseMs` is clamped to ≥ 1 so a zero lease can't be re-claimed in the same tick.
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
  // A crashed `uploading` reclaim counts the lost attempt; a fresh pending/failed
  // claim does not (its attempt is counted when it ends).
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
    nextAttemptAt: now + lease, // the lease paces crash-recovery re-claims
    error: null,
  }
  return { ledger: replaceJob(ledger, started), claimed: true, token: leaseSeq }
}

/** Apply `fn` only if the caller holds the current lease on a still-`uploading` job. */
const onHeldLease = (
  ledger: JobLedger,
  jobId: string,
  token: LeaseToken,
  fn: (job: UploadJob) => UploadJob,
): TransitionResult => {
  const job = ledger.find((j) => j.jobId === jobId)
  if (job === undefined || job.status !== 'uploading' || job.leaseSeq !== token) {
    return { ledger, changed: false }
  }
  return { ledger: replaceJob(ledger, fn(job)), changed: true }
}

/** uploading → succeeded (run the out-of-band HEAD verify of key AND size first). */
export function recordSuccess(
  ledger: JobLedger,
  jobId: string,
  token: LeaseToken,
  now: number,
): TransitionResult {
  return onHeldLease(ledger, jobId, token, (job) => ({
    ...job,
    status: 'succeeded',
    leaseUntil: null,
    verifiedAt: now,
    error: null,
  }))
}

/** uploading → failed (with backoff) or → dead at MAX_ATTEMPTS. */
export function recordFailure(
  ledger: JobLedger,
  jobId: string,
  token: LeaseToken,
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

/** uploading → skipped: the source URL is gone (twimg 403). Honest — never a fake save. */
export function recordSourceGone(
  ledger: JobLedger,
  jobId: string,
  token: LeaseToken,
  reason: string,
): TransitionResult {
  return onHeldLease(ledger, jobId, token, (job) => ({
    ...job,
    status: 'skipped',
    leaseUntil: null,
    error: reason,
  }))
}

/** Extend the lease of an in-progress upload (heartbeat) — for uploads longer than LEASE_MS. */
export function renewLease(
  ledger: JobLedger,
  jobId: string,
  token: LeaseToken,
  now: number,
  leaseMs: number = LEASE_MS,
): TransitionResult {
  const lease = Math.max(1, leaseMs)
  return onHeldLease(ledger, jobId, token, (job) => ({
    ...job,
    leaseUntil: now + lease,
    nextAttemptAt: now + lease,
  }))
}

/** Operator escape: move a `dead` (or `failed`) job back to `pending`. The only sanctioned terminal regression. */
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

export interface Rollup {
  readonly label: 'none' | 'syncing' | 'safe' | 'failed' | 'sourceGone'
  readonly safe: number
  readonly total: number
}

/** Per-Media-Item status, derived purely from its jobs across providers. */
export function rollup(ledger: JobLedger, mediaId: string): Rollup {
  const js = ledger.filter((j) => j.mediaId === mediaId)
  const total = js.length
  const safe = js.filter((j) => j.status === 'succeeded').length
  if (total === 0) return { label: 'none', safe, total }
  if (js.some((j) => j.status === 'pending' || j.status === 'uploading' || j.status === 'failed')) {
    return { label: 'syncing', safe, total }
  }
  if (js.some((j) => j.status === 'dead')) return { label: 'failed', safe, total } // dead wins over sourceGone
  if (js.some((j) => j.status === 'skipped')) return { label: 'sourceGone', safe, total }
  return { label: 'safe', safe, total }
}

/**
 * Destination seam (ADR-0013): one contract per Cloud Target. With presign-
 * everything, the adapter mints an upload target and verifies the landed object
 * out-of-band — bytes never transit Convex. Implementations (S3/R2, Dropbox,
 * Google Photos) land in their own tasks; `Conn` is the per-user connection,
 * kept generic here so this seam does not couple to the Convex schema (task A1).
 *
 * Deferred to their owning tasks (noted so the seam isn't mistaken for complete):
 * object-key derivation/sanitize → A3; size-match in verify() + presign expiry →
 * A1 schema; revoke / needs_reauth signalling → the OAuth adapters (C/D) + B7.
 */
export interface PresignedTarget {
  readonly url: string
  /** Presigned-POST policy fields (pinned content-type, length range, key). */
  readonly fields?: Readonly<Record<string, string>>
  readonly objectKey: string
  /** Short TTL — a job re-claimed after this must re-mint before streaming (A1 persists it). */
  readonly expiresAt?: number
}

export interface VerifyResult {
  readonly present: boolean
  readonly size?: number
}

export interface DestinationAdapter<Conn = unknown> {
  readonly provider: Provider
  isConfigured(conn: Conn): boolean
  presignUpload(
    input: { readonly objectKey: string; readonly contentType: string; readonly maxBytes: number },
    conn: Conn,
  ): Promise<PresignedTarget>
  verify(target: PresignedTarget, conn: Conn): Promise<VerifyResult>
}
