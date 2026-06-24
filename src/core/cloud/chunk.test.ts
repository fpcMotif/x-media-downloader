import { describe, it, expect } from 'vitest'
import { streamInChunks, readAll, type ChunkInfo } from './chunk'

/** A ReadableStream that yields the given pieces in order. */
function streamOf(pieces: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> {
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < pieces.length) {
        controller.enqueue(pieces[i]!)
        i += 1
      } else {
        controller.close()
      }
    },
  })
}

const bytes = (n: number, fill = 1): Uint8Array => new Uint8Array(n).fill(fill)

async function collect(
  body: ReadableStream<Uint8Array>,
  chunkBytes: number,
): Promise<{ total: number; chunks: { len: number; info: ChunkInfo }[] }> {
  const chunks: { len: number; info: ChunkInfo }[] = []
  const total = await streamInChunks(body, chunkBytes, async (chunk, info) => {
    chunks.push({ len: chunk.length, info })
  })
  return { total, chunks }
}

describe('streamInChunks', () => {
  it('emits exact-size non-final chunks and a remainder final chunk', async () => {
    const { total, chunks } = await collect(streamOf([bytes(250)]), 100)
    expect(total).toBe(250)
    expect(chunks.map((c) => c.len)).toEqual([100, 100, 50])
    expect(chunks.map((c) => c.info.offset)).toEqual([0, 100, 200])
    expect(chunks.map((c) => c.info.isLast)).toEqual([false, false, true])
  })

  it('flags the last full chunk isLast when total is an exact multiple', async () => {
    const { total, chunks } = await collect(streamOf([bytes(200)]), 100)
    expect(total).toBe(200)
    expect(chunks.map((c) => c.len)).toEqual([100, 100])
    expect(chunks.map((c) => c.info.isLast)).toEqual([false, true])
  })

  it('reassembles across arbitrary read boundaries', async () => {
    // pieces sum to 250 but split oddly; chunking must not depend on read shape
    const { total, chunks } = await collect(streamOf([bytes(30), bytes(90), bytes(130)]), 100)
    expect(total).toBe(250)
    expect(chunks.map((c) => c.len)).toEqual([100, 100, 50])
    expect(chunks.map((c) => c.info.isLast)).toEqual([false, false, true])
  })

  it('handles a single sub-chunk-size stream as one final chunk', async () => {
    const { total, chunks } = await collect(streamOf([bytes(40)]), 100)
    expect(total).toBe(40)
    expect(chunks).toEqual([{ len: 40, info: { offset: 0, isLast: true } }])
  })

  it('emits a single empty final chunk for an empty stream', async () => {
    const { total, chunks } = await collect(streamOf([]), 100)
    expect(total).toBe(0)
    expect(chunks).toEqual([{ len: 0, info: { offset: 0, isLast: true } }])
  })

  it('offsets are contiguous and sum to total', async () => {
    const { total, chunks } = await collect(streamOf([bytes(100), bytes(100), bytes(55)]), 100)
    expect(total).toBe(255)
    const last = chunks.at(-1)!
    expect(last.info.offset + last.len).toBe(total)
    expect(last.info.isLast).toBe(true)
    expect(chunks.slice(0, -1).every((c) => !c.info.isLast)).toBe(true)
  })
})

describe('readAll', () => {
  it('concatenates all pieces in order', async () => {
    const out = await readAll(
      streamOf([Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5)]),
    )
    expect([...out]).toEqual([1, 2, 3, 4, 5])
  })

  it('returns empty for an empty stream', async () => {
    const out = await readAll(streamOf([]))
    expect(out.length).toBe(0)
  })
})
