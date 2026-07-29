import { Cause, Context, Effect, Layer, Option } from 'effect'
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
import { FetchService, type FetchError } from '../fetch-service'
import { FolderCache } from './folder-cache'
import { SourceFetch } from './source-fetch'
import { parseSource } from './source'
import { MAX_CLOUD_REMOTE_ID_LENGTH, type UploadInput, type UploadOutcome } from './types'
import {
  controlArray,
  controlRecord,
  controlString,
  optionalControlBoolean,
  optionalControlString,
} from './control-json'

/**
 * Google Drive v3 upload adapter (ADR-0013 §5, ADR-0017). Small media
 * (≤ SIMPLE_MAX_BYTES) goes via one multipart request; larger/unknown-size media
 * streams through a resumable session in 256 KiB-multiple chunks — never buffering
 * a whole video. Files land in a single per-platform folder (e.g. `twitter`) at the
 * My Drive root — no app-root wrapper and no per-handle subfolder.
 *
 * Decomposed as a `DriveUploader` service whose layer depends on `FetchService`,
 * `SourceFetch`, and `FolderCache`; per-upload `accessToken`/`rootFolderId` are
 * method args. The services are resolved once when the layer is built, so
 * `upload`/`ensureRoot` are `R = never` and run on the shared cloud runtime.
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files'
const FILES_BASE = 'https://www.googleapis.com/drive/v3/files'
/** A valid Drive resumable chunk is a 256 KiB multiple; 32 × 256 KiB = 8 MiB. */
const RESUMABLE_CHUNK = 32 * 256 * 1024

const driveId = (value: unknown, label: string): string =>
  controlString(value, label, MAX_CLOUD_REMOTE_ID_LENGTH)

const driveIdEnvelope = (value: unknown, label: string): string => {
  const record = controlRecord(value, label)
  if (record.id === undefined || record.id === '') throw new Error(`${label} returned no id`)
  return driveId(record.id, `${label} id`)
}

const driveFiles = (value: unknown, maximum: number): readonly string[] => {
  const record = controlRecord(value, 'Drive file list')
  if (record.files === undefined) return []
  return controlArray(record.files, 'Drive files', maximum).map((file, index) =>
    driveId(controlRecord(file, `Drive file ${index}`).id, `Drive file ${index} id`),
  )
}

const queryLiteral = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")

interface DriveFileProof {
  readonly id: string
  readonly size?: string
  readonly trashed?: boolean
}

const driveFileProof = (value: unknown): DriveFileProof => {
  const record = controlRecord(value, 'Drive file proof')
  const size = optionalControlString(record.size, 'Drive file proof size', 32)
  const trashed = optionalControlBoolean(record.trashed, 'Drive file proof trashed')
  return {
    id: driveId(record.id, 'Drive file proof id'),
    ...(size === undefined ? {} : { size }),
    ...(trashed === undefined ? {} : { trashed }),
  }
}

const proofSuccess = (
  proof: DriveFileProof,
  expectedId: string,
  remotePath: string,
): UploadOutcome => {
  const bytes = proof.size === undefined ? Number.NaN : Number(proof.size)
  if (
    proof.id !== expectedId ||
    proof.trashed === true ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0
  )
    return {
      kind: 'failure',
      reason: `drive: file ${expectedId} exists but its proof is invalid`,
    }
  return { kind: 'success', bytes, remotePath, remoteId: expectedId }
}

export interface DriveArgs {
  readonly accessToken: string
  readonly rootFolderId: string
}

/** Read the error body, then fail with a tagged Drive HTTP error. */
const driveFail = (res: Response): Effect.Effect<never, CloudHttpError> =>
  Effect.promise(() => errText(res)).pipe(
    Effect.flatMap((body) => new CloudHttpError({ provider: 'drive', status: res.status, body })),
  )

