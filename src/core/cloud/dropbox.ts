import { Cause, Context, Effect, Layer } from 'effect'
import { errorReason } from '../error'
import { streamInChunks } from './chunk'
import {
  authHeader,
  CloudHttpError,
  discardResponseBody,
  errText,
  okJson,
  readControlJson,
  runUpload,
} from './http'
import { FetchService } from '../fetch-service'
import { SourceFetch } from './source-fetch'
import { parseSource } from './source'
import {
  MAX_CLOUD_REMOTE_ID_LENGTH,
  MAX_DROPBOX_API_PATH_LENGTH,
  type BlobAttemptAdvance,
  type RemoteAttempt,
  type UploadInput,
  type UploadOutcome,
} from './types'
import {
  controlRecord,
  controlSafeInteger,
  controlString,
  optionalControlString,
} from './control-json'
import { MAX_DIAGNOSTIC_TEXT_LENGTH } from '../diagnostic-text'

/**
 * Dropbox v2 upload adapter (ADR-0013 §5, ADR-0017). Small media
 * (≤ SIMPLE_MAX_BYTES) goes via `/2/files/upload`; larger/unknown-size media
 * streams through an upload session (`start` → `append_v2` → `finish`) in 4 MiB-
 * multiple chunks — never buffering a whole video. A `DropboxUploader` service
 * whose layer depends on `FetchService` + `SourceFetch` (no folder cache).
 */

const CONTENT = 'https://content.dropboxapi.com/2'
const CONTROL = 'https://api.dropboxapi.com/2'
/** A valid Dropbox session chunk is a 4 MiB multiple; 2 × 4 MiB = 8 MiB. */
const SESSION_CHUNK = 2 * 4 * 1024 * 1024
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

export interface DropboxArgs {
  readonly accessToken: string
}

const base64Url = (bytes: Uint8Array): string => {
  let out = ''
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const a = bytes[offset]!
    const b = bytes[offset + 1]
    const c = bytes[offset + 2]
    out += BASE64URL[a >> 2]
    out += BASE64URL[((a & 3) << 4) | ((b ?? 0) >> 4)]
    if (b !== undefined) out += BASE64URL[((b & 15) << 2) | ((c ?? 0) >> 6)]
    if (c !== undefined) out += BASE64URL[c & 63]
  }
  return out
}

/** Fixed-size, job-owned staging path. A SHA-256 digest keeps every allowed
 * Unicode job id inside Dropbox's path bound without truncating identity. */
export const dropboxStagePath = async (jobId: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(jobId))
  return `/.xmd-stage/v2/${base64Url(new Uint8Array(digest))}`
}

const canonicalPath = (path: string): string => `/${path.replace(/^\/+/u, '')}`.toLowerCase()

interface FileMetadata {
  readonly '.tag'?: string
  readonly id?: string
  readonly size?: number
  readonly path_display?: string
  readonly path_lower?: string
  readonly rev?: string
  readonly content_hash?: string
}

const fileMetadata = (value: unknown, label = 'Dropbox metadata'): FileMetadata => {
  const record = controlRecord(value, label)
  const tag = optionalControlString(record['.tag'], `${label} tag`, 32)
  const id = optionalControlString(record.id, `${label} id`, MAX_CLOUD_REMOTE_ID_LENGTH)
  const pathDisplay = optionalControlString(
    record.path_display,
    `${label} display path`,
    MAX_DROPBOX_API_PATH_LENGTH,
  )
  const pathLower = optionalControlString(
    record.path_lower,
    `${label} lower path`,
    MAX_DROPBOX_API_PATH_LENGTH,
  )
  const rev = optionalControlString(record.rev, `${label} revision`, MAX_CLOUD_REMOTE_ID_LENGTH)
  const contentHash = optionalControlString(record.content_hash, `${label} content hash`, 64)
  return {
    ...(tag === undefined ? {} : { '.tag': tag }),
    ...(id === undefined ? {} : { id }),
    ...(record.size === undefined
      ? {}
      : { size: controlSafeInteger(record.size, `${label} size`) }),
    ...(pathDisplay === undefined ? {} : { path_display: pathDisplay }),
    ...(pathLower === undefined ? {} : { path_lower: pathLower }),
    ...(rev === undefined ? {} : { rev }),
    ...(contentHash === undefined ? {} : { content_hash: contentHash }),
  }
}

