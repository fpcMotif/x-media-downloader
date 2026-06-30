import { describe, it, expect } from 'vitest'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { DriveUploader, DriveUploaderLive, type DriveArgs } from './drive'
import { FetchService } from '../fetch-service'
import { SourceFetch } from './source-fetch'
import { FolderCacheLive } from './folder-cache'
import type { UploadInput } from './types'

const input = (path = 'alice/t1_0.jpg'): UploadInput => ({
  url: 'https://pbs.twimg.com/media/x.jpg',
  target: { path, handle: 'alice', filename: path.split('/').pop()!, contentType: 'image/jpeg' },
})

const sourceResponse = (
  bytes: Uint8Array<ArrayBuffer>,
  opts: { status?: number; contentLength?: number | null; contentType?: string } = {},
): Response => {
  const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'image/jpeg' }
  if (opts.contentLength !== null)
    headers['content-length'] = String(opts.contentLength ?? bytes.length)
  return new Response(opts.status && opts.status >= 400 ? null : bytes, {
    status: opts.status ?? 200,
    headers,
  })
}

/** A stream that closes with no data — a non-null but empty body. */
const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.close()
    },
  })

const sourceStub = (make: () => Response): Layer.Layer<SourceFetch> =>
  Layer.succeed(SourceFetch, { fetch: () => Effect.succeed(make()) })

type Route = (url: string, init?: RequestInit) => Response

const isGet = (init?: RequestInit): boolean => (init?.method ?? 'GET') === 'GET'
const filesFound = (id: string): Response =>
  new Response(JSON.stringify({ files: [{ id }] }), { status: 200 })
const folderResolved: Route = (url, init) =>
  url.includes('/drive/v3/files?') && isGet(init)
    ? filesFound('folder')
    : new Response('x', { status: 500 })

/** The standard Drive REST router (folders + multipart + resumable). */
const driveRoute: Route = (url, init) => {
  if (url.includes('uploadType=multipart'))
    return new Response(JSON.stringify({ id: 'file-mp' }), { status: 200 })
  if (url.includes('uploadType=resumable'))
    return new Response(null, { status: 200, headers: { location: 'https://session.example/put' } })
  if (url === 'https://session.example/put')
    return new Response(JSON.stringify({ id: 'file-rs' }), { status: 200 })
  if (url.includes('/drive/v3/files?') && isGet(init))
    return new Response(JSON.stringify({ files: [] }), { status: 200 })
  if (url.includes('/drive/v3/files?'))
    return new Response(JSON.stringify({ id: 'folder-1' }), { status: 200 })
  return new Response('unexpected', { status: 500 })
}

// Per-scenario routers (module scope: they capture no test state).
const routeRootFound: Route = () => filesFound('root-id')
const routeFolderX: Route = () => filesFound('x')
const routeFolderExisting: Route = () => filesFound('existing')
const routeFolderCreateFails: Route = (url, init) =>
  isGet(init)
    ? new Response(JSON.stringify({ files: [] }), { status: 200 })
    : new Response('boom', { status: 500 })
const routeMultipart403: Route = (url, init) =>
  url.includes('uploadType=multipart')
    ? new Response('denied', { status: 403 })
    : folderResolved(url, init)
const routeNoSessionUrl: Route = (url, init) =>
  url.includes('uploadType=resumable')
    ? new Response(null, { status: 200 })
    : folderResolved(url, init)
const routeInitiate500: Route = (url, init) =>
  url.includes('uploadType=resumable')
    ? new Response('no', { status: 500 })
    : folderResolved(url, init)
const routeFinalPutNoId: Route = (url, init) => {
  if (url.includes('uploadType=resumable'))
    return new Response(null, { status: 200, headers: { location: 'https://s/put' } })
  if (url === 'https://s/put') return new Response(JSON.stringify({}), { status: 200 })
  return folderResolved(url, init)
}
const routeFinalPut410: Route = (url, init) => {
  if (url.includes('uploadType=resumable'))
    return new Response(null, { status: 200, headers: { location: 'https://s/put' } })
  if (url === 'https://s/put') return new Response('bad', { status: 410 })
  return folderResolved(url, init)
}
const routeMidChunk500: Route = (url, init) => {
  if (url.includes('uploadType=resumable'))
    return new Response(null, { status: 200, headers: { location: 'https://s/put' } })
  if (url === 'https://s/put') {
    const range = ((init?.headers ?? {}) as Record<string, string>)['content-range'] ?? ''
    return range.endsWith('/*')
      ? new Response('mid-fail', { status: 500 })
      : new Response(JSON.stringify({ id: 'x' }), { status: 200 })
  }
  return folderResolved(url, init)
}
const routeErrTextRejects: Route = (url, init) =>
  isGet(init)
    ? new Response(JSON.stringify({ files: [] }), { status: 200 })
    : // POST (folder create) errors AND its body read rejects (dropped connection)
      ({
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error('read failed')),
        headers: new Headers(),
      } as unknown as Response)

