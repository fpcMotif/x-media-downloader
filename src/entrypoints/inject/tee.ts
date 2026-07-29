import {
  MAX_TEE_BODY_BYTES,
  MAX_TEE_CAPTURES_IN_FLIGHT,
  MAX_TEE_ROUTE_BYTES,
} from '../../core/tee-contract'
import { utf8ByteLengthAtMost } from '../../core/wire/utf8'

export { MAX_TEE_BODY_BYTES, MAX_TEE_CAPTURES_IN_FLIGHT } from '../../core/tee-contract'
export { utf8ByteLengthAtMost } from '../../core/wire/utf8'

/** Input bytes retained by all active readers. Decoded strings remain bounded by this input. */
export const MAX_TEE_BYTES_IN_FLIGHT = MAX_TEE_BODY_BYTES * 2

type FetchOwner = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

type XhrPrototype = {
  open(this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]): void
}

type TeeOwner = { dispose: () => void }

// MAIN-world scripts can be re-evaluated by WXT, so this page-global key—not
// module state—finds the prior installer during delayed invalidation.
const TEE_OWNER = Symbol.for('xmd.main-world-response-tee.owner.v1')

const isTeeOwner = (value: unknown): value is TeeOwner =>
  typeof value === 'object' && value !== null && typeof (value as TeeOwner).dispose === 'function'

const ownerFor = (fetchOwner: FetchOwner): TeeOwner | undefined => {
  try {
    const value = (fetchOwner as unknown as Record<symbol, unknown>)[TEE_OWNER]
    return isTeeOwner(value) ? value : undefined
  } catch {
    return undefined
  }
}

export interface TeeCaptureLimits {
  readonly maxCapturesInFlight: number
  readonly maxBytesInFlight: number
}

export type MainWorldResponseTee = {
  readonly fetchOwner: FetchOwner
  readonly xhrPrototype: XhrPrototype
  readonly origin: string
  readonly isTrackedUrl: (url: string) => boolean
  /** Captured before the request starts; stale replies must retain this route. */
  readonly routeAtObservation: () => string
  readonly emit: (path: string, body: string, route: string) => void
  /** Test seam. Production uses the exported bounded defaults. */
  readonly captureLimits?: Partial<TeeCaptureLimits>
}

const contentLengthExceeds = (value: string | null, maxBytes: number): boolean => {
  if (value === null || !/^[0-9]+$/u.test(value.trim())) return false

  const bytes = Number(value)
  return Number.isSafeInteger(bytes) && bytes > maxBytes
}

const cancel = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> => {
  try {
    await reader.cancel()
  } catch {
    // The clone is advisory. Never expose its failure to the page request.
  }
}

interface CaptureLease {
  readonly reserve: (bytes: number) => boolean
  readonly release: () => void
}

const positiveSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${name}`)
  return value
}

/** One shared count + byte budget for every fetch and XHR observation. */
const makeCaptureBudget = (limits: Partial<TeeCaptureLimits> = {}) => {
  const maxCaptures = positiveSafeInteger(
    limits.maxCapturesInFlight ?? MAX_TEE_CAPTURES_IN_FLIGHT,
    'tee capture count',
  )
  const maxBytes = positiveSafeInteger(
    limits.maxBytesInFlight ?? MAX_TEE_BYTES_IN_FLIGHT,
    'tee capture byte limit',
  )
  let captures = 0
  let bytes = 0

  return {
    acquire: (): CaptureLease | undefined => {
      if (captures >= maxCaptures) return undefined
      captures += 1
      let ownedBytes = 0
      let released = false
      return {
        reserve: (amount) => {
          if (released || !Number.isSafeInteger(amount) || amount < 0 || amount > maxBytes - bytes)
            return false
          bytes += amount
          ownedBytes += amount
          return true
        },
        release: () => {
          if (released) return
          released = true
          captures -= 1
          bytes -= ownedBytes
        },
      }
    },
  }
}

const readBoundedUtf8ResponseWithBudget = async (
  response: Response,
  maxBytes: number,
  reserveBytes?: (bytes: number) => boolean,
): Promise<string | undefined> => {
  let clone: Response
  try {
    if (contentLengthExceeds(response.headers.get('content-length'), maxBytes)) return undefined
    clone = response.clone()
  } catch {
    return undefined
  }

  const reader = clone.body?.getReader()
  if (!reader) return undefined

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parts: string[] = []
  let bytes = 0

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- Reader pulls must remain ordered; parallel reads violate stream semantics.
      const next = await reader.read()
      if (next.done) {
        parts.push(decoder.decode())
        return parts.join('')
      }

      const chunkBytes = next.value.byteLength
      if (
        chunkBytes > maxBytes - bytes ||
        (reserveBytes !== undefined && !reserveBytes(chunkBytes))
      ) {
        // Keep the aggregate lease until the clone confirms cancellation.
        // oxlint-disable-next-line no-await-in-loop -- Cancellation must complete before this ordered stream exits.
        await cancel(reader)
        return undefined
      }
      bytes += chunkBytes

      parts.push(decoder.decode(next.value, { stream: true }))
    }
  } catch {
    await cancel(reader)
    return undefined
  }
}

/** Reads a clone only. The original Response remains wholly page-owned. */
export const readBoundedUtf8Response = (
  response: Response,
  maxBytes = MAX_TEE_BODY_BYTES,
): Promise<string | undefined> => readBoundedUtf8ResponseWithBudget(response, maxBytes)

const isTextXhr = (responseType: XMLHttpRequestResponseType): boolean =>
  responseType === '' || responseType === 'text'

const pathFor = (url: string, origin: string): string | undefined => {
  try {
    return new URL(url, origin).pathname
  } catch {
    return undefined
  }
}

const routeAtObservation = (tee: MainWorldResponseTee): string | undefined => {
  const route = tee.routeAtObservation()
  return utf8ByteLengthAtMost(route, MAX_TEE_ROUTE_BYTES) === undefined ? undefined : route
}

/**
 * Install a passive, bounded tee. It only observes successful tracked requests;
 * every auxiliary failure is swallowed so page networking keeps its native result.
 *
 * The returned disposer owns only the wrappers and listeners installed by this
 * call. It is safe to call repeatedly and never overwrites a newer installer.
 */
export const installMainWorldResponseTee = (tee: MainWorldResponseTee): (() => void) => {
  // Dispose the old owner before reading the slots we will restore. This avoids
  // chains when WXT has injected the new MAIN-world script before invalidating
  // the old one.
  ownerFor(tee.fetchOwner)?.dispose()

  const budget = makeCaptureBudget(tee.captureLimits)
  const currentXhrIsTracked = new WeakMap<XMLHttpRequest, boolean>()
  const currentXhrRoute = new WeakMap<XMLHttpRequest, string>()
  const xhrListeners = new WeakMap<XMLHttpRequest, { load: () => void; loadend: () => void }>()
  let disposed = false

  const observeFetchResponse = async (
    response: Response,
    requestUrl: string,
    route: string,
  ): Promise<void> => {
    let lease: CaptureLease | undefined
    try {
      if (disposed) return
      if (!response.ok) return
      lease = budget.acquire()
      if (lease === undefined) return

      const body = await readBoundedUtf8ResponseWithBudget(
        response,
        MAX_TEE_BODY_BYTES,
        lease.reserve,
      )
      if (body === undefined) return

      const path = pathFor(requestUrl, tee.origin)
      if (!disposed && path !== undefined) tee.emit(path, body, route)
    } catch {
      // The observer must not create an unhandled page-world rejection.
    } finally {
      lease?.release()
    }
  }

  const detachXhr = (xhr: XMLHttpRequest): void => {
    const listeners = xhrListeners.get(xhr)
    if (listeners === undefined) return
    xhrListeners.delete(xhr)
    try {
      xhr.removeEventListener('load', listeners.load)
      xhr.removeEventListener('loadend', listeners.loadend)
    } catch {
      // A page-modified EventTarget must not change native lifecycle cleanup.
    }
  }

  const observeXhr = (xhr: XMLHttpRequest): void => {
    if (disposed) return
    const onLoad = () => {
      detachXhr(xhr)
      if (disposed || currentXhrIsTracked.get(xhr) !== true) return
      // One request owns one observation. Repeated or synthetic load events
      // cannot replay it, and the next open writes its own state.
      currentXhrIsTracked.set(xhr, false)
      const route = currentXhrRoute.get(xhr)
      currentXhrRoute.delete(xhr)
      if (route === undefined) return
      try {
        if (
          xhr.status !== 200 ||
          !isTextXhr(xhr.responseType) ||
          contentLengthExceeds(xhr.getResponseHeader('content-length'), MAX_TEE_BODY_BYTES)
        ) {
          return
        }

        const lease = budget.acquire()
        if (lease === undefined) return
        try {
          const body = xhr.responseText
          const bodyBytes = utf8ByteLengthAtMost(body, MAX_TEE_BODY_BYTES)
          if (bodyBytes === undefined || !lease.reserve(bodyBytes)) return

          const path = pathFor(xhr.responseURL, tee.origin)
          if (!disposed && path !== undefined) tee.emit(path, body, route)
        } finally {
          lease.release()
        }
      } catch {
        // Reading a page-owned response must never change page behavior.
      }
    }
    const onLoadEnd = () => detachXhr(xhr)
    const listeners = { load: onLoad, loadend: onLoadEnd }
    try {
      xhrListeners.set(xhr, listeners)
      xhr.addEventListener('load', onLoad)
      xhr.addEventListener('loadend', onLoadEnd)
    } catch {
      detachXhr(xhr)
      // A page-modified EventTarget must not change native open behavior.
    }
  }

  const originalOpen = tee.xhrPrototype.open
  const patchedOpen: XhrPrototype['open'] = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ): void {
    // Fail closed before native open can abort or replace a prior request.
    detachXhr(this)
    currentXhrIsTracked.set(this, false)
    currentXhrRoute.delete(this)
    let tracked = false
    let route: string | undefined
    try {
      tracked = tee.isTrackedUrl(String(url))
      if (tracked) route = routeAtObservation(tee)
    } catch {
      // Preserve native open even if a hostile URL object throws while stringified.
    }

    originalOpen.apply(this, [method, url, ...rest])
    if (tracked && route !== undefined) {
      currentXhrIsTracked.set(this, true)
      currentXhrRoute.set(this, route)
      observeXhr(this)
    }
  }
  tee.xhrPrototype.open = patchedOpen

  const originalFetch = tee.fetchOwner.fetch
  const patchedFetch: FetchOwner['fetch'] = (input, init) => {
    let requestUrl: string | undefined
    let route: string | undefined
    if (!disposed) {
      try {
        requestUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (tee.isTrackedUrl(requestUrl)) route = routeAtObservation(tee)
      } catch {
        // Do not change a page fetch when request inspection itself fails.
      }
    }

    const result = originalFetch.call(tee.fetchOwner, input, init)
    if (requestUrl !== undefined && route !== undefined)
      void result.then(
        (response) => observeFetchResponse(response, requestUrl, route),
        () => undefined,
      )

    return result
  }
  tee.fetchOwner.fetch = patchedFetch

  const owner: TeeOwner = {
    dispose: () => dispose(),
  }
  try {
    Object.defineProperty(tee.fetchOwner, TEE_OWNER, {
      configurable: true,
      value: owner,
    })
  } catch {
    // A hostile non-extensible owner still gets scoped, ownership-guarded cleanup.
  }

  const dispose = () => {
    if (disposed) return
    disposed = true

    if (tee.fetchOwner.fetch === patchedFetch) tee.fetchOwner.fetch = originalFetch
    if (tee.xhrPrototype.open === patchedOpen) tee.xhrPrototype.open = originalOpen
    try {
      const slots = tee.fetchOwner as unknown as Record<symbol, unknown>
      if (slots[TEE_OWNER] === owner) delete slots[TEE_OWNER]
    } catch {
      // Metadata cleanup must not change page networking behavior.
    }
  }

  return dispose
}
