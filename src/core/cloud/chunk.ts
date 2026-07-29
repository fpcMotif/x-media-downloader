/**
 * Stream a `ReadableStream<Uint8Array>` to a sink in fixed-size chunks, bounding
 * memory to ~`chunkBytes` regardless of total size (ADR-0013: X video is
 * 20–512 MB — never buffer the whole file in the service worker).
 *
 * Guarantee: every chunk except the final one is exactly `chunkBytes` (so it can
 * be a provider's required multiple — 256 KiB for Drive resumable, 4 MiB for
 * Dropbox sessions); the final chunk is the true remainder. `isLast` is reported
 * only on that final chunk. An empty stream yields a single empty final chunk.
 *
 * Implemented by holding back one full chunk until the next read confirms more
 * data follows — so the last full chunk is correctly flagged `isLast` even when
 * the total is an exact multiple of `chunkBytes`.
 */
export interface ChunkInfo {
  /** Byte offset of this chunk within the stream (bytes already emitted). */
  readonly offset: number
  readonly isLast: boolean
}

/** A body crossed a byte limit before it could be consumed safely. */
export class BodyTooLargeError extends RangeError {
  readonly limit: number

  constructor(limit: number) {
    super(`body exceeds ${limit}-byte limit`)
    this.name = 'BodyTooLargeError'
    this.limit = limit
  }
}

/** Always copies into a fresh ArrayBuffer-backed array — keeps chunks usable as a
 *  fetch `BodyInit` regardless of the source view's backing buffer. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function assertByteLimit(value: number, minimum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${label} must be a safe integer >= ${minimum}`)
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): Promise<void> {
  try {
    await reader.cancel(reason)
  } catch {
    // Cleanup must never replace the read/sink failure that caused it.
  }
}

/** Cancel an owned stream without letting cleanup failure mask the primary result. */
export async function cancelStream(
  body: ReadableStream<Uint8Array>,
  reason?: unknown,
): Promise<void> {
  try {
    await body.cancel(reason)
  } catch {
    // Best-effort cleanup only.
  }
}

function joinParts(parts: ReadonlyArray<Uint8Array>, total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

export async function streamInChunks(
  body: ReadableStream<Uint8Array>,
  chunkBytes: number,
  onChunk: (chunk: Uint8Array<ArrayBuffer>, info: ChunkInfo) => Promise<void>,
): Promise<number> {
  assertByteLimit(chunkBytes, 1, 'chunkBytes')
  const size = chunkBytes
  const reader = body.getReader()
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  let held: Uint8Array<ArrayBuffer> | null = null // a full chunk not yet known to be the last
  let offset = 0
  let total = 0

  const emit = async (chunk: Uint8Array<ArrayBuffer>, isLast: boolean): Promise<void> => {
    await onChunk(chunk, { offset, isLast })
    offset += chunk.length
  }

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- stream reads are inherently sequential
      const { value, done } = await reader.read()
      if (value !== undefined && value.length > 0) {
        buffer = concat(buffer, value)
        total += value.length
      }
      while (buffer.length >= size) {
        // oxlint-disable-next-line no-await-in-loop -- chunk sinks must run in offset order
        if (held !== null) await emit(held, false)
        held = buffer.subarray(0, size)
        buffer = buffer.subarray(size)
      }
      if (done) break
    }

    // Drain: the held full chunk (if any) precedes the remainder; the very last
    // emit carries isLast. remainder.length < size (possibly 0).
    if (buffer.length > 0) {
      if (held !== null) await emit(held, false)
      await emit(buffer, true)
    } else if (held !== null) {
      await emit(held, true)
    } else {
      await emit(new Uint8Array(0), true)
    }
    return total
  } catch (error) {
    await cancelReader(reader, error)
    throw error
  } finally {
    reader.releaseLock()
  }
}

/** Read an entire stream into one buffer — only for media already known small
 *  (≤ `maxBytes`). The actual bytes are authoritative: a lying Content-Length
 *  cannot make this allocate past the bound. */
export async function readAll(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  assertByteLimit(maxBytes, 0, 'maxBytes')
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by nature
      const { value, done } = await reader.read()
      if (value !== undefined && value.length > 0) {
        if (value.length > maxBytes - total) throw new BodyTooLargeError(maxBytes)
        parts.push(value.slice())
        total += value.length
      }
      if (done) break
    }
    return joinParts(parts, total)
  } catch (error) {
    await cancelReader(reader, error)
    throw error
  } finally {
    reader.releaseLock()
  }
}

/**
 * Read at most `maxBytes`, canceling any remainder. Used only for diagnostic
 * text where a prefix is enough.
 */
export async function readPrefix(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  assertByteLimit(maxBytes, 0, 'maxBytes')
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by nature
      const { value, done } = await reader.read()
      if (value !== undefined && value.length > 0) {
        const remaining = maxBytes - total
        if (value.length > remaining) {
          if (remaining > 0) parts.push(value.slice(0, remaining))
          total = maxBytes
          truncated = true
          break
        }
        parts.push(value.slice())
        total += value.length
      }
      if (done) break
    }
    if (truncated) await cancelReader(reader, new BodyTooLargeError(maxBytes))
    return joinParts(parts, total)
  } catch (error) {
    await cancelReader(reader, error)
    throw error
  } finally {
    reader.releaseLock()
  }
}
