import { describe, it, expect } from 'vitest'
import { parseSourceResponse, type ParsedSource } from './source'
import type { UploadInput } from './types'

const input = (contentType = 'image/jpeg'): UploadInput => ({
  url: 'https://pbs.twimg.com/media/x.jpg',
  target: { path: 'alice/t1_0.jpg', handle: 'alice', filename: 't1_0.jpg', contentType },
})

const sourceResponse = (
  bytes: Uint8Array<ArrayBuffer>,
  opts: { status?: number; contentLength?: number | null; contentType?: string } = {},
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

const ok = (s: ParsedSource): Extract<ParsedSource, { ok: true }> => {
  if (!s.ok) throw new Error(`expected ok, got ${s.outcome.kind}`)
  return s
}

describe('parseSourceResponse', () => {
  it('maps a network error to a (retryable) failure', async () => {
    const out = await parseSourceResponse(input(), async () => {
      throw new Error('econnrefused')
    })
    expect(out).toMatchObject({ ok: false, outcome: { kind: 'failure' } })
  })

  it.each([403, 404, 410])(
    'maps a %d source to sourceGone (link-rot, never a fault)',
    async (s) => {
      const out = await parseSourceResponse(input(), async () =>
        sourceResponse(new Uint8Array(0), { status: s }),
      )
      expect(out).toMatchObject({ ok: false, outcome: { kind: 'sourceGone' } })
    },
  )

  it('maps a 500 source to a failure', async () => {
    const out = await parseSourceResponse(input(), async () =>
      sourceResponse(new Uint8Array(0), { status: 500 }),
    )
    expect(out).toMatchObject({ ok: false, outcome: { kind: 'failure' } })
  })

  it('maps a declared zero-length source to an empty failure', async () => {
    const out = await parseSourceResponse(input(), async () =>
      sourceResponse(new Uint8Array(0), { contentLength: 0 }),
    )
    expect(out).toMatchObject({ ok: false, outcome: { kind: 'failure', reason: 'empty source' } })
  })

  it('returns body + parsed size + response content-type on a healthy source', async () => {
    const out = await parseSourceResponse(input(), async () =>
      sourceResponse(new Uint8Array(1024), { contentType: 'image/png; charset=binary' }),
    )
    const s = ok(out)
    expect(s.size).toBe(1024)
    expect(s.contentType).toBe('image/png') // base type, params stripped
    expect(s.body).not.toBeNull()
  })

  it('falls back to the target MIME hint when the response omits content-type', async () => {
    const out = await parseSourceResponse(input('video/mp4'), async () =>
      sourceResponse(new Uint8Array(8)),
    )
    expect(ok(out).contentType).toBe('video/mp4')
  })

  it('treats a missing content-length as unknown size (null), not zero', async () => {
    const out = await parseSourceResponse(input(), async () =>
      sourceResponse(new Uint8Array(300), { contentLength: null }),
    )
    expect(ok(out).size).toBeNull()
  })
})
