import { describe, expect, it, vi } from 'vitest'
import { MAX_SYNDICATION_BODY_BYTES, makeSyndicationRecovery } from './syndication-recovery'

const utf8 = new TextEncoder()

const trackedStream = (chunks: readonly Uint8Array[], keepOpen = false) => {
  let reads = 0
  let cancelled = 0
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads += 1
      const next = chunks[reads - 1]
      if (next === undefined) {
        if (keepOpen) return new Promise<void>(() => {})
        controller.close()
      } else controller.enqueue(next)
    },
    cancel() {
      cancelled += 1
    },
  })
  return { body, reads: () => reads, cancelled: () => cancelled }
}

const response = (
  body: ReadableStream<Uint8Array> | null,
  headers?: Record<string, string>,
): Response => new Response(body, { status: 200, ...(headers === undefined ? {} : { headers }) })

const recoveryFor = (fetchImpl: typeof fetch) => makeSyndicationRecovery({ fetchImpl })

describe('SyndicationRecovery', () => {
  it('does not fetch an invalid snowflake', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const result = await recoveryFor(fetchImpl).recover('not-a-tweet', new AbortController().signal)
    expect(result).toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses the fixed endpoint, caller signal, and streamed UTF-8 text', async () => {
    const signal = new AbortController().signal
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(trackedStream([utf8.encode('{"media'), utf8.encode('Details":[]}')]).body),
      )
    await expect(recoveryFor(fetchImpl).recover('2068286123399676218', signal)).resolves.toBe(
      '{"mediaDetails":[]}',
    )
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://cdn.syndication.twimg.com/tweet-result?id=2068286123399676218',
      ),
      { signal },
    )
  })

  it('rejects a declared oversize body before reading and cancels it', async () => {
    const tracked = trackedStream([utf8.encode('unused')])
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response(tracked.body, { 'content-length': String(MAX_SYNDICATION_BODY_BYTES + 1) }),
      )
    await expect(
      recoveryFor(fetchImpl).recover('1', new AbortController().signal),
    ).resolves.toBeUndefined()
    expect(tracked.cancelled()).toBe(1)
  })

  it('cancels a lying or absent-length stream once it crosses the cap', async () => {
    const tracked = trackedStream(
      [utf8.encode('x'.repeat(MAX_SYNDICATION_BODY_BYTES)), utf8.encode('x')],
      true,
    )
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(tracked.body))
    await expect(
      recoveryFor(fetchImpl).recover('1', new AbortController().signal),
    ).resolves.toBeUndefined()
    expect(tracked.cancelled()).toBe(1)
  })

  it('accepts a body exactly at the cap', async () => {
    const text = 'x'.repeat(MAX_SYNDICATION_BODY_BYTES)
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      response(trackedStream([utf8.encode(text)]).body, {
        'content-length': String(MAX_SYNDICATION_BODY_BYTES),
      }),
    )
    await expect(recoveryFor(fetchImpl).recover('1', new AbortController().signal)).resolves.toBe(
      text,
    )
  })

  it.each(['non-ok', 'fetch-throws', 'invalid-utf8', 'aborted'])(
    'returns absent for %s',
    async (kind) => {
      const controller = new AbortController()
      if (kind === 'aborted') controller.abort()
      const fetchImpl =
        kind === 'non-ok'
          ? vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 }))
          : kind === 'fetch-throws'
            ? vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
            : vi
                .fn<typeof fetch>()
                .mockResolvedValue(response(trackedStream([new Uint8Array([0xc3])]).body))
      await expect(recoveryFor(fetchImpl).recover('1', controller.signal)).resolves.toBeUndefined()
    },
  )
})
