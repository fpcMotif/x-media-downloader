import { Context, Effect, Layer } from 'effect'
import { guardedFetch } from '../sync/url-guard'
import { FetchError } from '../fetch-service'

/**
 * The one sanctioned media-byte egress: the SSRF-guarded twimg fetch (ADR-0013).
 * Reuses `guardedFetch` verbatim — it owns the allow-list + per-hop redirect
 * revalidation and binds the fetch internally. Shared by Drive and Dropbox.
 */
export class SourceFetch extends Context.Service<
  SourceFetch,
  { readonly fetch: (url: string) => Effect.Effect<Response, FetchError> }
>()('cloud/SourceFetch') {}

/** Live layer wrapping `guardedFetch` over the injected `fetch`. */
export const makeSourceFetchLive = (fetchImpl: typeof fetch): Layer.Layer<SourceFetch> =>
  Layer.succeed(SourceFetch, {
    fetch: (url) =>
      Effect.tryPromise({ try: () => guardedFetch(url, {}, fetchImpl), catch: (cause) => new FetchError({ url, cause }) }),
  })
