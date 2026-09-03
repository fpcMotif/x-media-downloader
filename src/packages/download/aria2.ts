import { Cause, Effect, Layer, Option } from 'effect'
import { FetchService } from '@/packages/kernel/fetch-service'
import { DownloadError, Aria2RpcError } from './lib/errors'
import { errorReason } from '@/packages/kernel/error'
import type { DownloadStrategy, SaveRequest } from './strategy'
import { type JsonValue, isJsonObject } from '@/packages/schema'

/** Narrow one field of a parsed JSON-RPC response to a string/number.
 *  `| undefined` because every property read off a `JsonObject` index
 *  signature can be absent (`noUncheckedIndexedAccess`) — a missing key is
 *  exactly as untrustworthy as a present-but-wrong-shaped one. */
const isJsonString = (value: JsonValue | undefined): value is string => typeof value === 'string'
const isJsonNumber = (value: JsonValue | undefined): value is number => typeof value === 'number'

/** Minimal port over aria2's JSON-RPC `aria2.addUri`; resolves to the new gid.
 *  Reads the shared `FetchService` from `R` (ADR-0017) — no `fetchImpl` thread. */
export interface Aria2RpcPort {
  readonly addUri: (
    urls: ReadonlyArray<string>,
    options: Record<string, string>,
  ) => Effect.Effect<string, Aria2RpcError, FetchService>
}

/** Tunables for the aria2 backend. `split` drives parallel connections per file. */
export interface Aria2Options {
  readonly dir?: string
  readonly split: number
}

/**
 * Chrome match-pattern for an aria2 RPC URL's origin, suitable for a runtime
 * `permissions.request({ origins })` call. Host-only — match patterns omit the
 * port (`http://localhost:6800/jsonrpc` → `http://localhost/*`). None if the URL
 * is unparseable.
 */
export function aria2OriginPattern(rpcUrl: string): Option.Option<string> {
  try {
    const u = new URL(rpcUrl)
    return Option.some(`${u.protocol}//${u.hostname}/*`)
  } catch {
    return Option.none()
  }
}

/** The literal `addUri` options this module ever sends. A `type` alias — not an
 *  `interface` — so it satisfies {@link Aria2RpcPort}'s `Record<string, string>`
 *  parameter structurally, the same way a fresh object literal would. */
export type Aria2AddUriOptions = {
  readonly out: string
  readonly split: string
  readonly 'max-connection-per-server': string
  readonly dir?: string
}

/**
 * Translate a SaveRequest into aria2 options. `out` is the path relative to
 * `dir`, so subfolders in `req.filename` are preserved. `dir` is omitted when
 * empty so aria2 falls back to its configured default download directory.
 */
export function buildAria2Options(req: SaveRequest, opts: Aria2Options): Aria2AddUriOptions {
  return {
    out: req.filename,
    split: String(opts.split),
    'max-connection-per-server': String(opts.split),
    ...(opts.dir ? { dir: opts.dir } : {}),
  }
}

/** The JSON-RPC 2.0 envelope {@link buildJsonRpcBody} assembles. */
export type Aria2JsonRpcBody = {
  readonly jsonrpc: '2.0'
  readonly id: string
  readonly method: string
  readonly params: ReadonlyArray<unknown>
}

/**
 * Assemble a JSON-RPC 2.0 request envelope. The `token:<secret>` auth param is
 * prepended only when a secret is configured (aria2 omits it when unguarded).
 */
export function buildJsonRpcBody(
  method: string,
  params: ReadonlyArray<unknown>,
  secret: string,
): Aria2JsonRpcBody {
  return {
    jsonrpc: '2.0',
    id: 'xmd',
    method,
    params: secret ? ['token:' + secret, ...params] : [...params],
  }
}

/**
 * aria2 strategy (opt-in): hand the URL to a running aria2c daemon over
 * JSON-RPC. The port reads `FetchService` from `R`; this strategy provides it
 * once at construction (the composition edge), so `save` stays `R = never` and
 * satisfies {@link DownloadStrategy} like the other strategies.
 */
export function makeAria2Strategy(
  port: Aria2RpcPort,
  opts: Aria2Options,
  fetch: Layer.Layer<FetchService>,
): DownloadStrategy {
  return {
    save: (req) =>
      port.addUri([req.url], buildAria2Options(req, opts)).pipe(
        Effect.map((gid) => ({ kind: 'aria2' as const, gid })),
        Effect.catchCause((cause) => {
          const squashed = Cause.squash(cause)
          const reason = squashed instanceof Error ? squashed : String(squashed)
          return new DownloadError({ id: req.id, reason: errorReason(reason) })
        }),
        Effect.provide(fetch),
      ),
  }
}

/** Build an Aria2RpcPort backed by HTTP JSON-RPC against a running aria2c. */
export function makeAria2RpcPort(cfg: {
  readonly rpcUrl: string
  readonly secret: string
}): Aria2RpcPort {
  return {
    addUri: (urls, options) =>
      Effect.gen(function* () {
        const http = yield* FetchService
        const res = yield* http
          .fetch(cfg.rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(buildJsonRpcBody('aria2.addUri', [urls, options], cfg.secret)),
          })
          .pipe(Effect.catchTag('FetchError', (e) => new Aria2RpcError({ message: e.message })))
        const body = yield* Effect.tryPromise({
          try: (): Promise<JsonValue> => res.json(),
          catch: () => new Aria2RpcError({ message: 'aria2: malformed JSON-RPC response' }),
        })
        if (!isJsonObject(body))
          return yield* new Aria2RpcError({ message: 'aria2: malformed JSON-RPC response' })
        if (body.error !== undefined && isJsonObject(body.error)) {
          const { message, code } = body.error
          return yield* new Aria2RpcError({
            message: isJsonString(message)
              ? message
              : `aria2 error ${isJsonNumber(code) ? code : '?'}`,
            ...(isJsonNumber(code) ? { code } : {}),
          })
        }
        if (!isJsonString(body.result))
          return yield* new Aria2RpcError({ message: 'aria2: malformed JSON-RPC response' })
        return body.result
      }),
  }
}
