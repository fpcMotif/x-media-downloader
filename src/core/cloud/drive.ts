import { Context, Effect, Layer, Option } from 'effect'
import { streamInChunks } from './chunk'
import { authHeader, CloudHttpError, errText, okJson, runUpload } from './http'
import { FetchService, type FetchError } from '../fetch-service'
import { FolderCache } from './folder-cache'
import { SourceFetch } from './source-fetch'
import { parseSource } from './source'
import { type UploadInput, type UploadOutcome } from './types'

/**
 * Google Drive v3 upload adapter (ADR-0013 §5, ADR-0017). Small media
 * (≤ SIMPLE_MAX_BYTES) goes via one multipart request; larger/unknown-size media
 * streams through a resumable session in 256 KiB-multiple chunks — never buffering
 * a whole video. Files land in a per-handle subfolder under an app root folder.
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
/** The app root folder; the resolved id is persisted by the caller. */
const ROOT_FOLDER_NAME = 'X Media Downloader'

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
    readonly upload: (args: DriveArgs, input: UploadInput) => Effect.Effect<UploadOutcome>
    /** Lookup-or-create the app root folder; the id is persisted by the caller. */
    readonly ensureRoot: (accessToken: string) => Effect.Effect<string, CloudHttpError | FetchError>
  }
>()('cloud/DriveUploader') {}

export const DriveUploaderLive = Layer.effect(
  DriveUploader,
  Effect.gen(function* () {
    const http = yield* FetchService
    const source = yield* SourceFetch
    const cache = yield* FolderCache

    /** Lookup-or-create a folder named `name` under `parentId`. With full Drive
     *  scope the list query finds a pre-existing folder so re-runs don't duplicate it. */
    const ensureFolder = (
      accessToken: string,
      name: string,
      parentId: string | null,
    ): Effect.Effect<string, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        // Escape backslash BEFORE single-quote so a trailing `\` can't break out of
        // the q= string literal (defense-in-depth; the handle is sanitized upstream).
        const safe = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        const q = [
          `name='${safe}'`,
          `mimeType='${FOLDER_MIME}'`,
          'trashed=false',
          ...(parentId !== null ? [`'${parentId}' in parents`] : []),
        ].join(' and ')
        const listUrl = `${FILES_BASE}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`
        const found = yield* http.fetch(listUrl, { headers: authHeader(accessToken) })
        if (found.ok) {
          const id = (yield* okJson<{ files?: { id: string }[] }>(found)).files?.[0]?.id
          if (id !== undefined) return id
        }
        const created = yield* http.fetch(`${FILES_BASE}?fields=id`, {
          method: 'POST',
          headers: { ...authHeader(accessToken), 'content-type': 'application/json' },
          body: JSON.stringify({
            name,
            mimeType: FOLDER_MIME,
            ...(parentId !== null ? { parents: [parentId] } : {}),
          }),
        })
        if (!created.ok) return yield* driveFail(created)
        const id = (yield* okJson<{ id?: string }>(created)).id
        if (id === undefined)
          return yield* Effect.die(new Error('drive: folder create returned no id'))
        return id
      })

    const resolveHandleFolder = (
      args: DriveArgs,
      handle: string,
    ): Effect.Effect<string, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const cached = yield* cache.get(handle)
        if (Option.isSome(cached)) return cached.value
        const id = yield* ensureFolder(args.accessToken, handle, args.rootFolderId)
        yield* cache.set(handle, id)
        return id
      })

    /** One multipart request (media + metadata): sets name + parent in one call. */
    const multipart = (
      accessToken: string,
      bytes: Uint8Array,
      meta: { name: string; parentId: string; contentType: string },
    ): Effect.Effect<{ id: string }, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        // High-entropy boundary: a data-derived one could (astronomically rarely)
        // occur inside the binary body and silently truncate the part (RFC 2046).
        const boundary = `xmd${crypto.randomUUID().replace(/-/g, '')}`
        const enc = new TextEncoder()
        const head = enc.encode(
          `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n` +
            `${JSON.stringify({ name: meta.name, parents: [meta.parentId] })}\r\n` +
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
        return yield* okJson<{ id: string }>(res)
      })

    /** Resumable: initiate the session in Effect, then PUT 256 KiB-multiple chunks.
     *  The PUT loop runs inside `streamInChunks`' Promise sink using the bound
     *  Promise fetch — the chunker is reused verbatim, bounding memory; a provider
     *  error throws `CloudHttpError`, mapped back to the Effect channel by `catch`. */
    const resumable = (
      accessToken: string,
      body: ReadableStream<Uint8Array>,
      meta: { name: string; parentId: string; contentType: string; totalBytes: number | null },
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
          body: JSON.stringify({ name: meta.name, parents: [meta.parentId] }),
        })
        if (!init.ok) return yield* driveFail(init)
        const sessionUrl = init.headers.get('location')
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
                  throw new CloudHttpError({ provider: 'drive', status: res.status, body: await errText(res) })
                fileId = ((await res.json()) as { id?: string }).id ?? null
              } else if (res.status !== 308) {
                throw new CloudHttpError({ provider: 'drive', status: res.status, body: await errText(res) })
              }
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

    const upload = (args: DriveArgs, input: UploadInput): Effect.Effect<UploadOutcome> =>
      runUpload(parseSource(input).pipe(Effect.provideService(SourceFetch, source)), {
        simple: (bytes, contentType) =>
          Effect.gen(function* () {
            const parentId = yield* resolveHandleFolder(args, input.target.handle)
            const { id } = yield* multipart(args.accessToken, bytes, {
              name: input.target.filename,
              parentId,
              contentType,
            })
            return {
              kind: 'success',
              bytes: bytes.length,
              remotePath: input.target.path,
              remoteId: id,
            }
          }),
        streamed: (body, size, contentType) =>
          Effect.gen(function* () {
            const parentId = yield* resolveHandleFolder(args, input.target.handle)
            const { id, bytes } = yield* resumable(args.accessToken, body, {
              name: input.target.filename,
              parentId,
              contentType,
              totalBytes: size,
            })
            return {
              outcome: { kind: 'success', bytes, remotePath: input.target.path, remoteId: id },
              bytes,
            }
          }),
      })

    const ensureRoot = (accessToken: string): Effect.Effect<string, CloudHttpError | FetchError> =>
      ensureFolder(accessToken, ROOT_FOLDER_NAME, null)

    return { upload, ensureRoot }
  }),
)
