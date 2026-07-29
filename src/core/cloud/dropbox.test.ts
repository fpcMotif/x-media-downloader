import { describe, it, expect, vi } from 'vitest'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { dropboxStagePath, DropboxUploader, DropboxUploaderLive } from './dropbox'
import { FetchService } from '../fetch-service'
import { SourceFetch } from './source-fetch'
import { idempotencyKeyFor } from './upload-job'
import type { RemoteAttempt, UploadInput } from './types'

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

const statusOnlyResponse = (status: number, cancel: () => Promise<void>): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    body: { cancel },
  }) as unknown as Response

const sessionStarted = (): Response =>
  new Response(JSON.stringify({ session_id: 's' }), { status: 200 })

const HASH = 'a'.repeat(64)
const OWNER_KEY = 'b'.repeat(64)
const metadata = (id: string, size: number, path: string) => ({
  '.tag': 'file',
  id,
  rev: `rev-${id}`,
  content_hash: HASH,
  size,
  path_display: path,
  path_lower: path.toLowerCase(),
})

/** The standard Dropbox content router (single upload + session start/append/finish). */
const dropboxRoute: Route = (endpoint, init, body) => {
  const argRaw = ((init?.headers ?? {}) as Record<string, string>)['dropbox-api-arg'] ?? '{}'
  const arg = JSON.parse(argRaw) as {
    path?: string
    commit?: { path?: string }
  }
  const path = arg.path ?? arg.commit?.path ?? '/missing'
  if (endpoint === 'files/upload')
    return new Response(JSON.stringify(metadata('id:simple', body?.byteLength ?? 0, path)), {
      status: 200,
    })
  if (endpoint === 'files/upload_session/start')
    return new Response(JSON.stringify({ session_id: 'sess-1' }), { status: 200 })
  if (endpoint === 'files/upload_session/append_v2') return new Response('', { status: 200 })
  if (endpoint === 'files/upload_session/finish')
    return new Response(JSON.stringify(metadata('id:session', 999, path)), { status: 200 })
  return new Response('unexpected', { status: 500 })
}

// Per-scenario routers (module scope: they capture no test state).
const routeMetaX: Route = (endpoint, init) => dropboxRoute(endpoint, init, new Uint8Array(1))
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

const harness = (
  route: Route,
  src: Layer.Layer<SourceFetch>,
  options: { readonly controlRoute?: Route } = {},
) => {
  const calls: Call[] = []
  const controlCalls: string[] = []
  const record = (url: string, init?: RequestInit): Response => {
    if (url.startsWith('https://api.dropboxapi.com/2/')) {
      const endpoint = url.replace('https://api.dropboxapi.com/2/', '')
      controlCalls.push(endpoint)
      if (options.controlRoute !== undefined)
        return options.controlRoute(endpoint, init, init?.body as Uint8Array | undefined)
      if (endpoint === 'files/get_metadata')
        return new Response(
          JSON.stringify({
            error_summary: 'path/not_found/...',
            error: { '.tag': 'path', path: { '.tag': 'not_found' } },
          }),
          { status: 409 },
        )
      if (endpoint === 'files/create_folder_v2')
        return new Response(JSON.stringify({ metadata: { '.tag': 'folder' } }), { status: 200 })
      return new Response('unexpected control call', { status: 500 })
    }
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
    controlCalls,
    upload: async (i: UploadInput, accessToken = 'AT', jobId = 'job-1') => {
      const attempt = await rt.runPromise(
        Effect.flatMap(DropboxUploader, (u) => Effect.promise(() => u.prepare(jobId, OWNER_KEY))),
      )
      return await rt.runPromise(
        Effect.flatMap(DropboxUploader, (u) => u.advance({ accessToken }, i, attempt)),
      )
    },
    advance: (attempt: RemoteAttempt, i: UploadInput = input(), accessToken = 'AT') =>
      rt.runPromise(Effect.flatMap(DropboxUploader, (u) => u.advance({ accessToken }, i, attempt))),
  }
}

