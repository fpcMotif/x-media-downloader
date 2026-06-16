import { describe, it, expect } from 'vitest'
import { Effect, Exit } from 'effect'
import {
  FETCHED_HOST_PATTERNS,
  isAllowedContentType,
  makeFetchedStrategy,
  type FetchPort,
  type OffscreenPort,
  type PermissionsPort,
} from './fetched-strategy'
import type { SaveRequest } from './strategy'

const req: SaveRequest = {
  id: 'm1',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  filename: 'alice/1_0.jpg',
}

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])

function makePorts(overrides: {
  readonly permissions?: Partial<PermissionsPort>
  readonly fetch?: Partial<FetchPort>
  readonly offscreen?: Partial<OffscreenPort>
} = {}) {
  const permissionCalls: Array<{ permissions?: string[]; origins?: string[] }> = []
  const fetchCalls: string[] = []
  const offscreenCalls: Array<{ mimeType: string; filename: string; byteLen: number }> = []

  const permissions: PermissionsPort = {
    contains: overrides.permissions?.contains ?? (async () => true),
    request:
      overrides.permissions?.request ??
      (async (req) => {
        permissionCalls.push({
          ...(req.permissions ? { permissions: [...req.permissions] } : {}),
          ...(req.origins ? { origins: [...req.origins] } : {}),
        })
        return true
      }),
  }

  const fetchPort: FetchPort = {
    fetch:
      overrides.fetch?.fetch ??
      (async (url) => {
        fetchCalls.push(url)
        return {
          ok: true,
          status: 200,
          contentType: 'image/jpeg',
          bytes: async () => jpegBytes,
        }
      }),
  }

  const offscreen: OffscreenPort = {
    ensureDocument: overrides.offscreen?.ensureDocument ?? (async () => {}),
    saveBlob:
      overrides.offscreen?.saveBlob ??
      (async (opts) => {
        offscreenCalls.push({
          mimeType: opts.mimeType,
          filename: opts.filename,
          byteLen: opts.bytes.byteLength,
        })
        return 42
      }),
    closeDocument: overrides.offscreen?.closeDocument ?? (async () => {}),
  }

  const downloads = { download: async () => 99 }

  return { permissions, fetchPort, offscreen, permissionCalls, fetchCalls, offscreenCalls }
}

describe('FETCHED_HOST_PATTERNS', () => {
  it('covers twimg photo and video CDN hosts', () => {
    expect(FETCHED_HOST_PATTERNS).toEqual([
      'https://pbs.twimg.com/*',
      'https://video.twimg.com/*',
    ])
  })
})

describe('isAllowedContentType', () => {
  it('accepts image and video media types', () => {
    expect(isAllowedContentType('image/jpeg')).toBe(true)
    expect(isAllowedContentType('video/mp4')).toBe(true)
    expect(isAllowedContentType('application/octet-stream')).toBe(true)
  })

  it('rejects HTML and JSON error payloads', () => {
    expect(isAllowedContentType('text/html')).toBe(false)
    expect(isAllowedContentType('application/json')).toBe(false)
    expect(isAllowedContentType(null)).toBe(false)
  })
})

describe('makeFetchedStrategy', () => {
  it('fetches bytes, verifies content-type, saves via offscreen, and returns a browser handle', async () => {
    const { permissions, fetchPort, offscreen, fetchCalls, offscreenCalls } = makePorts()
    const handle = await Effect.runPromise(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen }).save(req),
    )
    expect(handle).toEqual({ kind: 'browser', id: 42 })
    expect(fetchCalls).toEqual([req.url])
    expect(offscreenCalls).toEqual([
      { mimeType: 'image/jpeg', filename: req.filename, byteLen: jpegBytes.byteLength },
    ])
  })

  it('requests offscreen + twimg permissions when not yet granted', async () => {
    const { permissions, fetchPort, offscreen, permissionCalls } = makePorts({
      permissions: {
        contains: async () => false,
        request: async (req) => {
          permissionCalls.push({
            ...(req.permissions ? { permissions: [...req.permissions] } : {}),
            ...(req.origins ? { origins: [...req.origins] } : {}),
          })
          return true
        },
      },
    })
    await Effect.runPromise(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen }).save(req),
    )
    expect(permissionCalls).toEqual([
      {
        permissions: ['offscreen'],
        origins: FETCHED_HOST_PATTERNS,
      },
    ])
  })

  it('maps a permission denial to DownloadError', async () => {
    const { permissions, fetchPort, offscreen } = makePorts({
      permissions: {
        contains: async () => false,
        request: async () => false,
      },
    })
    const exit = await Effect.runPromiseExit(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen }).save(req),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('maps a disallowed content-type to DownloadError', async () => {
    const { permissions, fetchPort, offscreen } = makePorts({
      fetch: {
        fetch: async () => ({
          ok: true,
          status: 200,
          contentType: 'text/html',
          bytes: async () => new Uint8Array([0x3c, 0x68, 0x74]),
        }),
      },
    })
    const exit = await Effect.runPromiseExit(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen }).save(req),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('maps a non-ok fetch response to DownloadError', async () => {
    const { permissions, fetchPort, offscreen } = makePorts({
      fetch: {
        fetch: async () => ({
          ok: false,
          status: 403,
          contentType: 'text/html',
          bytes: async () => new Uint8Array(),
        }),
      },
    })
    const exit = await Effect.runPromiseExit(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen }).save(req),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