const metadataEnvelope = (value: unknown, label: string): FileMetadata => {
  const record = controlRecord(value, label)
  return fileMetadata(record.metadata, `${label} metadata`)
}

const sessionIdEnvelope = (value: unknown): string =>
  controlString(
    controlRecord(value, 'Dropbox session start').session_id,
    'Dropbox session id',
    MAX_CLOUD_REMOTE_ID_LENGTH,
  )

/** Dropbox-API-Arg must be ASCII; escape any non-ASCII char as \uXXXX. */
function asciiArg(obj: unknown): string {
  // oxlint-disable-next-line no-control-regex -- intentionally match all non-ASCII
  return JSON.stringify(obj).replace(/[^\x00-\x7F]/g, (c) => {
    const code = c.charCodeAt(0)
    return `\\u${code.toString(16).padStart(4, '0')}`
  })
}

const commitInfo = (path: string) => ({
  path,
  mode: 'add',
  autorename: false,
  strict_conflict: false,
  mute: false,
})

interface DropboxProof {
  readonly fileId: string
  readonly rev: string
  readonly contentHash: string
  readonly bytes: number
  readonly pathLower: string
}

interface StageUploadSuccess extends Extract<UploadOutcome, { readonly kind: 'success' }> {
  readonly proof: DropboxProof
}

const fileProof = (meta: FileMetadata): DropboxProof => {
  if (
    (meta['.tag'] !== undefined && meta['.tag'] !== 'file') ||
    meta.id === undefined ||
    meta.id === '' ||
    meta.rev === undefined ||
    meta.rev === '' ||
    meta.content_hash === undefined ||
    !/^[\da-f]{64}$/u.test(meta.content_hash) ||
    meta.path_lower === undefined ||
    meta.path_lower === '' ||
    !Number.isSafeInteger(meta.size) ||
    (meta.size ?? -1) < 0
  )
    throw new Error('dropbox: file metadata proof is incomplete')
  return {
    fileId: meta.id,
    rev: meta.rev,
    contentHash: meta.content_hash,
    bytes: meta.size!,
    pathLower: meta.path_lower,
  }
}

const stageSuccess = (meta: FileMetadata, stagePath: string): StageUploadSuccess => {
  const proof = fileProof(meta)
  if (proof.pathLower !== canonicalPath(stagePath))
    throw new Error('dropbox: upload returned a different staging path')
  return {
    kind: 'success',
    bytes: proof.bytes,
    remotePath: stagePath,
    remoteId: proof.fileId,
    proof,
  }
}

const targetPath = (input: UploadInput): string => `/${input.target.path.replace(/^\/+/u, '')}`

const parentPaths = (filePath: string): ReadonlyArray<string> => {
  const parts = filePath.replace(/^\/+/u, '').split('/')
  const paths: string[] = []
  for (let index = 1; index < parts.length; index += 1)
    paths.push(`/${parts.slice(0, index).join('/')}`)
  return paths
}

const sameStagedBlob = (
  proof: DropboxProof,
  attempt: Extract<RemoteAttempt, { readonly kind: 'dropbox'; readonly phase: 'staged' }>,
): boolean =>
  proof.fileId === attempt.fileId &&
  proof.rev === attempt.rev &&
  proof.contentHash === attempt.contentHash &&
  proof.bytes === attempt.bytes

/** Read the error body, then fail with a tagged Dropbox HTTP error. */
const dropboxFail = (res: Response): Effect.Effect<never, CloudHttpError> =>
  Effect.promise(() => errText(res)).pipe(
    Effect.flatMap((body) => new CloudHttpError({ provider: 'dropbox', status: res.status, body })),
  )

export class DropboxUploader extends Context.Service<
  DropboxUploader,
  {
    readonly prepare: (jobId: string, ownerKey: string) => Promise<RemoteAttempt>
    readonly advance: (
      args: DropboxArgs,
      input: UploadInput,
      attempt: RemoteAttempt,
    ) => Effect.Effect<BlobAttemptAdvance>
  }
