import { bindFetch } from '../fetch'
import { streamInChunks } from './chunk'
import { authHeader, errText, httpErr, runUpload } from './http'
import { parseSourceResponse } from './source'
import { type CloudDestination, type UploadInput, type UploadOutcome } from './types'

/**
 * Google Drive v3 upload adapter (ADR-0013 §5). Small media (≤ SIMPLE_MAX_BYTES)
 * goes via one multipart request; larger/unknown-size media streams through a
 * resumable session in 256 KiB-multiple chunks — never buffering a whole video.
 * Files land in a per-handle subfolder under an app root folder. The caller
 * (background orchestrator) supplies a valid access token, the SSRF-guarded
 * source fetch, the root folder id, and an in-memory subfolder cache.
 */

const FOLDER_MIME = 'application/vnd.google-apps.folder'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files'
const FILES_BASE = 'https://www.googleapis.com/drive/v3/files'
/** A valid Drive resumable chunk must be a 256 KiB multiple; 32 × 256 KiB = 8 MiB.
 *  Equals SIMPLE_MAX_BYTES only by coincidence — the streaming path is entered on
 *  size cutoff (see types.ts), not on this chunk size. */
const KIB256 = 256 * 1024
const RESUMABLE_CHUNK = 32 * KIB256

export interface DriveDeps {
  readonly accessToken: string
  readonly rootFolderId: string
  readonly fetchImpl: typeof fetch
  /** SSRF-guarded fetch of the twimg source (e.g. `guardedFetch` bound). */
  readonly fetchSource: (url: string) => Promise<Response>
  /** handle → subfolder id, cached across the SW life. */
  readonly folderCache: Map<string, string>
}

const driveError = (res: Response, body: string): string => httpErr('drive', res, body)

/** Lookup-or-create a folder named `name` under `parentId`. With full Drive scope
 *  the list query finds a pre-existing folder so re-runs don't duplicate it. */
export async function ensureFolder(
  name: string,
  parentId: string | null,
  deps: Pick<DriveDeps, 'accessToken' | 'fetchImpl'>,
): Promise<string> {
  const doFetch = bindFetch(deps.fetchImpl)
  // Escape backslash BEFORE single-quote so a trailing `\` can't break out of the
  // q= string literal (defense-in-depth; the handle is also sanitized upstream).
  const safeName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  const q = [
    `name='${safeName}'`,
    `mimeType='${FOLDER_MIME}'`,
    'trashed=false',
    ...(parentId !== null ? [`'${parentId}' in parents`] : []),
  ].join(' and ')
  const listUrl = `${FILES_BASE}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`
  const found = await doFetch(listUrl, { headers: authHeader(deps.accessToken) })
  if (found.ok) {
    const json = (await found.json()) as { files?: { id: string }[] }
    const id = json.files?.[0]?.id
    if (id !== undefined) return id
  }
  const created = await doFetch(`${FILES_BASE}?fields=id`, {
    method: 'POST',
    headers: { ...authHeader(deps.accessToken), 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      ...(parentId !== null ? { parents: [parentId] } : {}),
    }),
  })
  if (!created.ok) throw new Error(driveError(created, await errText(created)))
  const json = (await created.json()) as { id?: string }
  if (json.id === undefined) throw new Error('drive: folder create returned no id')
  return json.id
}

/** Resolve the app root folder ("X Media Downloader"); the id is persisted by the caller. */
export const ensureRootFolder = (
  name: string,
  deps: Pick<DriveDeps, 'accessToken' | 'fetchImpl'>,
): Promise<string> => ensureFolder(name, null, deps)

async function resolveHandleFolder(deps: DriveDeps, handle: string): Promise<string> {
  const cached = deps.folderCache.get(handle)
  if (cached !== undefined) return cached
  const id = await ensureFolder(handle, deps.rootFolderId, deps)
  deps.folderCache.set(handle, id)
  return id
}

