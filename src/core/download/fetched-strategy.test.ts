import { describe, it, expect, vi, afterEach } from 'vitest'
import { Effect, Exit } from 'effect'
import {
  FETCHED_HOST_PATTERNS,
  isAllowedContentType,
  mimeBase,
  ensureFetchedPermissions,
  makeFetchedStrategy,
  makeFetchPort,
  makeOffscreenPort,
  makePermissionsPort,
  type FetchPort,
  type OffscreenPort,
  type PermissionsPort,
} from './fetched-strategy'
import type { DownloadStrategy, SaveRequest } from './strategy'

const req: SaveRequest = {
  id: 'm1',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  filename: 'alice/1_0.jpg',
}

const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])

/** A Direct-fallback stub that records the requests handed to it. */
function makeRecordingDirect() {
  const calls: SaveRequest[] = []
  const strategy: DownloadStrategy = {
    save: (r) =>
      Effect.sync(() => {
        calls.push(r)
        return { kind: 'browser' as const, id: 7 }
      }),
  }
  return { strategy, calls }
}

function makePorts(
  overrides: {
    readonly permissions?: Partial<PermissionsPort>
    readonly fetch?: Partial<FetchPort>
    readonly offscreen?: Partial<OffscreenPort>
  } = {},
) {
  const permissionCalls: Array<{ permissions?: string[]; origins?: string[] }> = []
  const fetchCalls: string[] = []
  const offscreenCalls: Array<{ mimeType: string; filename: string; byteLen: number }> = []

  const permissions: PermissionsPort = {
    contains: overrides.permissions?.contains ?? (async () => true),
    request:
      overrides.permissions?.request ??
      (async (pr) => {
        permissionCalls.push({
          ...(pr.permissions ? { permissions: [...pr.permissions] } : {}),
          ...(pr.origins ? { origins: [...pr.origins] } : {}),
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
          contentLength: jpegBytes.byteLength,
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

  return { permissions, fetchPort, offscreen, permissionCalls, fetchCalls, offscreenCalls }
}

describe('FETCHED_HOST_PATTERNS', () => {
  it('covers every registered adapter CDN — twimg photo/video hosts plus the Meta CDN wildcard', () => {
    expect(FETCHED_HOST_PATTERNS).toEqual([
      'https://pbs.twimg.com/*',
      'https://video.twimg.com/*',
      'https://*.cdninstagram.com/*',
    ])
  })
})

describe('mimeBase', () => {
  it('returns the trimmed base, stripping any parameters and preserving case', () => {
    expect(mimeBase('image/JPEG')).toBe('image/JPEG')
    expect(mimeBase('image/jpeg; charset=binary')).toBe('image/jpeg')
    expect(mimeBase('  video/mp4  ')).toBe('video/mp4')
  })

  it('returns an empty string for a null content-type', () => {
    expect(mimeBase(null)).toBe('')
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
        request: async (pr) => {
          permissionCalls.push({
            ...(pr.permissions ? { permissions: [...pr.permissions] } : {}),
            ...(pr.origins ? { origins: [...pr.origins] } : {}),
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
          contentLength: 3,
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
          contentLength: 0,
          bytes: async () => new Uint8Array(),
        }),
      },
    })
    const exit = await Effect.runPromiseExit(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen }).save(req),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('keeps ensureDocument/closeDocument balanced when fetch fails before saveBlob', async () => {
    // The refcount that guards concurrent saves leaks if ensureDocument runs but
    // its matching closeDocument never does. A save that fails the fetch (or the
    // content-type / bytes checks) returns before saveBlob, so it must not leave
    // the offscreen document acquired — otherwise the count never returns to zero
    // and a later successful save's close is suppressed, leaking an open document.
    let ensured = 0
    let closed = 0
    const { permissions, fetchPort } = makePorts({
      fetch: {
        fetch: async () => ({
          ok: false,
          status: 403,
          contentType: 'text/html',
          contentLength: 0,
          bytes: async () => new Uint8Array(),
        }),
      },
    })
    const offscreen: OffscreenPort = {
      ensureDocument: async () => {
        ensured += 1
      },
      saveBlob: async () => 42,
      closeDocument: async () => {
        closed += 1
      },
    }
    const exit = await Effect.runPromiseExit(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen }).save(req),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    // Either the document was never acquired, or every acquire was released.
    expect(ensured).toBe(closed)
  })

  it('releases the offscreen document when saveBlob itself fails', async () => {
    let ensured = 0
    let closed = 0
    const { permissions, fetchPort } = makePorts()
    const offscreen: OffscreenPort = {
      ensureDocument: async () => {
        ensured += 1
      },
      saveBlob: async () => {
        throw new Error('offscreen save failed')
      },
      closeDocument: async () => {
        closed += 1
      },
    }
    const exit = await Effect.runPromiseExit(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen }).save(req),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(ensured).toBe(1)
    expect(closed).toBe(1)
  })
})

describe('makeFetchedStrategy — size cap / OOM guard', () => {
  it('falls back to Direct when content-length exceeds the cap (never buffers the body in the SW)', async () => {
    const { permissions, offscreen, offscreenCalls } = makePorts()
    const fetchPort: FetchPort = {
      fetch: async () => ({
        ok: true,
        status: 200,
        contentType: 'video/mp4',
        contentLength: 200 * 1024 * 1024, // 200 MiB > cap
        bytes: async () => {
          throw new Error('over-cap body must not be read into the SW')
        },
      }),
    }
    const { strategy: direct, calls } = makeRecordingDirect()
    const handle = await Effect.runPromise(
      makeFetchedStrategy({
        permissions,
        fetch: fetchPort,
        offscreen,
        direct,
        maxBytes: 96 * 1024 * 1024,
      }).save(req),
    )
    expect(handle).toEqual({ kind: 'browser', id: 7 })
    expect(calls).toEqual([req])
    expect(offscreenCalls).toEqual([]) // never saved via offscreen
  })

  it('falls back to Direct for a video with no declared content-length', async () => {
    const { permissions, offscreen, offscreenCalls } = makePorts()
    const fetchPort: FetchPort = {
      fetch: async () => ({
        ok: true,
        status: 200,
        contentType: 'video/mp4',
        contentLength: null,
        bytes: async () => {
          throw new Error('unsized video must not be buffered')
        },
      }),
    }
    const { strategy: direct, calls } = makeRecordingDirect()
    const handle = await Effect.runPromise(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen, direct }).save(req),
    )
    expect(handle).toEqual({ kind: 'browser', id: 7 })
    expect(calls).toEqual([req])
    expect(offscreenCalls).toEqual([])
  })

  it('falls back to Direct when the buffered body exceeds the cap despite a small content-length', async () => {
    const { permissions, offscreen, offscreenCalls } = makePorts()
    const big = new Uint8Array(64)
    const fetchPort: FetchPort = {
      fetch: async () => ({
        ok: true,
        status: 200,
        contentType: 'image/jpeg',
        contentLength: 4, // under-reports the real 64-byte body
        bytes: async () => big,
      }),
    }
    const { strategy: direct, calls } = makeRecordingDirect()
    const handle = await Effect.runPromise(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen, direct, maxBytes: 16 }).save(
        req,
      ),
    )
    expect(handle).toEqual({ kind: 'browser', id: 7 })
    expect(calls).toEqual([req])
    expect(offscreenCalls).toEqual([])
  })

  it('keeps a small, sized image on the verified Fetched path even when Direct is available', async () => {
    const { permissions, fetchPort, offscreen, offscreenCalls } = makePorts()
    const { strategy: direct, calls } = makeRecordingDirect()
    const handle = await Effect.runPromise(
      makeFetchedStrategy({ permissions, fetch: fetchPort, offscreen, direct }).save(req),
    )
    expect(handle).toEqual({ kind: 'browser', id: 42 })
    expect(calls).toEqual([]) // Direct not used for a bounded image
    expect(offscreenCalls).toHaveLength(1)
  })
})

