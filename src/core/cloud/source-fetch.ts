import { Context, Effect, Layer } from 'effect'
import { makeMediaFetchPort } from '../media-url-policy'
import { FetchError } from '../fetch-service'

/**
 * Cloud's Effect adapter over the shared media egress policy. Shared by Drive
 * and Dropbox.
 */
export class SourceFetch extends Context.Service<
  SourceFetch,
  { readonly fetch: (url: string) => Effect.Effect<Response, FetchError> }
>()('cloud/SourceFetch') {}

/** Live layer wrapping the media URL policy over injected `fetch`. */
export const makeSourceFetchLive = (fetchImpl: typeof fetch): Layer.Layer<SourceFetch> => {
  const media = makeMediaFetchPort(fetchImpl)
  return Layer.succeed(SourceFetch, {
    fetch: (url) =>
      Effect.tryPromise({
        try: () => media.fetch(url),
        catch: (cause) => new FetchError({ url, cause }),
      }),
  })
}
