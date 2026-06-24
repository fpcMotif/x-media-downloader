import { describe, it, expect } from 'vitest'
import { dropboxUpload, makeDropboxDestination, type DropboxDeps } from './dropbox'
import type { UploadInput } from './types'

function sourceResponse(
  bytes: Uint8Array<ArrayBuffer>,
  opts: { status?: number; contentLength?: number | null } = {},
): Response {
  const headers: Record<string, string> = { 'content-type': 'video/mp4' }
  if (opts.contentLength !== null)
    headers['content-length'] = String(opts.contentLength ?? bytes.length)
  return new Response(opts.status && opts.status >= 400 ? null : bytes, {
    status: opts.status ?? 200,
    headers,
  })
}

const input = (path = 'alice/t1_0.mp4'): UploadInput => ({
  url: 'https://video.twimg.com/x.mp4',
  target: { path, handle: 'alice', filename: path.split('/').pop()!, contentType: 'video/mp4' },
})

function makeDropboxFetch() {
  const calls: { endpoint: string; arg: unknown; bodyLen: number }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const endpoint = u.replace('https://content.dropboxapi.com/2/', '')
    const argHeader =
      (init?.headers as Record<string, string> | undefined)?.['dropbox-api-arg'] ?? '{}'
    const body = init?.body as Uint8Array | undefined
    calls.push({ endpoint, arg: JSON.parse(argHeader), bodyLen: body?.byteLength ?? 0 })
    if (endpoint === 'files/upload') {
      return new Response(
        JSON.stringify({
          id: 'id:simple',
          size: body?.byteLength ?? 0,
          path_display: '/alice/t1_0.mp4',
        }),
        { status: 200 },
      )
    }
    if (endpoint === 'files/upload_session/start') {
      return new Response(JSON.stringify({ session_id: 'sess-1' }), { status: 200 })
    }
    if (endpoint === 'files/upload_session/append_v2') {
      return new Response('', { status: 200 })
    }
    if (endpoint === 'files/upload_session/finish') {
      return new Response(
        JSON.stringify({ id: 'id:session', size: 999, path_display: '/alice/big.mp4' }),
        { status: 200 },
      )
    }
    return new Response('unexpected', { status: 500 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const deps = (fetchImpl: typeof fetch, source: () => Response): DropboxDeps => ({
  accessToken: 'AT',
  fetchImpl,
  fetchSource: async () => source(),
})

describe('dropboxUpload', () => {
  it('maps a 410 source to sourceGone', async () => {
    const { fetchImpl } = makeDropboxFetch()
    const out = await dropboxUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(0), { status: 410 })),
    )
    expect(out.kind).toBe('sourceGone')
  })

  it('small media → single files/upload with an "add" commit', async () => {
    const { fetchImpl, calls } = makeDropboxFetch()
    const out = await dropboxUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(2048))),
    )
    expect(out).toMatchObject({
      kind: 'success',
      remoteId: 'id:simple',
      remotePath: '/alice/t1_0.mp4',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.endpoint).toBe('files/upload')
    expect((calls[0]!.arg as { path: string; mode: string }).path).toBe('/alice/t1_0.mp4')
    expect((calls[0]!.arg as { mode: string }).mode).toBe('add')
  })

  it('large/unknown media → session start → append(s) → finish in order', async () => {
    const { fetchImpl, calls } = makeDropboxFetch()
    // 20 MiB body, unknown size → streamed in 8 MiB chunks (start, append, finish)
    const bytes = new Uint8Array(20 * 1024 * 1024).fill(3)
    const out = await dropboxUpload(
      input('alice/big.mp4'),
      deps(fetchImpl, () => sourceResponse(bytes, { contentLength: null })),
    )
    expect(out).toMatchObject({ kind: 'success', remoteId: 'id:session' })
    const endpoints = calls.map((c) => c.endpoint)
    expect(endpoints[0]).toBe('files/upload_session/start')
    expect(endpoints.at(-1)).toBe('files/upload_session/finish')
    expect(
      endpoints.filter((e) => e === 'files/upload_session/append_v2').length,
    ).toBeGreaterThanOrEqual(1)
    // offsets are cumulative and the total equals the body size
    const finish = calls.at(-1)!
    expect((finish.arg as { cursor: { offset: number } }).cursor.offset).toBe(
      20 * 1024 * 1024 - finish.bodyLen,
    )
  })

  it('escapes non-ASCII path chars in the Dropbox-API-Arg header', async () => {
    let header = ''
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
      header = ((init?.headers ?? {}) as Record<string, string>)['dropbox-api-arg'] ?? ''
      return new Response(JSON.stringify({ id: 'x', size: 1, path_display: '/p' }), { status: 200 })
    }) as unknown as typeof fetch
    await dropboxUpload(
      input('日本/t1.mp4'),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(8))),
    )
    expect([...header].every((ch) => ch.charCodeAt(0) <= 127)).toBe(true) // pure ASCII
    expect(header).toContain('\\u')
  })

  it('empty source → failure', async () => {
    const { fetchImpl } = makeDropboxFetch()
    const out = await dropboxUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(0), { contentLength: 0 })),
    )
    expect(out.kind).toBe('failure')
  })

  it('a small unknown-size source uses a single-chunk session (start close → finish empty)', async () => {
    const { fetchImpl, calls } = makeDropboxFetch()
    // unknown size + small body ⇒ session path with exactly one (final) chunk
    const out = await dropboxUpload(
      input('alice/small.mp4'),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(1024), { contentLength: null })),
    )
    expect(out).toMatchObject({ kind: 'success', remoteId: 'id:session' })
    const endpoints = calls.map((c) => c.endpoint)
    expect(endpoints).toEqual(['files/upload_session/start', 'files/upload_session/finish'])
    // start carried the bytes (close:true); finish committed with an empty body at the end offset
    expect((calls[0]!.arg as { close: boolean }).close).toBe(true)
    expect(calls[0]!.bodyLen).toBe(1024)
    expect(calls[1]!.bodyLen).toBe(0)
    expect((calls[1]!.arg as { cursor: { offset: number } }).cursor.offset).toBe(1024)
  })

  it('simple-upload HTTP error → failure (never throws)', async () => {
    const fetchImpl = (async () =>
      new Response('denied', { status: 401 })) as unknown as typeof fetch
    const out = await dropboxUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(64))),
    )
    expect(out).toMatchObject({ kind: 'failure' })
    expect((out as { reason: string }).reason).toMatch(/dropbox HTTP 401/)
  })

  it('session start failure → failure', async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).endsWith('upload_session/start')
        ? new Response('no', { status: 500 })
        : new Response('{}', { status: 200 })) as unknown as typeof fetch
    const out = await dropboxUpload(
      input('alice/big.mp4'),
      deps(fetchImpl, () =>
        sourceResponse(new Uint8Array(20 * 1024 * 1024), { contentLength: null }),
      ),
    )
    expect(out.kind).toBe('failure')
  })

  it('session append failure → failure', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('upload_session/start'))
        return new Response(JSON.stringify({ session_id: 's' }), { status: 200 })
      if (u.endsWith('upload_session/append_v2')) return new Response('no', { status: 503 })
      return new Response(JSON.stringify({ id: 'x', size: 1, path_display: '/p' }), { status: 200 })
    }) as unknown as typeof fetch
    const out = await dropboxUpload(
      input('alice/big.mp4'),
      deps(fetchImpl, () =>
        sourceResponse(new Uint8Array(20 * 1024 * 1024), { contentLength: null }),
      ),
    )
    expect(out.kind).toBe('failure')
  })

  it('session finish failure → failure', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url)
      if (u.endsWith('upload_session/start'))
        return new Response(JSON.stringify({ session_id: 's' }), { status: 200 })
      if (u.endsWith('upload_session/append_v2')) return new Response('', { status: 200 })
      return new Response('no', { status: 500 }) // finish
    }) as unknown as typeof fetch
    const out = await dropboxUpload(
      input('alice/big.mp4'),
      deps(fetchImpl, () =>
        sourceResponse(new Uint8Array(20 * 1024 * 1024), { contentLength: null }),
      ),
    )
    expect(out.kind).toBe('failure')
  })

  it('single-chunk session: a finish (commit) error → failure', async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).endsWith('upload_session/start')
        ? new Response(JSON.stringify({ session_id: 's' }), { status: 200 })
        : new Response('commit failed', { status: 500 })) as unknown as typeof fetch
    const out = await dropboxUpload(
      input('alice/small.mp4'),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(1024), { contentLength: null })),
    )
    expect(out.kind).toBe('failure')
  })

  it('session success falls back to byte count + request path when finish omits size/path/id', async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).endsWith('upload_session/start')
        ? new Response(JSON.stringify({ session_id: 's' }), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    const out = await dropboxUpload(
      input('alice/small.mp4'),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(1024), { contentLength: null })),
    )
    expect(out).toMatchObject({ kind: 'success', bytes: 1024, remotePath: '/alice/small.mp4' })
    expect((out as { remoteId?: string }).remoteId).toBeUndefined()
  })

  it("errText falls back to '' when the error body read itself fails", async () => {
    const fetchImpl = (async () =>
      ({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error('read failed')),
        headers: new Headers(),
      }) as unknown as Response) as unknown as typeof fetch
    const out = await dropboxUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(32))),
    )
    expect(out).toMatchObject({ kind: 'failure', reason: 'dropbox HTTP 500' })
  })

  it('falls back to local byte count + request path when metadata omits size/path', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch // no id/size/path
    const out = await dropboxUpload(
      input('alice/t1_0.mp4'),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(2048))),
    )
    expect(out).toMatchObject({ kind: 'success', bytes: 2048, remotePath: '/alice/t1_0.mp4' })
    expect((out as { remoteId?: string }).remoteId).toBeUndefined()
  })
})

