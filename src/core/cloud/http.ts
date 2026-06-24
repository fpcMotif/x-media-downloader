import { errorReason } from '../error'
import { readAll } from './chunk'
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

/** Best-effort error body; a mid-read failure (dropped connection) yields ''. */
export const errText = (res: Response): Promise<string> => res.text().catch(() => '')

/** `<provider> HTTP <status>[: <body first 200 chars>]` — the shared error format. */
export const httpErr = (provider: string, res: Response, body: string): string =>
  `${provider} HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`

/** The single 'empty source' failure outcome (the source had no bytes). */
const EMPTY_SOURCE: UploadOutcome = { kind: 'failure', reason: 'empty source' }

/**
 * Provider-agnostic upload skeleton (template method): own the parsed-source
 * early-return, the simple-vs-streamed size dispatch, both empty-source guards,
 * and the catch→failure mapping. Each adapter supplies only its two byte sinks.
 *
 * - `simple(bytes, contentType)` runs for known-small media (≤ SIMPLE_MAX_BYTES),
 *   after the buffer is read and confirmed non-empty.
 * - `streamed(body, size, contentType)` runs for larger/unknown-size media and
 *   returns its success outcome plus the streamed byte count (so the runner can
 *   replace a zero-byte result with the shared empty-source failure).
 */
export async function runUpload(
  source: ParsedSource,
  sinks: {
    readonly simple: (bytes: Uint8Array<ArrayBuffer>, contentType: string) => Promise<UploadOutcome>
    readonly streamed: (
      body: ReadableStream<Uint8Array>,
      size: number | null,
      contentType: string,
    ) => Promise<{ outcome: UploadOutcome; bytes: number }>
  },
): Promise<UploadOutcome> {
  if (!source.ok) return source.outcome
  const { body, size, contentType } = source
  try {
    if (size !== null && size <= SIMPLE_MAX_BYTES) {
      const bytes = await readAll(body)
      if (bytes.length === 0) return EMPTY_SOURCE
      return await sinks.simple(bytes, contentType)
    }
    const { outcome, bytes } = await sinks.streamed(body, size, contentType)
    if (bytes === 0) return EMPTY_SOURCE
    return outcome
  } catch (err) {
    return { kind: 'failure', reason: errorReason(err) }
  }
}
