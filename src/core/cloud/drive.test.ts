import { describe, it, expect, vi } from 'vitest'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { DriveUploader, DriveUploaderLive, type DriveArgs } from './drive'
import { FetchService } from '../fetch-service'
import { SourceFetch } from './source-fetch'
import { FolderCacheLive } from './folder-cache'
import type { UploadInput } from './types'

const input = (path = 'alice/t1_0.jpg', folder = 'alice'): UploadInput => ({
  url: 'https://pbs.twimg.com/media/x.jpg',
  target: { path, folder, filename: path.split('/').pop()!, contentType: 'image/jpeg' },
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

const statusOnlyResponse = (
  status: number,
  cancel: () => Promise<void>,
  headers: HeadersInit = {},
): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    body: { cancel },
  }) as unknown as Response

const isGet = (init?: RequestInit): boolean => (init?.method ?? 'GET') === 'GET'
const filesFound = (id: string): Response =>
  new Response(JSON.stringify({ files: [{ id }] }), { status: 200 })
const isFolderLookup = (url: string): boolean =>
  (new URL(url).searchParams.get('q') ?? '').includes(
    "mimeType='application/vnd.google-apps.folder'",
  )
const folderResolved: Route = (url, init) =>
  url.includes('/drive/v3/files?') && isGet(init)
    ? isFolderLookup(url)
      ? filesFound('folder')
      : new Response(JSON.stringify({ files: [] }), { status: 200 })
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
const routeRootId: Route = () => new Response(JSON.stringify({ id: 'root-id' }), { status: 200 })
const routeRootFails: Route = () => new Response('down', { status: 500 })
const routeRootNoId: Route = () => new Response(JSON.stringify({}), { status: 200 })
const routeFolderX: Route = (url) =>
  isFolderLookup(url)
    ? filesFound('x')
    : new Response(JSON.stringify({ files: [] }), { status: 200 })
const routeFolderExisting: Route = (url) =>
  isFolderLookup(url)
    ? filesFound('existing')
    : new Response(JSON.stringify({ files: [] }), { status: 200 })
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

const harness = (
  route: Route,
  src: Layer.Layer<SourceFetch>,
  options: { readonly routeProbe?: boolean } = {},
) => {
  const calls: Call[] = []
  const record = (url: string, init?: RequestInit): Response => {
    calls.push({ url, method: init?.method ?? 'GET' })
    if (!options.routeProbe && /\/drive\/v3\/files\/[^/?]+\?fields=id,size,trashed$/u.test(url))
      return new Response('', { status: 404 })
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
    upload: (i: UploadInput, args: DriveArgs = DEFAULT_ARGS, fileId = 'file-mp') =>
      rt.runPromise(Effect.flatMap(DriveUploader, (u) => u.advance(args, i, fileId))),
    generateFileId: (token = 'AT') =>
      rt.runPromise(Effect.flatMap(DriveUploader, (u) => u.generateFileId(token))),
    ensureRoot: (token = 'AT') =>
      rt.runPromise(Effect.flatMap(DriveUploader, (u) => u.ensureRoot(token))),
  }
}

const folderCreates = (calls: Call[]): Call[] =>
  calls.filter(
    (c) => c.url.includes('/drive/v3/files?') && !c.url.includes('/upload/') && c.method === 'POST',
  )

describe('DriveUploader.advance', () => {
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
    const out = await h.upload(input(), undefined, 'file-rs')
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

  it('caches the destination folder across uploads (one runtime = one Ref)', async () => {
    const h = harness(
      driveRoute,
      sourceStub(() => sourceResponse(new Uint8Array(16))),
    )
    await h.upload(input())
    await h.upload(input('alice/t2_0.jpg'))
    expect(folderCreates(h.calls).length).toBe(1) // folder resolved once, then a Ref hit
  })

  it('scopes the folder cache to the resolved Drive root', async () => {
    const h = harness(
      driveRoute,
      sourceStub(() => sourceResponse(new Uint8Array(16))),
    )
    await h.upload(input(), { accessToken: 'old-token', rootFolderId: 'old-root' })
    await h.upload(input('alice/t2_0.jpg'), {
      accessToken: 'new-token',
      rootFolderId: 'new-root',
    })
    expect(folderCreates(h.calls)).toHaveLength(2)
  })
})

