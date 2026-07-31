import { describe, it, expect } from 'vitest'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { DropboxUploader, DropboxUploaderLive } from './dropbox'
import { FetchService } from '@/packages/kernel/fetch-service'
import { SourceFetch } from './lib/source-fetch'
import type { UploadInput } from './types'

const sourceResponse = (
  bytes: Uint8Array<ArrayBuffer>,
  opts: { status?: number; contentLength?: number | null } = {},
): Response => {
  const headers: Record<string, string> = { 'content-type': 'video/mp4' }
  if (opts.contentLength !== null)
    headers['content-length'] = String(opts.contentLength ?? bytes.length)
  return new Response(opts.status && opts.status >= 400 ? null : bytes, {
    status: opts.status ?? 200,
    headers,
  })
}

const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.close()
    },
  })

const input = (path = 'alice/t1_0.mp4'): UploadInput => ({
  url: 'https://video.twimg.com/x.mp4',
  target: { path, folder: 'alice', filename: path.split('/').pop()!, contentType: 'video/mp4' },
})

const sourceStub = (make: () => Response): Layer.Layer<SourceFetch> =>
  Layer.succeed(SourceFetch, { fetch: () => Effect.succeed(make()) })

type Route = (endpoint: string, init?: RequestInit, body?: Uint8Array) => Response

const sessionStarted = (): Response =>
  new Response(JSON.stringify({ session_id: 's' }), { status: 200 })

/** The standard Dropbox content router (single upload + session start/append/finish). */
const dropboxRoute: Route = (endpoint, _init, body) => {
  if (endpoint === 'files/upload')
    return new Response(
      JSON.stringify({
        id: 'id:simple',
        size: body?.byteLength ?? 0,
        path_display: '/alice/t1_0.mp4',
      }),
      { status: 200 },
    )
  if (endpoint === 'files/upload_session/start')
    return new Response(JSON.stringify({ session_id: 'sess-1' }), { status: 200 })
  if (endpoint === 'files/upload_session/append_v2') return new Response('', { status: 200 })
  if (endpoint === 'files/upload_session/finish')
    return new Response(
      JSON.stringify({ id: 'id:session', size: 999, path_display: '/alice/big.mp4' }),
      { status: 200 },
    )
  return new Response('unexpected', { status: 500 })
}

// Per-scenario routers (module scope: they capture no test state).
const routeMetaX: Route = () =>
  new Response(JSON.stringify({ id: 'x', size: 1, path_display: '/p' }), { status: 200 })
const routeEmptyMeta: Route = () => new Response(JSON.stringify({}), { status: 200 })
const routeSimple401: Route = () => new Response('denied', { status: 401 })
const routeSessionStart500: Route = (endpoint) =>
  endpoint.endsWith('upload_session/start')
    ? new Response('no', { status: 500 })
    : new Response('{}', { status: 200 })
const routeSessionAppend503: Route = (endpoint) => {
  if (endpoint.endsWith('upload_session/start')) return sessionStarted()
  if (endpoint.endsWith('upload_session/append_v2')) return new Response('no', { status: 503 })
  return routeMetaX(endpoint)
}
const routeSessionFinish500: Route = (endpoint) => {
  if (endpoint.endsWith('upload_session/start')) return sessionStarted()
  if (endpoint.endsWith('upload_session/append_v2')) return new Response('', { status: 200 })
  return new Response('no', { status: 500 }) // finish
}
const routeSingleChunkFinish500: Route = (endpoint) =>
  endpoint.endsWith('upload_session/start')
    ? sessionStarted()
    : new Response('commit failed', { status: 500 })
const routeSessionEmptyMeta: Route = (endpoint) =>
  endpoint.endsWith('upload_session/start')
    ? sessionStarted()
    : new Response(JSON.stringify({}), { status: 200 })
const routeErrTextRejects: Route = () =>
  ({
    ok: false,
    status: 500,
    text: () => Promise.reject(new Error('read failed')),
    headers: new Headers(),
  }) as unknown as Response

interface Call {
  readonly endpoint: string
  readonly arg: unknown
  readonly argRaw: string
  readonly bodyLen: number
}

