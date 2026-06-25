import type { UploadInput, UploadOutcome } from './types'

/** twimg link-rot statuses: the source is gone, not a fault to retry. */
const sourceGone = (status: number): boolean => status === 403 || status === 404 || status === 410

/**
 * Result of fetching + validating one upload's source response. On `ok`, the
 * caller owns `body` (the response stream) and either streams or buffers it;
 * otherwise `outcome` is the early-return result (failure / sourceGone).
 */
export type ParsedSource =
  | {
      readonly ok: true
      readonly body: ReadableStream<Uint8Array>
      readonly size: number | null
      readonly contentType: string
    }
  | { readonly ok: false; readonly outcome: UploadOutcome }

/**
 * Fetch the twimg source through the SSRF guard and validate it once for every
 * provider adapter: a network error → `failure`, link-rot (403/404/410) →
 * `sourceGone`, any other non-2xx or bodyless response → `failure`, and a
 * declared zero length → empty `failure`. `contentType` is the response's base
 * type, falling back to the target's MIME hint (Drive uses it for upload
 * metadata; Dropbox ignores it).
 */
export async function parseSourceResponse(
  input: UploadInput,
  fetchSource: (url: string) => Promise<Response>,
): Promise<ParsedSource> {
  let response: Response
  try {
    response = await fetchSource(input.url)
  } catch (err) {
    return { ok: false, outcome: { kind: 'failure', reason: `source fetch: ${String(err)}` } }
  }
  if (!response.ok || response.body === null) {
    const reason = `source HTTP ${response.status}`
    return {
      ok: false,
      outcome: sourceGone(response.status)
        ? { kind: 'sourceGone', reason }
        : { kind: 'failure', reason },
    }
  }
  const contentType =
    response.headers.get('content-type')?.split(';', 1)[0]?.trim() || input.target.contentType
  const lenHeader = response.headers.get('content-length')
  const size = lenHeader !== null && /^\d+$/.test(lenHeader) ? Number(lenHeader) : null
  if (size === 0) return { ok: false, outcome: { kind: 'failure', reason: 'empty source' } }
  return { ok: true, body: response.body, size, contentType }
}
