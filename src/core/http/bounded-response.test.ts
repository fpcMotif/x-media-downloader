import { describe, expect, it, vi } from 'vitest'
import { readBoundedJson, ResponseBodyTooLargeError } from './bounded-response'

const bodyWith = (
  reads: ReadonlyArray<ReadableStreamReadResult<Uint8Array> | Error>,
): {
  readonly body: ReadableStream<Uint8Array>
  readonly cancel: ReturnType<typeof vi.fn>
  readonly releaseLock: ReturnType<typeof vi.fn>
} => {
  let index = 0
  const cancel = vi.fn<(reason?: unknown) => Promise<void>>(async () => {})
  const releaseLock = vi.fn<() => void>()
  const reader = {
    read: vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>(async () => {
      const next = reads[index++] ?? ({ done: true, value: undefined } as const)
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

describe('readBoundedJson', () => {
  it('parses a response below the actual-byte cap', async () => {
    await expect(readBoundedJson(new Response('{"ok":true}'), 32)).resolves.toEqual({ ok: true })
  })

  it('rejects and cancels when streamed bytes cross the cap', async () => {
    const stream = bodyWith([{ done: false, value: new TextEncoder().encode('{"value":"xx"}') }])
    const response = {
      body: stream.body,
      headers: new Headers({ 'content-length': '1' }),
    } as Response

    await expect(readBoundedJson(response, 8)).rejects.toBeInstanceOf(ResponseBodyTooLargeError)
    expect(stream.cancel).toHaveBeenCalledOnce()
    expect(stream.releaseLock).toHaveBeenCalledOnce()
  })

  it('rejects an honest oversized Content-Length before pulling and cancels the body', async () => {
    const cancel = vi.fn<(reason?: unknown) => Promise<void>>(async () => {})
    const response = {
      body: { cancel } as unknown as ReadableStream<Uint8Array>,
      headers: new Headers({ 'content-length': '9' }),
    } as Response

    await expect(readBoundedJson(response, 8)).rejects.toBeInstanceOf(ResponseBodyTooLargeError)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects malformed UTF-8 and JSON', async () => {
    await expect(
      readBoundedJson(new Response(new Uint8Array([0xc3, 0x28])), 8),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(readBoundedJson(new Response('<html>'), 8)).rejects.toBeInstanceOf(SyntaxError)
  })

  it('cancels and preserves a stream read failure', async () => {
    const failure = new Error('socket reset')
    const stream = bodyWith([failure])
    const response = { body: stream.body, headers: new Headers() } as Response

    await expect(readBoundedJson(response, 8)).rejects.toBe(failure)
    expect(stream.cancel).toHaveBeenCalledWith(failure)
    expect(stream.releaseLock).toHaveBeenCalledOnce()
  })
})
