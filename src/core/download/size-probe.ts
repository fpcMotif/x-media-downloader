import { makeMediaFetchPort } from '../media-url-policy'

export interface ProbeResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
}

export const SIZE_PROBE_TIMEOUT_MS = 10_000

export type ProbeFetch = (
  url: string,
  init: { readonly method: 'HEAD'; readonly signal: AbortSignal },
) => Promise<ProbeResponse>

export interface SizeProbePort {
  /** Probed byte size from content-length, or null when unknown/unavailable (never throws). */
  readonly probe: (url: string) => Promise<number | null>
}

/** Adapt native fetch to the same guarded, redirect-rejecting media path as GET. */
export function makeGuardedProbeFetch(fetchImpl: typeof fetch): ProbeFetch {
  const media = makeMediaFetchPort(fetchImpl)
  return (url, init) => media.fetch(url, init)
}

export function makeSizeProbe(deps: {
  readonly fetch: ProbeFetch
  readonly timeoutMs?: number
}): SizeProbePort {
  return {
    probe: async (url) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? SIZE_PROBE_TIMEOUT_MS)
      try {
        const res = await deps.fetch(url, { method: 'HEAD', signal: controller.signal })
        if (!res.ok) return null
        const raw = res.headers.get('content-length')
        if (raw === null) return null
        const size = Number(raw)
        return Number.isSafeInteger(size) && size > 0 ? size : null
      } catch {
        return null
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}
