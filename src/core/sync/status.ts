/**
 * Make Cloud Sync failures legible. The outbox drains fire-and-forget
 * (ADR-0009) and the background swallows every error so downloads never block
 * on the cloud — but that left the user with a silent black box when sync was
 * misconfigured. These helpers turn a thrown drain/test error into one
 * actionable line, and shape the status the popup polls.
 */
import { boundedDiagnosticText, MAX_DIAGNOSTIC_TEXT_LENGTH } from '../diagnostic-text'
import { hasWireKeys, isWireRecord } from '../wire/exact'
import { isJsonWithinByteBudget } from '../wire/json-budget'

/** Result of a connection test or the latest drain attempt, as the popup sees it. */
export interface SyncStatus {
  /** Whether the last drain/test reached the deployment and was accepted. */
  readonly ok: boolean
  /** One human-actionable line — what happened and what to do about it. */
  readonly detail: string
  /** Events still queued locally, waiting to be delivered. */
  readonly pending: number
}

/** Runtime reply/session cap. The detail's tighter shared limit dominates today. */
export const MAX_SYNC_STATUS_BYTES = 16 * 1024
export const MAX_SYNC_STATUS_DETAIL_LENGTH = MAX_DIAGNOSTIC_TEXT_LENGTH

/** Canonical producer shape. Invalid counts are programmer errors; text is bounded. */
export function normalizeSyncStatus(status: SyncStatus): SyncStatus {
  if (!Number.isSafeInteger(status.pending) || status.pending < 0)
    throw new RangeError('SyncStatus.pending must be a nonnegative safe integer')
  return {
    ok: status.ok,
    detail: boundedDiagnosticText(status.detail),
    pending: status.pending,
  }
}

/** Exact shared decoder for both session storage and runtime replies. */
export function decodeSyncStatus(value: unknown): SyncStatus | undefined {
  if (
    !isJsonWithinByteBudget(value, MAX_SYNC_STATUS_BYTES) ||
    !isWireRecord(value) ||
    !hasWireKeys(value, ['ok', 'detail', 'pending']) ||
    typeof value.ok !== 'boolean' ||
    typeof value.detail !== 'string' ||
    value.detail.length > MAX_SYNC_STATUS_DETAIL_LENGTH ||
    typeof value.pending !== 'number' ||
    !Number.isSafeInteger(value.pending) ||
    value.pending < 0
  )
    return undefined
  return { ok: value.ok, detail: value.detail, pending: value.pending }
}

/**
 * Map an error thrown by `makeConvexHttpPort` (or a raw `fetch` rejection) to a
 * message that names the likely cause and the fix. The port throws tagged errors
 * (`ConvexHttpError` with the edge `status`, `ConvexFunctionError` with the
 * server `errorMessage`, `ConvexMalformedError`), so HTTP cases switch on the
 * status code rather than re-parsing strings — no regex-order dependence. A
 * server function error still carries free-form text (the function never got
 * pushed → "Could not find public function…", the fail-closed secret check →
 * "unauthorized…"), so those stay content-matched. A raw `fetch` rejection
 * (missing host permission, unparseable host) is untagged and lands in the
 * reachability fallback.
 */
export function classifySyncError(err: unknown): string {
  return boundedDiagnosticText(classifySyncErrorText(err))
}

function classifySyncErrorText(err: unknown): string {
  const tag = isTagged(err) ? err._tag : undefined
  if (tag === 'ConvexHttpError') return classifyHttpStatus((err as { status: number }).status)
  if (tag === 'ConvexMalformedError') return MALFORMED_HINT
  if (tag === 'ConvexFunctionError') {
    const fnMsg = (err as { errorMessage: string }).errorMessage
    return classifyFunctionMessage(fnMsg) ?? unreachableHint(fnMsg)
  }

  // Untagged input (raw fetch rejection, or a plain Error passed straight in):
  // fall back to text matching so the legacy classification is preserved.
  const msg = err instanceof Error ? err.message : String(err)
  const fn = classifyFunctionMessage(msg)
  if (fn !== undefined) return fn
  const httpMatch = /HTTP (\d{3})/.exec(msg)
  if (httpMatch !== null) return classifyHttpStatus(Number(httpMatch[1]), msg)
  if (/malformed/.test(msg)) return MALFORMED_HINT
  return unreachableHint(msg)
}

const MALFORMED_HINT = 'Unexpected response — is the URL really a Convex deployment?'

/** Classify a server function-error message; undefined when none of the known causes match. */
function classifyFunctionMessage(msg: string): string | undefined {
  if (/could not find .*function/i.test(msg)) {
    return 'Deployment reached, but its sync functions are missing — deploy the backend (cd backend && bunx convex deploy).'
  }
  if (/unauthorized/i.test(msg)) {
    return "Secret rejected — it must match the deployment's SYNC_SHARED_SECRET."
  }
  return undefined
}

/** Classify a non-2xx edge status. `raw` preserves the original `convex: HTTP N` text in the message. */
function classifyHttpStatus(status: number, raw: string = `convex: HTTP ${status}`): string {
  if (status === 404) return 'No Convex deployment at that URL — double-check the deployment URL.'
  if (status >= 400 && status < 500) return `Deployment rejected the request (${raw}).`
  if (status >= 500 && status < 600) return `Deployment error (${raw}) — try again shortly.`
  return unreachableHint(raw)
}

function unreachableHint(msg: string): string {
  return `Could not reach the deployment — check the URL and that access is granted (${msg}).`
}

function isTagged(err: unknown): err is { _tag: string } {
  return typeof err === 'object' && err !== null && '_tag' in err
}

/** Phrase a successful drain/test for the popup. */
export function describeSyncOk(pending: number): string {
  return pending > 0
    ? `Connected ✓ — ${pending} event${pending === 1 ? '' : 's'} still queued.`
    : 'Connected ✓ — metadata sync is working.'
}