describe('DropboxUploader.advance — staging', () => {
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
      kind: 'progress',
      attempt: { kind: 'dropbox', phase: 'staged', fileId: 'id:simple' },
    })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.endpoint).toBe('files/upload')
    expect((h.calls[0]!.arg as { path: string; mode: string }).path).toBe(
      await dropboxStagePath('job-1'),
    )
    expect((h.calls[0]!.arg as { mode: string }).mode).toBe('add')
    expect((h.calls[0]!.arg as { autorename: boolean }).autorename).toBe(false)
    expect((h.calls[0]!.arg as { strict_conflict: boolean }).strict_conflict).toBe(false)
  })

  it('large/unknown media discards every status-only append response', async () => {
    const cancel = vi.fn<() => Promise<void>>(async () => {})
    const route: Route = (endpoint, init, body) =>
      endpoint === 'files/upload_session/append_v2'
        ? statusOnlyResponse(200, cancel)
        : dropboxRoute(endpoint, init, body)
    const h = harness(
      route,
      sourceStub(() =>
        sourceResponse(new Uint8Array(20 * 1024 * 1024).fill(3), { contentLength: null }),
      ),
    )
    const out = await h.upload(input('alice/big.mp4'))
    expect(out).toMatchObject({
      kind: 'progress',
      attempt: { phase: 'staged', fileId: 'id:session' },
    })
    const endpoints = h.calls.map((c) => c.endpoint)
    expect(endpoints[0]).toBe('files/upload_session/start')
    expect(endpoints.at(-1)).toBe('files/upload_session/finish')
    expect(
      endpoints.filter((e) => e === 'files/upload_session/append_v2').length,
    ).toBeGreaterThanOrEqual(1)
    expect(cancel).toHaveBeenCalledTimes(
      endpoints.filter((e) => e === 'files/upload_session/append_v2').length,
    )
    const finish = h.calls.at(-1)!
    expect((finish.arg as { cursor: { offset: number } }).cursor.offset).toBe(
      20 * 1024 * 1024 - finish.bodyLen,
    )
  })

  it('derives an ASCII, collision-resistant stage path from the full job id', async () => {
    const first = await dropboxStagePath('日本/job:1')
    const second = await dropboxStagePath('日本/job:2')
    expect(first).not.toBe(second)
    expect([...first].every((ch) => ch.charCodeAt(0) <= 127)).toBe(true)
    expect(first).toMatch(/^\/\.xmd-stage\/v2\/[A-Za-z0-9_-]{43}$/u)
  })

  it('stages a maximum Unicode job id inside Dropbox limits and accepts its own proof', async () => {
    const jobId = idempotencyKeyFor('😀'.repeat(270), 'dropbox')
    const stagePath = await dropboxStagePath(jobId)
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
    )

    expect(stagePath).toHaveLength('/.xmd-stage/v2/'.length + 43)
    expect(await h.upload(input(), 'AT', jobId)).toMatchObject({
      kind: 'progress',
      attempt: { stagePath },
    })
  })

  it('rebinds an uploaded stage after a crash without fetching or uploading bytes again', async () => {
    const stagePath = await dropboxStagePath('job-1')
    const fetchSource = vi.fn<(url: string) => Effect.Effect<Response>>(() =>
      Effect.succeed(sourceResponse(new Uint8Array(64))),
    )
    const h = harness(dropboxRoute, Layer.succeed(SourceFetch, { fetch: fetchSource }), {
      controlRoute: (endpoint) =>
        endpoint === 'files/get_metadata'
          ? new Response(JSON.stringify(metadata('id:recovered', 64, stagePath)), { status: 200 })
          : new Response('unexpected', { status: 500 }),
    })

    expect(await h.upload(input())).toMatchObject({
      kind: 'progress',
      attempt: {
        phase: 'staged',
        fileId: 'id:recovered',
        bytes: 64,
      },
    })
    expect(fetchSource).not.toHaveBeenCalled()
    expect(h.calls).toHaveLength(0)
    expect(h.controlCalls).toEqual(['files/get_metadata'])
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
    expect(out).toMatchObject({
      kind: 'progress',
      attempt: { phase: 'staged', fileId: 'id:session' },
    })
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

  it('rejects a session result without durable metadata proof', async () => {
    const h = harness(
      routeSessionEmptyMeta,
      sourceStub(() => sourceResponse(new Uint8Array(1024), { contentLength: null })),
    )
    const out = await h.upload(input('alice/small.mp4'))
    expect(out).toMatchObject({ kind: 'failure' })
  })

  it("errText falls back to '' when the error body read itself fails", async () => {
    const h = harness(
      routeErrTextRejects,
      sourceStub(() => sourceResponse(new Uint8Array(32))),
    )
    expect(await h.upload(input())).toMatchObject({ kind: 'failure', reason: 'dropbox HTTP 500' })
  })

  it('rejects a simple result without durable metadata proof', async () => {
    const h = harness(
      routeEmptyMeta,
      sourceStub(() => sourceResponse(new Uint8Array(2048))),
    )
    const out = await h.upload(input('alice/t1_0.mp4'))
    expect(out).toMatchObject({ kind: 'failure' })
  })

  it.each([
    ['wrong id type', { id: 1 }],
    ['missing revision', { rev: undefined }],
    ['wrong content hash type', { content_hash: 1 }],
    ['wrong size type', { size: '2048' }],
    ['oversized id', { id: 'x'.repeat(4_097) }],
  ])('fails closed on a simple-upload proof with %s', async (_case, patch) => {
    const route: Route = (endpoint, init, body) => {
      if (endpoint !== 'files/upload') return new Response('unexpected', { status: 500 })
      const arg = JSON.parse(
        String(((init?.headers ?? {}) as Record<string, string>)['dropbox-api-arg']),
      ) as { path: string }
      return new Response(
        JSON.stringify({ ...metadata('id:proof', body?.byteLength ?? 0, arg.path), ...patch }),
        { status: 200 },
      )
    }
    const h = harness(
      route,
      sourceStub(() => sourceResponse(new Uint8Array(2048))),
    )
    expect(await h.upload(input())).toMatchObject({ kind: 'failure' })
    expect(h.controlCalls).not.toContain('files/move_v2')
  })

  it('rejects a malformed upload-session id before append or finish', async () => {
    const h = harness(
      (endpoint) =>
        endpoint === 'files/upload_session/start'
          ? new Response(JSON.stringify({ session_id: 1 }), { status: 200 })
          : new Response('unexpected', { status: 500 }),
      sourceStub(() => sourceResponse(new Uint8Array(1024), { contentLength: null })),
    )
    expect(await h.upload(input('alice/small.mp4'))).toMatchObject({ kind: 'failure' })
    expect(h.calls.map((call) => call.endpoint)).toEqual(['files/upload_session/start'])
  })

  it('bounds a malformed Dropbox error body', async () => {
    const h = harness(
      () => new Response('x'.repeat(20_000), { status: 500 }),
      sourceStub(() => sourceResponse(new Uint8Array(2048))),
    )
    const out = await h.upload(input())
    expect(out).toMatchObject({ kind: 'failure', status: 500 })
    expect((out as { reason: string }).reason).toHaveLength('dropbox HTTP 500: '.length + 200)
  })
})