describe('DriveUploader — durable id reconciliation', () => {
  it('generates one file id for the caller to persist', async () => {
    const h = harness(
      (url) =>
        url.includes('/generateIds')
          ? new Response(JSON.stringify({ ids: ['generated-id'] }), { status: 200 })
          : new Response('unexpected', { status: 500 }),
      sourceStub(() => sourceResponse(new Uint8Array(1))),
    )
    expect(await h.generateFileId()).toBe('generated-id')
  })

  it.each([
    ['missing', { ids: [] }],
    ['wrongly typed', { ids: [42] }],
    ['oversized', { ids: ['x'.repeat(4_097)] }],
  ])('rejects a %s generated Drive id', async (_case, body) => {
    const h = harness(
      (url) =>
        url.includes('/generateIds')
          ? new Response(JSON.stringify(body), { status: 200 })
          : new Response('unexpected', { status: 500 }),
      sourceStub(() => sourceResponse(new Uint8Array(1))),
    )
    await expect(h.generateFileId()).rejects.toThrow('Drive generated id must be bounded text')
  })

  it.each([
    ['missing id', { size: '8', trashed: false }],
    ['wrong size type', { id: 'existing-id', size: 8, trashed: false }],
    ['wrong trashed type', { id: 'existing-id', size: '8', trashed: 'false' }],
    ['oversized id', { id: 'x'.repeat(4_097), size: '8', trashed: false }],
  ])('fails closed on a %s Drive proof without another create', async (_case, proof) => {
    const fetchSource = vi.fn<(url: string) => Effect.Effect<Response>>(() =>
      Effect.succeed(sourceResponse(new Uint8Array(8))),
    )
    const h = harness(
      (url) =>
        url.includes('/drive/v3/files/existing-id?')
          ? new Response(JSON.stringify(proof), { status: 200 })
          : new Response('unexpected', { status: 500 }),
      Layer.succeed(SourceFetch, { fetch: fetchSource }),
      { routeProbe: true },
    )
    expect(await h.upload(input(), undefined, 'existing-id')).toMatchObject({ kind: 'failure' })
    expect(fetchSource).not.toHaveBeenCalled()
    expect(h.calls.some((call) => call.url.includes('uploadType='))).toBe(false)
  })

  it('bounds a malformed Drive error body', async () => {
    const h = harness(
      () => new Response('x'.repeat(20_000), { status: 500 }),
      sourceStub(() => sourceResponse(new Uint8Array(8))),
    )
    const out = await h.upload(input(), undefined, 'existing-id')
    expect(out).toMatchObject({ kind: 'failure', status: 500 })
    expect((out as { reason: string }).reason).toHaveLength('drive HTTP 500: '.length + 200)
  })

  it('settles from GET proof without fetching or creating bytes', async () => {
    const fetchSource = vi.fn<(url: string) => Effect.Effect<Response>>(() =>
      Effect.succeed(sourceResponse(new Uint8Array(8))),
    )
    const h = harness(
      (url) =>
        url.includes('/drive/v3/files/existing-id?')
          ? new Response(
              JSON.stringify({
                id: 'existing-id',
                size: '12',
                trashed: false,
                name: 't1_0.jpg',
                parents: ['folder'],
              }),
              { status: 200 },
            )
          : url.includes('/drive/v3/files?')
            ? filesFound('folder')
            : new Response('unexpected', { status: 500 }),
      Layer.succeed(SourceFetch, { fetch: fetchSource }),
      { routeProbe: true },
    )
    expect(await h.upload(input(), undefined, 'existing-id')).toMatchObject({
      kind: 'success',
      bytes: 12,
      remoteId: 'existing-id',
    })
    expect(fetchSource).not.toHaveBeenCalled()
    expect(h.calls.some((call) => call.url.includes('uploadType='))).toBe(false)
  })

  it('sends the persisted id in multipart and resumable create metadata', async () => {
    let multipart = ''
    let resumable = ''
    const route: Route = (url, init) => {
      if (url.includes('uploadType=multipart')) {
        multipart = new TextDecoder().decode(init?.body as Uint8Array)
        return new Response(JSON.stringify({ id: 'persisted-id' }), { status: 200 })
      }
      if (url.includes('uploadType=resumable')) {
        resumable = String(init?.body)
        return new Response(null, {
          status: 200,
          headers: { location: 'https://persisted.example/put' },
        })
      }
      if (url === 'https://persisted.example/put')
        return new Response(JSON.stringify({ id: 'persisted-id' }), { status: 200 })
      if (url.includes('/drive/v3/files?'))
        return new Response(JSON.stringify({ files: [] }), { status: 200 })
      return new Response('unexpected', { status: 500 })
    }
    const small = harness(
      route,
      sourceStub(() => sourceResponse(new Uint8Array(8))),
    )
    await small.upload(input('pic.jpg', ''), undefined, 'persisted-id')
    const large = harness(
      route,
      sourceStub(() => sourceResponse(new Uint8Array(8), { contentLength: null })),
    )
    await large.upload(input('pic.jpg', ''), undefined, 'persisted-id')
    expect(multipart).toContain('"id":"persisted-id"')
    expect(resumable).toContain('"id":"persisted-id"')
  })

  it('accepts a 409 only after GET proves the same generated id', async () => {
    let probes = 0
    let creates = 0
    const h = harness(
      (url) => {
        if (url.includes('/drive/v3/files/proven-id?')) {
          probes += 1
          return probes === 1
            ? new Response('', { status: 404 })
            : new Response(
                JSON.stringify({
                  id: 'proven-id',
                  size: '64',
                  trashed: false,
                  name: 'pic.jpg',
                  parents: ['root-1'],
                }),
                { status: 200 },
              )
        }
        if (url.includes('uploadType=multipart')) {
          creates += 1
          return new Response('already exists', { status: 409 })
        }
        if (url.includes('/drive/v3/files?'))
          return new Response(JSON.stringify({ files: [] }), { status: 200 })
        return new Response('unexpected', { status: 500 })
      },
      sourceStub(() => sourceResponse(new Uint8Array(64))),
      { routeProbe: true },
    )
    expect(await h.upload(input('pic.jpg', ''), undefined, 'proven-id')).toMatchObject({
      kind: 'success',
      remoteId: 'proven-id',
      bytes: 64,
    })
    expect({ probes, creates }).toEqual({ probes: 2, creates: 1 })
  })

  it('keeps a 409 as failure when GET cannot prove the id', async () => {
    const h = harness(
      (url) => {
        if (url.includes('/drive/v3/files/unproven-id?')) return new Response('', { status: 404 })
        if (url.includes('uploadType=multipart'))
          return new Response('already exists', { status: 409 })
        if (url.includes('/drive/v3/files?'))
          return new Response(JSON.stringify({ files: [] }), { status: 200 })
        return new Response('unexpected', { status: 500 })
      },
      sourceStub(() => sourceResponse(new Uint8Array(64))),
      { routeProbe: true },
    )
    expect(await h.upload(input('pic.jpg', ''), undefined, 'unproven-id')).toMatchObject({
      kind: 'failure',
      status: 409,
    })
  })

  it('honors a user rename or move once the generated id proves the file', async () => {
    const fetchSource = vi.fn<(url: string) => Effect.Effect<Response>>(() =>
      Effect.succeed(sourceResponse(new Uint8Array(8))),
    )
    const h = harness(
      (url) =>
        url.includes('/drive/v3/files/moved-id?')
          ? new Response(
              JSON.stringify({
                id: 'moved-id',
                size: '8',
                trashed: false,
                name: 'renamed.jpg',
                parents: ['other-folder'],
              }),
              { status: 200 },
            )
          : url.includes('/drive/v3/files?')
            ? filesFound('folder')
            : new Response('unexpected', { status: 500 }),
      Layer.succeed(SourceFetch, { fetch: fetchSource }),
      { routeProbe: true },
    )

    expect(await h.upload(input(), undefined, 'moved-id')).toMatchObject({
      kind: 'success',
      remoteId: 'moved-id',
      remotePath: 'alice/t1_0.jpg',
      bytes: 8,
    })
    expect(fetchSource).not.toHaveBeenCalled()
  })

  it('rejects a second job for the same target before fetching or creating bytes', async () => {
    let targetExists = false
    let creates = 0
    const fetchSource = vi.fn<(url: string) => Effect.Effect<Response>>(() =>
      Effect.succeed(sourceResponse(new Uint8Array(8))),
    )
    const h = harness(
      (url) => {
        if (isFolderLookup(url)) return filesFound('folder')
        if (url.includes('uploadType=multipart')) {
          creates += 1
          targetExists = true
          return new Response(JSON.stringify({ id: 'first-id' }), { status: 200 })
        }
        if (url.includes('/drive/v3/files?'))
          return targetExists
            ? filesFound('first-id')
            : new Response(JSON.stringify({ files: [] }), { status: 200 })
        return new Response('unexpected', { status: 500 })
      },
      Layer.succeed(SourceFetch, { fetch: fetchSource }),
    )

    expect(await h.upload(input(), undefined, 'first-id')).toMatchObject({
      kind: 'success',
      remoteId: 'first-id',
    })
    expect(await h.upload(input(), undefined, 'second-id')).toMatchObject({
      kind: 'failure',
      status: 409,
      reason: expect.stringContaining('refusing to create a duplicate'),
    })
    expect(fetchSource).toHaveBeenCalledTimes(1)
    expect(creates).toBe(1)
  })
})

