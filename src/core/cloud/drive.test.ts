import { describe, it, expect } from 'vitest'
import {
  driveUpload,
  ensureFolder,
  ensureRootFolder,
  makeDriveDestination,
  type DriveDeps,
} from './drive'
import type { UploadInput } from './types'

function sourceResponse(
  bytes: Uint8Array<ArrayBuffer>,
  opts: { status?: number; contentLength?: number | null; contentType?: string } = {},
): Response {
  const headers: Record<string, string> = { 'content-type': opts.contentType ?? 'image/jpeg' }
  if (opts.contentLength !== null)
    headers['content-length'] = String(opts.contentLength ?? bytes.length)
  return new Response(opts.status && opts.status >= 400 ? null : bytes, {
    status: opts.status ?? 200,
    headers,
  })
}

const input = (path = 'alice/t1_0.jpg'): UploadInput => ({
  url: 'https://pbs.twimg.com/media/x.jpg',
  target: { path, handle: 'alice', filename: path.split('/').pop()!, contentType: 'image/jpeg' },
})

/** Records calls and routes Drive REST endpoints. */
function makeDriveFetch() {
  const calls: { url: string; method: string }[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    calls.push({ url: u, method })
    // Upload endpoints (/upload/drive/v3/files) must be matched before the
    // folder endpoints (/drive/v3/files) — both share the `/drive/v3/files` path.
    if (u.includes('uploadType=multipart')) {
      return new Response(JSON.stringify({ id: 'file-mp' }), { status: 200 })
    }
    if (u.includes('uploadType=resumable')) {
      return new Response(null, {
        status: 200,
        headers: { location: 'https://session.example/put' },
      })
    }
    if (u === 'https://session.example/put') {
      return new Response(JSON.stringify({ id: 'file-rs' }), { status: 200 })
    }
    if (u.includes('/drive/v3/files?') && method === 'GET') {
      return new Response(JSON.stringify({ files: [] }), { status: 200 })
    }
    if (u.includes('/drive/v3/files?') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'folder-1' }), { status: 200 })
    }
    return new Response('unexpected', { status: 500 })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function deps(
  fetchImpl: typeof fetch,
  source: () => Response,
  folderCache = new Map<string, string>(),
): DriveDeps {
  return {
    accessToken: 'AT',
    rootFolderId: 'root-1',
    fetchImpl,
    fetchSource: async () => source(),
    folderCache,
  }
}

describe('driveUpload', () => {
  it('maps a 403 source to sourceGone (link-rot), not a failure', async () => {
    const { fetchImpl } = makeDriveFetch()
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(0), { status: 403 })),
    )
    expect(out.kind).toBe('sourceGone')
  })

  it('maps a 500 source to a (retryable) failure', async () => {
    const { fetchImpl } = makeDriveFetch()
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(0), { status: 500 })),
    )
    expect(out.kind).toBe('failure')
  })

  it('small media → one multipart request, returns the file id', async () => {
    const { fetchImpl, calls } = makeDriveFetch()
    const bytes = new Uint8Array(1024).fill(7)
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(bytes)),
    )
    expect(out).toMatchObject({
      kind: 'success',
      bytes: 1024,
      remoteId: 'file-mp',
      remotePath: 'alice/t1_0.jpg',
    })
    expect(calls.some((c) => c.url.includes('uploadType=multipart'))).toBe(true)
    expect(calls.some((c) => c.url.includes('uploadType=resumable'))).toBe(false)
  })

  it('unknown/large media → resumable session, returns the file id', async () => {
    const { fetchImpl, calls } = makeDriveFetch()
    const bytes = new Uint8Array(300).fill(9)
    // no content-length → routed to resumable
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(bytes, { contentLength: null })),
    )
    expect(out).toMatchObject({ kind: 'success', bytes: 300, remoteId: 'file-rs' })
    expect(calls.some((c) => c.url.includes('uploadType=resumable'))).toBe(true)
    expect(calls.filter((c) => c.url === 'https://session.example/put')).toHaveLength(1)
  })

  it('empty source → failure (never a fake save)', async () => {
    const { fetchImpl } = makeDriveFetch()
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(0), { contentLength: 0 })),
    )
    expect(out.kind).toBe('failure')
  })

  it('caches the per-handle subfolder across uploads', async () => {
    const { fetchImpl, calls } = makeDriveFetch()
    const cache = new Map<string, string>()
    const d = deps(fetchImpl, () => sourceResponse(new Uint8Array(16)), cache)
    await driveUpload(input(), d)
    await driveUpload(input('alice/t2_0.jpg'), d)
    // folder create POST should happen at most once for the same handle
    const folderCreates = calls.filter(
      (c) =>
        c.url.includes('/drive/v3/files?') && !c.url.includes('/upload/') && c.method === 'POST',
    )
    expect(folderCreates.length).toBe(1)
    expect(cache.get('alice')).toBe('folder-1')
  })
})

