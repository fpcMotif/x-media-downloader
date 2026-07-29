import { Option } from 'effect'
import { syndicationUrl } from '../core/adapters/x/syndication'
import { bindFetch } from '../core/fetch'
import { MAX_SYNDICATION_BODY_BYTES } from '../core/wire/limits'

/**
 * X's fixed tweet-result payload is small metadata, not media bytes. Keep one
 * recovery reply within the existing 64 KiB export-fragment budget and far
 * below Chrome's 64 MiB runtime-message ceiling.
 */
export { MAX_SYNDICATION_BODY_BYTES } from '../core/wire/limits'

export interface SyndicationRecovery {
  /** Returns no body for invalid, unavailable, cancelled, or oversized input. */
  readonly recover: (tweetId: string, signal?: AbortSignal) => Promise<string | undefined>
}

const declaredBodyBytes = (headers: Headers): number | undefined => {
  const raw = headers.get('content-length')
  if (raw === null || !/^\d+$/.test(raw)) return undefined
  const bytes = Number(raw)
  return Number.isSafeInteger(bytes) ? bytes : undefined
}

const cancel = async (body: ReadableStream<Uint8Array> | null): Promise<void> => {
  await body?.cancel().catch(() => {})
}

const readUtf8Body = async (
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<string | undefined> => {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const text: string[] = []
  let bytes = 0
  const cancelReader = (): Promise<void> => reader.cancel().catch(() => {})
  const onAbort = (): void => {
    void cancelReader()
  }

  if (signal.aborted) {
    await cancelReader()
    reader.releaseLock()
    return undefined
  }

  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- stream reads are ordered
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      bytes += value.byteLength
      if (signal.aborted || bytes > MAX_SYNDICATION_BODY_BYTES) {
        // oxlint-disable-next-line no-await-in-loop -- cancellation must settle before release
        await cancelReader()
        return undefined
      }
      text.push(decoder.decode(value, { stream: true }))
    }
    if (signal.aborted) return undefined
    text.push(decoder.decode())
    const result = text.join('')
    return result === '' ? undefined : result
  } catch {
    return undefined
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

/**
 * The worker-only recovery module. It owns URL validation, the untrusted HTTP
 * response boundary, byte accounting, stream cancellation, and UTF-8 decode.
 */
export function makeSyndicationRecovery(deps: {
  readonly fetchImpl: typeof fetch
}): SyndicationRecovery {
  const fetchSyndication = bindFetch(deps.fetchImpl)
  return {
    recover: async (tweetId, signal = new AbortController().signal) => {
      const url = syndicationUrl(tweetId)
      if (Option.isNone(url) || signal.aborted) return undefined
      try {
        const response = await fetchSyndication(url.value, { signal })
        if (!response.ok || signal.aborted) {
          await cancel(response.body)
          return undefined
        }
        const length = declaredBodyBytes(response.headers)
        if (length !== undefined && length > MAX_SYNDICATION_BODY_BYTES) {
          await cancel(response.body)
          return undefined
        }
        if (response.body === null) return undefined
        return readUtf8Body(response.body, signal)
      } catch {
        return undefined
      }
    },
  }
}
