import { Effect } from 'effect'
import { DownloadError } from '../errors'
import type { DownloadStrategy, SaveRequest } from './strategy'

/** Minimal port over aria2's JSON-RPC `aria2.addUri`; resolves to the new gid. */
export interface Aria2RpcPort {
  readonly addUri: (urls: ReadonlyArray<string>, options: Record<string, string>) => Promise<string>
}

/** Tunables for the aria2 backend. `split` drives parallel connections per file. */
export interface Aria2Options {
  readonly dir?: string
  readonly split: number
}

/**
 * Translate a SaveRequest into aria2 options. `out` is the path relative to
 * `dir`, so subfolders in `req.filename` are preserved. `dir` is omitted when
 * empty so aria2 falls back to its configured default download directory.
 */
export function buildAria2Options(req: SaveRequest, opts: Aria2Options): Record<string, string> {
  return {
    out: req.filename,
    split: String(opts.split),
    'max-connection-per-server': String(opts.split),
    ...(opts.dir ? { dir: opts.dir } : {}),
  }
}

/**
 * Assemble a JSON-RPC 2.0 request envelope. The `token:<secret>` auth param is
 * prepended only when a secret is configured (aria2 omits it when unguarded).
 */
export function buildJsonRpcBody(
  method: string,
  params: ReadonlyArray<unknown>,
  secret: string,
): { jsonrpc: '2.0'; id: string; method: string; params: ReadonlyArray<unknown> } {
  return {
    jsonrpc: '2.0',
    id: 'xmd',
    method,
    params: secret ? ['token:' + secret, ...params] : [...params],
  }
}

/**
 * aria2 strategy (opt-in): hand the URL to a running aria2c daemon over
 * JSON-RPC for fast, resumable, multi-connection transfers to an arbitrary dir.
 */
export function makeAria2Strategy(port: Aria2RpcPort, opts: Aria2Options): DownloadStrategy {
  return {
    save: (req) =>
      Effect.tryPromise({
        try: () => port.addUri([req.url], buildAria2Options(req, opts)),
        catch: (cause) => new DownloadError({ id: req.id, reason: String(cause) }),
      }).pipe(Effect.map((gid) => ({ kind: 'aria2' as const, gid }))),
  }
}

/** Build an Aria2RpcPort backed by HTTP JSON-RPC against a running aria2c. */
export function makeAria2RpcPort(cfg: {
  readonly rpcUrl: string
  readonly secret: string
  readonly fetchImpl: typeof fetch
}): Aria2RpcPort {
  return {
    addUri: async (urls, options) => {
      const res = await cfg.fetchImpl(cfg.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildJsonRpcBody('aria2.addUri', [urls, options], cfg.secret)),
      })
      const body = (await res.json()) as {
        result?: string
        error?: { code?: number; message?: string }
      }
      if (body.error) throw new Error(body.error.message ?? `aria2 error ${body.error.code ?? '?'}`)
      if (typeof body.result !== 'string') throw new Error('aria2: malformed JSON-RPC response')
      return body.result
    },
  }
}
