import { Cause, Data, Effect } from 'effect'
import { errorReason } from '../error'
import { cancelStream, readAll, readPrefix } from './chunk'
import { FetchError } from '../fetch-service'
import { readBoundedJson } from '../http/bounded-response'
import type { ParsedSource } from './source'
import { SIMPLE_MAX_BYTES, type UploadOutcome } from './types'

/**
 * Shared HTTP + upload plumbing for the Drive/Dropbox byte adapters (ADR-0013).
 * The provider name is a parameter so the error strings stay byte-identical to
 * the old per-adapter copies (`drive HTTP ...` / `dropbox HTTP ...`).
 */

/** Bearer auth header for a provider access token. */
export const authHeader = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
})

/** Raw-byte limits for untrusted provider control responses. */
export const MAX_PROVIDER_ERROR_BYTES = 16 * 1024
export const MAX_CONTROL_JSON_BYTES = 1024 * 1024

/** Discard a response that was handled by status/headers alone. Never rejects. */
export const discardResponseBody = (res: Response): Promise<void> =>
  res.body === null ? Promise.resolve() : cancelStream(res.body)

/** Best-effort bounded error-body prefix; a mid-read failure yields ''. */
export const errText = async (res: Response): Promise<string> => {
  if (res.body === null) return ''
  try {
    return new TextDecoder().decode(await readPrefix(res.body, MAX_PROVIDER_ERROR_BYTES))
  } catch {
    return ''
  }
}

/** Parse one bounded provider control response. The stream bytes, not a trusted
 *  Content-Length, enforce the cap. An honest oversized header fails before a pull. */
export const readControlJson = (res: Response): Promise<unknown> =>
  readBoundedJson(res, MAX_CONTROL_JSON_BYTES)

/** Parse a JSON response body as `T`. A malformed body rejects → a defect that
 *  `runUpload`'s `catchCause` maps to a failure outcome (as the old `await` did). */
export const okJson = (res: Response): Effect.Effect<unknown> =>
  Effect.promise(() => readControlJson(res))

/** `<provider> HTTP <status>[: <body first 200 chars>]` — the shared error format. */
export const httpErr = (provider: string, status: number, body: string): string =>
  `${provider} HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ''}`

/**
 * A non-2xx response from a provider's upload API. Carries the numeric `status`
 * as a real field — not buried in a message string — so the upload-status
 * classifier can dispatch on it structurally instead of regexing the text. The
 * `message` getter reproduces the exact `<provider> HTTP <status>[: body]` text
 * the adapters used to throw, so every `.message` / `errorReason` reader (and the
 * byte-stable `UploadOutcome.reason`) is unchanged.
 */
export class CloudHttpError extends Data.TaggedError('CloudHttpError')<{
  readonly provider: string
  readonly status: number
  readonly body: string
}> {
  get message(): string {
    return httpErr(this.provider, this.status, this.body)
  }
}

/** The single 'empty source' failure outcome (the source had no bytes). */
type UploadSuccess = Extract<UploadOutcome, { readonly kind: 'success' }>
type UploadNonSuccess = Exclude<UploadOutcome, { readonly kind: 'success' }>

const EMPTY_SOURCE: UploadNonSuccess = { kind: 'failure', reason: 'empty source' }

/**
 * Provider-agnostic upload skeleton (template method), Effect-shaped (ADR-0017):
 * own the parsed-source early-return, the simple-vs-streamed size dispatch, both
 * empty-source guards, and the failure→outcome mapping. Each adapter supplies only
 * its two byte sinks.
 *
 * `R` flows from `source` (`SourceFetch`) and the sinks (`FetchService`/etc.). `E`
 * collapses to `never`: an expected `CloudHttpError` maps to an outcome carrying
 * its `status`; anything else (a `FetchError`, a stream-sink rejection surfaced as
 * a defect, a JSON-parse failure) maps via the byte-stable `reason` string.
 */
export const runUpload = <Success extends UploadSuccess, R>(
  source: Effect.Effect<ParsedSource, never, R>,
  sinks: {
    readonly simple: (
      bytes: Uint8Array<ArrayBuffer>,
      contentType: string,
    ) => Effect.Effect<Success | UploadNonSuccess, CloudHttpError | FetchError, R>
    readonly streamed: (
      body: ReadableStream<Uint8Array>,
      size: number | null,
      contentType: string,
    ) => Effect.Effect<
      { outcome: Success | UploadNonSuccess; bytes: number },
      CloudHttpError | FetchError,
      R
    >
  },
): Effect.Effect<Success | UploadNonSuccess, never, R> =>
  Effect.gen(function* () {
    const s = yield* source
    if (!s.ok) return s.outcome
    const run = Effect.suspend(() =>
      s.size !== null && s.size <= SIMPLE_MAX_BYTES
        ? Effect.gen(function* () {
            const bytes = yield* Effect.promise(() => readAll(s.body, SIMPLE_MAX_BYTES))
            return bytes.length === 0 ? EMPTY_SOURCE : yield* sinks.simple(bytes, s.contentType)
          })
        : sinks
            .streamed(s.body, s.size, s.contentType)
            .pipe(Effect.map(({ outcome, bytes }) => (bytes === 0 ? EMPTY_SOURCE : outcome))),
    )
    return yield* run.pipe(
      Effect.ensuring(Effect.promise(() => cancelStream(s.body))),
      Effect.catchTag('CloudHttpError', (e) =>
        Effect.succeed<UploadNonSuccess>({
          kind: 'failure',
          reason: e.message,
          status: e.status,
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.succeed<UploadNonSuccess>({
          kind: 'failure',
          reason: errorReason(Cause.squash(cause)),
        }),
      ),
    )
  })
