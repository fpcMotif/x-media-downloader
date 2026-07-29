import { describe, it, expect, vi } from 'vitest'
import { Effect } from 'effect'
import {
  authHeader,
  CloudHttpError,
  discardResponseBody,
  errText,
  httpErr,
  MAX_CONTROL_JSON_BYTES,
  MAX_PROVIDER_ERROR_BYTES,
  readControlJson,
  runUpload,
} from './http'
import { FetchError } from '../fetch-service'
import type { ParsedSource } from './source'
import { SIMPLE_MAX_BYTES, type UploadOutcome } from './types'

// Direct unit tests for the provider-agnostic upload template method (runUpload) and
// the shared HTTP helpers. These are reached transitively by upload-pipeline.e2e.test,
// but here each branch — source early-return, simple-vs-streamed size dispatch, both
// empty-source guards, and the CloudHttpError/defect → outcome mapping — is pinned by
// intent through injected sinks, with no FetchService/runtime needed (R collapses to never).

type SimpleSink = (
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
) => Effect.Effect<UploadOutcome, CloudHttpError | FetchError>
type StreamedSink = (
  body: ReadableStream<Uint8Array>,
  size: number | null,
  contentType: string,
) => Effect.Effect<{ outcome: UploadOutcome; bytes: number }, CloudHttpError | FetchError>

const success = (bytes = 3): UploadOutcome => ({ kind: 'success', bytes, remotePath: 'p' })

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes)
      controller.close()
    },
  })

function controlledBody(
  reads: ReadonlyArray<ReadableStreamReadResult<Uint8Array> | Error>,
  streamCancelImpl: () => Promise<void> = async () => {},
): {
  readonly body: ReadableStream<Uint8Array>
  readonly readerCancel: ReturnType<typeof vi.fn>
  readonly streamCancel: ReturnType<typeof vi.fn>
  readonly releaseLock: ReturnType<typeof vi.fn>
} {
  let at = 0
  const readerCancel = vi.fn<(reason?: unknown) => Promise<void>>(async () => {})
  const streamCancel = vi.fn<() => Promise<void>>(streamCancelImpl)
  const releaseLock = vi.fn<() => void>()
  const reader = {
    read: vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>(async () => {
      const next = reads[at] ?? ({ done: true, value: undefined } as const)
      at += 1
      if (next instanceof Error) throw next
      return next
    }),
    cancel: readerCancel,
    releaseLock,
  }
  return {
    body: {
      getReader: () => reader,
      cancel: streamCancel,
    } as unknown as ReadableStream<Uint8Array>,
    readerCancel,
    streamCancel,
    releaseLock,
  }
}

const okSource = (
  over: {
    size?: number | null
    contentType?: string
    body?: ReadableStream<Uint8Array>
  } = {},
): Effect.Effect<ParsedSource> =>
  Effect.succeed({
    ok: true,
    body: over.body ?? streamOf(new Uint8Array([1, 2, 3])),
    size: over.size === undefined ? 3 : over.size,
    contentType: over.contentType ?? 'video/mp4',
  })

const sinks = (over: { simple?: SimpleSink; streamed?: StreamedSink } = {}) => ({
  simple: vi.fn<SimpleSink>(over.simple ?? (() => Effect.succeed(success()))),
  streamed: vi.fn<StreamedSink>(
    over.streamed ?? (() => Effect.succeed({ outcome: success(), bytes: 1 })),
  ),
})

