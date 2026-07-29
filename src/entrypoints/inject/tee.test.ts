import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installMainWorldResponseTee,
  MAX_TEE_BODY_BYTES,
  readBoundedUtf8Response,
  utf8ByteLengthAtMost,
  type MainWorldResponseTee,
} from './tee'

type Listener = () => void

class FakeXhr {
  status = 200
  responseType: XMLHttpRequestResponseType = ''
  responseURL = 'https://x.com/i/api/graphql/TweetDetail'
  responseText = ''
  contentLength: string | null = null
  readonly listeners = new Map<string, Listener[]>()
  readonly openCalls: unknown[][] = []

  addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }

  removeEventListener(name: string, listener: Listener): void {
    this.listeners.set(
      name,
      (this.listeners.get(name) ?? []).filter((registered) => registered !== listener),
    )
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === 'content-length' ? this.contentLength : null
  }

  open(method: string, url: string | URL, ...rest: unknown[]): void {
    this.openCalls.push([method, url, ...rest])
  }

  load(): void {
    for (const listener of this.listeners.get('load') ?? []) listener()
    for (const listener of this.listeners.get('loadend') ?? []) listener()
  }

  error(): void {
    for (const listener of this.listeners.get('error') ?? []) listener()
    for (const listener of this.listeners.get('loadend') ?? []) listener()
  }

  abort(): void {
    for (const listener of this.listeners.get('abort') ?? []) listener()
    for (const listener of this.listeners.get('loadend') ?? []) listener()
  }
}

const xhrPrototype = FakeXhr.prototype as unknown as MainWorldResponseTee['xhrPrototype']
const originalFakeOpen = FakeXhr.prototype.open

