import { Context, Data, Effect, Layer } from 'effect'
import { bindFetch } from './fetch'

/**
 * A transport-level fetch failure (DNS, abort, dropped socket) — distinct from a
 * non-2xx response (which each port maps to its own tagged error). Tagged so a
 * rejected fetch surfaces as a value, never a defect; `message` feeds any
 * `errorReason`/`.message` reader.
 */
export class FetchError extends Data.TaggedError('FetchError')<{
  readonly url: string
  readonly cause: unknown
}> {
  get message(): string {
    return `fetch ${this.url}: ${String(this.cause)}`
  }
}

/**
 * The injected `fetch` capability (ADR-0017), shared by every port that talks
 * HTTP from the service worker. Bound to `globalThis` ONCE at layer build (the
 * MV3 illegal-invocation rule, see `fetch.ts`) and exposed two ways:
 *  - `fetch`        — `Effect<Response, FetchError>`, used inside Effect;
 *  - `fetchPromise` — the same bound `Promise` fetch, for the streamed upload sink
 *                     (so `streamInChunks` is reused verbatim — no bridge).
 */
export class FetchService extends Context.Service<
  FetchService,
  {
    readonly fetch: (url: string, init?: RequestInit) => Effect.Effect<Response, FetchError>
    readonly fetchPromise: typeof fetch
  }
>()('app/FetchService') {}

/** Live layer over an injected `fetch`, bound to `globalThis` exactly once. */
export const makeFetchServiceLive = (fetchImpl: typeof fetch): Layer.Layer<FetchService> => {
  const doFetch = bindFetch(fetchImpl)
  return Layer.succeed(FetchService, {
    fetch: (url, init) =>
      Effect.tryPromise({ try: () => doFetch(url, init), catch: (cause) => new FetchError({ url, cause }) }),
    fetchPromise: doFetch,
  })
}
