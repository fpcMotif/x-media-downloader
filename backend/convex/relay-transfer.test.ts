import { convexTest } from 'convex-test'
import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Id } from './_generated/dataModel'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')
const submit = makeFunctionReference<
  'mutation',
  {
    secret: string
    deviceId: string
    mediaId: string
    sourceUrl: string
    path: string
    contentType: string
    budgetDay: string
    estimatedBytes: number
  },
  { id: Id<'relay_jobs'>; created: boolean }
>('relay:submit')
const run = makeFunctionReference<'action', { id: Id<'relay_jobs'> }, null>('relayWorker:run')
const status = makeFunctionReference<'query'>('relay:status')
const control = makeFunctionReference<'mutation'>('relay:control')
const secret = 'test-secret'
const input = {
  secret,
  deviceId: 'device',
  mediaId: 'image',
  sourceUrl: 'https://pbs.twimg.com/media/test.jpg',
  path: 'test.jpg',
  contentType: 'image/jpeg',
  budgetDay: '2026-09-20',
  estimatedBytes: 4,
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('SYNC_SHARED_SECRET', secret)
  vi.stubEnv('RELAY_ENABLED', 'true')
  vi.stubEnv('RELAY_DRIVE_CLIENT_ID', 'client')
  vi.stubEnv('RELAY_DRIVE_CLIENT_SECRET', 'secret')
  vi.stubEnv('RELAY_DRIVE_REFRESH_TOKEN', 'refresh')
  vi.stubEnv('RELAY_DRIVE_FOLDER_ID', 'folder')
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it.each([false, true])(
  'persists completion and one Drive identity after ambiguous final response: %s',
  async (ambiguous) => {
    const t = convexTest(schema, modules)
    const source = new Uint8Array([1, 3, 5, 7])
    let remote: Uint8Array | null = null
    let creations = 0
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes('oauth2.googleapis.com'))
        return Response.json({ access_token: 'test-access' })
      if (url.includes('generateIds')) return Response.json({ ids: ['stable-file'] })
      if (url.includes('/drive/v3/files/stable-file'))
        return remote
          ? Response.json({ id: 'stable-file', size: String(remote.byteLength), trashed: false })
          : new Response(null, { status: 404 })
      if (url.includes('pbs.twimg.com'))
        return new Response(source, { headers: { 'Content-Length': '4', ETag: '"image-v1"' } })
      if (init.method === 'POST') {
        creations++
        return new Response(null, {
          headers: {
            Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=private-session',
          },
        })
      }
      if (init.method === 'PUT' && init.body instanceof Uint8Array) {
        remote = new Uint8Array(init.body)
        if (ambiguous) throw new Error('lost final response')
        return Response.json({ id: 'stable-file', size: '4' })
      }
      throw new Error('Unexpected test HTTP request')
    })
    vi.stubGlobal('fetch', fetchMock)
    await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
    const accepted = await t.mutation(submit, input)
    await t.action(run, { id: accepted.id })
    if (ambiguous) {
      vi.setSystemTime(Date.now() + 10_000)
      await t.action(run, { id: accepted.id })
    }
    const result = await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })
    expect(result).toEqual([
      expect.objectContaining({ status: 'completed', fileId: 'stable-file', offset: 4, total: 4 }),
    ])
    expect(remote).toEqual(source)
    expect(creations).toBe(1)
    expect(JSON.stringify(result)).not.toContain('private-session')
  },
)

