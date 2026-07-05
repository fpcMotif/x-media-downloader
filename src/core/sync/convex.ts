/**
 * Minimal port over Convex's public HTTP API: `POST {deployment}/api/{mutation|query}`
 * with `{path, args, format: 'json'}` → `{status: 'success'|'error', …}`. Reads
 * the shared `FetchService` from `R` (ADR-0017) — no `fetchImpl` thread, no
 * convex SDK and no WebSocket client inside the MV3 service worker (ADR-0009).
 */
import { Data, Effect, Option } from 'effect'
import { FetchService, FetchError } from '../fetch-service'

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

/** Build a ConvexPort backed by HTTP against a Convex deployment. */
export function makeConvexHttpPort(cfg: { readonly deploymentUrl: string }): ConvexPort {
  const base = cfg.deploymentUrl.replace(/\/+$/, '')
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
      // A 200 from a non-Convex host (parked domain, corp proxy, SPA index.html)
      // serves HTML, so `res.json()` throws. Wrap it into the same vocabulary as
      // the other failures so the drain loop classifies it as a sync error instead
      // of surfacing an opaque parser stack trace.
      const body = yield* Effect.tryPromise({
        try: () =>
          res.json() as Promise<{ status?: string; value?: unknown; errorMessage?: string }>,
        catch: () =>
          new ConvexMalformedError({ detail: 'convex: malformed response (invalid JSON body)' }),
      })
      if (body.status === 'error')
        return yield* new ConvexFunctionError({
          errorMessage: body.errorMessage ?? 'convex: function error',
        })
      if (body.status !== 'success')
        return yield* new ConvexMalformedError({ detail: 'convex: malformed response' })
      return body.value
    })
  return {
    mutation: (path, args) => call('mutation', path, args),
    query: (path, args) => call('query', path, args),
  }
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
 * Ask the deployment which of `mediaIds` (MediaItem.id / requestId) have
 * already been downloaded on ANY device. Parallel to `queryDownloadedAmong`
 * (post-level); not currently called by the extension (v1 keeps per-item
 * dedup local-only) — see admission-gate wiring in background.ts.
 */
export function queryDownloadedMediaIdsAmong(
  port: ConvexPort,
  secret: string,
  mediaIds: string[],
): Effect.Effect<string[], ConvexMutationError, FetchService> {
  return port.query('sync:downloadedMediaIdsAmong', { secret, mediaIds }) as Effect.Effect<
    string[],
    ConvexMutationError,
    FetchService
  >
}