>()('cloud/DropboxUploader') {}

export const DropboxUploaderLive = Layer.effect(
  DropboxUploader,
  Effect.gen(function* () {
    const http = yield* FetchService
    const source = yield* SourceFetch

    /** Promise RPC for the session loop (reused inside streamInChunks' sink). */
    const rpc = (
      accessToken: string,
      endpoint: string,
      arg: unknown,
      body: Uint8Array<ArrayBuffer>,
    ): Promise<Response> =>
      http.fetchPromise(`${CONTENT}/${endpoint}`, {
        method: 'POST',
        headers: {
          ...authHeader(accessToken),
          'dropbox-api-arg': asciiArg(arg),
          'content-type': 'application/octet-stream',
        },
        body,
      })

    const control = (
      accessToken: string,
      endpoint: string,
      arg: unknown,
    ): Effect.Effect<Response, never, never> =>
      http
        .fetch(`${CONTROL}/${endpoint}`, {
          method: 'POST',
          headers: { ...authHeader(accessToken), 'content-type': 'application/json' },
          body: JSON.stringify(arg),
        })
        .pipe(
          Effect.catchTag('FetchError', (error) =>
            Effect.die(new Error(`dropbox: ${error.message}`)),
          ),
        )

    const getMetadata = (
      accessToken: string,
      pathOrId: string,
    ): Effect.Effect<FileMetadata, CloudHttpError> =>
      Effect.gen(function* () {
        const res = yield* control(accessToken, 'files/get_metadata', {
          path: pathOrId,
          include_deleted: false,
        })
        if (!res.ok) return yield* dropboxFail(res)
        return fileMetadata(yield* okJson(res))
      })

    const probeMetadata = (
      accessToken: string,
      path: string,
    ): Effect.Effect<FileMetadata | null, CloudHttpError> =>
      Effect.gen(function* () {
        const res = yield* control(accessToken, 'files/get_metadata', {
          path,
          include_deleted: false,
        })
        if (res.ok) return fileMetadata(yield* okJson(res))
        if (res.status !== 409) return yield* dropboxFail(res)
        const body = controlRecord(
          yield* Effect.promise(() => readControlJson(res)),
          'Dropbox error',
        )
        const error =
          body.error === undefined ? undefined : controlRecord(body.error, 'Dropbox error detail')
        const pathError =
          error?.path === undefined ? undefined : controlRecord(error.path, 'Dropbox path error')
        const errorTag = optionalControlString(error?.['.tag'], 'Dropbox error tag', 64)
        const pathTag = optionalControlString(pathError?.['.tag'], 'Dropbox path error tag', 64)
        if (errorTag === 'path' && pathTag === 'not_found') return null
        const summary = optionalControlString(
          body.error_summary,
          'Dropbox error summary',
          MAX_DIAGNOSTIC_TEXT_LENGTH,
        )
        return yield* new CloudHttpError({
          provider: 'dropbox',
          status: 409,
          body: summary ?? 'metadata conflict',
        })
      })

    const ensureParentFolders = (
      accessToken: string,
      filePath: string,
    ): Effect.Effect<void, CloudHttpError> =>
      Effect.gen(function* () {
        for (const path of parentPaths(filePath)) {
          const res = yield* control(accessToken, 'files/create_folder_v2', {
            path,
            autorename: false,
          })
          if (res.ok) {
            yield* Effect.promise(() => discardResponseBody(res))
            continue
          }
          if (res.status !== 409) return yield* dropboxFail(res)
          yield* Effect.promise(() => discardResponseBody(res))
          const existing = yield* getMetadata(accessToken, path)
          if (existing['.tag'] !== 'folder')
            return yield* new CloudHttpError({
              provider: 'dropbox',
              status: 409,
              body: `parent path is not a folder: ${path}`,
            })
        }
      })

    const moveFile = (
      accessToken: string,
      fileId: string,
      destination: string,
    ): Effect.Effect<FileMetadata, CloudHttpError> =>
      Effect.gen(function* () {
        const res = yield* control(accessToken, 'files/move_v2', {
          from_path: fileId,
          to_path: destination,
          autorename: false,
          allow_ownership_transfer: false,
        })
        if (!res.ok) return yield* dropboxFail(res)
        return metadataEnvelope(yield* okJson(res), 'Dropbox move')
      })

    const simpleUpload = (
      accessToken: string,
      bytes: Uint8Array<ArrayBuffer>,
      path: string,
    ): Effect.Effect<FileMetadata, CloudHttpError> =>
      Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () => rpc(accessToken, 'files/upload', commitInfo(path), bytes),
          // A single-upload rpc only rejects on a transport failure — a non-2xx is a
          // resolved Response handled by dropboxFail below, never thrown — so (unlike
          // the session sink) it is never a CloudHttpError.
          catch: (e) => new CloudHttpError({ provider: 'dropbox', status: 0, body: String(e) }),
        })
        if (!res.ok) return yield* dropboxFail(res)
        return fileMetadata(yield* okJson(res))
      })

    /**
     * Streamed upload session, the proven loop reused verbatim inside one
     * tryPromise. Always ≥ 2 chunks in practice, but the single-chunk edge
     * (unknown size that turns out small) is handled: start with close=true then
     * finish with an empty commit body at the final offset.
     */
    const sessionUpload = (
      accessToken: string,
      body: ReadableStream<Uint8Array>,
      path: string,
    ): Effect.Effect<{ meta: FileMetadata; bytes: number }, CloudHttpError> =>
      Effect.tryPromise({
        try: async () => {
          let sessionId: string | null = null
          let cursorOffset = 0
          let meta: FileMetadata | null = null
          let startedClosed = false

          const total = await streamInChunks(body, SESSION_CHUNK, async (chunk, info) => {
            if (sessionId === null) {
              const res = await rpc(
                accessToken,
                'files/upload_session/start',
                { close: info.isLast },
                chunk,
              )
              if (!res.ok)
                throw new CloudHttpError({
                  provider: 'dropbox',
                  status: res.status,
                  body: await errText(res),
                })
              sessionId = sessionIdEnvelope(await readControlJson(res))
              cursorOffset = chunk.length
              startedClosed = info.isLast
              return
            }
            const cursor = { session_id: sessionId, offset: cursorOffset }
            if (info.isLast) {
              const res = await rpc(
                accessToken,
                'files/upload_session/finish',
                { cursor, commit: commitInfo(path) },
                chunk,
              )
              if (!res.ok)
                throw new CloudHttpError({
                  provider: 'dropbox',
                  status: res.status,
                  body: await errText(res),
                })
              meta = fileMetadata(await readControlJson(res))
              cursorOffset += chunk.length
              return
            }
            const res = await rpc(
              accessToken,
              'files/upload_session/append_v2',
              { cursor, close: false },
              chunk,
            )
            if (!res.ok)
              throw new CloudHttpError({
                provider: 'dropbox',
                status: res.status,
                body: await errText(res),
              })
            await discardResponseBody(res)
            cursorOffset += chunk.length
          })

          // Single-chunk session: start(close:true) ran but finish never did — commit now.
          if (meta === null && sessionId !== null && startedClosed) {
            const res = await rpc(
              accessToken,
              'files/upload_session/finish',
              { cursor: { session_id: sessionId, offset: cursorOffset }, commit: commitInfo(path) },
              new Uint8Array(0),
            )
            if (!res.ok)
              throw new CloudHttpError({
                provider: 'dropbox',
                status: res.status,
                body: await errText(res),
              })
            meta = fileMetadata(await readControlJson(res))
          }
          /* v8 ignore next -- streamInChunks always emits a final chunk, so meta is set */
          if (meta === null) throw new Error('dropbox: session finished without metadata')
          return { meta, bytes: total }
        },
        catch: (e) =>
          e instanceof CloudHttpError
            ? e
            : new CloudHttpError({ provider: 'dropbox', status: 0, body: String(e) }),
      })

    const uploadStage = (
      args: DropboxArgs,
      input: UploadInput,
      stagePath: string,
    ): Effect.Effect<StageUploadSuccess | Exclude<UploadOutcome, { readonly kind: 'success' }>> =>
      runUpload(parseSource(input).pipe(Effect.provideService(SourceFetch, source)), {
        simple: (bytes) =>
          simpleUpload(args.accessToken, bytes, stagePath).pipe(
            Effect.map((meta) => stageSuccess(meta, stagePath)),
          ),
        streamed: (body) =>
          sessionUpload(args.accessToken, body, stagePath).pipe(
            Effect.map(({ meta, bytes }) => ({
              outcome: stageSuccess(meta, stagePath),
              bytes,
            })),
          ),
      })

    const prepare = async (jobId: string, ownerKey: string): Promise<RemoteAttempt> => ({
      kind: 'dropbox',
      phase: 'prepared',
      ownerKey,
      stagePath: await dropboxStagePath(jobId),
    })

    const advanceOperation = (
      args: DropboxArgs,
      input: UploadInput,
      attempt: Extract<RemoteAttempt, { readonly kind: 'dropbox' }>,
    ): Effect.Effect<BlobAttemptAdvance, CloudHttpError> =>
      Effect.gen(function* () {
        const destination = targetPath(input)
        if (canonicalPath(destination).startsWith('/.xmd-stage/'))
          return {
            kind: 'failure',
            reason: 'dropbox: destination uses the reserved .xmd-stage namespace',
          }
        if (attempt.phase === 'prepared') {
          const existing = yield* probeMetadata(args.accessToken, attempt.stagePath)
          if (existing !== null) {
            const proof = fileProof(existing)
            if (proof.pathLower !== canonicalPath(attempt.stagePath))
              return {
                kind: 'failure',
                reason: 'dropbox: staged path resolved to a different file path',
              }
            return {
              kind: 'progress',
              attempt: {
                ...attempt,
                phase: 'staged',
                fileId: proof.fileId,
                rev: proof.rev,
                contentHash: proof.contentHash,
                bytes: proof.bytes,
              },
            }
          }
          yield* ensureParentFolders(args.accessToken, attempt.stagePath)
          const uploaded = yield* uploadStage(args, input, attempt.stagePath)
          if (uploaded.kind !== 'success') return uploaded
          return {
            kind: 'progress',
            attempt: {
              ...attempt,
              phase: 'staged',
              fileId: uploaded.proof.fileId,
              rev: uploaded.proof.rev,
              contentHash: uploaded.proof.contentHash,
              bytes: uploaded.proof.bytes,
            },
          }
        }

        const current = fileProof(yield* getMetadata(args.accessToken, attempt.fileId))
        if (!sameStagedBlob(current, attempt))
          return {
            kind: 'failure',
            reason: 'dropbox: staged file changed; refusing to move or overwrite it',
          }
        const targetLower = canonicalPath(destination)
        if (current.pathLower === targetLower)
          return {
            kind: 'success',
            bytes: current.bytes,
            remoteId: current.fileId,
            remotePath: input.target.path,
          }
        if (current.pathLower !== canonicalPath(attempt.stagePath))
          return {
            kind: 'success',
            bytes: current.bytes,
            remoteId: current.fileId,
            remotePath: input.target.path,
          }

        yield* ensureParentFolders(args.accessToken, destination)
        const moved = fileProof(yield* moveFile(args.accessToken, attempt.fileId, destination))
        if (!sameStagedBlob(moved, attempt) || moved.pathLower !== targetLower)
          return {
            kind: 'failure',
            reason: 'dropbox: move returned a different file proof',
          }
        return {
          kind: 'success',
          bytes: moved.bytes,
          remoteId: moved.fileId,
          remotePath: input.target.path,
        }
      })

    const advance = (
      args: DropboxArgs,
      input: UploadInput,
      attempt: RemoteAttempt,
    ): Effect.Effect<BlobAttemptAdvance> => {
      if (attempt.kind !== 'dropbox')
        return Effect.succeed({
          kind: 'failure',
          reason: 'dropbox: remote attempt belongs to another provider',
        })
      return advanceOperation(args, input, attempt).pipe(
        Effect.catchTag('CloudHttpError', (error) =>
          Effect.succeed<BlobAttemptAdvance>({
            kind: 'failure',
            reason: error.message,
            status: error.status,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed<BlobAttemptAdvance>({
            kind: 'failure',
            reason: errorReason(Cause.squash(cause)),
          }),
        ),
      )
    }

    return { prepare, advance }
  }),
)