describe('runUpload — template method', () => {
  it('returns the early-return outcome when the source is not ok, never touching the sinks', async () => {
    const s = sinks()
    const gone: UploadOutcome = { kind: 'sourceGone', reason: 'source HTTP 410' }
    const outcome = await Effect.runPromise(
      runUpload(Effect.succeed<ParsedSource>({ ok: false, outcome: gone }), s),
    )
    expect(outcome).toEqual(gone)
    expect(s.simple).not.toHaveBeenCalled()
    expect(s.streamed).not.toHaveBeenCalled()
  })

  it('buffers and uses the simple sink for a small source, forwarding bytes + content type', async () => {
    const s = sinks({ simple: () => Effect.succeed(success(3)) })
    const outcome = await Effect.runPromise(runUpload(okSource({ size: 3 }), s))
    expect(outcome).toEqual(success(3))
    expect(s.simple).toHaveBeenCalledTimes(1)
    expect(s.streamed).not.toHaveBeenCalled()
    const [bytes, ct] = s.simple.mock.calls[0]!
    expect([...bytes]).toEqual([1, 2, 3])
    expect(ct).toBe('video/mp4')
  })

  it('reports empty source when the simple buffer reads zero bytes (sink not called)', async () => {
    const s = sinks()
    const outcome = await Effect.runPromise(
      runUpload(okSource({ size: 3, body: streamOf(new Uint8Array(0)) }), s),
    )
    expect(outcome).toEqual({ kind: 'failure', reason: 'empty source' })
    expect(s.simple).not.toHaveBeenCalled()
  })

  it('streams via the streamed sink when size is unknown', async () => {
    const s = sinks({ streamed: () => Effect.succeed({ outcome: success(5000), bytes: 5000 }) })
    const outcome = await Effect.runPromise(runUpload(okSource({ size: null }), s))
    expect(outcome).toEqual(success(5000))
    expect(s.streamed).toHaveBeenCalledTimes(1)
    expect(s.simple).not.toHaveBeenCalled()
    const [, size, ct] = s.streamed.mock.calls[0]!
    expect(size).toBeNull()
    expect(ct).toBe('video/mp4')
  })

  it('reports empty source when the streamed sink uploads zero bytes', async () => {
    const s = sinks({ streamed: () => Effect.succeed({ outcome: success(0), bytes: 0 }) })
    const outcome = await Effect.runPromise(runUpload(okSource({ size: null }), s))
    expect(outcome).toEqual({ kind: 'failure', reason: 'empty source' })
  })

  it('dispatches on SIMPLE_MAX_BYTES: at the cap → simple, one over → streamed', async () => {
    const atCap = sinks()
    await Effect.runPromise(
      runUpload(okSource({ size: SIMPLE_MAX_BYTES, body: streamOf(new Uint8Array([7])) }), atCap),
    )
    expect(atCap.simple).toHaveBeenCalledTimes(1)
    expect(atCap.streamed).not.toHaveBeenCalled()

    const overCap = sinks()
    await Effect.runPromise(runUpload(okSource({ size: SIMPLE_MAX_BYTES + 1 }), overCap))
    expect(overCap.streamed).toHaveBeenCalledTimes(1)
    expect(overCap.simple).not.toHaveBeenCalled()
  })

  it('rejects a lying small Content-Length when actual bytes cross 8 MiB', async () => {
    const source = controlledBody([{ done: false, value: new Uint8Array(SIMPLE_MAX_BYTES + 1) }])
    const s = sinks()

    const outcome = await Effect.runPromise(runUpload(okSource({ size: 1, body: source.body }), s))

    expect(outcome).toEqual({
      kind: 'failure',
      reason: `body exceeds ${SIMPLE_MAX_BYTES}-byte limit`,
    })
    expect(s.simple).not.toHaveBeenCalled()
    expect(s.streamed).not.toHaveBeenCalled()
    expect(source.readerCancel).toHaveBeenCalledOnce()
    expect(source.streamCancel).toHaveBeenCalledOnce()
  })

  it('cancels an unread source when the streamed sink rejects', async () => {
    const source = controlledBody([])
    const sinkError = new Error('sink rejected')
    const s = sinks({ streamed: () => Effect.die(sinkError) })

    const outcome = await Effect.runPromise(
      runUpload(okSource({ size: null, body: source.body }), s),
    )

    expect(outcome).toEqual({ kind: 'failure', reason: 'sink rejected' })
    expect(source.streamCancel).toHaveBeenCalledOnce()
  })

  it('never lets cancellation failure replace the sink failure', async () => {
    const source = controlledBody([], async () => {
      throw new Error('cancel failed')
    })
    const s = sinks({ streamed: () => Effect.die(new Error('sink failed')) })

    await expect(
      Effect.runPromise(runUpload(okSource({ size: null, body: source.body }), s)),
    ).resolves.toEqual({ kind: 'failure', reason: 'sink failed' })
  })

  it('cancels when a streamed sink throws before returning its Effect', async () => {
    const source = controlledBody([])
    const sinkError = new Error('sink construction failed')
    const s = sinks({
      streamed: () => {
        throw sinkError
      },
    })

    await expect(
      Effect.runPromise(runUpload(okSource({ size: null, body: source.body }), s)),
    ).resolves.toEqual({ kind: 'failure', reason: sinkError.message })
    expect(source.streamCancel).toHaveBeenCalledOnce()
  })

  it('maps a CloudHttpError to a failure outcome carrying the numeric status', async () => {
    const s = sinks({
      simple: () =>
        Effect.fail(new CloudHttpError({ provider: 'gdrive', status: 413, body: 'too big' })),
    })
    const outcome = await Effect.runPromise(runUpload(okSource({ size: 3 }), s))
    expect(outcome).toEqual({ kind: 'failure', reason: 'gdrive HTTP 413: too big', status: 413 })
  })

  it('maps a non-CloudHttpError failure (FetchError) via its byte-stable reason string', async () => {
    const s = sinks({
      streamed: () => Effect.fail(new FetchError({ url: 'https://up', cause: 'reset' })),
    })
    const outcome = await Effect.runPromise(runUpload(okSource({ size: null }), s))
    expect(outcome).toEqual({ kind: 'failure', reason: 'fetch https://up: reset' })
  })

  it('maps an unexpected defect (a thrown sink) via catchCause', async () => {
    const s = sinks({ streamed: () => Effect.die(new Error('sink exploded')) })
    const outcome = await Effect.runPromise(runUpload(okSource({ size: null }), s))
    expect(outcome).toEqual({ kind: 'failure', reason: 'sink exploded' })
  })
})

