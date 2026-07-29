/**
 * Minimal port over Convex's public HTTP API: `POST {deployment}/api/{mutation|query}`
 * with `{path, args, format: 'json'}` → `{status: 'success'|'error', …}`. Reads
 * the shared `FetchService` from `R` (ADR-0017) — no `fetchImpl` thread, no
 * convex SDK and no WebSocket client inside the MV3 service worker (ADR-0009).
 */
import { Data, Effect, Option } from 'effect'
import { FetchService, FetchError } from '../fetch-service'
import { readBoundedJson } from '../http/bounded-response'

/** Convex function replies are metadata-only; never buffer more than 1 MiB. */
export const MAX_CONVEX_RESPONSE_BYTES = 1024 * 1024

/**
 * A non-2xx answer from the deployment edge. `status` is the HTTP code so the
 * popup classifier can switch on it structurally (e.g. 404 vs other 4xx vs 5xx)
 * instead of re-parsing a string. `message` mirrors the legacy `convex: HTTP N`
 * text so anything that reads `err.message` is unchanged.
 */
export class ConvexHttpError extends Data.TaggedError('ConvexHttpError')<{
  readonly status: number
}> {
  get message(): string {
    return `convex: HTTP ${this.status}`
  }
}

/**
 * A `200 {status:'error'}` Convex function error — the server's own
 * `errorMessage` (e.g. "Could not find public function…", "unauthorized…").
 */
export class ConvexFunctionError extends Data.TaggedError('ConvexFunctionError')<{
  readonly errorMessage: string
}> {
  get message(): string {
    return this.errorMessage
  }
}

/** A 200 whose body is not a well-formed Convex envelope (HTML page, junk JSON). */
export class ConvexMalformedError extends Data.TaggedError('ConvexMalformedError')<{
  readonly detail: string
}> {
  get message(): string {
    return this.detail
  }
}

/** The failure channel of {@link ConvexPort.mutation} / {@link ConvexPort.query}. */
export type ConvexMutationError =
  | ConvexHttpError
  | ConvexFunctionError
  | ConvexMalformedError
  | FetchError

export interface ConvexPort {
  readonly mutation: (
    path: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<unknown, ConvexMutationError, FetchService>
  readonly query: (
    path: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<unknown, ConvexMutationError, FetchService>
}

export interface ConvexFunctionCall {
  readonly path: string
  readonly args: Record<string, unknown>
  readonly format: 'json'
}

export function buildFunctionCall(path: string, args: Record<string, unknown>): ConvexFunctionCall {
  return { path, args, format: 'json' }
}

/**
 * Chrome match-pattern for a deployment URL's origin, for a runtime
 * `permissions.request({ origins })` call (aria2 precedent). Option of the
 * pattern; None if the URL is unparseable.
 */
export function convexOriginPattern(deploymentUrl: string): Option.Option<string> {
  try {
    const u = new URL(deploymentUrl)
    return Option.some(`${u.protocol}//${u.hostname}/*`)
  } catch {
    return Option.none()
  }
}

/**
 * Canonical identity for one Convex deployment. Query, fragment, and embedded
 * credentials are not valid deployment-base syntax.
 */
export function normalizeConvexDeploymentUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    )
      return undefined
    return url.href.replace(/\/+$/u, '')
  } catch {
    return undefined
  }
}

/** Build a ConvexPort backed by HTTP against a Convex deployment. */
export function makeConvexHttpPort(cfg: { readonly deploymentUrl: string }): ConvexPort {
  const base =
    normalizeConvexDeploymentUrl(cfg.deploymentUrl) ?? cfg.deploymentUrl.replace(/\/+$/u, '')
  // Shared request+parse for both endpoints so `mutation` and `query` can never
  // drift in how they POST the envelope or classify a failure. `endpoint` is the
  // path after `/api` (`mutation` vs `query`).
  const call = (endpoint: 'mutation' | 'query', path: string, args: Record<string, unknown>) =>
    Effect.gen(function* () {
      const http = yield* FetchService
      const res = yield* http.fetch(`${base}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildFunctionCall(path, args)),
      })
      if (!res.ok) return yield* new ConvexHttpError({ status: res.status })
      // A deployment, proxy, or wrong host controls every response byte. Read
      // through one streamed cap before validating the documented envelope.
      const raw = yield* Effect.tryPromise({
        try: () => readBoundedJson(res, MAX_CONVEX_RESPONSE_BYTES),
        catch: () =>
          new ConvexMalformedError({ detail: 'convex: malformed response (invalid JSON body)' }),
      })
      const body = decodeConvexEnvelope(raw)
      if (body === undefined)
        return yield* new ConvexMalformedError({ detail: 'convex: malformed response' })
      return body.status === 'success'
        ? body.value
        : yield* new ConvexFunctionError({ errorMessage: body.errorMessage })
    })
  return {
    mutation: (path, args) => call('mutation', path, args),
    query: (path, args) => call('query', path, args),
  }
}

type ConvexEnvelope =
  | { readonly status: 'success'; readonly value: unknown }
  | { readonly status: 'error'; readonly errorMessage: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasOnlyKeys = (
  value: Record<string, unknown>,
  required: ReadonlyArray<string>,
  optional: ReadonlyArray<string>,
): boolean => {
  const allowed = new Set([...required, ...optional])
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  )
}

const hasValidLogLines = (value: Record<string, unknown>): boolean =>
  !Object.hasOwn(value, 'logLines') ||
  (Array.isArray(value.logLines) && value.logLines.every((line) => typeof line === 'string'))

/** Exact documented Convex HTTP envelope, including its optional diagnostic fields. */
function decodeConvexEnvelope(value: unknown): ConvexEnvelope | undefined {
  if (!isRecord(value) || !hasValidLogLines(value)) return undefined
  if (value.status === 'success') {
    return hasOnlyKeys(value, ['status', 'value'], ['logLines'])
      ? { status: 'success', value: value.value }
      : undefined
  }
  if (value.status !== 'error') return undefined
  if (
    !hasOnlyKeys(value, ['status', 'errorMessage'], ['errorData', 'logLines']) ||
    typeof value.errorMessage !== 'string' ||
    value.errorMessage.trim() === '' ||
    (Object.hasOwn(value, 'errorData') && !isRecord(value.errorData))
  )
    return undefined
  return { status: 'error', errorMessage: value.errorMessage }
}

/**
 * Ask the deployment which of `tweetIds` have already been downloaded. Shapes the
 * `sync:downloadedAmong` query call and narrows the envelope value to `string[]`.
 */
export function queryDownloadedAmong(
  port: ConvexPort,
  secret: string,
  tweetIds: string[],
): Effect.Effect<string[], ConvexMutationError, FetchService> {
  return port.query('sync:downloadedAmong', { secret, tweetIds }) as Effect.Effect<
    string[],
    ConvexMutationError,
    FetchService
  >
}

/**
 * Ask which canonical Save Request IDs were downloaded on any device.
 * Parallel to the coarser post-level `queryDownloadedAmong`.
 */
export function queryDownloadedRequestIdsAmong(
  port: ConvexPort,
  secret: string,
  requestIds: string[],
): Effect.Effect<string[], ConvexMutationError, FetchService> {
  return port.query('sync:downloadedRequestIdsAmong', { secret, requestIds }) as Effect.Effect<
    string[],
    ConvexMutationError,
    FetchService
  >
}