const RECONCILE_STAGE_PATH = await dropboxStagePath('job-reconcile')

describe('DropboxUploader.advance — stable-id reconcile and move', () => {
  const stagePath = RECONCILE_STAGE_PATH
  const staged: RemoteAttempt = {
    kind: 'dropbox',
    phase: 'staged',
    ownerKey: OWNER_KEY,
    stagePath,
    fileId: 'id:staged',
    rev: 'rev-id:staged',
    contentHash: HASH,
    bytes: 64,
  }

  const proof = (path: string, over: Record<string, unknown> = {}) => ({
    ...metadata('id:staged', 64, path),
    ...over,
  })

  it('settles after a lost move response when GET by id shows the destination', async () => {
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
      {
        controlRoute: (endpoint) =>
          endpoint === 'files/get_metadata'
            ? new Response(JSON.stringify(proof('/alice/t1_0.mp4')), { status: 200 })
            : new Response('unexpected', { status: 500 }),
      },
    )
    expect(await h.advance(staged)).toMatchObject({
      kind: 'success',
      remoteId: 'id:staged',
      remotePath: 'alice/t1_0.mp4',
    })
    expect(h.calls).toHaveLength(0)
    expect(h.controlCalls).toEqual(['files/get_metadata'])
  })

  it('moves the unchanged staged id without overwrite or autorename', async () => {
    let moveArg: Record<string, unknown> | undefined
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
      {
        controlRoute: (endpoint, init) => {
          if (endpoint === 'files/get_metadata')
            return new Response(JSON.stringify(proof(stagePath)), { status: 200 })
          if (endpoint === 'files/create_folder_v2')
            return new Response(JSON.stringify({ metadata: { '.tag': 'folder' } }), {
              status: 200,
            })
          if (endpoint === 'files/move_v2') {
            moveArg = JSON.parse(String(init?.body)) as Record<string, unknown>
            return new Response(JSON.stringify({ metadata: proof('/alice/t1_0.mp4') }), {
              status: 200,
            })
          }
          return new Response('unexpected', { status: 500 })
        },
      },
    )
    expect(await h.advance(staged)).toMatchObject({
      kind: 'success',
      remotePath: 'alice/t1_0.mp4',
    })
    expect(moveArg).toMatchObject({
      from_path: 'id:staged',
      to_path: '/alice/t1_0.mp4',
      autorename: false,
    })
    expect(moveArg).not.toHaveProperty('mode', 'overwrite')
  })

  it('keeps the staged file on destination conflict', async () => {
    let moves = 0
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
      {
        controlRoute: (endpoint) => {
          if (endpoint === 'files/get_metadata')
            return new Response(JSON.stringify(proof(stagePath)), { status: 200 })
          if (endpoint === 'files/create_folder_v2')
            return new Response(JSON.stringify({ metadata: { '.tag': 'folder' } }), {
              status: 200,
            })
          if (endpoint === 'files/move_v2') {
            moves += 1
            return new Response('to/conflict/file', { status: 409 })
          }
          return new Response('unexpected', { status: 500 })
        },
      },
    )
    expect(await h.advance(staged)).toMatchObject({ kind: 'failure', status: 409 })
    expect(moves).toBe(1)
    expect(h.calls).toHaveLength(0)
  })

  it('never moves a staged id whose revision or content proof changed', async () => {
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
      {
        controlRoute: (endpoint) =>
          endpoint === 'files/get_metadata'
            ? new Response(JSON.stringify(proof(stagePath, { content_hash: 'c'.repeat(64) })), {
                status: 200,
              })
            : new Response('move must not run', { status: 500 }),
      },
    )
    expect(await h.advance(staged)).toMatchObject({
      kind: 'failure',
      reason: expect.stringContaining('staged file changed'),
    })
    expect(h.controlCalls).toEqual(['files/get_metadata'])
  })

  it.each([
    ['wrong revision type', { rev: 1 }],
    ['wrong content hash type', { content_hash: 1 }],
    ['wrong size type', { size: '64' }],
  ])('never moves after a staged proof has %s', async (_case, patch) => {
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
      {
        controlRoute: (endpoint) =>
          endpoint === 'files/get_metadata'
            ? new Response(JSON.stringify(proof(stagePath, patch)), { status: 200 })
            : new Response('move must not run', { status: 500 }),
      },
    )
    expect(await h.advance(staged)).toMatchObject({ kind: 'failure' })
    expect(h.controlCalls).toEqual(['files/get_metadata'])
  })

  it('honors a user move by stable id while retaining the logical target path', async () => {
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
      {
        controlRoute: (endpoint) =>
          endpoint === 'files/get_metadata'
            ? new Response(JSON.stringify(proof('/archive/user-name.mp4')), { status: 200 })
            : new Response('move must not run', { status: 500 }),
      },
    )
    expect(await h.advance(staged)).toMatchObject({
      kind: 'success',
      remotePath: 'alice/t1_0.mp4',
    })
    expect(h.controlCalls).toEqual(['files/get_metadata'])
  })

  it('accepts the 1024-character logical path after Dropbox adds its slash', async () => {
    const logicalPath = 'x'.repeat(1024)
    const h = harness(
      dropboxRoute,
      sourceStub(() => sourceResponse(new Uint8Array(64))),
      {
        controlRoute: (endpoint) =>
          endpoint === 'files/get_metadata'
            ? new Response(JSON.stringify(proof(`/${logicalPath}`)), { status: 200 })
            : new Response('move must not run', { status: 500 }),
      },
    )

    await expect(h.advance(staged, input(logicalPath))).resolves.toMatchObject({
      kind: 'success',
      remotePath: logicalPath,
    })
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
