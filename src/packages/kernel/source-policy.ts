export const X_MEDIA_HOSTS: ReadonlyArray<{
  readonly host: string
  readonly includeSubdomains: boolean
}> = [
  { host: 'pbs.twimg.com', includeSubdomains: false },
  { host: 'video.twimg.com', includeSubdomains: false },
]
export const META_MEDIA_HOSTS: ReadonlyArray<{
  readonly host: string
  readonly includeSubdomains: boolean
}> = [{ host: 'cdninstagram.com', includeSubdomains: true }]

export class UnsafeSourceUrlError extends Error {}

export function validateSourceUrl(
  raw: string,
  hosts: ReadonlyArray<{ readonly host: string; readonly includeSubdomains: boolean }>,
): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeSourceUrlError('Malformed media source URL')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.port !== '' && url.port !== '443') ||
    !hosts.some(
      (entry) =>
        url.hostname === entry.host ||
        (entry.includeSubdomains && url.hostname.endsWith(`.${entry.host}`)),
    )
  )
    throw new UnsafeSourceUrlError('Unsafe media source URL')
  return url
}

export class SourceRedirectLimitError extends Error {}

export async function fetchSource(
  raw: string,
  init: RequestInit,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  validate: (url: string) => URL,
  remaining = 5,
): Promise<Response> {
  const url = validate(raw)
  const response = await fetchImpl(url.toString(), {
    ...init,
    credentials: 'omit',
    redirect: 'manual',
  })
  if (response.status < 300 || response.status >= 400) return response
  const location = response.headers.get('location')
  if (!location) return response
  await response.body?.cancel()
  if (remaining === 0) throw new SourceRedirectLimitError('Too many media redirects')
  return await fetchSource(
    new URL(location, url).toString(),
    init,
    fetchImpl,
    validate,
    remaining - 1,
  )
}