describe('ensureFolder', () => {
  it('reuses an existing folder instead of creating a duplicate', async () => {
    const calls: { url: string; method: string }[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      return new Response(JSON.stringify({ files: [{ id: 'existing' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const id = await ensureFolder('alice', 'root', { accessToken: 'AT', fetchImpl })
    expect(id).toBe('existing')
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })

  it('creates when the list query itself is not ok (falls through to POST)', async () => {
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET'
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ id: 'created' }), {
            status: 200,
          })) as unknown as typeof fetch
    const id = await ensureFolder('bob', null, { accessToken: 'AT', fetchImpl })
    expect(id).toBe('created')
  })

  it('escapes single-quotes and backslashes in the folder name (q= injection guard)', async () => {
    let listUrl = ''
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') listUrl = String(url)
      return new Response(JSON.stringify({ files: [{ id: 'x' }] }), { status: 200 })
    }) as unknown as typeof fetch
    await ensureFolder("a'b\\c", 'root', { accessToken: 'AT', fetchImpl })
    const q = decodeURIComponent(new URL(listUrl).searchParams.get('q') ?? '')
    expect(q).toContain("name='a\\'b\\\\c'")
  })

  it('throws a drive error when folder creation fails', async () => {
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET'
        ? new Response(JSON.stringify({ files: [] }), { status: 200 })
        : new Response('quota', { status: 403 })) as unknown as typeof fetch
    await expect(ensureFolder('c', 'root', { accessToken: 'AT', fetchImpl })).rejects.toThrow(
      /drive HTTP 403/,
    )
  })

  it('throws when folder creation returns no id', async () => {
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET'
        ? new Response(JSON.stringify({ files: [] }), { status: 200 })
        : new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch
    await expect(ensureFolder('c', 'root', { accessToken: 'AT', fetchImpl })).rejects.toThrow(
      /no id/,
    )
  })
})

describe('ensureRootFolder', () => {
  it('resolves a top-level folder (no parent constraint in the query)', async () => {
    let listUrl = ''
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') listUrl = String(url)
      return new Response(JSON.stringify({ files: [{ id: 'root-id' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const id = await ensureRootFolder('X Media Downloader', { accessToken: 'AT', fetchImpl })
    expect(id).toBe('root-id')
    const q = decodeURIComponent(new URL(listUrl).searchParams.get('q') ?? '')
    expect(q).not.toContain('in parents') // null parent → no parent clause
  })
})

describe('driveUpload — error & resumable edge paths', () => {
  it('maps a folder-resolution failure to an upload failure (never throws)', async () => {
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) =>
      (init?.method ?? 'GET') === 'GET'
        ? new Response(JSON.stringify({ files: [] }), { status: 200 })
        : new Response('boom', { status: 500 })) as unknown as typeof fetch
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(64))),
    )
    expect(out).toMatchObject({ kind: 'failure' })
    expect((out as { reason: string }).reason).toMatch(/drive HTTP 500/)
  })

  it('multipart upload failure → failure outcome', async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('uploadType=multipart')) return new Response('denied', { status: 403 })
      if (u.includes('/drive/v3/files?') && (init?.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({ files: [{ id: 'folder' }] }), { status: 200 })
      return new Response('x', { status: 500 })
    }) as unknown as typeof fetch
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(64))),
    )
    expect(out.kind).toBe('failure')
  })

  it('resumable initiate without a session url → failure', async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('uploadType=resumable')) return new Response(null, { status: 200 }) // no location
      if (u.includes('/drive/v3/files?') && (init?.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({ files: [{ id: 'folder' }] }), { status: 200 })
      return new Response('x', { status: 500 })
    }) as unknown as typeof fetch
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(64), { contentLength: null })),
    )
    expect(out).toMatchObject({ kind: 'failure' })
    expect((out as { reason: string }).reason).toMatch(/session url/)
  })

  it('resumable initiate failure → failure', async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('uploadType=resumable')) return new Response('no', { status: 500 })
      if (u.includes('/drive/v3/files?') && (init?.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({ files: [{ id: 'folder' }] }), { status: 200 })
      return new Response('x', { status: 500 })
    }) as unknown as typeof fetch
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(64), { contentLength: null })),
    )
    expect(out.kind).toBe('failure')
  })

  it('resumable: final PUT returning no id → failure', async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('uploadType=resumable'))
        return new Response(null, { status: 200, headers: { location: 'https://s/put' } })
      if (u === 'https://s/put') return new Response(JSON.stringify({}), { status: 200 })
      if (u.includes('/drive/v3/files?') && (init?.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({ files: [{ id: 'folder' }] }), { status: 200 })
      return new Response('x', { status: 500 })
    }) as unknown as typeof fetch
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(64), { contentLength: null })),
    )
    expect(out).toMatchObject({ kind: 'failure' })
    expect((out as { reason: string }).reason).toMatch(/file id/)
  })

  it('resumable: final PUT error status → failure', async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('uploadType=resumable'))
        return new Response(null, { status: 200, headers: { location: 'https://s/put' } })
      if (u === 'https://s/put') return new Response('bad', { status: 410 })
      if (u.includes('/drive/v3/files?') && (init?.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({ files: [{ id: 'folder' }] }), { status: 200 })
      return new Response('x', { status: 500 })
    }) as unknown as typeof fetch
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(64), { contentLength: null })),
    )
    expect(out.kind).toBe('failure')
  })

  it('resumable multi-chunk: 308 on non-final chunk then 200 on the last', async () => {
    const puts: string[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('uploadType=resumable'))
        return new Response(null, { status: 200, headers: { location: 'https://s/put' } })
      if (u === 'https://s/put') {
        const range = ((init?.headers ?? {}) as Record<string, string>)['content-range'] ?? ''
        puts.push(range)
        // Non-final chunks use `*` total and expect 308; the final uses a concrete total.
        return range.endsWith('/*')
          ? new Response(null, { status: 308 })
          : new Response(JSON.stringify({ id: 'big-file' }), { status: 200 })
      }
      if (u.includes('/drive/v3/files?') && (init?.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({ files: [{ id: 'folder' }] }), { status: 200 })
      return new Response('x', { status: 500 })
    }) as unknown as typeof fetch
    // 9 MiB, known size > SIMPLE_MAX_BYTES → resumable in 8 MiB chunks (8 MiB + 1 MiB).
    const bytes = new Uint8Array(9 * 1024 * 1024)
    const out = await driveUpload(
      input('alice/big.mp4'),
      deps(fetchImpl, () => sourceResponse(bytes)),
    )
    expect(out).toMatchObject({ kind: 'success', remoteId: 'big-file', bytes: 9 * 1024 * 1024 })
    expect(puts.length).toBe(2)
    expect(puts[0]!.endsWith('/*')).toBe(true) // non-final
  })

  it('resumable: a 500 on a non-final chunk → failure', async () => {
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('uploadType=resumable'))
        return new Response(null, { status: 200, headers: { location: 'https://s/put' } })
      if (u === 'https://s/put') {
        const range = ((init?.headers ?? {}) as Record<string, string>)['content-range'] ?? ''
        return range.endsWith('/*')
          ? new Response('mid-fail', { status: 500 })
          : new Response(JSON.stringify({ id: 'x' }), { status: 200 })
      }
      if (u.includes('/drive/v3/files?') && (init?.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({ files: [{ id: 'folder' }] }), { status: 200 })
      return new Response('x', { status: 500 })
    }) as unknown as typeof fetch
    const bytes = new Uint8Array(9 * 1024 * 1024)
    const out = await driveUpload(
      input('alice/big.mp4'),
      deps(fetchImpl, () => sourceResponse(bytes)),
    )
    expect(out.kind).toBe('failure')
  })
})

