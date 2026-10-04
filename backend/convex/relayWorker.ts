'use node'

import { v, type Infer } from 'convex/values'
import { makeFunctionReference } from 'convex/server'
import { action, internalAction } from './_generated/server'
import { assertSecret } from './auth'
import { setupReason } from './relayModel'
import type { Doc, Id } from './_generated/dataModel'
import { CHUNK_BYTES, relayProgress } from './relayModel'
import {
  fetchSource,
  validateSourceUrl,
  X_MEDIA_HOSTS,
  META_MEDIA_HOSTS,
  UnsafeSourceUrlError,
  SourceRedirectLimitError,
} from '../../src/packages/kernel/source-policy'

const progressValidator = v.object(relayProgress)
type Progress = Infer<typeof progressValidator>
const claim = makeFunctionReference<'mutation', { id: Id<'relay_jobs'> }, Doc<'relay_jobs'> | null>(
  'relay:claim',
)
const authorized = makeFunctionReference<'query', { id: Id<'relay_jobs'>; fence: number }, boolean>(
  'relay:authorized',
)
const checkpoint = makeFunctionReference<
  'mutation',
  {
    id: Id<'relay_jobs'>
    fence: number
    progress: Progress
    release: boolean
    completed: boolean
    error?: string
    permanent?: boolean
  },
  boolean
>('relay:checkpoint')
const admissionAllowed = makeFunctionReference<'query', Record<string, never>, boolean>(
  'relay:admissionAllowed',
)
const hosts = [...X_MEDIA_HOSTS, ...META_MEDIA_HOSTS]
const DRIVE = 'https://www.googleapis.com/drive/v3/files'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/
const CONFIRMED = /^bytes=0-(\d+)$/
const STRONG_ETAG = /^"[^"\r\n]*"$/

class RelayStopped extends Error {}

class RelayFailure extends Error {
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message)
  }
}

function sessionUrl(raw: string): string {
  const url = new URL(raw)
  if (
    url.origin !== 'https://www.googleapis.com' ||
    !url.pathname.startsWith('/upload/drive/v3/files') ||
    url.username ||
    url.password
  )
    throw new RelayFailure('Invalid Drive session', true)
  return url.toString()
}
interface ProviderReply {
  access_token?: string
  ids?: string[]
  id?: string
  size?: string
  trashed?: boolean
  files?: { id: string }[]
}
async function jsonObject(response: Response): Promise<ProviderReply> {
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new RelayFailure('Invalid provider response')
  const reply: ProviderReply = {}
  if ('access_token' in value && typeof value.access_token === 'string')
    reply.access_token = value.access_token
  if ('id' in value && typeof value.id === 'string') reply.id = value.id
  if ('size' in value && typeof value.size === 'string') reply.size = value.size
  if ('trashed' in value && typeof value.trashed === 'boolean') reply.trashed = value.trashed
  if ('ids' in value && Array.isArray(value.ids) && value.ids.every((id) => typeof id === 'string'))
    reply.ids = value.ids
  if ('files' in value && Array.isArray(value.files)) {
    reply.files = []
    for (const entry of value.files) {
      const file: unknown = entry
      if (!file || typeof file !== 'object' || !('id' in file) || typeof file.id !== 'string')
        throw new RelayFailure('Invalid provider file response')
      reply.files.push({ id: file.id })
    }
  }
  return reply
}
function requiredString(value: string | undefined): string {
  if (typeof value !== 'string' || !value) throw new RelayFailure('Invalid provider response')
  return value
}
function confirmed(response: Response, ceiling: number): number {
  const header = response.headers.get('range')
  const match = header === null ? null : CONFIRMED.exec(header)
  if (header !== null && !match) throw new RelayFailure('Invalid Drive confirmed range', true)
  const offset = match ? Number(match[1]) + 1 : 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > ceiling)
    throw new RelayFailure('Invalid Drive confirmed offset', true)
  return offset
}
async function readChunk(response: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new RelayFailure('Source has no readable body', true)
  const reader = response.body.getReader()
  const bytes = new Uint8Array(max)
  let used = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) return bytes.subarray(0, used)
      if (used + part.value.byteLength > max)
        throw new RelayFailure('Source exceeded byte limit or ignored Range', true)
      bytes.set(part.value, used)
      used += part.value.byteLength
    }
  } finally {
    await reader.cancel()
  }
}

export const probe = action({
  args: { secret: v.string(), sourceUrl: v.string() },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, { secret, sourceUrl }) => {
    assertSecret(secret)
    const reason = setupReason()
    if (reason) throw new Error(reason)
    const response = await fetchSource(
      sourceUrl,
      { method: 'HEAD', signal: AbortSignal.timeout(25_000) },
      async (url, init) => {
        if (!(await ctx.runQuery(admissionAllowed, {})))
          throw new Error('Relay admission is disabled, paused, or disconnected')
        return await fetch(url, init)
      },
      (url) => validateSourceUrl(url, hosts),
    )
    const length = Number(response.headers.get('content-length'))
    await response.body?.cancel()
    return response.ok && Number.isSafeInteger(length) && length > 0 ? length : null
  },
})