const deferred = <A>() => {
  let resolve!: (value: A) => void
  const promise = new Promise<A>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const pendingResponse = () => {
  const next = deferred<ReadableStreamReadResult<Uint8Array>>()
  const read = vi.fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>(() => next.promise)
  const cancel = vi.fn<() => Promise<void>>(async () => {})
  const clone = vi.fn<() => unknown>(() => ({
    body: { getReader: () => ({ read, cancel }) },
  }))
  return {
    response: { ok: true, headers: new Headers(), clone } as unknown as Response,
    next,
    read,
    cancel,
    clone,
  }
}

const makeTee = (over: Partial<MainWorldResponseTee> = {}) => {
  const emit = vi.fn<(path: string, body: string, route: string) => void>()
  const fetchOwner = {
    fetch: vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(),
  }
  const tee: MainWorldResponseTee = {
    fetchOwner,
    xhrPrototype,
    origin: 'https://x.com',
    isTrackedUrl: (url) => url === '/tracked',
    routeAtObservation: () => '/route-a',
    emit,
    ...over,
  }
  return { tee, emit, fetchOwner }
}

afterEach(() => {
  FakeXhr.prototype.open = originalFakeOpen
})

describe('MAIN-world response tee', () => {
  it('returns the original fetch response while emitting only its bounded clone', async () => {
    const { tee, emit, fetchOwner } = makeTee()
    const response = new Response('{"ok":true}')
    fetchOwner.fetch.mockResolvedValue(response)
    installMainWorldResponseTee(tee)

    const result = await tee.fetchOwner.fetch('/tracked')
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith('/tracked', '{"ok":true}', '/route-a'))

    expect(result).toBe(response)
    await expect(result.text()).resolves.toBe('{"ok":true}')
  })

  it('never clones a non-tracked or failed fetch response', async () => {
    const { tee, emit, fetchOwner } = makeTee()
    const nonTracked = new Response('ignored')
    const failed = new Response('ignored', { status: 500 })
    const nonTrackedClone = vi.spyOn(nonTracked, 'clone')
    const failedClone = vi.spyOn(failed, 'clone')
    fetchOwner.fetch.mockResolvedValueOnce(nonTracked).mockResolvedValueOnce(failed)
    installMainWorldResponseTee(tee)

    await tee.fetchOwner.fetch('/not-tracked')
    await tee.fetchOwner.fetch('/tracked')
    await Promise.resolve()

    expect(nonTrackedClone).not.toHaveBeenCalled()
    expect(failedClone).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('bounds concurrent fetch clones, skips excess capture, and recycles every permit', async () => {
    const first = pendingResponse()
    const excess = pendingResponse()
    const afterRelease = pendingResponse()
    const { tee, emit, fetchOwner } = makeTee({
      captureLimits: {
        maxCapturesInFlight: 1,
        maxBytesInFlight: 16,
      },
    })
    fetchOwner.fetch
      .mockResolvedValueOnce(first.response)
      .mockResolvedValueOnce(excess.response)
      .mockResolvedValueOnce(afterRelease.response)
    installMainWorldResponseTee(tee)

    await tee.fetchOwner.fetch('/tracked')
    await vi.waitFor(() => expect(first.read).toHaveBeenCalledOnce())
    await tee.fetchOwner.fetch('/tracked')
    await Promise.resolve()
    expect(excess.clone).not.toHaveBeenCalled()

    first.next.resolve({ done: true, value: undefined })
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce())
    await tee.fetchOwner.fetch('/tracked')
    await vi.waitFor(() => expect(afterRelease.read).toHaveBeenCalledOnce())

    afterRelease.next.resolve({ done: true, value: undefined })
    await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(2))
  })

  it('enforces aggregate fetch bytes and cancels only the excess clone', async () => {
    const firstDone = deferred<ReadableStreamReadResult<Uint8Array>>()
    const firstRead = vi
      .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
      .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode('ab') })
      .mockImplementationOnce(() => firstDone.promise)
    const firstCancel = vi.fn<() => Promise<void>>(async () => {})
    const firstClone = vi.fn<() => unknown>(() => ({
      body: { getReader: () => ({ read: firstRead, cancel: firstCancel }) },
    }))
    const first = {
      ok: true,
      headers: new Headers(),
      clone: firstClone,
    } as unknown as Response
    const secondRead = vi
      .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
      .mockResolvedValue({ done: false, value: new TextEncoder().encode('cd') })
    const secondCancel = vi.fn<() => Promise<void>>(async () => {})
    const secondClone = vi.fn<() => unknown>(() => ({
      body: { getReader: () => ({ read: secondRead, cancel: secondCancel }) },
    }))
    const second = {
      ok: true,
      headers: new Headers(),
      clone: secondClone,
    } as unknown as Response
    const { tee, emit, fetchOwner } = makeTee({
      captureLimits: {
        maxCapturesInFlight: 2,
        maxBytesInFlight: 3,
      },
    })
    fetchOwner.fetch.mockResolvedValueOnce(first).mockResolvedValueOnce(second)
    installMainWorldResponseTee(tee)

    await tee.fetchOwner.fetch('/tracked')
    await vi.waitFor(() => expect(firstRead).toHaveBeenCalledTimes(2))
    await tee.fetchOwner.fetch('/tracked')
    await vi.waitFor(() => expect(secondCancel).toHaveBeenCalledOnce())

    expect(secondClone).toHaveBeenCalledOnce()
    expect(emit).not.toHaveBeenCalled()
    firstDone.resolve({ done: true, value: undefined })
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce())
    expect(emit).toHaveBeenCalledWith('/tracked', 'ab', '/route-a')
    expect(firstCancel).not.toHaveBeenCalled()
  })

  it('holds the aggregate permit until an overflowing clone finishes cancellation', async () => {
    const cancellation = deferred<void>()
    const overflowRead = vi
      .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
      .mockResolvedValue({ done: false, value: new Uint8Array([1, 2]) })
    const overflowCancel = vi.fn<() => Promise<void>>(() => cancellation.promise)
    const overflowClone = vi.fn<() => unknown>(() => ({
      body: { getReader: () => ({ read: overflowRead, cancel: overflowCancel }) },
    }))
    const overflow = {
      ok: true,
      headers: new Headers(),
      clone: overflowClone,
    } as unknown as Response
    const blocked = pendingResponse()
    const afterCancel = pendingResponse()
    const { tee, fetchOwner } = makeTee({
      captureLimits: { maxCapturesInFlight: 1, maxBytesInFlight: 1 },
    })
    fetchOwner.fetch
      .mockResolvedValueOnce(overflow)
      .mockResolvedValueOnce(blocked.response)
      .mockResolvedValueOnce(afterCancel.response)
    installMainWorldResponseTee(tee)

    await tee.fetchOwner.fetch('/tracked')
    await vi.waitFor(() => expect(overflowCancel).toHaveBeenCalledOnce())
    await tee.fetchOwner.fetch('/tracked')
    await Promise.resolve()
    expect(blocked.clone).not.toHaveBeenCalled()

    cancellation.resolve()
    await cancellation.promise
    await new Promise((resolve) => setTimeout(resolve, 0))
    await tee.fetchOwner.fetch('/tracked')
    await vi.waitFor(() => expect(afterCancel.read).toHaveBeenCalledOnce())
    afterCancel.next.resolve({ done: true, value: undefined })
  })

  it('drops a fetch clone from an oversized Content-Length without cloning it', async () => {
    const { tee, emit, fetchOwner } = makeTee()
    const response = new Response('small', {
      headers: { 'content-length': String(MAX_TEE_BODY_BYTES + 1) },
    })
    const clone = vi.spyOn(response, 'clone')
    fetchOwner.fetch.mockResolvedValue(response)
    installMainWorldResponseTee(tee)

    await tee.fetchOwner.fetch('/tracked')
    await Promise.resolve()

    expect(clone).not.toHaveBeenCalled()
    expect(emit).not.toHaveBeenCalled()
  })

  it('drops a streamed fetch clone over the cap and leaves its original readable', async () => {
    const body = `${'a'.repeat(MAX_TEE_BODY_BYTES)}b`
    const response = new Response(body)

    await expect(readBoundedUtf8Response(response)).resolves.toBeUndefined()
    await expect(response.text()).resolves.toBe(body)
  })

  it('drops malformed UTF-8 from a fetch clone', async () => {
    const response = new Response(new Uint8Array([0xc3, 0x28]))

    await expect(readBoundedUtf8Response(response)).resolves.toBeUndefined()
    await expect(response.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer)
  })

  it('cancels cloned streams on overflow and fatal UTF-8', async () => {
    const readOverflow = vi
      .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
      .mockResolvedValue({
        done: false,
        value: new Uint8Array(MAX_TEE_BODY_BYTES + 1),
      })
    const cancelOverflow = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const overflow = {
      headers: new Headers(),
      clone: () => ({
        body: { getReader: () => ({ read: readOverflow, cancel: cancelOverflow }) },
      }),
    } as unknown as Response

    await expect(readBoundedUtf8Response(overflow)).resolves.toBeUndefined()
    await vi.waitFor(() => expect(cancelOverflow).toHaveBeenCalledOnce())

    const readMalformed = vi
      .fn<() => Promise<ReadableStreamReadResult<Uint8Array>>>()
      .mockResolvedValueOnce({ done: false, value: new Uint8Array([0xc3, 0x28]) })
      .mockResolvedValueOnce({ done: true, value: undefined })
    const cancelMalformed = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const malformed = {
      headers: new Headers(),
      clone: () => ({
        body: { getReader: () => ({ read: readMalformed, cancel: cancelMalformed }) },
      }),
    } as unknown as Response

    await expect(readBoundedUtf8Response(malformed)).resolves.toBeUndefined()
    await vi.waitFor(() => expect(cancelMalformed).toHaveBeenCalledOnce())
  })

  it('does not read a definitely oversized or non-text XHR response', () => {
    const { tee, emit } = makeTee()
    installMainWorldResponseTee(tee)

    const oversized = new FakeXhr()
    oversized.responseText = 'must not read'
    oversized.contentLength = String(MAX_TEE_BODY_BYTES + 1)
    const oversizedText = Object.getOwnPropertyDescriptor(oversized, 'responseText')
    Object.defineProperty(oversized, 'responseText', {
      get: () => {
        throw new Error('responseText was read')
      },
    })
    oversized.open('GET', '/tracked')
    oversized.load()

    const binary = new FakeXhr()
    binary.responseType = 'arraybuffer'
    Object.defineProperty(binary, 'responseText', {
      get: () => {
        throw new Error('responseText was read')
      },
    })
    binary.open('GET', '/tracked')
    binary.load()

    expect(oversizedText).toBeDefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('keeps one XHR listener per active request and never replays a reused request', () => {
    const { tee, emit } = makeTee()
    installMainWorldResponseTee(tee)

    const xhr = new FakeXhr()
    xhr.responseText = '{"tracked":1}'
    xhr.open('GET', '/tracked')
    xhr.load()
    xhr.load()

    xhr.responseURL = 'https://x.com/account/settings'
    xhr.responseText = '{"private":1}'
    xhr.open('GET', '/not-tracked')
    xhr.load()

    xhr.responseURL = 'https://x.com/i/api/graphql/TweetDetail'
    xhr.responseText = '{"tracked":2}'
    xhr.open('GET', '/tracked')
    xhr.load()

    expect(xhr.listeners.get('load')).toEqual([])
    expect(xhr.listeners.get('loadend')).toEqual([])
    expect(emit.mock.calls).toEqual([
      ['/i/api/graphql/TweetDetail', '{"tracked":1}', '/route-a'],
      ['/i/api/graphql/TweetDetail', '{"tracked":2}', '/route-a'],
    ])
  })

  it('replaces an active XHR listener before reuse', () => {
    const { tee, emit } = makeTee()
    installMainWorldResponseTee(tee)

    const xhr = new FakeXhr()
    xhr.responseText = '{"latest":true}'
    xhr.open('GET', '/tracked')
    xhr.open('GET', '/tracked')
    expect(xhr.listeners.get('load')).toHaveLength(1)
    expect(xhr.listeners.get('loadend')).toHaveLength(1)

    xhr.load()

    expect(emit).toHaveBeenCalledOnce()
    expect(xhr.listeners.get('load')).toEqual([])
    expect(xhr.listeners.get('loadend')).toEqual([])
  })

  it('shares count and byte permits with XHR and releases them after every drop', () => {
    const { tee, emit } = makeTee({
      captureLimits: {
        maxCapturesInFlight: 1,
        maxBytesInFlight: 2,
      },
    })
    installMainWorldResponseTee(tee)

    const nested = new FakeXhr()
    nested.responseText = 'b'
    nested.open('GET', '/tracked')
    emit.mockImplementationOnce(() => nested.load())

    const outer = new FakeXhr()
    outer.responseText = 'a'
    outer.open('GET', '/tracked')
    outer.load()
    expect(emit).toHaveBeenCalledTimes(1)

    nested.open('GET', '/tracked')
    nested.responseText = 'abc'
    nested.load()
    expect(emit).toHaveBeenCalledTimes(1)

    nested.open('GET', '/tracked')
    nested.responseText = 'ab'
    nested.load()
    expect(emit).toHaveBeenCalledTimes(2)
    expect(nested.listeners.get('load')).toEqual([])
    expect(nested.listeners.get('loadend')).toEqual([])
  })

  it('emits text XHR bodies at the cap, preserves native open arguments, and rejects cap + 1', () => {
    const { tee, emit } = makeTee()
    installMainWorldResponseTee(tee)

    const atCap = new FakeXhr()
    atCap.responseText = 'a'.repeat(MAX_TEE_BODY_BYTES)
    atCap.open('GET', '/tracked', true)
    atCap.load()

    const overCap = new FakeXhr()
    overCap.responseText = `${'a'.repeat(MAX_TEE_BODY_BYTES)}b`
    overCap.open('POST', '/tracked', false)
    overCap.load()

    expect(atCap.openCalls).toEqual([['GET', '/tracked', true]])
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0]?.[0]).toBe('/i/api/graphql/TweetDetail')
    expect(emit.mock.calls[0]?.[1]).toHaveLength(MAX_TEE_BODY_BYTES)
    expect(emit.mock.calls[0]?.[2]).toBe('/route-a')
  })

  it('stamps a fetch before a later SPA navigation', async () => {
    let route = '/a'
    const { tee, emit, fetchOwner } = makeTee({ routeAtObservation: () => route })
    const reply = deferred<Response>()
    fetchOwner.fetch.mockReturnValue(reply.promise)
    installMainWorldResponseTee(tee)

    const result = tee.fetchOwner.fetch('/tracked')
    route = '/b'
    reply.resolve(new Response('{"old":true}'))

    await result
    await vi.waitFor(() => expect(emit).toHaveBeenCalledOnce())
    expect(emit).toHaveBeenCalledWith('/tracked', '{"old":true}', '/a')
  })

  it('stamps XHR before a later SPA navigation', () => {
    let route = '/a'
    const { tee, emit } = makeTee({ routeAtObservation: () => route })
    installMainWorldResponseTee(tee)

    const xhr = new FakeXhr()
    xhr.responseText = '{"old":true}'
    xhr.open('GET', '/tracked')
    route = '/b'
    xhr.load()

    expect(emit).toHaveBeenCalledWith('/i/api/graphql/TweetDetail', '{"old":true}', '/a')
  })

  it('replaces an invalidated tee without duplicate fetch or XHR emissions', async () => {
    const { tee: first, emit: firstEmit, fetchOwner } = makeTee()
    const disposeFirst = installMainWorldResponseTee(first)
    disposeFirst()

    const { tee: second, emit: secondEmit } = makeTee({ fetchOwner })
    const pageFetch = fetchOwner.fetch
    const disposeSecond = installMainWorldResponseTee(second)
    pageFetch.mockResolvedValue(new Response('{"fetch":true}'))

    await fetchOwner.fetch('/tracked')
    await vi.waitFor(() => expect(secondEmit).toHaveBeenCalledTimes(1))

    const xhr = new FakeXhr()
    xhr.responseText = '{"xhr":true}'
    xhr.open('GET', '/tracked')
    xhr.load()

    expect(firstEmit).not.toHaveBeenCalled()
    expect(secondEmit).toHaveBeenCalledTimes(2)
    expect(xhr.listeners.get('load')).toEqual([])
    expect(xhr.listeners.get('loadend')).toEqual([])
    disposeSecond()
  })

  it('restores the exact prior methods and leaves active XHR listeners to self-clean', () => {
    const { tee, fetchOwner } = makeTee()
    const priorFetch = fetchOwner.fetch
    const priorOpen = FakeXhr.prototype.open
    const dispose = installMainWorldResponseTee(tee)
    const xhr = new FakeXhr()

    xhr.open('GET', '/tracked')
    expect(xhr.listeners.get('load')).toHaveLength(1)
    expect(xhr.listeners.get('loadend')).toHaveLength(1)

    dispose()
    dispose()

    expect(fetchOwner.fetch).toBe(priorFetch)
    expect(FakeXhr.prototype.open).toBe(priorOpen)
    expect(xhr.listeners.get('load')).toHaveLength(1)
    xhr.load()
    expect(xhr.listeners.get('load')).toEqual([])
    expect(xhr.listeners.get('loadend')).toEqual([])
  })

  it('self-cleans XHR listeners after error and abort terminals', () => {
    const { tee } = makeTee()
    installMainWorldResponseTee(tee)

    const failed = new FakeXhr()
    failed.open('GET', '/tracked')
    failed.error()

    const aborted = new FakeXhr()
    aborted.open('GET', '/tracked')
    aborted.abort()

    for (const xhr of [failed, aborted]) {
      expect(xhr.listeners.get('load')).toEqual([])
      expect(xhr.listeners.get('loadend')).toEqual([])
    }
  })

  it('does not let a stale disposer remove a newer owner', async () => {
    const { tee: first, emit: firstEmit, fetchOwner } = makeTee()
    const priorFetch = fetchOwner.fetch
    const priorOpen = FakeXhr.prototype.open
    const disposeFirst = installMainWorldResponseTee(first)
    const firstXhr = new FakeXhr()
    firstXhr.open('GET', '/tracked')
    expect(firstXhr.listeners.get('load')).toHaveLength(1)
    const { tee: second, emit: secondEmit } = makeTee({ fetchOwner })
    const disposeSecond = installMainWorldResponseTee(second)

    disposeFirst()
    firstXhr.load()
    expect(firstXhr.listeners.get('load')).toEqual([])
    expect(firstXhr.listeners.get('loadend')).toEqual([])

    priorFetch.mockResolvedValue(new Response('{"fetch":true}'))
    await fetchOwner.fetch('/tracked')
    await vi.waitFor(() => expect(secondEmit).toHaveBeenCalledOnce())
    const xhr = new FakeXhr()
    xhr.responseText = '{"xhr":true}'
    xhr.open('GET', '/tracked')
    xhr.load()

    expect(firstEmit).not.toHaveBeenCalled()
    expect(secondEmit).toHaveBeenCalledTimes(2)
    disposeSecond()
    expect(fetchOwner.fetch).toBe(priorFetch)
    expect(FakeXhr.prototype.open).toBe(priorOpen)
  })

  it('counts UTF-8 without allocating an encoded copy', () => {
    expect(utf8ByteLengthAtMost('a¢€😀\ud800', 13)).toBe(13)
    expect(utf8ByteLengthAtMost('a¢€😀\ud800', 12)).toBeUndefined()
  })
})