interface Call {
  readonly url: string
  readonly method: string
}

const harness = (route: Route, src: Layer.Layer<SourceFetch>) => {
  const calls: Call[] = []
  const record = (url: string, init?: RequestInit): Response => {
    calls.push({ url, method: init?.method ?? 'GET' })
    return route(url, init)
  }
  const fetchLayer = Layer.succeed(FetchService, {
    fetch: (url, init) => Effect.sync(() => record(url, init)),
    fetchPromise: (async (url: string | URL, init?: RequestInit) =>
      record(String(url), init)) as typeof fetch,
  })
  const app = DriveUploaderLive.pipe(
    Layer.provide(Layer.mergeAll(fetchLayer, src, FolderCacheLive)),
  )
  const rt = ManagedRuntime.make(app)
  const DEFAULT_ARGS: DriveArgs = { accessToken: 'AT', rootFolderId: 'root-1' }
  return {
    calls,
    upload: (i: UploadInput, args: DriveArgs = DEFAULT_ARGS) =>
      rt.runPromise(Effect.flatMap(DriveUploader, (u) => u.upload(args, i))),
    ensureRoot: (token = 'AT') =>
      rt.runPromise(Effect.flatMap(DriveUploader, (u) => u.ensureRoot(token))),
  }
}

const folderCreates = (calls: Call[]): Call[] =>
  calls.filter(
    (c) => c.url.includes('/drive/v3/files?') && !c.url.includes('/upload/') && c.method === 'POST',
  )

