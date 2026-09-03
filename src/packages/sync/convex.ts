/**
 * Minimal port over Convex's public HTTP API: `POST {deployment}/api/{mutation|query}`
 * with `{path, args, format: 'json'}` → `{status: 'success'|'error', …}`. Reads
 * the shared `FetchService` from `R` (ADR-0017) — no `fetchImpl` thread, no
 * convex SDK and no WebSocket client inside the MV3 service worker (ADR-0009).
 */
import { Data, Effect, Option } from 'effect'
import { FetchService, FetchError, makeFetchServiceLive } from '@/packages/kernel/fetch-service'
import { type JsonObject, type JsonValue, isJsonObject } from '@/packages/schema'

/**
 * A non-2xx answer from the deployment edge. `status` is the HTTP code so the
 * popup classifier can switch on it structurally (e.g. 404 vs other 4xx vs 5xx)
 * instead of re-parsing a string. `message` mirrors the legacy `convex: HTTP N`
 * text so anything that reads `err.message` is unchanged.
 */
export class ConvexHttpError extends Data.TaggedError('ConvexHttpError')<{
  readonly status: number
}> {
  override get message(): string {
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
  override get message(): string {
    return this.errorMessage
  }
}

/** A 200 whose body is not a well-formed Convex envelope (HTML page, junk JSON). */
export class ConvexMalformedError extends Data.TaggedError('ConvexMalformedError')<{
  readonly detail: string
}> {
  override get message(): string {
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
    args: JsonObject,
  ) => Effect.Effect<JsonValue, ConvexMutationError, FetchService>
  readonly query: (
    path: string,
    args: JsonObject,
  ) => Effect.Effect<JsonValue, ConvexMutationError, FetchService>
}

export interface ConvexFunctionCall {
  readonly path: string
  readonly args: JsonObject
  readonly format: 'json'
}

export function buildFunctionCall(path: string, args: JsonObject): ConvexFunctionCall {
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

/** Narrow one field of a parsed Convex envelope to a string. `| undefined`
 *  because every property read off a `JsonObject` index signature can be
 *  absent (`noUncheckedIndexedAccess`) — a missing key is exactly as
 *  untrustworthy as a present-but-wrong-shaped one. Reused for both
 *  `status`/`errorMessage` (here) and each element of a `string[]` query
 *  result (`isJsonStringArray` below). */
const isJsonString = (value: JsonValue | undefined): value is string => typeof value === 'string'

/** Build a ConvexPort backed by HTTP against a Convex deployment. */
export function makeConvexHttpPort(cfg: { readonly deploymentUrl: string }): ConvexPort {
  const base = cfg.deploymentUrl.replace(/\/+$/, '')
  // Shared request+parse for both endpoints so `mutation` and `query` can never
  // drift in how they POST the envelope or classify a failure. `endpoint` is the
  // path after `/api` (`mutation` vs `query`).
  const call = (endpoint: 'mutation' | 'query', path: string, args: JsonObject) =>
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
        try: (): Promise<JsonValue> => res.json(),
        catch: () =>
          new ConvexMalformedError({ detail: 'convex: malformed response (invalid JSON body)' }),
      })
      // The documented envelope is always an object; anything else (an array, a
      // bare string/number) is a shape this port doesn't understand.
      if (!isJsonObject(body))
        return yield* new ConvexMalformedError({ detail: 'convex: malformed response' })
      if (body.status === 'error') {
        const errorMessage = isJsonString(body.errorMessage)
          ? body.errorMessage
          : 'convex: function error'
        return yield* new ConvexFunctionError({ errorMessage })
      }
      if (body.status !== 'success')
        return yield* new ConvexMalformedError({ detail: 'convex: malformed response' })
      // `value` is absent only on a malformed success envelope the schema never
      // actually produces; `null` is the JSON-native "nothing here" already used
      // throughout this module's own error detail literals.
      return body.value ?? null
    })
  return {
    mutation: (path, args) => call('mutation', path, args),
    query: (path, args) => call('query', path, args),
  }
}

/** The Promise-land shape {@link makeConvexPromisePort} builds — a named contract
 *  (mirrors the background's own `ConvexPort` seam) rather than an inline object
 *  type, so its `mutation` return value keeps carrying `JsonValue` instead of
 *  being reconstructed as an anonymous, evidence-discarding type. */
export interface ConvexPromisePort {
  readonly mutation: (name: string, args: JsonObject) => Promise<JsonValue>
}

/** The Effect→Promise airlock: the canonical live implementation of the background's
 *  `ConvexPort` type. `fetchImpl` must be a BOUND fetch (MV3 illegal-invocation — see
 *  core/fetch.ts); the port's tagged errors surface as the Promise rejection, exactly
 *  what classifySyncError consumes. */
export function makeConvexPromisePort(
  cfg: { readonly deploymentUrl: string },
  fetchImpl: typeof fetch,
): ConvexPromisePort {
  const port = makeConvexHttpPort(cfg)
  const layer = makeFetchServiceLive(fetchImpl)
  return {
    mutation: (name, args) =>
      Effect.runPromise(port.mutation(name, args).pipe(Effect.provide(layer))),
  }
}

/** Narrow a query envelope value to `string[]` — every element checked, not just
 *  the array shape, since the value crossed the same untyped JSON boundary as
 *  the rest of the envelope. */
const isJsonStringArray = (value: JsonValue): value is string[] =>
  Array.isArray(value) && value.every(isJsonString)

/** A query answered with something other than the documented `string[]` — the
 *  deployment's own contract broke, so this is a malformed response, not a
 *  crash at the call site. */
function expectStringArray(
  effect: Effect.Effect<JsonValue, ConvexMutationError, FetchService>,
): Effect.Effect<string[], ConvexMutationError, FetchService> {
  return effect.pipe(
    Effect.flatMap((value) =>
      isJsonStringArray(value)
        ? Effect.succeed(value)
        : Effect.fail(new ConvexMalformedError({ detail: 'convex: expected a string[] value' })),
    ),
  )
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
  return expectStringArray(port.query('sync:downloadedAmong', { secret, tweetIds }))
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
  return expectStringArray(port.query('sync:downloadedMediaIdsAmong', { secret, mediaIds }))
}
