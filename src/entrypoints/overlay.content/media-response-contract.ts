import { MAX_TEE_BODY_BYTES, MAX_TEE_ROUTE_BYTES } from '../../core/tee-contract'
import { utf8ByteLengthAtMost as measureUtf8AtMost } from '../../core/wire/utf8'

/** Longest response path accepted from the page world. */
export const MAX_MEDIA_RESPONSE_PATH_BYTES = MAX_TEE_ROUTE_BYTES

export type MediaResponse = {
  readonly path: string
  readonly body: string
  /** Page route when MAIN started the request, not when its clone completed. */
  readonly route: string
}

/**
 * Count UTF-8 bytes without allocating a second copy of an untrusted body.
 * Lone UTF-16 surrogates match TextEncoder's replacement-character behavior.
 */
export const utf8ByteLengthAtMost = (text: string, maxBytes: number): boolean =>
  measureUtf8AtMost(text, maxBytes) !== undefined

const ownDataString = (value: object, key: string): string | undefined => {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string')
      return undefined
    return descriptor.value
  } catch {
    return undefined
  }
}

/**
 * The document is a hostile ingress: any page script can forge this event.
 * Read only own data descriptors, reject every extra key, then bound bytes
 * before the caller attempts JSON.parse.
 */
export const decodeMediaResponse = (detail: unknown): MediaResponse | undefined => {
  if (typeof detail !== 'object' || detail === null) return undefined

  let keys: readonly PropertyKey[]
  try {
    keys = Reflect.ownKeys(detail)
  } catch {
    return undefined
  }
  if (
    keys.length !== 3 ||
    !keys.includes('path') ||
    !keys.includes('body') ||
    !keys.includes('route')
  )
    return undefined

  const path = ownDataString(detail, 'path')
  const body = ownDataString(detail, 'body')
  const route = ownDataString(detail, 'route')
  if (path === undefined || body === undefined || route === undefined) return undefined
  if (!utf8ByteLengthAtMost(path, MAX_MEDIA_RESPONSE_PATH_BYTES)) return undefined
  if (!utf8ByteLengthAtMost(body, MAX_TEE_BODY_BYTES)) return undefined
  if (!utf8ByteLengthAtMost(route, MAX_TEE_ROUTE_BYTES)) return undefined

  return { path, body, route }
}

/** Reject a reply that began on a prior SPA route. */
export const isMediaResponseForRoute = (response: MediaResponse, route: string): boolean =>
  response.route === route

/** Event.detail itself is also page-controlled on forged Event subclasses. */
export const decodeMediaResponseEvent = (event: Event): MediaResponse | undefined => {
  try {
    return decodeMediaResponse((event as CustomEvent<unknown>).detail)
  } catch {
    return undefined
  }
}