const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.close()
    },
  })

describe('dropboxUpload — empty-body edges', () => {
  it('declared non-zero length but empty simple body → failure', async () => {
    const { fetchImpl } = makeDropboxFetch()
    const out = await dropboxUpload(
      input(),
      deps(
        fetchImpl,
        () =>
          new Response(emptyStream(), {
            status: 200,
            headers: { 'content-type': 'video/mp4', 'content-length': '7' },
          }),
      ),
    )
    expect(out).toMatchObject({ kind: 'failure', reason: 'empty source' })
  })

  it('empty stream with unknown size → session yields zero bytes → failure', async () => {
    const { fetchImpl } = makeDropboxFetch()
    const out = await dropboxUpload(
      input(),
      deps(
        fetchImpl,
        () =>
          new Response(emptyStream(), { status: 200, headers: { 'content-type': 'video/mp4' } }),
      ),
    )
    expect(out).toMatchObject({ kind: 'failure', reason: 'empty source' })
  })
})

describe('makeDropboxDestination', () => {
  it('uploads through the provider-agnostic CloudDestination', async () => {
    const { fetchImpl } = makeDropboxFetch()
    const dest = makeDropboxDestination(deps(fetchImpl, () => sourceResponse(new Uint8Array(16))))
    const out = await dest.upload(input())
    expect(out).toMatchObject({ kind: 'success', remoteId: 'id:simple' })
  })
})