it.each([false, true])(
  'recovers interrupted chunks only with matching source identity (changed=%s)',
  async (sourceChanged) => {
    const t = convexTest(schema, modules)
    const chunk = 8 * 1024 * 1024
    const source = new Uint8Array(chunk + 3).fill(47)
    const remote = new Uint8Array(source.length)
    let received = 0
    let complete = false
    const starts: number[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'access' })
      if (url.includes('generateIds')) return Response.json({ ids: ['stable-file'] })
      if (url.includes('/drive/v3/files/stable-file'))
        return complete
          ? Response.json({ id: 'stable-file', size: String(remote.length) })
          : new Response(null, { status: 404 })
      const headers = new Headers(init.headers)
      if (url.includes('pbs.twimg.com')) {
        const start = Number(headers.get('range')?.split('=')[1]?.split('-')[0])
        starts.push(start)
        const end = Math.min(start + chunk, source.length)
        return new Response(source.slice(start, end), {
          status: 206,
          headers: {
            'Content-Range': `bytes ${start}-${end - 1}/${source.length}`,
            ETag: sourceChanged && starts.length > 1 ? '"changed-source"' : '"stable-source"',
          },
        })
      }
      if (init.method === 'POST')
        return new Response(null, {
          headers: {
            Location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=private',
          },
        })
      if (init.method === 'PUT' && !(init.body instanceof Uint8Array))
        return new Response(null, { status: 308, headers: { Range: `bytes=0-${received - 1}` } })
      if (init.body instanceof Uint8Array) {
        if (received === 0) {
          received = chunk / 2
          remote.set(init.body.subarray(0, received))
          throw new Error('interrupted chunk')
        }
        remote.set(init.body, received)
        received += init.body.length
        complete = received === source.length
        return Response.json({ id: 'stable-file', size: String(received) })
      }
      throw new Error('Unexpected HTTP request')
    })
    await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
    const { id } = await t.mutation(submit, { ...input, estimatedBytes: source.length })
    await t.action(run, { id })
    vi.setSystemTime(Date.now() + 10_000)
    await t.action(run, { id })
    expect(starts).toEqual([0, chunk / 2])
    const result = await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })
    if (sourceChanged) {
      expect(result).toEqual([
        expect.objectContaining({
          status: 'failed',
          error: 'Source size, identity, or Range validation failed',
        }),
      ])
      expect(complete).toBe(false)
    } else {
      expect(remote.every((byte, index) => byte === source[index])).toBe(true)
      expect(result).toEqual([
        expect.objectContaining({ status: 'completed', offset: source.length, failures: 1 }),
      ])
    }
  },
)

it.each(['oversized-header', 'oversized-stream', 'expired', 'invalid-range'])(
  'fails explicitly without Drive bytes for %s',
  async (failure) => {
    const t = convexTest(schema, modules)
    let uploads = 0
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'access' })
      if (url.includes('generateIds')) return Response.json({ ids: ['stable-file'] })
      if (url.includes('pbs.twimg.com')) {
        if (failure === 'expired') return new Response(null, { status: 403 })
        if (failure === 'oversized-header')
          return new Response(new Uint8Array(5), { headers: { 'Content-Length': '5' } })
        if (failure === 'invalid-range')
          return new Response(new Uint8Array(4), {
            status: 206,
            headers: { 'Content-Range': 'bytes 1-4/4' },
          })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(3))
              controller.enqueue(new Uint8Array(2))
              controller.close()
            },
          }),
        )
      }
      if (init.method === 'PUT') uploads++
      return new Response(null, { status: 404 })
    })
    await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
    const { id } = await t.mutation(submit, input)
    await t.action(run, { id })
    expect(uploads).toBe(0)
    expect(await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.stringMatching(/Source/) }),
    ])
  },
)

it('refuses partial recovery of a small source without its original strong validator', async () => {
  const t = convexTest(schema, modules)
  let byteUploads = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'access' })
    if (url.includes('pbs.twimg.com'))
      return new Response(new Uint8Array([3, 4]), {
        status: 206,
        headers: { 'Content-Range': 'bytes 2-3/4' },
      })
    if (init.method === 'PUT' && !(init.body instanceof Uint8Array))
      return new Response(null, { status: 308, headers: { Range: 'bytes=0-1' } })
    if (init.body instanceof Uint8Array) {
      byteUploads++
      return Response.json({ id: 'stable-file', size: '4' })
    }
    return new Response(null, { status: 404 })
  })
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const { id } = await t.mutation(submit, input)
  await t.run((ctx) =>
    ctx.db.patch(id, {
      fileId: 'stable-file',
      session: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=private',
      total: 4,
      offset: 2,
    }),
  )
  await t.action(run, { id })
  expect(byteUploads).toBe(0)
  expect(await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })).toEqual([
    expect.objectContaining({
      status: 'failed',
      error: 'Source size, identity, or Range validation failed',
    }),
  ])
})

it('never follows source redirects outside the allowlist', async () => {
  const t = convexTest(schema, modules)
  const urls: string[] = []
  vi.stubGlobal('fetch', async (url: string) => {
    urls.push(url)
    if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'test-access' })
    if (url.includes('generateIds')) return Response.json({ ids: ['stable-file'] })
    if (url.includes('pbs.twimg.com'))
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } })
    return new Response(null, { status: 404 })
  })
  await t.mutation(control, { secret, enabled: true, accepting: true, connected: true })
  const accepted = await t.mutation(submit, input)
  await t.action(run, { id: accepted.id })
  expect(urls.some((url) => url.includes('127.0.0.1'))).toBe(false)
  expect(await t.query(status, { secret, deviceId: 'device', mediaIds: ['image'] })).toEqual([
    expect.objectContaining({
      status: 'failed',
      failures: 1,
      error: 'Unsafe source redirect refused',
    }),
  ])
})