/** One multipart request (media + metadata): sets name + parent in a single call. */
async function multipartUpload(
  deps: DriveDeps,
  doFetch: typeof fetch,
  bytes: Uint8Array,
  meta: { name: string; parentId: string; contentType: string },
): Promise<{ id: string }> {
  // High-entropy boundary: a data-derived one could (astronomically rarely) occur
  // inside the binary media body and silently truncate the part (RFC 2046/2387).
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
  const res = await doFetch(`${UPLOAD_BASE}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: {
      ...authHeader(deps.accessToken),
      'content-type': `multipart/related; boundary=${boundary}`,
    },
    body,
  })
  if (!res.ok) throw new Error(driveError(res, await errText(res)))
  return (await res.json()) as { id: string }
}

/** Resumable upload: initiate a session, then PUT 256 KiB-multiple chunks. */
async function resumableUpload(
  deps: DriveDeps,
  doFetch: typeof fetch,
  body: ReadableStream<Uint8Array>,
  meta: { name: string; parentId: string; contentType: string; totalBytes: number | null },
): Promise<{ id: string; bytes: number }> {
  const initiate = await doFetch(`${UPLOAD_BASE}?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      ...authHeader(deps.accessToken),
      'content-type': 'application/json; charset=UTF-8',
      'x-upload-content-type': meta.contentType,
      ...(meta.totalBytes !== null ? { 'x-upload-content-length': String(meta.totalBytes) } : {}),
    },
    body: JSON.stringify({ name: meta.name, parents: [meta.parentId] }),
  })
  if (!initiate.ok) throw new Error(driveError(initiate, await errText(initiate)))
  const sessionUrl = initiate.headers.get('location')
  if (sessionUrl === null) throw new Error('drive: resumable initiate returned no session url')

  let fileId: string | null = null
  const total = await streamInChunks(body, RESUMABLE_CHUNK, async (chunk, info) => {
    const end = info.offset + chunk.length - 1
    const totalStr = info.isLast ? String(info.offset + chunk.length) : '*'
    // A zero-length final chunk (offset 0) means an empty source — caller guards that.
    const range =
      chunk.length === 0 ? `bytes */${info.offset}` : `bytes ${info.offset}-${end}/${totalStr}`
    const init: RequestInit = { method: 'PUT', headers: { 'content-range': range } }
    if (chunk.length > 0) init.body = chunk
    const res = await doFetch(sessionUrl, init)
    if (info.isLast) {
      if (res.status !== 200 && res.status !== 201) {
        throw new Error(driveError(res, await errText(res)))
      }
      fileId = ((await res.json()) as { id?: string }).id ?? null
    } else if (res.status !== 308) {
      throw new Error(driveError(res, await errText(res)))
    }
  })
  if (fileId === null) throw new Error('drive: resumable upload did not return a file id')
  return { id: fileId, bytes: total }
}

/** Upload one media item to Drive. Never throws — maps every failure to an outcome. */
export async function driveUpload(input: UploadInput, deps: DriveDeps): Promise<UploadOutcome> {
  const source = await parseSourceResponse(input, deps.fetchSource)
  const doFetch = bindFetch(deps.fetchImpl)
  const buildMeta = async (contentType: string) => {
    const parentId = await resolveHandleFolder(deps, input.target.handle)
    return { name: input.target.filename, parentId, contentType }
  }
  return runUpload(source, {
    simple: async (bytes, contentType) => {
      const { id } = await multipartUpload(deps, doFetch, bytes, await buildMeta(contentType))
      return { kind: 'success', bytes: bytes.length, remotePath: input.target.path, remoteId: id }
    },
    streamed: async (body, size, contentType) => {
      const { id, bytes } = await resumableUpload(deps, doFetch, body, {
        ...(await buildMeta(contentType)),
        totalBytes: size,
      })
      return {
        outcome: { kind: 'success', bytes, remotePath: input.target.path, remoteId: id },
        bytes,
      }
    },
  })
}

/** Drive as a provider-agnostic `CloudDestination`; deps captured in the closure. */
export const makeDriveDestination = (deps: DriveDeps): CloudDestination => ({
  upload: (input) => driveUpload(input, deps),
})
