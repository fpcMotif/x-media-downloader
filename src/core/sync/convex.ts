/**
 * Minimal port over Convex's public HTTP API: `POST {deployment}/api/mutation`
 * with `{path, args, format: 'json'}` → `{status: 'success'|'error', …}`.
 * fetch-injected like the aria2 RPC port (ADR-0006) — no convex SDK and no
 * WebSocket client inside the MV3 service worker (ADR-0009).
 */
import { Data, Option } from 'effect'
import { bindFetch } from '../fetch'

export interface ConvexPort {
  readonly mutation: (path: string, args: Record<string, unknown>) => Promise<unknown>
}

/**
 * A non-2xx answer from the deployment edge. `status` is the HTTP code so the
 * popup classifier can switch on it structurally (e.g. 404 vs other 4xx vs 5xx)
 * instead of re-parsing a string. `message` mirrors the legacy `convex: HTTP N`
 * text so anything that reads `err.message` is unchanged.
 */
export class ConvexHttpError extends Data.TaggedError('ConvexHttpError')<{
  readonly status: number
}> {
  get message(): string {
    return `convex: HTTP ${this.status}`
  }
}

/**
 * A `200 {status:'error'}` Convex function error — the server's own
 * `errorMessage` (e.g. "Could not find public function…", "unauthorized…").
 */
export class ConvexFunctionError extends Data.TaggedError('ConvexFunctionError')<{
  readonly errorMessage: string
}> {
  get message(): string {
    return this.errorMessage
  }
}

/** A 200 whose body is not a well-formed Convex envelope (HTML page, junk JSON). */
export class ConvexMalformedError extends Data.TaggedError('ConvexMalformedError')<{
  readonly detail: string
}> {
  get message(): string {
    return this.detail
  }
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
 * `permissions.request({ origins })` call (aria2 precedent). Option of the
 * pattern; None if the URL is unparseable.
 */
export function convexOriginPattern(deploymentUrl: string): Option.Option<string> {
  try {
    const u = new URL(deploymentUrl)
    return Option.some(`${u.protocol}//${u.hostname}/*`)
  } catch {
    return Option.none()
  }
}

/** Build a ConvexPort backed by HTTP against a Convex deployment. */
export function makeConvexHttpPort(cfg: {
  readonly deploymentUrl: string
  readonly fetchImpl: typeof fetch
}): ConvexPort {
  const base = cfg.deploymentUrl.replace(/\/+$/, '')
  // Detach fetch from `cfg` or the MV3 SW rejects it with "Illegal invocation".
  const doFetch = bindFetch(cfg.fetchImpl)
  return {
    mutation: async (path, args) => {
      const res = await doFetch(`${base}/api/mutation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildFunctionCall(path, args)),
      })
      if (!res.ok) throw new ConvexHttpError({ status: res.status })
      // A 200 from a non-Convex host (parked domain, corp proxy, SPA index.html)
      // serves HTML, so `res.json()` throws a raw SyntaxError. Wrap it into the
      // same vocabulary as the other failures so the drain loop classifies it as a
      // sync error instead of surfacing an opaque parser stack trace.
      let body: { status?: string; value?: unknown; errorMessage?: string }
      try {
        body = (await res.json()) as { status?: string; value?: unknown; errorMessage?: string }
      } catch {
        throw new ConvexMalformedError({ detail: 'convex: malformed response (invalid JSON body)' })
      }
      if (body.status === 'error') {
        throw new ConvexFunctionError({
          errorMessage: body.errorMessage ?? 'convex: function error',
        })
      }
      if (body.status !== 'success')
        throw new ConvexMalformedError({ detail: 'convex: malformed response' })
      return body.value
    },
  }
}