describe('DriveUploader.upload', () => {
  it('maps a 403 source to sourceGone (link-rot), not a failure', async () => {
    const h = harness(
      driveRoute,
      sourceStub(() => sourceResponse(new Uint8Array(0), { status: 403 })),
    )
    expect((await h.upload(input())).kind).toBe('sourceGone')
  })

  it('maps a 500 source to a (retryable) failure', async () => {
    const h = harness(
      driveRoute,
      sourceStub(() => sourceResponse(new Uint8Array(0), { status: 500 })),
    )
    expect((await h.upload(input())).kind).toBe('failure')
  })

  it('small media → one multipart request, returns the file id', async () => {
    const h = harness(
      driveRoute,
      sourceStub(() => sourceResponse(new Uint8Array(1024).fill(7))),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({
      kind: 'success',
      bytes: 1024,
      remoteId: 'file-mp',
      remotePath: 'alice/t1_0.jpg',
    })
    expect(h.calls.some((c) => c.url.includes('uploadType=multipart'))).toBe(true)
    expect(h.calls.some((c) => c.url.includes('uploadType=resumable'))).toBe(false)
  })

  it('unknown/large media → resumable session, returns the file id', async () => {
    const h = harness(
      driveRoute,
      sourceStub(() => sourceResponse(new Uint8Array(300).fill(9), { contentLength: null })),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({ kind: 'success', bytes: 300, remoteId: 'file-rs' })
    expect(h.calls.filter((c) => c.url === 'https://session.example/put')).toHaveLength(1)
  })

  it('empty source → failure (never a fake save)', async () => {
    const h = harness(
      driveRoute,
      sourceStub(() => sourceResponse(new Uint8Array(0), { contentLength: 0 })),
    )
    expect((await h.upload(input())).kind).toBe('failure')
  })

  it('caches the per-handle subfolder across uploads (one runtime = one Ref)', async () => {
    const h = harness(
      driveRoute,
      sourceStub(() => sourceResponse(new Uint8Array(16))),
    )
    await h.upload(input())
    await h.upload(input('alice/t2_0.jpg'))
    expect(folderCreates(h.calls).length).toBe(1) // alice resolved once, then a Ref hit
  })
})

describe('DriveUploader.ensureRoot', () => {
  it('resolves a top-level folder (no parent constraint in the query)', async () => {
    const h = harness(
      routeRootFound,
      sourceStub(() => sourceResponse(new Uint8Array(1))),
    )
    expect(await h.ensureRoot()).toBe('root-id')
    const q = decodeURIComponent(new URL(h.calls[0]!.url).searchParams.get('q') ?? '')
    expect(q).not.toContain('in parents') // null parent → no parent clause
  })

  it('escapes single-quotes and backslashes in the folder name (q= injection guard)', async () => {
    const h = harness(
      routeFolderX,
      sourceStub(() => sourceResponse(new Uint8Array(16))),
    )
    await h.upload({
      url: 'https://pbs.twimg.com/media/x.jpg',
      target: {
        path: "a'b\\c/f.jpg",
        handle: "a'b\\c",
        filename: 'f.jpg',
        contentType: 'image/jpeg',
      },
    })
    const q = decodeURIComponent(new URL(h.calls[0]!.url).searchParams.get('q') ?? '')
    expect(q).toContain("name='a\\'b\\\\c'")
  })

  it('reuses an existing folder instead of creating a duplicate', async () => {
    const h = harness(
      routeFolderExisting,
      sourceStub(() => sourceResponse(new Uint8Array(16))),
    )
    await h.upload(input())
    expect(folderCreates(h.calls).length).toBe(0)
  })
})

describe('DriveUploader — error & resumable edge paths', () => {
  it('maps a folder-resolution failure to an upload failure (never throws)', async () => {
    const h = harness(
      routeFolderCreateFails,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({ kind: 'failure' })
    expect((out as { reason: string }).reason).toMatch(/drive HTTP 500/)
  })

  it('multipart upload failure → failure outcome', async () => {
    const h = harness(
      routeMultipart403,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
    )
    expect((await h.upload(input())).kind).toBe('failure')
  })

  it('resumable initiate without a session url → failure', async () => {
    const h = harness(
      routeNoSessionUrl,
      sourceStub(() => sourceResponse(new Uint8Array(64), { contentLength: null })),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({ kind: 'failure' })
    expect((out as { reason: string }).reason).toMatch(/session url/)
  })

  it('resumable initiate failure → failure', async () => {
    const h = harness(
      routeInitiate500,
      sourceStub(() => sourceResponse(new Uint8Array(64), { contentLength: null })),
    )
    expect((await h.upload(input())).kind).toBe('failure')
  })

  it('resumable: final PUT returning no id → failure', async () => {
    const h = harness(
      routeFinalPutNoId,
      sourceStub(() => sourceResponse(new Uint8Array(64), { contentLength: null })),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({ kind: 'failure' })
    expect((out as { reason: string }).reason).toMatch(/file id/)
  })

  it('resumable: final PUT error status → failure', async () => {
    const h = harness(
      routeFinalPut410,
      sourceStub(() => sourceResponse(new Uint8Array(64), { contentLength: null })),
    )
    expect((await h.upload(input())).kind).toBe('failure')
  })

  it('resumable multi-chunk: 308 on non-final chunk then 200 on the last', async () => {
    const puts: string[] = []
    // Captures `puts` (test-local), so it legitimately lives here, not at module scope.
    const route: Route = (url, init) => {
      if (url.includes('uploadType=resumable'))
        return new Response(null, { status: 200, headers: { location: 'https://s/put' } })
      if (url === 'https://s/put') {
        const range = ((init?.headers ?? {}) as Record<string, string>)['content-range'] ?? ''
        puts.push(range)
        return range.endsWith('/*')
          ? new Response(null, { status: 308 })
          : new Response(JSON.stringify({ id: 'big-file' }), { status: 200 })
      }
      return folderResolved(url, init)
    }
    // 9 MiB, known size > SIMPLE_MAX_BYTES → resumable in 8 MiB chunks (8 MiB + 1 MiB).
    const h = harness(
      route,
      sourceStub(() => sourceResponse(new Uint8Array(9 * 1024 * 1024))),
    )
    const out = await h.upload(input('alice/big.mp4'))
    expect(out).toMatchObject({ kind: 'success', remoteId: 'big-file', bytes: 9 * 1024 * 1024 })
    expect(puts.length).toBe(2)
    expect(puts[0]!.endsWith('/*')).toBe(true) // non-final
  })

  it('resumable: a 500 on a non-final chunk → failure', async () => {
    const h = harness(
      routeMidChunk500,
      sourceStub(() => sourceResponse(new Uint8Array(9 * 1024 * 1024))),
    )
    expect((await h.upload(input('alice/big.mp4'))).kind).toBe('failure')
  })

  it('empty stream with unknown size → resumable yields zero bytes → failure', async () => {
    const h = harness(
      driveRoute,
      Layer.succeed(SourceFetch, {
        fetch: () =>
          Effect.succeed(
            new Response(emptyStream(), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
          ),
      }),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({ kind: 'failure', reason: 'empty source' })
    expect(h.calls.find((c) => c.url === 'https://session.example/put')).toBeDefined()
  })

  it('declared non-zero length but empty multipart body → failure', async () => {
    const h = harness(
      driveRoute,
      Layer.succeed(SourceFetch, {
        fetch: () =>
          Effect.succeed(
            new Response(emptyStream(), {
              status: 200,
              headers: { 'content-type': 'image/jpeg', 'content-length': '5' },
            }),
          ),
      }),
    )
    expect(await h.upload(input())).toMatchObject({ kind: 'failure', reason: 'empty source' })
  })

  it("errText falls back to '' when the error body read itself fails", async () => {
    const h = harness(
      routeErrTextRejects,
      sourceStub(() => sourceResponse(new Uint8Array(32))),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({ kind: 'failure' })
    expect((out as { reason: string }).reason).toBe('drive HTTP 500') // body '' ⇒ no `: <body>` suffix
  })
})
