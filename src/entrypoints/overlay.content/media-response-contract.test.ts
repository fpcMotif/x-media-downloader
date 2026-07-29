import { describe, expect, it, vi } from 'vitest'
import {
  decodeMediaResponse,
  decodeMediaResponseEvent,
  isMediaResponseForRoute,
  MAX_MEDIA_RESPONSE_PATH_BYTES,
  utf8ByteLengthAtMost,
} from './media-response-contract'
import { MAX_TEE_BODY_BYTES, MAX_TEE_ROUTE_BYTES } from '../../core/tee-contract'

describe('media response boundary', () => {
  it('accepts the exact, bounded payload emitted by the MAIN-world tee', () => {
    expect(
      decodeMediaResponse({ path: '/i/api/graphql', body: '{"ok":true}', route: '/home' }),
    ).toEqual({
      path: '/i/api/graphql',
      body: '{"ok":true}',
      route: '/home',
    })
  })

  it('rejects missing, extra, and non-string own detail fields', () => {
    expect(decodeMediaResponse(null)).toBeUndefined()
    expect(decodeMediaResponse({ path: '/x' })).toBeUndefined()
    expect(
      decodeMediaResponse({ path: '/x', body: '{}', route: '/home', extra: true }),
    ).toBeUndefined()
    expect(decodeMediaResponse({ path: '/x', body: 1, route: '/home' })).toBeUndefined()
    expect(decodeMediaResponse({ path: '/x', body: '{}', route: 1 })).toBeUndefined()
  })

  it('never invokes hostile accessors or proxies', () => {
    const getter = vi.fn<() => string>(() => '{"bad":true}')
    const accessor = Object.create(null, {
      path: { enumerable: true, value: '/x' },
      route: { enumerable: true, value: '/home' },
      body: { enumerable: true, get: getter },
    })
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('nope')
        },
      },
    )

    expect(decodeMediaResponse(accessor)).toBeUndefined()
    expect(getter).not.toHaveBeenCalled()
    expect(decodeMediaResponse(throwingProxy)).toBeUndefined()
  })

  it('contains a forged event detail getter', () => {
    const event = Object.create(Event.prototype, {
      detail: {
        get() {
          throw new Error('nope')
        },
      },
    }) as Event

    expect(decodeMediaResponseEvent(event)).toBeUndefined()
  })

  it('enforces UTF-8 byte caps before JSON parsing', () => {
    expect(
      decodeMediaResponse({
        path: `${'a'.repeat(MAX_MEDIA_RESPONSE_PATH_BYTES)}b`,
        body: '{}',
        route: '/home',
      }),
    ).toBeUndefined()
    expect(
      decodeMediaResponse({
        path: '/x',
        body: `${'a'.repeat(MAX_TEE_BODY_BYTES)}b`,
        route: '/home',
      }),
    ).toBeUndefined()
    expect(
      decodeMediaResponse({ path: '/x', body: '{}', route: `${'a'.repeat(MAX_TEE_ROUTE_BYTES)}b` }),
    ).toBeUndefined()
    expect(utf8ByteLengthAtMost('💾', 4)).toBe(true)
    expect(utf8ByteLengthAtMost('💾', 3)).toBe(false)
  })

  it('accepts only responses observed on the current route', () => {
    const response = { path: '/x', body: '{}', route: '/a' }
    expect(isMediaResponseForRoute(response, '/a')).toBe(true)
    expect(isMediaResponseForRoute(response, '/b')).toBe(false)
  })
})