describe('makeFetchPort', () => {
  it('invokes the injected fetch with a global receiver, never unbound (Illegal invocation)', async () => {
    // background wires `makeFetchPort(fetch)` with the bare global; an unbound
    // `fetchImpl(url)` runs with `this === undefined` → "Illegal invocation" in the
    // MV3 SW. A non-arrow stub exposes the dynamic `this`; bindFetch must detach it.
    const brandChecked = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation")
      }
      return Promise.resolve(new Response(jpegBytes, { headers: { 'content-type': 'image/jpeg' } }))
    } as typeof fetch
    const port = makeFetchPort(brandChecked)
    const res = await port.fetch('https://pbs.twimg.com/media/AAA.jpg')
    expect(res.ok).toBe(true)
    expect(res.contentType).toBe('image/jpeg')
    expect(await res.bytes()).toEqual(jpegBytes)
  })
})

describe('makePermissionsPort', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('delegates contains/request to browser.permissions with offscreen + twimg origins', async () => {
    const contains = vi
      .spyOn(browser.permissions, 'contains')
      .mockResolvedValue(true as never) as unknown as ReturnType<typeof vi.fn>
    const request = vi
      .spyOn(browser.permissions, 'request')
      .mockResolvedValue(false as never) as unknown as ReturnType<typeof vi.fn>

    const port = makePermissionsPort()
    await expect(port.contains({})).resolves.toBe(true)
    await expect(port.request({})).resolves.toBe(false)

    const expected = { permissions: ['offscreen'], origins: [...FETCHED_HOST_PATTERNS] }
    expect(contains).toHaveBeenCalledWith(expected)
    expect(request).toHaveBeenCalledWith(expected)
  })
})

