/**
 * Minimal port over Convex's public HTTP API: `POST {deployment}/api/mutation`
 * with `{path, args, format: 'json'}` → `{status: 'success'|'error', …}`.
 * fetch-injected like the aria2 RPC port (ADR-0006) — no convex SDK and no
 * WebSocket client inside the MV3 service worker (ADR-0009).
 */
export interface ConvexPort {
  readonly mutation: (path: string, args: Record<string, unknown>) => Promise<unknown>
}

export interface ConvexFunctionCall {
  readonly path: string
  readonly args: Record<string, unknown>
  readonly format: 'json'
}

export function buildFunctionCall(path: string, args: Record<string, unknown>): ConvexFunctionCall {
  return { path, args, format: 'json' }
}

/**
 * Chrome match-pattern for a deployment URL's origin, for a runtime
 * `permissions.request({ origins })` call (aria2 precedent). Null if the URL
 * is unparseable.
 */
export function convexOriginPattern(deploymentUrl: string): string | null {
  try {
    const u = new URL(deploymentUrl)
    return `${u.protocol}//${u.hostname}/*`
  } catch {
    return null
  }
}

/** Build a ConvexPort backed by HTTP against a Convex deployment. */
export function makeConvexHttpPort(cfg: {
  readonly deploymentUrl: string
  readonly fetchImpl: typeof fetch
}): ConvexPort {
  const base = cfg.deploymentUrl.replace(/\/+$/, '')
  return {
    mutation: async (path, args) => {
      const res = await cfg.fetchImpl(`${base}/api/mutation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildFunctionCall(path, args)),
      })
      if (!res.ok) throw new Error(`convex: HTTP ${res.status}`)
      const body = (await res.json()) as {
        status?: string
        value?: unknown
        errorMessage?: string
      }
      if (body.status === 'error') throw new Error(body.errorMessage ?? 'convex: function error')
      if (body.status !== 'success') throw new Error('convex: malformed response')
      return body.value
    },
  }
}
