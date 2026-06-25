import type { UploadSummary } from './upload-job'

/**
 * Make cloud-upload outcomes legible in the popup (mirrors `sync/status.ts`).
 * The drain is fire-and-forget so downloads never block on a cloud upload; these
 * helpers turn ledger counts + the last error into one actionable line.
 */
export interface CloudUploadStatus {
  readonly summary: UploadSummary
  /** The most recent non-skipped failure reason, if any. */
  readonly lastError: string | null
}

/** Error-message rules in priority order; the first matching regex wins. The
 *  regexes are compiled once here rather than per `classifyUploadError` call. */
const UPLOAD_ERROR_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /HTTP 401|invalid_grant|unauthorized|no refresh_token/i,
    'Authorization expired — reconnect the provider.',
  ],
  [
    /HTTP 403|insufficient|insufficientScopes|access_denied/i,
    'Provider refused the upload — re-grant access (check the scope).',
  ],
  [
    /HTTP 429|rateLimit|too_many_requests/i,
    'Provider rate-limited the upload — retrying with backoff.',
  ],
  [/HTTP 5\d\d/, 'Provider error — retrying shortly.'],
  [/source HTTP|sourceGone|link/i, 'The media link expired before it could be uploaded.'],
  [/insufficient.*storage|quotaExceeded|storageQuota/i, 'Provider storage is full.'],
]

/** Map a provider/upload error message to one human-actionable line. */
export function classifyUploadError(reason: string): string {
  for (const [pattern, message] of UPLOAD_ERROR_RULES) {
    if (pattern.test(reason)) return message
  }
  return reason
}

/** One-line summary of the ledger for the popup. */
export function describeUploadSummary(s: UploadSummary): string {
  const inFlight = s.pending + s.uploading
  if (inFlight > 0) {
    return `Uploading — ${s.succeeded} done, ${inFlight} in progress${s.failed > 0 ? `, ${s.failed} retrying` : ''}.`
  }
  if (s.succeeded === 0 && s.dead === 0 && s.skipped === 0) return 'No uploads yet.'
  const parts = [`${s.succeeded} uploaded`]
  if (s.dead > 0) parts.push(`${s.dead} failed`)
  if (s.skipped > 0) parts.push(`${s.skipped} skipped (link expired)`)
  return `${parts.join(' · ')}.`
}
