import { bindFetch } from '../fetch'
import { streamInChunks } from './chunk'
import { authHeader, errText, httpErr, runUpload } from './http'
import { parseSourceResponse } from './source'
import { type CloudDestination, type UploadInput, type UploadOutcome } from './types'

/**
 * Dropbox v2 upload adapter (ADR-0013 §5). Small media (≤ SIMPLE_MAX_BYTES) goes
 * via `/2/files/upload`; larger/unknown-size media streams through an upload
 * session (`start` → `append_v2` → `finish`) in 4 MiB-multiple chunks — never
 * buffering a whole video. App-folder access type: paths are relative to
 * `Apps/<App>/`. The caller supplies a valid access token + SSRF-guarded source.
 */

const CONTENT = 'https://content.dropboxapi.com/2'
/** A valid Dropbox session chunk is a 4 MiB multiple; 2 × 4 MiB = 8 MiB, each
 *  request body staying well under 150 MB. Equals SIMPLE_MAX_BYTES only by
 *  coincidence — the streaming path is entered on size cutoff (see types.ts). */
const MIB4 = 4 * 1024 * 1024
const SESSION_CHUNK = 2 * MIB4

export interface DropboxDeps {
  readonly accessToken: string
  readonly fetchImpl: typeof fetch
  readonly fetchSource: (url: string) => Promise<Response>
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

const dropboxError = (res: Response, body: string): string => httpErr('dropbox', res, body)

const commitInfo = (path: string) => ({ path, mode: 'add', autorename: true, mute: false })

async function rpc(
  deps: DropboxDeps,
  doFetch: typeof fetch,
  endpoint: string,
  arg: unknown,
  body: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  return doFetch(`${CONTENT}/${endpoint}`, {
    method: 'POST',
    headers: {
      ...authHeader(deps.accessToken),
      'dropbox-api-arg': asciiArg(arg),
      'content-type': 'application/octet-stream',
    },
    body,
  })
}

async function simpleUpload(
  deps: DropboxDeps,
  doFetch: typeof fetch,
  bytes: Uint8Array<ArrayBuffer>,
  path: string,
): Promise<FileMetadata> {
  const res = await rpc(deps, doFetch, 'files/upload', commitInfo(path), bytes)
  if (!res.ok) throw new Error(dropboxError(res, await errText(res)))
  return (await res.json()) as FileMetadata
}

/**
 * Streamed upload session. Always ≥ 2 chunks in practice (only entered when the
 * source exceeds SIMPLE_MAX_BYTES or its size is unknown), but the single-chunk
 * edge (unknown size that turns out small) is handled: start with close=true then
 * finish with an empty commit body at the final offset.
 */
async function sessionUpload(
  deps: DropboxDeps,
  doFetch: typeof fetch,
  body: ReadableStream<Uint8Array>,
  path: string,
): Promise<{ meta: FileMetadata; bytes: number }> {
  let sessionId: string | null = null
  let cursorOffset = 0
  let meta: FileMetadata | null = null
  let startedClosed = false

  const total = await streamInChunks(body, SESSION_CHUNK, async (chunk, info) => {
    if (sessionId === null) {
      const res = await rpc(
        deps,
        doFetch,
        'files/upload_session/start',
        { close: info.isLast },
        chunk,
      )
      if (!res.ok) throw new Error(dropboxError(res, await errText(res)))
      sessionId = ((await res.json()) as { session_id: string }).session_id
      cursorOffset = chunk.length
      startedClosed = info.isLast
      return
    }
    const cursor = { session_id: sessionId, offset: cursorOffset }
    if (info.isLast) {
      const res = await rpc(
        deps,
        doFetch,
        'files/upload_session/finish',
        { cursor, commit: commitInfo(path) },
        chunk,
      )
      if (!res.ok) throw new Error(dropboxError(res, await errText(res)))
      meta = (await res.json()) as FileMetadata
      cursorOffset += chunk.length
      return
    }
    const res = await rpc(
      deps,
      doFetch,
      'files/upload_session/append_v2',
      { cursor, close: false },
      chunk,
    )
    if (!res.ok) throw new Error(dropboxError(res, await errText(res)))
    cursorOffset += chunk.length
  })

  // Single-chunk session: start(close:true) ran but finish never did — commit now.
  if (meta === null && sessionId !== null && startedClosed) {
    const res = await rpc(
      deps,
      doFetch,
      'files/upload_session/finish',
      { cursor: { session_id: sessionId, offset: cursorOffset }, commit: commitInfo(path) },
      new Uint8Array(0),
    )
    if (!res.ok) throw new Error(dropboxError(res, await errText(res)))
    meta = (await res.json()) as FileMetadata
  }
  // Unreachable invariant: streamInChunks always emits a final chunk, so either the
  // in-loop finish or the single-chunk finish above sets `meta`. Guards against a
  // future refactor breaking that contract.
  /* v8 ignore next */
  if (meta === null) throw new Error('dropbox: session finished without metadata')
  return { meta, bytes: total }
}

/** Build the success outcome from Dropbox metadata, falling back to local values. */
const dropboxSuccess = (
  meta: FileMetadata,
  fallbackBytes: number,
  path: string,
): UploadOutcome => ({
  kind: 'success',
  bytes: meta.size ?? fallbackBytes,
  remotePath: meta.path_display ?? path,
  ...(meta.id !== undefined ? { remoteId: meta.id } : {}),
})

/** Upload one media item to Dropbox. Never throws — maps every failure to an outcome. */
export async function dropboxUpload(input: UploadInput, deps: DropboxDeps): Promise<UploadOutcome> {
  const source = await parseSourceResponse(input, deps.fetchSource)
  const doFetch = bindFetch(deps.fetchImpl)
  const path = `/${input.target.path.replace(/^\/+/, '')}`
  return runUpload(source, {
    simple: async (bytes) => {
      const meta = await simpleUpload(deps, doFetch, bytes, path)
      return dropboxSuccess(meta, bytes.length, path)
    },
    streamed: async (body) => {
      const { meta, bytes } = await sessionUpload(deps, doFetch, body, path)
      return { outcome: dropboxSuccess(meta, bytes, path), bytes }
    },
  })
}

/** Dropbox as a provider-agnostic `CloudDestination`; deps captured in the closure. */
export const makeDropboxDestination = (deps: DropboxDeps): CloudDestination => ({
  upload: (input) => dropboxUpload(input, deps),
})
