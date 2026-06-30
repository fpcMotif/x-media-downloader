export interface ProbeResponse {
  readonly ok: boolean
  readonly status: number
  readonly headers: { get(name: string): string | null }
}

export type ProbeFetch = (url: string, init: { method: 'HEAD' }) => Promise<ProbeResponse>

export interface SizeProbePort {
  /** Probed byte size from content-length, or null when unknown/unavailable (never throws). */
  readonly probe: (url: string) => Promise<number | null>
}

export function makeSizeProbe(deps: { fetch: ProbeFetch }): SizeProbePort {
  return {
    probe: async (url) => {
      try {
        const res = await deps.fetch(url, { method: 'HEAD' })
        if (!res.ok) return null
        const raw = res.headers.get('content-length')
        if (raw === null) return null
        const size = Number(raw)
        return Number.isFinite(size) && size > 0 ? size : null
      } catch {
        return null
      }
    },
  }
}