// fakeBrowser has no `browser.offscreen`; stub a minimal one that models the
// single shared document's lifecycle so we can observe close-during-save.
// `saveBlob` is gated on explicit deferreds so we control completion ordering
// and can interleave a close() between save A finishing and B/C messaging.
function stubOffscreen() {
  let open = false
  const closeDocument = vi.fn<() => Promise<void>>(async () => {
    open = false
  })
  const createDocument = vi.fn<() => Promise<void>>(async () => {
    open = true
  })
  browser.offscreen = {
    hasDocument: async () => open,
    createDocument,
    closeDocument,
  } as unknown as typeof browser.offscreen

  const gates: Array<() => void> = []
  // The offscreen save round-trips over runtime messaging. Each call parks on
  // a deferred (so the test can order completions), then — at the moment it
  // resolves — checks the live document state. A torn-down doc rejects, which
  // is exactly the production "offscreen save failed" symptom.
  browser.runtime.sendMessage = (async () => {
    await new Promise<void>((resolve) => gates.push(resolve))
    if (!open) {
      throw new Error('Could not establish connection. Receiving end does not exist.')
    }
    return { downloadId: 42 }
  }) as typeof browser.runtime.sendMessage

  return {
    createDocument,
    closeDocument,
    isOpen: () => open,
    releaseSave: () => gates.shift()?.(),
    pending: () => gates.length,
  }
}

describe('makeOffscreenPort — OffscreenSaveError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws OffscreenSaveError when the offscreen response carries an error', async () => {
    browser.offscreen = {
      hasDocument: async () => true,
      createDocument: async () => {},
      closeDocument: async () => {},
    } as unknown as typeof browser.offscreen
    browser.runtime.sendMessage = (async () => ({
      error: 'disk full',
    })) as typeof browser.runtime.sendMessage

    const port = makeOffscreenPort()
    await expect(
      port.saveBlob({ bytes: new Uint8Array([1]), mimeType: 'image/jpeg', filename: 'a.jpg' }),
    ).rejects.toMatchObject({ _tag: 'OffscreenSaveError', message: 'disk full' })
  })
})