export const run = internalAction({
  args: { id: v.id('relay_jobs') },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const job = await ctx.runMutation(claim, { id })
    if (!job) return null
    const fence = job.fence
    const progress: Progress = {
      offset: job.offset,
      sourceBytes: job.sourceBytes,
      uploadedBytes: job.uploadedBytes,
      peakRss: job.peakRss,
      ...(job.fileId ? { fileId: job.fileId } : {}),
      ...(job.session ? { session: job.session } : {}),
      ...(job.total === undefined ? {} : { total: job.total }),
      ...(job.etag ? { etag: job.etag } : {}),
      ...(job.resolvedUrl ? { resolvedUrl: job.resolvedUrl } : {}),
      ...(job.folderIds ? { folderIds: job.folderIds } : {}),
    }
    const deadline = AbortSignal.timeout(120_000)
    const allowed = async () => {
      if (deadline.aborted || Date.now() - job.acceptedAt >= job.maxElapsedMs)
        throw new RelayFailure('Elapsed-time limit reached', true)
      if (!(await ctx.runQuery(authorized, { id, fence })))
        throw new RelayStopped('Relay stopped at request boundary')
    }
    const request = async (url: string, init: RequestInit = {}) => {
      await allowed()
      return await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.any([deadline, AbortSignal.timeout(25_000)]),
      })
    }
    const persist = async (release = false, completed = false) => {
      progress.peakRss = Math.max(progress.peakRss, process.memoryUsage().rss)
      if (!(await ctx.runMutation(checkpoint, { id, fence, progress, release, completed })))
        throw new RelayFailure('Worker lease was superseded', true)
    }
    try {
      const tokenResponse = await request('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.RELAY_DRIVE_CLIENT_ID ?? '',
          client_secret: process.env.RELAY_DRIVE_CLIENT_SECRET ?? '',
          refresh_token: process.env.RELAY_DRIVE_REFRESH_TOKEN ?? '',
        }),
      })
      if (!tokenResponse.ok) throw new RelayFailure('Backend Drive authorization failed', true)
      const token = requiredString((await jsonObject(tokenResponse)).access_token)
      const drive = async (url: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${token}`)
        return await request(url, { ...init, headers })
      }
      const parts = job.path.split('/')
      const filename = parts.pop()!
      if (!progress.fileId) {
        const response = await drive(
          `${DRIVE}/generateIds?count=${parts.length + 1}&space=drive&type=files`,
        )
        if (!response.ok) throw new RelayFailure('Drive identity allocation failed')
        const ids = (await jsonObject(response)).ids
        if (
          !Array.isArray(ids) ||
          ids.length !== parts.length + 1 ||
          !ids.every((value) => typeof value === 'string')
        )
          throw new RelayFailure('Invalid Drive identities')
        progress.fileId = ids[0]!
        progress.folderIds = ids.slice(1)
        await persist()
      }
      const inspect = async () => {
        const response = await drive(
          `${DRIVE}/${encodeURIComponent(progress.fileId!)}?fields=id,size,trashed`,
        )
        if (response.status === 404) return false
        if (!response.ok) throw new RelayFailure('Drive reconciliation failed')
        const file = await jsonObject(response)
        if (
          file.trashed ||
          file.id !== progress.fileId ||
          progress.total === undefined ||
          Number(file.size) !== progress.total
        )
          throw new RelayFailure('Drive file identity or size mismatch', true)
        progress.offset = progress.total
        await persist(true, true)
        return true
      }
      if (await inspect()) return null
      if (progress.session) {
        const response = await drive(sessionUrl(progress.session), {
          method: 'PUT',
          headers: { 'Content-Range': `bytes */${progress.total ?? '*'}`, 'Content-Length': '0' },
        })
        if (response.ok) {
          if (!(await inspect())) throw new RelayFailure('Drive completion not yet visible')
          return null
        }
        if (response.status === 404 || response.status === 410) {
          delete progress.session
          progress.offset = 0
          await persist()
        } else if (response.status === 308) {
          progress.offset = confirmed(response, progress.total ?? job.maxBytes)
          await persist()
        } else throw new RelayFailure('Drive resume probe failed')
      }
      const start = progress.offset
      const headers = new Headers({
        Range: `bytes=${start}-${Math.min(start + CHUNK_BYTES, job.maxBytes) - 1}`,
        'Accept-Encoding': 'identity',
      })
      if (progress.etag) headers.set('If-Range', progress.etag)
      const response = await fetchSource(job.sourceUrl, { headers }, request, (url) =>
        validateSourceUrl(url, hosts),
      )
      if (response.status !== 200 && response.status !== 206)
        throw new RelayFailure(
          response.status === 403 || response.status === 404
            ? 'Source expired or rejected server access'
            : 'Source request failed',
          response.status < 500,
        )
      if (
        response.headers.get('content-encoding') &&
        response.headers.get('content-encoding') !== 'identity'
      ) {
        await response.body?.cancel()
        throw new RelayFailure('Encoded source cannot resume safely', true)
      }
      const range = RANGE.exec(response.headers.get('content-range') ?? '')
      const total = range
        ? Number(range[3])
        : Number(response.headers.get('content-length')) || undefined
      const etag = response.headers.get('etag')
      const resolvedUrl = response.url || job.sourceUrl
      const ranged = response.status === 206
      if (
        (ranged &&
          (!range ||
            Number(range[1]) !== start ||
            Number(range[2]) !== Math.min(start + CHUNK_BYTES, total ?? 0) - 1)) ||
        (start > 0 && !ranged) ||
        (total !== undefined &&
          (!Number.isSafeInteger(total) || total <= 0 || total > job.maxBytes)) ||
        (progress.total !== undefined && total !== progress.total) ||
        (progress.etag && etag !== progress.etag) ||
        (progress.resolvedUrl && resolvedUrl !== progress.resolvedUrl) ||
        (start > 0 && (!progress.etag || !progress.resolvedUrl)) ||
        ((start > 0 || (total ?? 0) > CHUNK_BYTES) && (!etag || !STRONG_ETAG.test(etag)))
      ) {
        await response.body?.cancel()
        throw new RelayFailure('Source size, identity, or Range validation failed', true)
      }
      const bytes = await readChunk(response, Math.min(CHUNK_BYTES, job.maxBytes - start))
      progress.sourceBytes += bytes.byteLength
      if (
        bytes.byteLength === 0 ||
        (total !== undefined && bytes.byteLength !== Math.min(CHUNK_BYTES, total - start))
      )
        throw new RelayFailure('Source length mismatch', true)
      progress.total = total ?? bytes.byteLength
      progress.resolvedUrl = resolvedUrl
      if (etag) progress.etag = etag
      await persist()
      if (!progress.session) {
        let parent = job.folderId
        for (const [index, name] of parts.entries()) {
          const escaped = name.replaceAll('\\', '\\\\').replaceAll("'", "\\'")
          const q = encodeURIComponent(
            `'${parent}' in parents and name = '${escaped}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          )
          const list = await drive(`${DRIVE}?q=${q}&fields=files(id)&pageSize=1`)
          if (!list.ok) throw new RelayFailure('Drive folder lookup failed')
          const files = (await jsonObject(list)).files
          const found = Array.isArray(files) ? files[0] : undefined
          if (found && typeof found === 'object' && 'id' in found && typeof found.id === 'string') {
            parent = found.id
          } else {
            const folderId = progress.folderIds?.[index]
            if (!folderId) throw new RelayFailure('Missing durable folder identity', true)
            const created = await drive(DRIVE, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: folderId,
                name,
                mimeType: 'application/vnd.google-apps.folder',
                parents: [parent],
              }),
            })
            if (!created.ok && created.status !== 409)
              throw new RelayFailure('Drive folder creation failed')
            parent = folderId
          }
        }
        const response = await drive(`${UPLOAD}?uploadType=resumable&fields=id,size`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Upload-Content-Type': job.contentType,
            'X-Upload-Content-Length': String(progress.total),
          },
          body: JSON.stringify({
            id: progress.fileId,
            name: filename,
            parents: [parent],
            mimeType: job.contentType,
          }),
        })
        if (response.status === 409) {
          if (!(await inspect())) throw new RelayFailure('Drive conflict awaits reconciliation')
          return null
        }
        if (!response.ok) throw new RelayFailure('Drive session creation failed')
        progress.session = sessionUrl(response.headers.get('location') ?? '')
        await persist()
      }
      const uploaded = await drive(sessionUrl(progress.session), {
        method: 'PUT',
        headers: {
          'Content-Type': job.contentType,
          'Content-Length': String(bytes.byteLength),
          'Content-Range': `bytes ${start}-${start + bytes.byteLength - 1}/${progress.total}`,
        },
        body: bytes,
      })
      progress.uploadedBytes += bytes.byteLength
      if (uploaded.ok) {
        if (!(await inspect())) throw new RelayFailure('Drive completion awaits reconciliation')
        return null
      }
      if (uploaded.status !== 308)
        throw new RelayFailure('Drive chunk response requires reconciliation')
      const offset = confirmed(uploaded, start + bytes.byteLength)
      if (offset <= start) throw new RelayFailure('Drive made no confirmed progress')
      progress.offset = offset
      await persist(true)
    } catch (error) {
      if (error instanceof RelayStopped) {
        await ctx.runMutation(checkpoint, { id, fence, progress, release: true, completed: false })
      } else {
        let safe = new RelayFailure('Transfer interrupted; retrying from confirmed Drive progress')
        if (error instanceof RelayFailure) safe = error
        else if (error instanceof UnsafeSourceUrlError || error instanceof SourceRedirectLimitError)
          safe = new RelayFailure('Unsafe source redirect refused', true)
        await ctx.runMutation(checkpoint, {
          id,
          fence,
          progress,
          release: true,
          completed: false,
          error: safe.message,
          permanent: safe.permanent,
        })
      }
    }
    return null
  },
})
