import { Context, Effect, Layer, Option } from 'effect'
import { streamInChunks } from './lib/chunk'
import { authHeader, CloudHttpError, errText, okJson, runUpload } from './lib/http'
import { FetchService, type FetchError } from '@/packages/kernel/fetch-service'
import { FolderCache } from './lib/folder-cache'
import { SourceFetch } from './lib/source-fetch'
import { parseSource } from './lib/source'
import { type UploadInput, type UploadOutcome } from './types'

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
    const ensureFolder = (
      accessToken: string,
      name: string,
      parentId: string,
    ): Effect.Effect<string, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        // Escape backslash BEFORE single-quote so a trailing `\` can't break out of
        // the q= string literal (defense-in-depth; the folder name is sanitized upstream).
        const safe = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        const q = [
          `name='${safe}'`,
          `mimeType='${FOLDER_MIME}'`,
          'trashed=false',
          `'${parentId}' in parents`,
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
          body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
        })
        if (!created.ok) return yield* driveFail(created)
        const id = (yield* okJson<{ id?: string }>(created)).id
        if (id === undefined)
          return yield* Effect.die(new Error('drive: folder create returned no id'))
        return id
      })

    /** Lookup-or-create the destination folder (e.g. `twitter`) at the My Drive
     *  root, memoized on the runtime's Ref so repeated uploads resolve it once. */
    const resolveFolder = (
      args: DriveArgs,
      folder: string,
    ): Effect.Effect<string, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const cached = yield* cache.get(folder)
        if (Option.isSome(cached)) return cached.value
        const id = yield* ensureFolder(args.accessToken, folder, args.rootFolderId)
        yield* cache.set(folder, id)
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
                  throw new CloudHttpError({
                    provider: 'drive',
                    status: res.status,
                    body: await errText(res),
                  })
                fileId = ((await res.json()) as { id?: string }).id ?? null
              } else if (res.status !== 308) {
                throw new CloudHttpError({
                  provider: 'drive',
                  status: res.status,
                  body: await errText(res),
                })
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
            const parentId =
              input.target.folder === ''
                ? args.rootFolderId
                : yield* resolveFolder(args, input.target.folder)
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
            const parentId =
              input.target.folder === ''
                ? args.rootFolderId
                : yield* resolveFolder(args, input.target.folder)
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

    /** Resolve the My Drive root folder id — the parent every destination folder is
     *  created under. One cheap GET; the caller caches the id for the SW's life. */
    const ensureRoot = (accessToken: string): Effect.Effect<string, CloudHttpError | FetchError> =>
      Effect.gen(function* () {
        const res = yield* http.fetch(`${FILES_BASE}/root?fields=id`, {
          headers: authHeader(accessToken),
        })
        if (!res.ok) return yield* driveFail(res)
        const id = (yield* okJson<{ id?: string }>(res)).id
        if (id === undefined)
          return yield* Effect.die(new Error('drive: root resolve returned no id'))
        return id
      })

    return { upload, ensureRoot }
  }),
)