describe('makeOffscreenPort', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps the shared document open across concurrent saves so a finished save cannot close it under the others', async () => {
    // A 3-photo tweet fires 3 fetched saves sharing one offscreen document.
    // Each save mirrors the strategy: ensureDocument(), then
    // saveBlob(...).finally(closeDocument). Without a refcount, the first save
    // to finish closes the doc while the others are still mid saveBlob, so their
    // runtime.sendMessage lands on a closed document and rejects.
    const { createDocument, closeDocument, isOpen, releaseSave, pending } = stubOffscreen()
    const port = makeOffscreenPort()

    const photo = (n: number) =>
      (async () => {
        await port.ensureDocument()
        return port
          .saveBlob({
            bytes: jpegBytes,
            mimeType: 'image/jpeg',
            filename: `alice/1_${n}.jpg`,
          })
          .finally(() => port.closeDocument().catch(() => {}))
      })()

    const all = Promise.all([photo(0), photo(1), photo(2)])

    // Let all three reach the parked sendMessage (document open, none done yet).
    await vi.waitFor(() => expect(pending()).toBe(3))
    expect(createDocument).toHaveBeenCalledTimes(1)

    // Save A completes first and runs its close() while B/C are still parked.
    releaseSave()
    await Promise.resolve()
    releaseSave()
    await Promise.resolve()
    releaseSave()

    const ids = await all
    expect(ids).toEqual([42, 42, 42])
    expect(closeDocument).toHaveBeenCalledTimes(1)
    expect(isOpen()).toBe(false)
  })

  it('opens the document again for a later save once the previous batch closed it', async () => {
    const { createDocument, closeDocument, releaseSave } = stubOffscreen()
    const port = makeOffscreenPort()

    await port.ensureDocument()
    const first = port
      .saveBlob({ bytes: jpegBytes, mimeType: 'image/jpeg', filename: 'a.jpg' })
      .finally(() => port.closeDocument().catch(() => {}))
    await vi.waitFor(() => releaseSave())
    await first
    expect(closeDocument).toHaveBeenCalledTimes(1)

    await port.ensureDocument()
    const second = port
      .saveBlob({ bytes: jpegBytes, mimeType: 'image/jpeg', filename: 'b.jpg' })
      .finally(() => port.closeDocument().catch(() => {}))
    await vi.waitFor(() => releaseSave())
    await second

    expect(createDocument).toHaveBeenCalledTimes(2)
    expect(closeDocument).toHaveBeenCalledTimes(2)
  })
})

describe('ensureFetchedPermissions', () => {
  it('returns true if port.contains returns true', async () => {
    const { permissions, permissionCalls } = makePorts({
      permissions: {
        contains: async () => true,
        request: async (pr) => {
          permissionCalls.push({
            ...(pr.permissions ? { permissions: [...pr.permissions] } : {}),
            ...(pr.origins ? { origins: [...pr.origins] } : {}),
          })
          return true
        },
      },
    })
    const result = await ensureFetchedPermissions(permissions)
    expect(result).toBe(true)
    expect(permissionCalls).toEqual([])
  })

  it('requests permissions and returns true if port.contains returns false and request returns true', async () => {
    const { permissions, permissionCalls } = makePorts({
      permissions: {
        contains: async () => false,
        request: async (pr) => {
          permissionCalls.push({
            ...(pr.permissions ? { permissions: [...pr.permissions] } : {}),
            ...(pr.origins ? { origins: [...pr.origins] } : {}),
          })
          return true
        },
      },
    })
    const result = await ensureFetchedPermissions(permissions)
    expect(result).toBe(true)
    expect(permissionCalls).toEqual([
      {
        permissions: ['offscreen'],
        origins: FETCHED_HOST_PATTERNS,
      },
    ])
  })

  it('returns false if port.contains returns false and request returns false', async () => {
    const { permissions, permissionCalls } = makePorts({
      permissions: {
        contains: async () => false,
        request: async (pr) => {
          permissionCalls.push({
            ...(pr.permissions ? { permissions: [...pr.permissions] } : {}),
            ...(pr.origins ? { origins: [...pr.origins] } : {}),
          })
          return false
        },
      },
    })
    const result = await ensureFetchedPermissions(permissions)
    expect(result).toBe(false)
    expect(permissionCalls).toEqual([
      {
        permissions: ['offscreen'],
        origins: FETCHED_HOST_PATTERNS,
      },
    ])
  })
})
