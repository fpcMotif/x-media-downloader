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

/** Always copies into a fresh ArrayBuffer-backed array — keeps chunks usable as a
 *  fetch `BodyInit` regardless of the source view's backing buffer. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

export async function streamInChunks(
  body: ReadableStream<Uint8Array>,
  chunkBytes: number,
  onChunk: (chunk: Uint8Array<ArrayBuffer>, info: ChunkInfo) => Promise<void>,
): Promise<number> {
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
  } finally {
    reader.releaseLock()
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
}

/** Read an entire stream into one buffer — only for media already known small
 *  (≤ SIMPLE_MAX_BYTES). Returns the concatenated bytes. */
export async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- sequential by nature
      const { value, done } = await reader.read()
      if (value !== undefined && value.length > 0) {
        parts.push(value)
        total += value.length
      }
      if (done) break
    }
  } finally {
    reader.releaseLock()
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