const harness = (route: Route, src: Layer.Layer<SourceFetch>) => {
  const calls: Call[] = []
  const record = (url: string, init?: RequestInit): Response => {
    const endpoint = url.replace('https://content.dropboxapi.com/2/', '')
    const argRaw = ((init?.headers ?? {}) as Record<string, string>)['dropbox-api-arg'] ?? '{}'
    const body = init?.body as Uint8Array | undefined
    calls.push({ endpoint, arg: JSON.parse(argRaw), argRaw, bodyLen: body?.byteLength ?? 0 })
    return route(endpoint, init, body)
  }
  const fetchLayer = Layer.succeed(FetchService, {
    fetch: (url, init) => Effect.sync(() => record(url, init)),
    fetchPromise: (async (url: string | URL, init?: RequestInit) =>
      record(String(url), init)) as typeof fetch,
  })
  const app = DropboxUploaderLive.pipe(Layer.provide(Layer.mergeAll(fetchLayer, src)))
  const rt = ManagedRuntime.make(app)
  return {
    calls,
    upload: (i: UploadInput, accessToken = 'AT') =>
      rt.runPromise(Effect.flatMap(DropboxUploader, (u) => u.upload({ accessToken }, i))),
  }
}

describe('DropboxUploader.upload', () => {
  it('maps a 410 source to sourceGone', async () => {
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(0), { status: 410 })),
    )
    expect((await h.upload(input())).kind).toBe('sourceGone')
  })

  it('small media → single files/upload with an "add" commit', async () => {
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(2048))),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({
      kind: 'success',
      remoteId: 'id:simple',
      remotePath: '/alice/t1_0.mp4',
    })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.endpoint).toBe('files/upload')
    expect((h.calls[0]!.arg as { path: string; mode: string }).path).toBe('/alice/t1_0.mp4')
    expect((h.calls[0]!.arg as { mode: string }).mode).toBe('add')
  })

  it('large/unknown media → session start → append(s) → finish in order', async () => {
    const h = harness(
      dropboxRoute,
      sourceStub(() =>
        sourceResponse(new Uint8Array(20 * 1024 * 1024).fill(3), { contentLength: null }),
      ),
    )
    const out = await h.upload(input('alice/big.mp4'))
    expect(out).toMatchObject({ kind: 'success', remoteId: 'id:session' })
    const endpoints = h.calls.map((c) => c.endpoint)
    expect(endpoints[0]).toBe('files/upload_session/start')
    expect(endpoints.at(-1)).toBe('files/upload_session/finish')
    expect(
      endpoints.filter((e) => e === 'files/upload_session/append_v2').length,
    ).toBeGreaterThanOrEqual(1)
    const finish = h.calls.at(-1)!
    expect((finish.arg as { cursor: { offset: number } }).cursor.offset).toBe(
      20 * 1024 * 1024 - finish.bodyLen,
    )
  })

  it('escapes non-ASCII path chars in the Dropbox-API-Arg header', async () => {
    const h = harness(
      routeMetaX,
      sourceStub(() => sourceResponse(new Uint8Array(8))),
    )
    await h.upload(input('日本/t1.mp4'))
    const header = h.calls[0]!.argRaw
    expect([...header].every((ch) => ch.charCodeAt(0) <= 127)).toBe(true) // pure ASCII
    expect(header).toContain('\\u')
  })

  it('empty source → failure', async () => {
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(0), { contentLength: 0 })),
    )
    expect((await h.upload(input())).kind).toBe('failure')
  })

  it('a small unknown-size source uses a single-chunk session (start close → finish empty)', async () => {
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(1024), { contentLength: null })),
    )
    const out = await h.upload(input('alice/small.mp4'))
    expect(out).toMatchObject({ kind: 'success', remoteId: 'id:session' })
    expect(h.calls.map((c) => c.endpoint)).toEqual([
      'files/upload_session/start',
      'files/upload_session/finish',
    ])
    expect((h.calls[0]!.arg as { close: boolean }).close).toBe(true)
    expect(h.calls[0]!.bodyLen).toBe(1024)
    expect(h.calls[1]!.bodyLen).toBe(0)
    expect((h.calls[1]!.arg as { cursor: { offset: number } }).cursor.offset).toBe(1024)
  })

  it('simple-upload HTTP error → failure (never throws)', async () => {
    const h = harness(
      routeSimple401,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({ kind: 'failure' })
    expect((out as { reason: string }).reason).toMatch(/dropbox HTTP 401/)
  })

  it('session start failure → failure', async () => {
    const h = harness(
      routeSessionStart500,
      sourceStub(() => sourceResponse(new Uint8Array(20 * 1024 * 1024), { contentLength: null })),
    )
    expect((await h.upload(input('alice/big.mp4'))).kind).toBe('failure')
  })

  it('session append failure → failure', async () => {
    const h = harness(
      routeSessionAppend503,
      sourceStub(() => sourceResponse(new Uint8Array(20 * 1024 * 1024), { contentLength: null })),
    )
    expect((await h.upload(input('alice/big.mp4'))).kind).toBe('failure')
  })

  it('session finish failure → failure', async () => {
    const h = harness(
      routeSessionFinish500,
      sourceStub(() => sourceResponse(new Uint8Array(20 * 1024 * 1024), { contentLength: null })),
    )
    expect((await h.upload(input('alice/big.mp4'))).kind).toBe('failure')
  })

  it('single-chunk session: a finish (commit) error → failure', async () => {
    const h = harness(
      routeSingleChunkFinish500,
      sourceStub(() => sourceResponse(new Uint8Array(1024), { contentLength: null })),
    )
    expect((await h.upload(input('alice/small.mp4'))).kind).toBe('failure')
  })

  it('session success falls back to byte count + request path when finish omits size/path/id', async () => {
    const h = harness(
      routeSessionEmptyMeta,
      sourceStub(() => sourceResponse(new Uint8Array(1024), { contentLength: null })),
    )
    const out = await h.upload(input('alice/small.mp4'))
    expect(out).toMatchObject({ kind: 'success', bytes: 1024, remotePath: '/alice/small.mp4' })
    expect((out as { remoteId?: string }).remoteId).toBeUndefined()
  })

  it("errText falls back to '' when the error body read itself fails", async () => {
    const h = harness(
      routeErrTextRejects,
      sourceStub(() => sourceResponse(new Uint8Array(32))),
    )
    expect(await h.upload(input())).toMatchObject({ kind: 'failure', reason: 'dropbox HTTP 500' })
  })

  it('falls back to local byte count + request path when metadata omits size/path', async () => {
    const h = harness(
      routeEmptyMeta,
      sourceStub(() => sourceResponse(new Uint8Array(2048))),
    )
    const out = await h.upload(input('alice/t1_0.mp4'))
    expect(out).toMatchObject({ kind: 'success', bytes: 2048, remotePath: '/alice/t1_0.mp4' })
    expect((out as { remoteId?: string }).remoteId).toBeUndefined()
  })
})