/** A stream that closes with no data — a non-null but empty body. */
const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.close()
    },
  })

describe('driveUpload — empty-body & error-text edges', () => {
  it('empty stream with unknown size → resumable yields zero bytes → failure', async () => {
    const { fetchImpl, calls } = makeDriveFetch()
    const out = await driveUpload(
      input(),
      deps(
        fetchImpl,
        () =>
          new Response(emptyStream(), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      ),
    )
    expect(out).toMatchObject({ kind: 'failure', reason: 'empty source' })
    // the single empty final chunk is PUT with a `bytes */0` range (no body)
    const put = calls.find((c) => c.url === 'https://session.example/put')
    expect(put).toBeDefined()
  })

  it('declared non-zero length but empty multipart body → failure', async () => {
    const { fetchImpl } = makeDriveFetch()
    const out = await driveUpload(
      input(),
      // size 5 routes to multipart, but readAll drains nothing
      deps(
        fetchImpl,
        () =>
          new Response(emptyStream(), {
            status: 200,
            headers: { 'content-type': 'image/jpeg', 'content-length': '5' },
          }),
      ),
    )
    expect(out).toMatchObject({ kind: 'failure', reason: 'empty source' })
  })

  it("errText falls back to '' when the error body read itself fails", async () => {
    const fetchImpl = (async (_u: string | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify({ files: [] }), { status: 200 })
      // POST (folder create) errors AND its body read rejects (dropped connection)
      return {
        ok: false,
        status: 500,
        text: () => Promise.reject(new Error('read failed')),
        headers: new Headers(),
      } as unknown as Response
    }) as unknown as typeof fetch
    const out = await driveUpload(
      input(),
      deps(fetchImpl, () => sourceResponse(new Uint8Array(32))),
    )
    expect(out).toMatchObject({ kind: 'failure' })
    // body '' ⇒ no `: <body>` suffix on the message
    expect((out as { reason: string }).reason).toBe('drive HTTP 500')
  })
})

describe('makeDriveDestination', () => {
  it('uploads through the provider-agnostic CloudDestination', async () => {
    const { fetchImpl } = makeDriveFetch()
    const dest = makeDriveDestination(deps(fetchImpl, () => sourceResponse(new Uint8Array(32))))
    const out = await dest.upload(input())
    expect(out).toMatchObject({ kind: 'success', remoteId: 'file-mp' })
  })
})
