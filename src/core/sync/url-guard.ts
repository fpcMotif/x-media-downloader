import { Data } from 'effect'
import { bindFetch } from '../fetch'

/**
 * SSRF guard for the cloud-destinations byte path (ADR-0013 §5.3). The extension
 * (and any server-side fetcher) must dereference *only* X's public media CDNs and
 * nothing else — never an internal address reached via a crafted or redirected URL.
 *
 * `assertAllowedMediaUrl` is a pure check (no I/O); `guardedFetch` is the single
 * egress wrapper that re-runs the check on every redirect hop. Validate both a
 * Media Item's `url` and its `previewUrl` (use `assertAllowedMediaUrls`).
 */
export class UnsafeUrlError extends Data.TaggedError('UnsafeUrlError')<{
  readonly url: string
  readonly reason: string
}> {}

/** Exact hostnames — X's public media CDNs. Suffix/subdomain look-alikes are rejected. */
const ALLOWED_HOSTS: ReadonlySet<string> = new Set(['pbs.twimg.com', 'video.twimg.com'])

/** Default redirect-hop ceiling for {@link guardedFetch}. */
export const MAX_REDIRECTS = 5

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
  // Defense in depth: WHATWG URL parsing already rejects out-of-range octets
  // (`new URL('https://999.1.1.1/')` throws) before this runs, so this guard is
  // unreachable via assertAllowedMediaUrl — but kept as a fail-closed invariant.
  /* v8 ignore next */
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true // malformed → unsafe
  if (a === 0 || a === 10 || a === 127) return true // this-network, RFC-1918 /8, loopback
  if (a === 169 && b === 254) return true // link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // RFC-1918 /12
  if (a === 192 && b === 168) return true // RFC-1918 /16
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT /10
  return false
}

/**
 * Throw {@link UnsafeUrlError} unless `raw` is an https URL on the exact media-CDN
 * allow-list, with no credentials, default port, and no IP-literal host. Returns
 * the parsed {@link URL} on success.
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
  if (!ALLOWED_HOSTS.has(host)) return reject(raw, `host not on allow-list: ${host}`)
  return u
}

/** Validate every present url (e.g. a Media Item's `url` and `previewUrl`); undefined is skipped. */
export function assertAllowedMediaUrls(...urls: ReadonlyArray<string | undefined>): void {
  for (const url of urls) {
    if (url !== undefined) assertAllowedMediaUrl(url)
  }
}

/**
 * The only sanctioned way to fetch a media CDN URL. Guards the initial URL, fetches
 * with `redirect: 'manual'`, and re-runs the full guard on each `Location` before
 * following it — so a redirect can never escape the allow-list. Bounded by `maxHops`.
 */
export async function guardedFetch(
  raw: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  maxHops: number = MAX_REDIRECTS,
): Promise<Response> {
  // Detach the bare global fetch or the MV3 SW rejects it with "Illegal invocation" (see bindFetch).
  const doFetch = bindFetch(fetchImpl)
  let current = assertAllowedMediaUrl(raw)
  for (let hop = 0; hop <= maxHops; hop += 1) {
    // redirects are inherently sequential — each hop depends on the previous Location
    // oxlint-disable-next-line no-await-in-loop
    const res = await doFetch(current.toString(), { ...init, redirect: 'manual' })
    const redirected = res.status >= 300 && res.status < 400
    if (!redirected) return res
    const location = res.headers.get('location')
    if (location === null || location === '') return res // redirect without a target — hand back as-is
    current = assertAllowedMediaUrl(new URL(location, current).toString())
  }
  return reject(raw, `too many redirects (> ${maxHops})`)
}
