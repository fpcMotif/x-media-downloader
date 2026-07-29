/** A response body crossed its declared in-memory control-plane limit. */
export class ResponseBodyTooLargeError extends RangeError {
  readonly maxBytes: number

  constructor(maxBytes: number) {
    super(`response body exceeds ${maxBytes}-byte limit`)
    this.name = 'ResponseBodyTooLargeError'
    this.maxBytes = maxBytes
  }
}

const assertMaxBytes = (maxBytes: number): void => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new RangeError('maxBytes must be a nonnegative safe integer')
}

const cancelBody = async (body: ReadableStream<Uint8Array>, reason: unknown): Promise<void> => {
  try {
    await body.cancel(reason)
  } catch {
    // Cleanup must not replace the size or parse failure.
  }
}

const cancelReader = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): Promise<void> => {
  try {
    await reader.cancel(reason)
  } catch {
    // Cleanup must not replace the read failure.
  }
}

const declaredTooLarge = (headers: Headers, maxBytes: number): boolean => {
  const raw = headers.get('content-length')
  return raw !== null && /^\d+$/u.test(raw) && Number(raw) > maxBytes
}

const join = (chunks: ReadonlyArray<Uint8Array>, total: number): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

/**
 * Parse one untrusted JSON control response.
 *
 * The body stream is authoritative. A truthful oversized Content-Length fails
 * before the first pull; a missing or false header cannot bypass the byte cap.
 * Oversized and failed reads cancel the owned stream. UTF-8 is strict.
 */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  assertMaxBytes(maxBytes)
  const body = response.body
  if (body !== null && declaredTooLarge(response.headers, maxBytes)) {
    const error = new ResponseBodyTooLargeError(maxBytes)
    await cancelBody(body, error)
    throw error
  }

  const chunks: Uint8Array[] = []
  let total = 0
  if (body !== null) {
    const reader = body.getReader()
    try {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop -- response streams are sequential.
        const { value, done } = await reader.read()
        if (value !== undefined && value.length > 0) {
          if (value.length > maxBytes - total) throw new ResponseBodyTooLargeError(maxBytes)
          chunks.push(value.slice())
          total += value.length
        }
        if (done) break
      }
    } catch (error) {
      await cancelReader(reader, error)
      throw error
    } finally {
      reader.releaseLock()
    }
  }

  const text = new TextDecoder('utf-8', { fatal: true }).decode(join(chunks, total))
  return JSON.parse(text) as unknown
}
