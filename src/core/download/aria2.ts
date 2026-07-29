import { Cause, Effect, Layer, Option } from 'effect'
import { FetchService } from '../fetch-service'
import { DownloadError, Aria2RpcError } from '../errors'
import { errorReason } from '../error'
import { boundedDiagnosticText, MAX_DIAGNOSTIC_TEXT_LENGTH } from '../diagnostic-text'
import { readBoundedJson } from '../http/bounded-response'
import type { DownloadStrategy, SaveRequest } from './strategy'

/** Minimal port over aria2's JSON-RPC `aria2.addUri`; resolves to the new gid.
 *  Reads the shared `FetchService` from `R` (ADR-0017) — no `fetchImpl` thread. */
export interface Aria2RpcPort {
  readonly addUri: (
    urls: ReadonlyArray<string>,
    options: Record<string, string>,
  ) => Effect.Effect<string, Aria2RpcError, FetchService>
  readonly tellStatus: (gid: string) => Effect.Effect<Aria2Status, Aria2RpcError, FetchService>
}

export type Aria2Status =
  | {
      readonly gid: string
      readonly status: 'active' | 'waiting' | 'paused'
      readonly completedLength: string
      readonly totalLength: string
    }
  | {
      readonly gid: string
      readonly status: 'complete' | 'error' | 'removed'
      readonly completedLength: string
      readonly totalLength: string
      readonly errorCode?: string
      readonly errorMessage?: string
    }

/** Persistence-safe protocol bounds. Exported for the transfer registry codec. */
export const ARIA2_DECIMAL_MAX_DIGITS = 32
export const ARIA2_ERROR_CODE_MAX_LENGTH = 32
export const ARIA2_ERROR_MESSAGE_MAX_LENGTH = MAX_DIAGNOSTIC_TEXT_LENGTH
/** JSON-RPC control replies contain one GID/status record, never file bytes. */
export const MAX_ARIA2_RESPONSE_BYTES = 64 * 1024

/** aria2 GIDs are 16 hexadecimal characters; its all-zero sentinel is reserved. */
export const isAria2Gid = (value: unknown): value is string =>
  typeof value === 'string' && /^(?!0{16}$)[0-9a-fA-F]{16}$/.test(value)

export const normalizeAria2Gid = (value: unknown): string | undefined =>
  isAria2Gid(value) ? value.toLowerCase() : undefined

/** Build the optional `gid` accepted by `aria2.addUri`; rejects reserved or malformed IDs. */
export function buildAria2GidOption(gid: string): Record<'gid', string> {
  const normalized = normalizeAria2Gid(gid)
  if (normalized === undefined)
    throw new TypeError('aria2 gid must be 16 non-zero hexadecimal characters')
  return { gid: normalized }
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
 * JSON-RPC. The port reads `FetchService` from `R`; this strategy provides it
 * once at construction (the composition edge), so `save` stays `R = never` and
 * satisfies {@link DownloadStrategy} like the other strategies.
 */
export function makeAria2Strategy(
  port: Aria2RpcPort,
  opts: Aria2Options,
  fetch: Layer.Layer<FetchService>,
  reservedGid?: (request: SaveRequest) => string | undefined,
): DownloadStrategy {
  return {
    save: (req) => {
      const expected = reservedGid?.(req)
      const gidOption = expected === undefined ? undefined : buildAria2GidOption(expected)
      return port
        .addUri([req.url], {
          ...buildAria2Options(req, opts),
          ...gidOption,
        })
        .pipe(
          Effect.flatMap((gid) =>
            gidOption !== undefined && gid !== gidOption.gid
              ? new Aria2RpcError({ message: 'aria2 returned an unexpected gid' })
              : Effect.succeed({ kind: 'aria2' as const, gid }),
          ),
          Effect.catchCause(
            (cause) => new DownloadError({ id: req.id, reason: errorReason(Cause.squash(cause)) }),
          ),
          Effect.provide(fetch),
        )
    },
  }
}

/** Build an Aria2RpcPort backed by HTTP JSON-RPC against a running aria2c. */
export function makeAria2RpcPort(cfg: {
  readonly rpcUrl: string
  readonly secret: string
}): Aria2RpcPort {
  const call = (method: string, params: ReadonlyArray<unknown>) =>
    Effect.gen(function* () {
      const http = yield* FetchService
      const res = yield* http
        .fetch(cfg.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(buildJsonRpcBody(method, params, cfg.secret)),
        })
        .pipe(
          Effect.catchTag(
            'FetchError',
            (e) => new Aria2RpcError({ message: boundedDiagnosticText(e.message) }),
          ),
        )
      const body = yield* Effect.tryPromise({
        try: () => readBoundedJson(res, MAX_ARIA2_RESPONSE_BYTES),
        catch: () => new Aria2RpcError({ message: 'aria2: malformed JSON-RPC response' }),
      })
      return yield* decodeJsonRpcEnvelope(body)
    })

  return {
    addUri: (urls, options) =>
      Effect.gen(function* () {
        const result = yield* call('aria2.addUri', [urls, options])
        const gid = normalizeAria2Gid(result)
        if (gid === undefined)
          return yield* new Aria2RpcError({ message: 'aria2: malformed JSON-RPC response' })
        return gid
      }),
    tellStatus: (gid) => {
      const normalizedGid = normalizeAria2Gid(gid)
      if (normalizedGid === undefined) return malformedResponse()
      return call('aria2.tellStatus', [
        normalizedGid,
        ['gid', 'status', 'completedLength', 'totalLength', 'errorCode', 'errorMessage'],
      ]).pipe(
        Effect.flatMap((result) => {
          const status = decodeAria2Status(result, normalizedGid)
          return status
            ? Effect.succeed(status)
            : new Aria2RpcError({ message: 'aria2: malformed JSON-RPC response' })
        }),
      )
    },
  }
}

