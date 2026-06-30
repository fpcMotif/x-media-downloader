import { Context, Effect, Layer } from 'effect'
import { streamInChunks } from './chunk'
import { authHeader, CloudHttpError, errText, okJson, runUpload } from './http'
import { FetchService } from '../fetch-service'
import { SourceFetch } from './source-fetch'
import { parseSource } from './source'
import { type UploadInput, type UploadOutcome } from './types'

/**
 * Dropbox v2 upload adapter (ADR-0013 §5, ADR-0017). Small media
 * (≤ SIMPLE_MAX_BYTES) goes via `/2/files/upload`; larger/unknown-size media
 * streams through an upload session (`start` → `append_v2` → `finish`) in 4 MiB-
 * multiple chunks — never buffering a whole video. A `DropboxUploader` service
 * whose layer depends on `FetchService` + `SourceFetch` (no folder cache).
 */

const CONTENT = 'https://content.dropboxapi.com/2'
/** A valid Dropbox session chunk is a 4 MiB multiple; 2 × 4 MiB = 8 MiB. */
const SESSION_CHUNK = 2 * 4 * 1024 * 1024

export interface DropboxArgs {
  readonly accessToken: string
}

interface FileMetadata {
  readonly id?: string
  readonly size?: number
  readonly path_display?: string
}

/** Dropbox-API-Arg must be ASCII; escape any non-ASCII char as \uXXXX. */
function asciiArg(obj: unknown): string {
  // oxlint-disable-next-line no-control-regex -- intentionally match all non-ASCII
  return JSON.stringify(obj).replace(/[^\x00-\x7F]/g, (c) => {
    const code = c.charCodeAt(0)
    return `\\u${code.toString(16).padStart(4, '0')}`
  })
}

const commitInfo = (path: string) => ({ path, mode: 'add', autorename: true, mute: false })

/** Build the success outcome from Dropbox metadata, falling back to local values. */
const dropboxSuccess = (meta: FileMetadata, fallbackBytes: number, path: string): UploadOutcome => ({
  kind: 'success',
  bytes: meta.size ?? fallbackBytes,
  remotePath: meta.path_display ?? path,
  ...(meta.id !== undefined ? { remoteId: meta.id } : {}),
})

const targetPath = (input: UploadInput): string => `/${input.target.path.replace(/^\/+/, '')}`

/** Read the error body, then fail with a tagged Dropbox HTTP error. */
const dropboxFail = (res: Response): Effect.Effect<never, CloudHttpError> =>
  Effect.promise(() => errText(res)).pipe(
    Effect.flatMap((body) => new CloudHttpError({ provider: 'dropbox', status: res.status, body })),
  )

export class DropboxUploader extends Context.Service<
  DropboxUploader,
  { readonly upload: (args: DropboxArgs, input: UploadInput) => Effect.Effect<UploadOutcome> }
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

    const simpleUpload = (
      accessToken: string,
      bytes: Uint8Array<ArrayBuffer>,
      path: string,
    ): Effect.Effect<FileMetadata, CloudHttpError> =>
      Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () => rpc(accessToken, 'files/upload', commitInfo(path), bytes),
          catch: (e) =>
            e instanceof CloudHttpError ? e : new CloudHttpError({ provider: 'dropbox', status: 0, body: String(e) }),
        })
        if (!res.ok) return yield* dropboxFail(res)
        return yield* okJson<FileMetadata>(res)
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
              const res = await rpc(accessToken, 'files/upload_session/start', { close: info.isLast }, chunk)
              if (!res.ok)
                throw new CloudHttpError({ provider: 'dropbox', status: res.status, body: await errText(res) })
              sessionId = ((await res.json()) as { session_id: string }).session_id
              cursorOffset = chunk.length
              startedClosed = info.isLast
              return
            }
            const cursor = { session_id: sessionId, offset: cursorOffset }
            if (info.isLast) {
              const res = await rpc(accessToken, 'files/upload_session/finish', { cursor, commit: commitInfo(path) }, chunk)
              if (!res.ok)
                throw new CloudHttpError({ provider: 'dropbox', status: res.status, body: await errText(res) })
              meta = (await res.json()) as FileMetadata
              cursorOffset += chunk.length
              return
            }
            const res = await rpc(accessToken, 'files/upload_session/append_v2', { cursor, close: false }, chunk)
            if (!res.ok)
              throw new CloudHttpError({ provider: 'dropbox', status: res.status, body: await errText(res) })
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
              throw new CloudHttpError({ provider: 'dropbox', status: res.status, body: await errText(res) })
            meta = (await res.json()) as FileMetadata
          }
          /* v8 ignore next -- streamInChunks always emits a final chunk, so meta is set */
          if (meta === null) throw new Error('dropbox: session finished without metadata')
          return { meta, bytes: total }
        },
        catch: (e) =>
          e instanceof CloudHttpError ? e : new CloudHttpError({ provider: 'dropbox', status: 0, body: String(e) }),
      })

    const upload = (args: DropboxArgs, input: UploadInput): Effect.Effect<UploadOutcome> => {
      const path = targetPath(input)
      return runUpload(parseSource(input).pipe(Effect.provideService(SourceFetch, source)), {
        simple: (bytes) =>
          simpleUpload(args.accessToken, bytes, path).pipe(
            Effect.map((meta) => dropboxSuccess(meta, bytes.length, path)),
          ),
        streamed: (body) =>
          sessionUpload(args.accessToken, body, path).pipe(
            Effect.map(({ meta, bytes }) => ({ outcome: dropboxSuccess(meta, bytes, path), bytes })),
          ),
      })
    }

    return { upload }
  }),
)