describe('DriveUploader.ensureRoot', () => {
  it('resolves the My Drive root folder id', async () => {
    const h = harness(
      routeRootId,
      sourceStub(() => sourceResponse(new Uint8Array(1))),
    )
    expect(await h.ensureRoot()).toBe('root-id')
    expect(h.calls[0]!.url).toContain('/drive/v3/files/root?fields=id')
  })

  it('fails when the root lookup is not ok', async () => {
    const h = harness(
      routeRootFails,
      sourceStub(() => sourceResponse(new Uint8Array(1))),
    )
    await expect(h.ensureRoot()).rejects.toThrow('drive HTTP 500')
  })

  it('dies when the root lookup returns no id', async () => {
    const h = harness(
      routeRootNoId,
      sourceStub(() => sourceResponse(new Uint8Array(1))),
    )
    await expect(h.ensureRoot()).rejects.toThrow('root resolve returned no id')
  })
})

describe('DriveUploader — destination folder resolution', () => {
  it('escapes single-quotes and backslashes in the folder name (q= injection guard)', async () => {
    const h = harness(
      routeFolderX,
      sourceStub(() => sourceResponse(new Uint8Array(16))),
    )
    await h.upload({
      url: 'https://pbs.twimg.com/media/x.jpg',
      target: {
        path: "a'b\\c/f.jpg",
        folder: "a'b\\c",
        filename: 'f.jpg',
        contentType: 'image/jpeg',
      },
    })
    const listCall = h.calls.find((call) => call.url.includes('?q='))
    const q = decodeURIComponent(new URL(listCall!.url).searchParams.get('q') ?? '')
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

  it('uploads to the root when the target folder is empty (no subfolder created)', async () => {
    const h = harness(
      driveRoute,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
    )
    const out = await h.upload(input('pic.jpg', ''))
    expect(out).toMatchObject({ kind: 'success', remotePath: 'pic.jpg' })
    expect(folderCreates(h.calls).length).toBe(0) // folder==='' → parent is the root id
  })

  it('streams to the root when the target folder is empty (unknown size, no subfolder)', async () => {
    const h = harness(
      driveRoute,
      sourceStub(() => sourceResponse(new Uint8Array(300).fill(9), { contentLength: null })),
    )
    const out = await h.upload(input('big.mp4', ''), undefined, 'file-rs')
    expect(out).toMatchObject({ kind: 'success', remoteId: 'file-rs' })
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
    expect((out as { reason: string }).reason).toMatch(/no id/)
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
    const initCancel = vi.fn<() => Promise<void>>(async () => {})
    const chunkCancel = vi.fn<() => Promise<void>>(async () => {})
    // Captures `puts` (test-local), so it legitimately lives here, not at module scope.
    const route: Route = (url, init) => {
      if (url.includes('uploadType=resumable'))
        return statusOnlyResponse(200, initCancel, { location: 'https://s/put' })
      if (url === 'https://s/put') {
        const range = ((init?.headers ?? {}) as Record<string, string>)['content-range'] ?? ''
        puts.push(range)
        return range.endsWith('/*')
          ? statusOnlyResponse(308, chunkCancel)
          : new Response(JSON.stringify({ id: 'big-file' }), { status: 200 })
      }
      return folderResolved(url, init)
    }
    // 9 MiB, known size > SIMPLE_MAX_BYTES → resumable in 8 MiB chunks (8 MiB + 1 MiB).
    const h = harness(
      route,
      sourceStub(() => sourceResponse(new Uint8Array(9 * 1024 * 1024))),
    )
    const out = await h.upload(input('alice/big.mp4'), undefined, 'big-file')
    expect(out).toMatchObject({ kind: 'success', remoteId: 'big-file', bytes: 9 * 1024 * 1024 })
    expect(puts.length).toBe(2)
    expect(puts[0]!.endsWith('/*')).toBe(true) // non-final
    expect(initCancel).toHaveBeenCalledOnce()
    expect(chunkCancel).toHaveBeenCalledOnce()
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
    const out = await h.upload(input(), undefined, 'file-rs')
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

// Folder create returns 200 but no id → Effect.die.
const routeFolderCreateNoId: Route = (url, init) =>
  isGet(init)
    ? new Response(JSON.stringify({ files: [] }), { status: 200 })
    : new Response(JSON.stringify({}), { status: 200 })
// A non-CloudHttpError thrown inside the resumable PUT sink (dropped socket).
const routePutThrows: Route = (url, init) => {
  if (url.includes('uploadType=resumable'))
    return new Response(null, { status: 200, headers: { location: 'https://s/put' } })
  if (url === 'https://s/put') throw new Error('socket dropped')
  return folderResolved(url, init)
}

describe('DriveUploader — folder + transport edge branches', () => {
  it('fails closed on a folder-list error instead of creating a duplicate folder', async () => {
    const route: Route = (_url, init) =>
      isGet(init)
        ? new Response('list unavailable', { status: 500 })
        : new Response(JSON.stringify({ id: 'folder-x' }), { status: 200 })
    const h = harness(
      route,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
    )
    const out = await h.upload(input(), undefined, 'folder-x')
    expect(out).toMatchObject({ kind: 'failure', status: 500 })
    expect(folderCreates(h.calls)).toHaveLength(0)
  })

  it('fails when folder creation returns no id', async () => {
    const h = harness(
      routeFolderCreateNoId,
      sourceStub(() => sourceResponse(new Uint8Array(16))),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({ kind: 'failure' })
    expect((out as { reason: string }).reason).toMatch(/no id/)
  })

  it('resumable: a transport throw mid-PUT becomes a status-0 failure', async () => {
    const h = harness(
      routePutThrows,
      sourceStub(() => sourceResponse(new Uint8Array(300).fill(9), { contentLength: null })),
    )
    expect((await h.upload(input())).kind).toBe('failure')
  })
})
