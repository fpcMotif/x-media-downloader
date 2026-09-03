import { Cause, Data, Effect } from 'effect'
import { errorReason } from '@/packages/kernel/error'
import { readAll } from './chunk'
import { FetchError } from '@/packages/kernel/fetch-service'
import type { ParsedSource } from './source'
import { SIMPLE_MAX_BYTES, type UploadOutcome } from '../types'

/**
 * Shared HTTP + upload plumbing for the Drive/Dropbox byte adapters (ADR-0013).
 * The provider name is a parameter so the error strings stay byte-identical to
 * the old per-adapter copies (`drive HTTP ...` / `dropbox HTTP ...`).
 */

/** Bearer auth header for a provider access token. */
export const authHeader = (token: string) =>
  ({
    authorization: `Bearer ${token}`,
  }) satisfies Record<string, string>

/** Best-effort error body; a mid-read failure (dropped connection) yields ''. */
export const errText = (res: Response): Promise<string> => res.text().catch(() => '')

/** Parse a JSON response body as `T`. A malformed body rejects → a defect that
 *  `runUpload`'s `catchCause` maps to a failure outcome (as the old `await` did). */
export const okJson = <T>(res: Response): Effect.Effect<T> =>
  Effect.promise(() => {
    // SAFETY: `T` is caller-supplied and unconstrained — there is no runtime shape
    // to check it against here. Each `okJson<T>()` call site owns the actual
    // invariant (which provider field it reads off `T`); a malformed body still
    // fails safely, just as a defect instead of a type error.
    return res.json() as Promise<T>
  })

/** Promise-land twin of `okJson`, for plain async/await code that can't take on an
 *  Effect boundary mid-loop (the Dropbox session sink runs inside one `tryPromise`). */
export const jsonAs = <T>(res: Response): Promise<T> => {
  // SAFETY: `T` is caller-supplied and unconstrained, same as `okJson` above —
  // there is no runtime shape to check it against here; a malformed body still
  // fails safely, just as a thrown rejection instead of a type error.
  return res.json() as Promise<T>
}

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
  override get message(): string {
    return httpErr(this.provider, this.status, this.body)
  }
}

/** The single 'empty source' failure outcome (the source had no bytes). */
const EMPTY_SOURCE: UploadOutcome = { kind: 'failure', reason: 'empty source' }

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
export const runUpload = <R>(
  source: Effect.Effect<ParsedSource, never, R>,
  sinks: {
    readonly simple: (
      bytes: Uint8Array<ArrayBuffer>,
      contentType: string,
    ) => Effect.Effect<UploadOutcome, CloudHttpError | FetchError, R>
    readonly streamed: (
      body: ReadableStream<Uint8Array>,
      size: number | null,
      contentType: string,
    ) => Effect.Effect<{ outcome: UploadOutcome; bytes: number }, CloudHttpError | FetchError, R>
  },
): Effect.Effect<UploadOutcome, never, R> =>
  Effect.gen(function* () {
    const s = yield* source
    if (!s.ok) return s.outcome
    const run =
      s.size !== null && s.size <= SIMPLE_MAX_BYTES
        ? Effect.gen(function* () {
            const bytes = yield* Effect.promise(() => readAll(s.body))
            return bytes.length === 0 ? EMPTY_SOURCE : yield* sinks.simple(bytes, s.contentType)
          })
        : sinks
            .streamed(s.body, s.size, s.contentType)
            .pipe(Effect.map(({ outcome, bytes }) => (bytes === 0 ? EMPTY_SOURCE : outcome)))
    return yield* run.pipe(
      Effect.catchTag('CloudHttpError', (e) =>
        Effect.succeed<UploadOutcome>({ kind: 'failure', reason: e.message, status: e.status }),
      ),
      Effect.catchCause((cause) => {
        const squashed = Cause.squash(cause)
        const reason = squashed instanceof Error ? squashed : String(squashed)
        return Effect.succeed<UploadOutcome>({ kind: 'failure', reason: errorReason(reason) })
      }),
    )
  })
