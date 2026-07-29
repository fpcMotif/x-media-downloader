import { describe, it, expect, vi } from 'vitest'
import { Effect, Layer } from 'effect'
import { parseSource, type ParsedSource } from './source'
import { SourceFetch } from './source-fetch'
import { FetchError } from '../fetch-service'
import type { UploadInput } from './types'

const input = (contentType = 'image/jpeg'): UploadInput => ({
  url: 'https://pbs.twimg.com/media/x.jpg',
  target: { path: 'alice/t1_0.jpg', folder: 'alice', filename: 't1_0.jpg', contentType },
})

const sourceResponse = (
  bytes: Uint8Array<ArrayBuffer>,
  opts: { status?: number; contentLength?: number | string | null; contentType?: string } = {},
): Response => {
  const headers: Record<string, string> = {}
  if (opts.contentType !== undefined) headers['content-type'] = opts.contentType
  if (opts.contentLength !== null)
    headers['content-length'] = String(opts.contentLength ?? bytes.length)
  return new Response(opts.status && opts.status >= 400 ? null : bytes, {
    status: opts.status ?? 200,
    headers,
  })
}

const liveResponse = (
  status: number,
  headers: HeadersInit = {},
  cancelImpl: () => Promise<void> = async () => {},
): { readonly response: Response; readonly cancel: ReturnType<typeof vi.fn> } => {
  const cancel = vi.fn<() => Promise<void>>(cancelImpl)
  const body = { cancel } as unknown as ReadableStream<Uint8Array>
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      body,
      headers: new Headers(headers),
    } as Response,
    cancel,
  }
}

const sourceLayer = (fetch: () => Effect.Effect<Response, FetchError>): Layer.Layer<SourceFetch> =>
  Layer.succeed(SourceFetch, { fetch })

const run = (layer: Layer.Layer<SourceFetch>, inp: UploadInput): Promise<ParsedSource> =>
  Effect.runPromise(parseSource(inp).pipe(Effect.provide(layer)))

const ok = (s: ParsedSource): Extract<ParsedSource, { ok: true }> => {
  if (!s.ok) throw new Error(`expected ok, got ${s.outcome.kind}`)
  return s
}

describe('parseSource', () => {
  it('maps a transport error to a (retryable) failure', async () => {
    const out = await run(
      sourceLayer(() =>
        Effect.fail(new FetchError({ url: 'x', cause: new Error('econnrefused') })),
      ),
      input(),
    )
    expect(out).toMatchObject({ ok: false, outcome: { kind: 'failure' } })
  })

  it.each([403, 404, 410])(
    'maps a %d source to sourceGone (link-rot, never a fault)',
    async (s) => {
      const out = await run(
        sourceLayer(() => Effect.succeed(sourceResponse(new Uint8Array(0), { status: s }))),
        input(),
      )
      expect(out).toMatchObject({ ok: false, outcome: { kind: 'sourceGone' } })
    },
  )

  it('maps a 500 source to a failure', async () => {
    const out = await run(
      sourceLayer(() => Effect.succeed(sourceResponse(new Uint8Array(0), { status: 500 }))),
      input(),
    )
    expect(out).toMatchObject({ ok: false, outcome: { kind: 'failure' } })
  })

  it.each([
    { status: 403, kind: 'sourceGone' },
    { status: 404, kind: 'sourceGone' },
    { status: 410, kind: 'sourceGone' },
    { status: 500, kind: 'failure' },
  ] as const)(
    'cancels a live $status error body before returning $kind',
    async ({ status, kind }) => {
      const live = liveResponse(status)
      const out = await run(
        sourceLayer(() => Effect.succeed(live.response)),
        input(),
      )

      expect(out).toMatchObject({ ok: false, outcome: { kind } })
      expect(live.cancel).toHaveBeenCalledOnce()
    },
  )

  it('maps a declared zero-length source to an empty failure', async () => {
    const out = await run(
      sourceLayer(() => Effect.succeed(sourceResponse(new Uint8Array(0), { contentLength: 0 }))),
      input(),
    )
    expect(out).toMatchObject({ ok: false, outcome: { kind: 'failure', reason: 'empty source' } })
  })

  it('cancels actual bytes when Content-Length lies that the source is empty', async () => {
    const live = liveResponse(200, { 'content-length': '0' })
    const out = await run(
      sourceLayer(() => Effect.succeed(live.response)),
      input(),
    )

    expect(out).toMatchObject({ ok: false, outcome: { kind: 'failure', reason: 'empty source' } })
    expect(live.cancel).toHaveBeenCalledOnce()
  })

  it('does not let body-cancel failure replace the source outcome', async () => {
    const live = liveResponse(500, {}, async () => {
      throw new Error('cancel failed')
    })

    await expect(
      run(
        sourceLayer(() => Effect.succeed(live.response)),
        input(),
      ),
    ).resolves.toMatchObject({ ok: false, outcome: { kind: 'failure', reason: 'source HTTP 500' } })
  })

  it('returns body + parsed size + response content-type on a healthy source', async () => {
    const out = await run(
      sourceLayer(() =>
        Effect.succeed(
          sourceResponse(new Uint8Array(1024), { contentType: 'image/png; charset=binary' }),
        ),
      ),
      input(),
    )
    const s = ok(out)
    expect(s.size).toBe(1024)
    expect(s.contentType).toBe('image/png') // base type, params stripped
    expect(s.body).not.toBeNull()
  })

  it('falls back to the target MIME hint when the response omits content-type', async () => {
    const out = await run(
      sourceLayer(() => Effect.succeed(sourceResponse(new Uint8Array(8)))),
      input('video/mp4'),
    )
    expect(ok(out).contentType).toBe('video/mp4')
  })

  it('treats a missing content-length as unknown size (null), not zero', async () => {
    const out = await run(
      sourceLayer(() =>
        Effect.succeed(sourceResponse(new Uint8Array(300), { contentLength: null })),
      ),
      input(),
    )
    expect(ok(out).size).toBeNull()
  })

  it.each(['-1', '1.5', '1e3', 'Infinity', '9007199254740992'])(
    'treats hostile Content-Length %s as unknown',
    async (contentLength) => {
      const out = await run(
        sourceLayer(() => Effect.succeed(sourceResponse(new Uint8Array(1), { contentLength }))),
        input(),
      )
      expect(ok(out).size).toBeNull()
    },
  )

  it('accepts only safe digit-only Content-Length values', async () => {
    const padded = await run(
      sourceLayer(() =>
        Effect.succeed(sourceResponse(new Uint8Array(1), { contentLength: '0008' })),
      ),
      input(),
    )
    const maximum = await run(
      sourceLayer(() =>
        Effect.succeed(
          sourceResponse(new Uint8Array(1), {
            contentLength: String(Number.MAX_SAFE_INTEGER),
          }),
        ),
      ),
      input(),
    )

    expect(ok(padded).size).toBe(8)
    expect(ok(maximum).size).toBe(Number.MAX_SAFE_INTEGER)
  })
})
