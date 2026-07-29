import { describe, it, expect, vi } from 'vitest'
import { BodyTooLargeError, streamInChunks, readAll, type ChunkInfo } from './chunk'
import { SIMPLE_MAX_BYTES } from './types'

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

function controlledStream(
  reads: ReadonlyArray<ReadableStreamReadResult<Uint8Array> | Error>,
  cancelImpl: (reason?: unknown) => Promise<void> = async () => {},
): {
  readonly body: ReadableStream<Uint8Array>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly releaseLock: ReturnType<typeof vi.fn>
} {
  let at = 0
  const cancel = vi.fn<(reason?: unknown) => Promise<void>>(cancelImpl)
  const releaseLock = vi.fn<() => void>()
  const reader = {
    read: vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>(async () => {
      const next = reads[at] ?? ({ done: true, value: undefined } as const)
      at += 1
      if (next instanceof Error) throw next
      return next
    }),
    cancel,
    releaseLock,
  }
  return {
    body: { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
    cancel,
    releaseLock,
  }
}

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

  it('cancels and releases the reader when the sink rejects', async () => {
    const source = controlledStream([
      { done: false, value: bytes(150) },
      { done: true, value: undefined },
    ])
    const sinkError = new Error('sink rejected')

    await expect(
      streamInChunks(source.body, 100, async () => {
        throw sinkError
      }),
    ).rejects.toBe(sinkError)
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(source.cancel).toHaveBeenCalledWith(sinkError)
    expect(source.releaseLock).toHaveBeenCalledOnce()
  })

  it('preserves a read failure when cancellation also rejects', async () => {
    const readError = new Error('read failed')
    const source = controlledStream([readError], async () => {
      throw new Error('cancel failed')
    })

    await expect(streamInChunks(source.body, 100, async () => {})).rejects.toBe(readError)
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(source.releaseLock).toHaveBeenCalledOnce()
  })
})

describe('readAll', () => {
  it('concatenates all pieces in order', async () => {
    const out = await readAll(
      streamOf([Uint8Array.of(1, 2), Uint8Array.of(3), Uint8Array.of(4, 5)]),
      5,
    )
    expect([...out]).toEqual([1, 2, 3, 4, 5])
  })

  it('returns empty for an empty stream', async () => {
    const out = await readAll(streamOf([]), 0)
    expect(out.length).toBe(0)
  })

  it('accepts actual bytes exactly at the simple-upload cap', async () => {
    const out = await readAll(streamOf([bytes(SIMPLE_MAX_BYTES)]), SIMPLE_MAX_BYTES)
    expect(out.length).toBe(SIMPLE_MAX_BYTES)
  })

  it('rejects actual bytes over the cap and cancels the reader', async () => {
    const source = controlledStream([
      { done: false, value: bytes(4) },
      { done: false, value: bytes(5) },
    ])

    await expect(readAll(source.body, 8)).rejects.toMatchObject({
      name: 'BodyTooLargeError',
      limit: 8,
    })
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(source.releaseLock).toHaveBeenCalledOnce()
  })

  it('rejects one hostile over-cap pull before retaining it', async () => {
    const source = controlledStream([{ done: false, value: bytes(9) }])

    await expect(readAll(source.body, 8)).rejects.toBeInstanceOf(BodyTooLargeError)
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(source.releaseLock).toHaveBeenCalledOnce()
  })

  it('preserves a read failure while canceling and releasing', async () => {
    const readError = new Error('read failed')
    const source = controlledStream([readError], async () => {
      throw new Error('cancel failed')
    })

    await expect(readAll(source.body, 8)).rejects.toBe(readError)
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(source.releaseLock).toHaveBeenCalledOnce()
  })

  it('validates the limit before locking the stream', async () => {
    const getReader = vi.fn<() => ReadableStreamDefaultReader<Uint8Array>>()
    const body = { getReader } as unknown as ReadableStream<Uint8Array>

    await expect(readAll(body, -1)).rejects.toBeInstanceOf(RangeError)
    await expect(readAll(body, 1.5)).rejects.toBeInstanceOf(RangeError)
    await expect(readAll(body, Number.MAX_SAFE_INTEGER + 1)).rejects.toBeInstanceOf(RangeError)
    expect(getReader).not.toHaveBeenCalled()
  })
})
