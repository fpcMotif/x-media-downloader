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

const AUTH = 'Authorization expired — reconnect the provider.'
const ACCESS = 'Provider refused the upload — re-grant access (check the scope).'
const RATE = 'Provider rate-limited the upload — retrying with backoff.'
const SERVER = 'Provider error — retrying shortly.'
const LINK = 'The media link expired before it could be uploaded.'
const STORAGE = 'Provider storage is full.'

/** Error-message rules in priority order; the first matching regex wins. The
 *  regexes are compiled once here rather than per `classifyUploadError` call.
 *  These cover the error sources that genuinely arrive as text — the source-fetch
 *  path (`source HTTP <n>`), OAuth messages, and provider body codes
 *  (`quotaExceeded`). Provider *upload* HTTP errors instead arrive as a tagged
 *  `CloudHttpError`, dispatched on their numeric `status` by `classifyStatus`. */
const UPLOAD_ERROR_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/HTTP 401|invalid_grant|unauthorized|no refresh_token/i, AUTH],
  [/HTTP 403|insufficient|insufficientScopes|access_denied/i, ACCESS],
  [/HTTP 429|rateLimit|too_many_requests/i, RATE],
  [/HTTP 5\d\d/, SERVER],
  [/source HTTP|sourceGone|link/i, LINK],
  [/insufficient.*storage|quotaExceeded|storageQuota/i, STORAGE],
]

/** Structural dispatch on a provider HTTP status (carried by `CloudHttpError`),
 *  mirroring the message rules' precedence (auth > access > rate > server). A
 *  status the rules don't special-case (e.g. 400/404) returns null, so the
 *  message still decides. */
function classifyStatus(status: number): string | null {
  if (status === 401) return AUTH
  if (status === 403) return ACCESS
  if (status === 429) return RATE
  if (status >= 500) return SERVER
  return null
}

/** Map a provider/upload error to one human-actionable line. Prefers the tagged
 *  HTTP `status` when present (errors-as-values), falling back to the message
 *  rules for the text-only error sources. */
export function classifyUploadError(reason: string, status?: number): string {
  if (status !== undefined) {
    const byStatus = classifyStatus(status)
    if (byStatus !== null) return byStatus
  }
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