describe('DropboxUploader — empty-body edges', () => {
  it('declared non-zero length but empty simple body → failure', async () => {
    const h = harness(
      dropboxRoute,
      Layer.succeed(SourceFetch, {
        fetch: () =>
          Effect.succeed(
            new Response(emptyStream(), {
              status: 200,
              headers: { 'content-type': 'video/mp4', 'content-length': '7' },
            }),
          ),
      }),
    )
    expect(await h.upload(input())).toMatchObject({ kind: 'failure', reason: 'empty source' })
  })

  it('empty stream with unknown size → session yields zero bytes → failure', async () => {
    const h = harness(
      dropboxRoute,
      Layer.succeed(SourceFetch, {
        fetch: () =>
          Effect.succeed(
            new Response(emptyStream(), { status: 200, headers: { 'content-type': 'video/mp4' } }),
          ),
      }),
    )
    expect(await h.upload(input())).toMatchObject({ kind: 'failure', reason: 'empty source' })
  })
})

// A non-CloudHttpError thrown inside the single files/upload rpc (dropped socket).
const routeUploadThrows: Route = (endpoint) => {
  if (endpoint === 'files/upload') throw new Error('socket dropped')
  return new Response('unexpected', { status: 500 })
}
// A non-CloudHttpError thrown inside the streamed session loop (dropped socket).
const routeSessionThrows: Route = (endpoint) => {
  if (endpoint.endsWith('upload_session/start')) throw new Error('socket dropped')
  return new Response('unexpected', { status: 500 })
}

describe('DropboxUploader — transport edge branches', () => {
  it('small media: a transport throw becomes a status-0 failure', async () => {
    const h = harness(
      routeUploadThrows,
      sourceStub(() => sourceResponse(new Uint8Array(2048))),
    )
    expect((await h.upload(input())).kind).toBe('failure')
  })

  it('session: a transport throw mid-stream becomes a status-0 failure', async () => {
    const h = harness(
      routeSessionThrows,
      sourceStub(() =>
        sourceResponse(new Uint8Array(20 * 1024 * 1024).fill(3), { contentLength: null }),
      ),
    )
    expect((await h.upload(input('alice/big.mp4'))).kind).toBe('failure')
  })
})