const malformedResponse = () => new Aria2RpcError({ message: 'aria2: malformed JSON-RPC response' })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

/** Decode the shared JSON-RPC envelope before each method validates its result. */
function decodeJsonRpcEnvelope(body: unknown): Effect.Effect<unknown, Aria2RpcError> {
  if (!isRecord(body)) return malformedResponse()
  if (body.jsonrpc !== '2.0' || body.id !== 'xmd') return malformedResponse()
  if (hasExactKeys(body, ['jsonrpc', 'id', 'error'])) {
    const error = body.error
    if (!isRecord(error) || !hasExactKeys(error, ['code', 'message'])) return malformedResponse()
    const code = error.code
    const message = error.message
    if (typeof code !== 'number' || !Number.isSafeInteger(code)) return malformedResponse()
    if (
      typeof message !== 'string' ||
      message.trim().length === 0 ||
      message.length > ARIA2_ERROR_MESSAGE_MAX_LENGTH
    )
      return malformedResponse()
    return new Aria2RpcError({ message, code })
  }
  return hasExactKeys(body, ['jsonrpc', 'id', 'result'])
    ? Effect.succeed(body.result)
    : malformedResponse()
}

const statusValues = new Set(['active', 'waiting', 'paused', 'error', 'complete', 'removed'])
const statusKeys = new Set([
  'gid',
  'status',
  'completedLength',
  'totalLength',
  'errorCode',
  'errorMessage',
])
const isCanonicalDecimal = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= ARIA2_DECIMAL_MAX_DIGITS &&
  /^(0|[1-9][0-9]*)$/.test(value)
const isBoundedErrorCode = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= ARIA2_ERROR_CODE_MAX_LENGTH &&
  /^(0|[1-9][0-9]*)$/.test(value)
const isBoundedErrorMessage = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= ARIA2_ERROR_MESSAGE_MAX_LENGTH
const isAria2StatusValue = (value: unknown): value is Aria2Status['status'] =>
  typeof value === 'string' && statusValues.has(value)

function decodeAria2Status(result: unknown, requestedGid: string): Aria2Status | undefined {
  if (!isRecord(result) || Object.keys(result).some((key) => !statusKeys.has(key))) return undefined
  const { gid, status, completedLength, totalLength, errorCode, errorMessage } = result
  if (
    gid !== requestedGid ||
    !isAria2StatusValue(status) ||
    !isCanonicalDecimal(completedLength) ||
    !isCanonicalDecimal(totalLength)
  )
    return undefined
  const hasErrorCode = Object.hasOwn(result, 'errorCode')
  const hasErrorMessage = Object.hasOwn(result, 'errorMessage')
  if (
    (hasErrorCode && !isBoundedErrorCode(errorCode)) ||
    (hasErrorMessage && !isBoundedErrorMessage(errorMessage))
  )
    return undefined
  if (
    (hasErrorCode || hasErrorMessage) &&
    status !== 'complete' &&
    status !== 'error' &&
    status !== 'removed'
  )
    return undefined
  const base = { gid, status, completedLength, totalLength }
  return status === 'complete' || status === 'error' || status === 'removed'
    ? {
        ...base,
        ...(hasErrorCode ? { errorCode: errorCode as string } : {}),
        ...(hasErrorMessage ? { errorMessage: errorMessage as string } : {}),
      }
    : base
}
