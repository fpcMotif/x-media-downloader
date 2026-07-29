import { Data } from 'effect'
import { isCdnHostnameForAnyPlatform } from './adapters/catalog'
import { bindFetch } from './fetch'

/**
 * Media-byte URL policy. Worker-owned network reads accept only a registered
 * platform CDN and reject redirects. The Fetch API hides redirect locations from
 * non-navigation JavaScript, so manual per-hop validation would be false security.
 *
 * Direct and aria2 only hand off a validated initial URL. Chrome or the daemon
 * owns the later network path and its redirect policy.
 */
export class UnsafeUrlError extends Data.TaggedError('UnsafeUrlError')<{
  readonly url: string
  readonly reason: string
}> {}

const reject = (url: string, reason: string): never => {
  throw new UnsafeUrlError({ url, reason })
}

/** Is `host` an IP literal (IPv4 dotted-quad or any bracketed/colon IPv6)? */
function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')
}

/** A private / loopback / link-local / CGNAT / metadata IPv4 literal. */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  // Defense in depth: WHATWG URL parsing rejects out-of-range octets first.
  /* v8 ignore next */
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

/**
 * Throw {@link UnsafeUrlError} unless `raw` is an https URL on the exact media-CDN
 * allow-list, with no credentials, default port, and no IP-literal host.
 */
export function assertAllowedMediaUrl(raw: string): URL {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return reject(raw, 'unparseable url')
  }
  if (u.protocol !== 'https:') return reject(raw, `non-https scheme: ${u.protocol}`)
  if (u.username !== '' || u.password !== '') return reject(raw, 'embedded credentials')
  if (u.port !== '' && u.port !== '443') return reject(raw, `non-443 port: ${u.port}`)

  const host = u.hostname
  if (isIpLiteral(host)) {
    return reject(
      raw,
      isPrivateIpv4(host) ? 'private/link-local ip' : 'ip-literal host not allowed',
    )
  }
  if (!isCdnHostnameForAnyPlatform(host)) return reject(raw, `host not on allow-list: ${host}`)
  return u
}

/** Validate every present media URL; undefined is skipped. */
export function assertAllowedMediaUrls(...urls: ReadonlyArray<string | undefined>): void {
  for (const url of urls) {
    if (url !== undefined) assertAllowedMediaUrl(url)
  }
}

export interface MediaFetchRequest {
  readonly method?: 'GET' | 'HEAD'
  readonly signal?: AbortSignal
}

export interface MediaFetchPort {
  /**
   * Fetch one validated media response. The caller owns the returned final body.
   * Redirects fail before another URL is dereferenced.
   */
  readonly fetch: (url: string, request?: MediaFetchRequest) => Promise<Response>
}

async function cancelResponse(response: Response, reason: unknown): Promise<void> {
  if (response.body === null) return
  try {
    await response.body.cancel(reason)
  } catch {
    // Cleanup must not replace the policy error.
  }
}

/**
 * Build the sole worker-owned media egress. `redirect: "error"` is deliberate:
 * Fetch exposes manual redirects as opaque responses with no readable Location.
 */
export function makeMediaFetchPort(fetchImpl: typeof fetch): MediaFetchPort {
  // Detach the bare global fetch or the MV3 SW rejects it with "Illegal invocation".
  const doFetch = bindFetch(fetchImpl)
  return {
    fetch: async (raw, request = {}) => {
      const url = assertAllowedMediaUrl(raw)
      const response = await doFetch(url.toString(), { ...request, redirect: 'error' })

      // A conforming Fetch implementation rejects redirects. Keep injected and
      // test transports fail-closed if they ignore redirect mode.
      if (
        response.type === 'opaqueredirect' ||
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      ) {
        const error = new UnsafeUrlError({ url: raw, reason: 'redirects are not allowed' })
        await cancelResponse(response, error)
        throw error
      }
      return response
    },
  }
}

/** Convenience wrapper for callers that do not retain a port. */
export const guardedFetch = (
  raw: string,
  request: MediaFetchRequest,
  fetchImpl: typeof fetch,
): Promise<Response> => makeMediaFetchPort(fetchImpl).fetch(raw, request)