describe('http helpers', () => {
  it('authHeader builds a bearer header', () => {
    expect(authHeader('tok-123')).toEqual({ authorization: 'Bearer tok-123' })
  })

  it('httpErr formats provider/status, omits an empty body, and truncates to 200 chars', () => {
    expect(httpErr('dropbox', 409, 'conflict')).toBe('dropbox HTTP 409: conflict')
    expect(httpErr('gdrive', 500, '')).toBe('gdrive HTTP 500')
    expect(httpErr('gdrive', 400, 'x'.repeat(300))).toBe(`gdrive HTTP 400: ${'x'.repeat(200)}`)
  })

  it('CloudHttpError.message reproduces the httpErr text byte-for-byte', () => {
    const e = new CloudHttpError({ provider: 'gdrive', status: 404, body: 'gone' })
    expect(e.message).toBe('gdrive HTTP 404: gone')
    expect(e.status).toBe(404)
  })

  it('discards a status-only response without exposing cleanup failure', async () => {
    const cancel = vi.fn<() => Promise<void>>(async () => {
      throw new Error('cancel failed')
    })
    const res = { body: { cancel } } as unknown as Response

    await expect(discardResponseBody(res)).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledOnce()
    await expect(discardResponseBody({ body: null } as Response)).resolves.toBeUndefined()
  })

  it('errText returns the response body text', async () => {
    expect(await errText(new Response('boom'))).toBe('boom')
  })

  it('bounds hostile provider error text by raw bytes and cancels the remainder', async () => {
    const source = controlledBody([
      {
        done: false,
        value: new TextEncoder().encode('é'.repeat(MAX_PROVIDER_ERROR_BYTES / 2 + 1)),
      },
    ])
    const res = { body: source.body } as Response

    const text = await errText(res)

    expect(text).toBe('é'.repeat(MAX_PROVIDER_ERROR_BYTES / 2))
    expect(source.readerCancel).toHaveBeenCalledOnce()
    expect(source.releaseLock).toHaveBeenCalledOnce()
  })

  it('returns empty error text after a failed read and still attempts cancellation', async () => {
    const source = controlledBody([new Error('connection reset')])

    await expect(errText({ body: source.body } as Response)).resolves.toBe('')
    expect(source.readerCancel).toHaveBeenCalledOnce()
    expect(source.releaseLock).toHaveBeenCalledOnce()
  })

  it('parses valid control JSON exactly at the 1 MiB cap', async () => {
    const padding = 'x'.repeat(MAX_CONTROL_JSON_BYTES - 8)
    const json = `{"x":"${padding}"}`
    expect(new TextEncoder().encode(json)).toHaveLength(MAX_CONTROL_JSON_BYTES)

    await expect(readControlJson(new Response(json))).resolves.toEqual({
      x: padding,
    })
  })

  it('rejects control JSON over 1 MiB despite a lying small header', async () => {
    const source = controlledBody([
      { done: false, value: new Uint8Array(MAX_CONTROL_JSON_BYTES + 1) },
    ])
    const res = {
      body: source.body,
      headers: new Headers({ 'content-length': '1' }),
    } as Response

    await expect(readControlJson(res)).rejects.toMatchObject({
      name: 'ResponseBodyTooLargeError',
      maxBytes: MAX_CONTROL_JSON_BYTES,
    })
    expect(source.readerCancel).toHaveBeenCalledOnce()
  })

  it('rejects an honestly oversized control response before pulling', async () => {
    const source = controlledBody([])
    const res = {
      body: source.body,
      headers: new Headers({ 'content-length': String(MAX_CONTROL_JSON_BYTES + 1) }),
    } as Response

    await expect(readControlJson(res)).rejects.toMatchObject({
      name: 'ResponseBodyTooLargeError',
      maxBytes: MAX_CONTROL_JSON_BYTES,
    })
    expect(source.streamCancel).toHaveBeenCalledOnce()
    expect(source.releaseLock).not.toHaveBeenCalled()
  })
})