export class DriveUploader extends Context.Service<
  DriveUploader,
  {
    /** Allocate provider identity. The caller persists it before `advance`. */
    readonly generateFileId: (
      accessToken: string,
    ) => Effect.Effect<string, CloudHttpError | FetchError>
    /** Reconcile by id, then create with that same id only when absent. */
    readonly advance: (
      args: DriveArgs,
      input: UploadInput,
      fileId: string,
    ) => Effect.Effect<UploadOutcome>
    /** Resolve the My Drive root folder id (the parent destination folders are
     *  created under); the id is persisted by the caller and reused per SW life. */
    readonly ensureRoot: (accessToken: string) => Effect.Effect<string, CloudHttpError | FetchError>
  }
>()('cloud/DriveUploader') {}

export const DriveUploaderLive = Layer.effect(
  DriveUploader,
  Effect.gen(function* () {
    const http = yield* FetchService
    const source = yield* SourceFetch
    const cache = yield* FolderCache

    /** Lookup-or-create a folder named `name` under `parentId` (a real folder id or
     *  the `'root'` alias). Scoping the query to `parentId` stops a common name like
     *  `twitter` from matching an unrelated folder elsewhere in the Drive; with full
     *  Drive scope it also finds a pre-existing folder so re-runs don't duplicate it. */
    const findFolder = (
      accessToken: string,
      name: string,
      parentId: string,
    ): Effect.Effect<string | null, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const q = [
          `name='${queryLiteral(name)}'`,
          `mimeType='${FOLDER_MIME}'`,
          'trashed=false',
          `'${queryLiteral(parentId)}' in parents`,
        ].join(' and ')
        const res = yield* http.fetch(
          `${FILES_BASE}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=2`,
          { headers: authHeader(accessToken) },
        )
        if (!res.ok) return yield* driveFail(res)
        const files = driveFiles(yield* okJson(res), 2)
        if (files.length > 1)
          return yield* new CloudHttpError({
            provider: 'drive',
            status: 409,
            body: `multiple destination folders are named ${name}`,
          })
        return files[0] ?? null
      })

    const ensureFolder = (
      accessToken: string,
      name: string,
      parentId: string,
    ): Effect.Effect<string, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const found = yield* findFolder(accessToken, name, parentId)
        if (found !== null) return found
        const created = yield* http.fetch(`${FILES_BASE}?fields=id`, {
          method: 'POST',
          headers: { ...authHeader(accessToken), 'content-type': 'application/json' },
          body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
        })
        if (!created.ok) return yield* driveFail(created)
        return driveIdEnvelope(yield* okJson(created), 'Drive folder create')
      })

    /** Lookup-or-create the destination folder (e.g. `twitter`) at the My Drive
     *  root, memoized on the runtime's Ref so repeated uploads resolve it once. */
    const resolveFolder = (
      args: DriveArgs,
      folder: string,
    ): Effect.Effect<string, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const cacheKey = `${args.rootFolderId.length}:${args.rootFolderId}:${folder}`
        const cached = yield* cache.get(cacheKey)
        if (Option.isSome(cached)) return cached.value
        const id = yield* ensureFolder(args.accessToken, folder, args.rootFolderId)
        yield* cache.set(cacheKey, id)
        return id
      })

    /** One multipart request (media + metadata): sets name + parent in one call. */
    const multipart = (
      accessToken: string,
      bytes: Uint8Array,
      meta: { fileId: string; name: string; parentId: string; contentType: string },
    ): Effect.Effect<{ id: string }, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        // High-entropy boundary: a data-derived one could (astronomically rarely)
        // occur inside the binary body and silently truncate the part (RFC 2046).
        const boundary = `xmd${crypto.randomUUID().replace(/-/g, '')}`
        const enc = new TextEncoder()
        const head = enc.encode(
          `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
            `${JSON.stringify({ id: meta.fileId, name: meta.name, parents: [meta.parentId] })}\r\n` +
            `--${boundary}\r\ncontent-type: ${meta.contentType}\r\n\r\n`,
        )
        const tail = enc.encode(`\r\n--${boundary}--`)
        const body = new Uint8Array(head.length + bytes.length + tail.length)
        body.set(head, 0)
        body.set(bytes, head.length)
        body.set(tail, head.length + bytes.length)
        const res = yield* http.fetch(`${UPLOAD_BASE}?uploadType=multipart&fields=id`, {
          method: 'POST',
          headers: {
            ...authHeader(accessToken),
            'content-type': `multipart/related; boundary=${boundary}`,
          },
          body,
        })
        if (!res.ok) return yield* driveFail(res)
        return { id: driveIdEnvelope(yield* okJson(res), 'Drive multipart create') }
      })

    /** Resumable: initiate the session in Effect, then PUT 256 KiB-multiple chunks.
     *  The PUT loop runs inside `streamInChunks`' Promise sink using the bound
     *  Promise fetch — the chunker is reused verbatim, bounding memory; a provider
     *  error throws `CloudHttpError`, mapped back to the Effect channel by `catch`. */
    const resumable = (
      accessToken: string,
      body: ReadableStream<Uint8Array>,
      meta: {
        fileId: string
        name: string
        parentId: string
        contentType: string
        totalBytes: number | null
      },
    ): Effect.Effect<{ id: string; bytes: number }, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const init = yield* http.fetch(`${UPLOAD_BASE}?uploadType=resumable&fields=id`, {
          method: 'POST',
          headers: {
            ...authHeader(accessToken),
            'content-type': 'application/json; charset=UTF-8',
            'x-upload-content-type': meta.contentType,
            ...(meta.totalBytes !== null
              ? { 'x-upload-content-length': String(meta.totalBytes) }
              : {}),
          },
          body: JSON.stringify({
            id: meta.fileId,
            name: meta.name,
            parents: [meta.parentId],
          }),
        })
        if (!init.ok) return yield* driveFail(init)
        const sessionUrl = init.headers.get('location')
        yield* Effect.promise(() => discardResponseBody(init))
        if (sessionUrl === null)
          return yield* Effect.die(new Error('drive: resumable initiate returned no session url'))

        const doFetch = http.fetchPromise
        let fileId: string | null = null
        const total = yield* Effect.tryPromise({
          try: () =>
            streamInChunks(body, RESUMABLE_CHUNK, async (chunk, info) => {
              const end = info.offset + chunk.length - 1
              const totalStr = info.isLast ? String(info.offset + chunk.length) : '*'
              // A zero-length final chunk (offset 0) means an empty source — guarded upstream.
              const range =
                chunk.length === 0
                  ? `bytes */${info.offset}`
                  : `bytes ${info.offset}-${end}/${totalStr}`
              const reqInit: RequestInit = { method: 'PUT', headers: { 'content-range': range } }
              if (chunk.length > 0) reqInit.body = chunk
              const res = await doFetch(sessionUrl, reqInit)
              if (info.isLast) {
                if (res.status !== 200 && res.status !== 201)
                  throw new CloudHttpError({
                    provider: 'drive',
                    status: res.status,
                    body: await errText(res),
                  })
                fileId = driveIdEnvelope(await readControlJson(res), 'Drive resumable create')
              } else if (res.status !== 308) {
                throw new CloudHttpError({
                  provider: 'drive',
                  status: res.status,
                  body: await errText(res),
                })
              } else await discardResponseBody(res)
            }),
          catch: (e) =>
            e instanceof CloudHttpError
              ? e
              : new CloudHttpError({ provider: 'drive', status: 0, body: String(e) }),
        })
        if (fileId === null)
          return yield* Effect.die(new Error('drive: resumable upload did not return a file id'))
        return { id: fileId, bytes: total }
      })

    const generateFileId = (
      accessToken: string,
    ): Effect.Effect<string, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const res = yield* http.fetch(`${FILES_BASE}/generateIds?count=1&space=drive&type=files`, {
          headers: authHeader(accessToken),
        })
        if (!res.ok) return yield* driveFail(res)
        const record = controlRecord(yield* okJson(res), 'Drive generateIds')
        const ids = controlArray(record.ids, 'Drive generated ids', 1)
        return driveId(ids[0], 'Drive generated id')
      })

    const probeFile = (
      accessToken: string,
      fileId: string,
    ): Effect.Effect<DriveFileProof | null, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const res = yield* http.fetch(
          `${FILES_BASE}/${encodeURIComponent(fileId)}?fields=id,size,trashed`,
          { headers: authHeader(accessToken) },
        )
        if (res.status === 404) {
          yield* Effect.promise(() => discardResponseBody(res))
          return null
        }
        if (!res.ok) return yield* driveFail(res)
        return driveFileProof(yield* okJson(res))
      })

    const findTargetConflict = (
      accessToken: string,
      filename: string,
      parentId: string,
    ): Effect.Effect<string | null, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const q = [
          `name='${queryLiteral(filename)}'`,
          'trashed=false',
          `'${queryLiteral(parentId)}' in parents`,
        ].join(' and ')
        const res = yield* http.fetch(
          `${FILES_BASE}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`,
          { headers: authHeader(accessToken) },
        )
        if (!res.ok) return yield* driveFail(res)
        return driveFiles(yield* okJson(res), 1)[0] ?? null
      })

    const uploadWithId = (
      args: DriveArgs,
      input: UploadInput,
      fileId: string,
      parentId: string,
    ): Effect.Effect<UploadOutcome> =>
      runUpload(parseSource(input).pipe(Effect.provideService(SourceFetch, source)), {
        simple: (bytes, contentType) =>
          Effect.gen(function* () {
            const { id } = yield* multipart(args.accessToken, bytes, {
              fileId,
              name: input.target.filename,
              parentId,
              contentType,
            })
            if (id !== fileId)
              return yield* Effect.die(
                new Error(`drive: create returned unexpected file id ${String(id)}`),
              )
            return {
              kind: 'success',
              bytes: bytes.length,
              remotePath: input.target.path,
              remoteId: id,
            }
          }),
        streamed: (body, size, contentType) =>
          Effect.gen(function* () {
            const { id, bytes } = yield* resumable(args.accessToken, body, {
              fileId,
              name: input.target.filename,
              parentId,
              contentType,
              totalBytes: size,
            })
            if (id !== fileId)
              return yield* Effect.die(
                new Error(`drive: create returned unexpected file id ${String(id)}`),
              )
            return {
              outcome: { kind: 'success', bytes, remotePath: input.target.path, remoteId: id },
              bytes,
            }
          }),
      })

    const advance = (
      args: DriveArgs,
      input: UploadInput,
      fileId: string,
    ): Effect.Effect<UploadOutcome> =>
      Effect.gen(function* () {
        const existing = yield* probeFile(args.accessToken, fileId)
        if (existing !== null) return proofSuccess(existing, fileId, input.target.path)
        const parentId =
          input.target.folder === ''
            ? args.rootFolderId
            : yield* resolveFolder(args, input.target.folder)
        const conflict = yield* findTargetConflict(
          args.accessToken,
          input.target.filename,
          parentId,
        )
        if (conflict !== null)
          return {
            kind: 'failure',
            reason: `drive: destination already exists (${conflict}); refusing to create a duplicate`,
            status: 409,
          } satisfies UploadOutcome
        const created = yield* uploadWithId(args, input, fileId, parentId)
        if (created.kind !== 'failure' || created.status !== 409) return created
        const raced = yield* probeFile(args.accessToken, fileId)
        return raced === null ? created : proofSuccess(raced, fileId, input.target.path)
      }).pipe(
        Effect.catchTag('CloudHttpError', (error) =>
          Effect.succeed<UploadOutcome>({
            kind: 'failure',
            reason: error.message,
            status: error.status,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed<UploadOutcome>({
            kind: 'failure',
            reason: errorReason(Cause.squash(cause)),
          }),
        ),
      )

    /** Resolve the My Drive root folder id — the parent every destination folder is
     *  created under. One cheap GET; the caller caches the id for the SW's life. */
    const ensureRoot = (accessToken: string): Effect.Effect<string, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const res = yield* http.fetch(`${FILES_BASE}/root?fields=id`, {
          headers: authHeader(accessToken),
        })
        if (!res.ok) return yield* driveFail(res)
        return driveIdEnvelope(yield* okJson(res), 'Drive root resolve')
      })

    return { generateFileId, advance, ensureRoot }
  }),
)
