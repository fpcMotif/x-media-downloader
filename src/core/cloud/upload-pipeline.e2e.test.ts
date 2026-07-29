import { describe, it, expect } from 'vitest'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { DriveUploader, DriveUploaderLive } from './drive'
import { DropboxUploader, DropboxUploaderLive } from './dropbox'
import { makeFetchServiceLive } from '../fetch-service'
import { makeSourceFetchLive } from './source-fetch'
import { FolderCacheLive } from './folder-cache'
import {
  guessMime,
  type BlobAttemptAdvance,
  type CloudProviderId,
  type RemoteAttempt,
  type UploadInput,
} from './types'
import {
  bindRemoteAttempt,
  claim,
  enqueue,
  readyJobs,
  recordFailure,
  recordRemoteProgress,
  recordSourceGone,
  recordSuccess,
  summarize,
  type JobLedger,
  type UploadJobSpec,
} from './upload-job'

/**
 * End-to-end byte-path drain (ADR-0013, ADR-0017): exercises the REAL modules
 * wired the way the background orchestrator wires them — the UploadJob ledger
 * (enqueue → claim → record), the provider uploader services on a shared
 * `ManagedRuntime`, the SSRF-guarded `SourceFetch`, and the chunk streamer. Only
 * `fetch` (provider + twimg) and the clock are injected.
 */

type MediaItem = {
  id: string
  tweetId: string
  handle: string
  type: 'photo' | 'video' | 'gif'
  url: string
  ext: string
  index: number
}

/** Mirrors the background's spec builder: the cloud folder is the directory of the
 *  rendered local path (here the author handle stands in for the platform folder). */
function specFromItem(item: MediaItem, provider: CloudProviderId): UploadJobSpec {
  const filename = `${item.tweetId}_${item.index}.${item.ext}`
  return {
    requestId: item.id,
    provider,
    url: item.url,
    target: {
      path: `${item.handle}/${filename}`,
      folder: item.handle,
      filename,
      contentType: guessMime(item.ext),
    },
  }
}

const photo = (over: Partial<MediaItem> = {}): MediaItem => ({
  id: 'req-1',
  tweetId: '100',
  handle: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA?format=jpg&name=orig',
  ext: 'jpg',
  index: 0,
  ...over,
})

const video = (over: Partial<MediaItem> = {}): MediaItem =>
  photo({
    id: 'req-vid',
    type: 'video',
    url: 'https://video.twimg.com/ext_tw_video/BBB.mp4',
    ext: 'mp4',
    ...over,
  })

/** twimg CDN mock; `body`/`status` decide what each media URL returns. */
function makeTwimgFetch(opts: {
  body?: Uint8Array<ArrayBuffer>
  status?: number
  contentLength?: number | null
}) {
  return (async (url: string | URL) => {
    void url
    const status = opts.status ?? 200
    if (status >= 400) return new Response(null, { status })
    const headers: Record<string, string> = { 'content-type': 'image/jpeg' }
    const body = opts.body ?? new Uint8Array(1024)
    if (opts.contentLength !== null)
      headers['content-length'] = String(opts.contentLength ?? body.length)
    return new Response(body, { status, headers })
  }) as unknown as typeof fetch
}

/** Google Drive REST mock (folder list/create + multipart + resumable). */
function makeDriveProviderFetch() {
  let putCount = 0
  const fileId = 'drive-file-id'
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (u.includes('/generateIds'))
      return new Response(JSON.stringify({ ids: [fileId] }), { status: 200 })
    if (u.includes(`/drive/v3/files/${fileId}?fields=id,size,trashed`))
      return new Response('', { status: 404 })
    if (u.includes('uploadType=multipart'))
      return new Response(JSON.stringify({ id: fileId }), { status: 200 })
    if (u.includes('uploadType=resumable'))
      return new Response(null, { status: 200, headers: { location: 'https://drive.sess/put' } })
    if (u === 'https://drive.sess/put') {
      putCount += 1
      const range = ((init?.headers ?? {}) as Record<string, string>)['content-range'] ?? ''
      return range.endsWith('/*')
        ? new Response(null, { status: 308 })
        : new Response(JSON.stringify({ id: fileId }), { status: 200 })
    }
    if (u.includes('/drive/v3/files?') && method === 'GET')
      return new Response(JSON.stringify({ files: [] }), { status: 200 })
    if (u.includes('/drive/v3/files?') && method === 'POST')
      return new Response(JSON.stringify({ id: 'folder-x' }), { status: 200 })
    return new Response('unexpected', { status: 500 })
  }) as unknown as typeof fetch
  return { fetchImpl, putCount: () => putCount }
}

/** Dropbox content API mock (simple upload + upload session). */
function makeDropboxProviderFetch() {
  const fileId = 'id:db-file'
  const rev = 'db-rev'
  const contentHash = 'a'.repeat(64)
  let currentPath = ''
  let currentSize = 0
  const metadata = () => ({
    '.tag': 'file',
    id: fileId,
    rev,
    content_hash: contentHash,
    size: currentSize,
    path_display: currentPath,
    path_lower: currentPath.toLowerCase(),
  })
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.startsWith('https://api.dropboxapi.com/2/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        path?: string
        to_path?: string
      }
      if (u.endsWith('files/create_folder_v2'))
        return new Response(JSON.stringify({ metadata: { '.tag': 'folder' } }), { status: 200 })
      if (u.endsWith('files/get_metadata') && body.path !== fileId && body.path !== currentPath)
        return new Response(
          JSON.stringify({
            error_summary: 'path/not_found/...',
            error: { '.tag': 'path', path: { '.tag': 'not_found' } },
          }),
          { status: 409 },
        )
      if (u.endsWith('files/get_metadata'))
        return new Response(JSON.stringify(metadata()), { status: 200 })
      if (u.endsWith('files/move_v2')) {
        currentPath = body.to_path ?? currentPath
        return new Response(JSON.stringify({ metadata: metadata() }), { status: 200 })
      }
    }
    const arg = JSON.parse(
      ((init?.headers ?? {}) as Record<string, string>)['dropbox-api-arg'] ?? '{}',
    ) as { path?: string; commit?: { path?: string } }
    if (u.endsWith('files/upload')) {
      currentPath = arg.path ?? ''
      currentSize = (init?.body as Uint8Array | undefined)?.byteLength ?? 0
      return new Response(JSON.stringify(metadata()), { status: 200 })
    }
    if (u.endsWith('upload_session/start'))
      return new Response(JSON.stringify({ session_id: 'sess' }), { status: 200 })
    if (u.endsWith('upload_session/append_v2')) return new Response('', { status: 200 })
    if (u.endsWith('upload_session/finish')) {
      currentPath = arg.commit?.path ?? ''
      currentSize = 999
      return new Response(JSON.stringify(metadata()), { status: 200 })
    }
    return new Response('unexpected', { status: 500 })
  }) as unknown as typeof fetch
  return { fetchImpl }
}

interface AttemptRunner {
  readonly prepare: (
    jobId: string,
    provider: CloudProviderId,
    input: UploadInput,
  ) => Promise<RemoteAttempt>
  readonly advance: (
    provider: CloudProviderId,
    input: UploadInput,
    attempt: RemoteAttempt,
  ) => Promise<BlobAttemptAdvance>
}
const OWNER_KEY = 'b'.repeat(64)

/** Build the provider uploaders on one runtime — production's exact wiring, but
 *  with the provider REST fetch and the twimg fetch injected separately. */
function makeUploader(providerFetch: typeof fetch, twimgFetch: typeof fetch): AttemptRunner {
  const services = Layer.mergeAll(
    makeFetchServiceLive(providerFetch),
    makeSourceFetchLive(twimgFetch), // the REAL SSRF guard wraps this
    FolderCacheLive,
  )
  const app = Layer.mergeAll(DriveUploaderLive, DropboxUploaderLive).pipe(Layer.provide(services))
  const rt = ManagedRuntime.make(app)
  return {
    prepare: (jobId, provider) =>
      provider === 'gdrive'
        ? rt
            .runPromise(Effect.flatMap(DriveUploader, (u) => u.generateFileId('AT')))
            .then((fileId) => ({ kind: 'gdrive', ownerKey: OWNER_KEY, fileId }))
        : rt.runPromise(
            Effect.flatMap(DropboxUploader, (u) =>
              Effect.promise(() => u.prepare(jobId, OWNER_KEY)),
            ),
          ),
    advance: (provider, input, attempt) =>
      provider === 'gdrive'
        ? attempt.kind === 'gdrive'
          ? rt.runPromise(
              Effect.flatMap(DriveUploader, (u) =>
                u.advance({ accessToken: 'AT', rootFolderId: 'root' }, input, attempt.fileId),
              ),
            )
          : Promise.resolve({ kind: 'failure', reason: 'wrong provider attempt' })
        : rt.runPromise(
            Effect.flatMap(DropboxUploader, (u) =>
              u.advance({ accessToken: 'AT' }, input, attempt),
            ),
          ),
  }
}

/** The orchestration drain loop, distilled: claim each ready job, upload, record. */
async function drainOnce(
  ledger: JobLedger,
  runner: AttemptRunner,
  now: number,
): Promise<JobLedger> {
  let next = ledger
  for (const ready of readyJobs(next, now)) {
    const c = claim(next, ready.jobId, now)
    next = c.ledger
    if (!c.claimed) continue
    let job = next.find((j) => j.jobId === ready.jobId)!
    const input = { url: job.url, target: job.target }
    if (job.remoteAttempt === undefined) {
      // oxlint-disable-next-line no-await-in-loop -- later claims require this persisted attempt.
      const prepared = await runner.prepare(job.jobId, job.provider, input)
      next = bindRemoteAttempt(next, job.jobId, c.token!, prepared).ledger
      job = next.find((candidate) => candidate.jobId === ready.jobId)!
    }
    let outcome: Exclude<BlobAttemptAdvance, { readonly kind: 'progress' }> | undefined
    for (let step = 0; step < 2; step += 1) {
      // oxlint-disable-next-line no-await-in-loop -- Dropbox persists stage proof before move.
      const advanced = await runner.advance(job.provider, input, job.remoteAttempt!)
      if (advanced.kind !== 'progress') {
        outcome = advanced
        break
      }
      next = recordRemoteProgress(next, job.jobId, c.token!, advanced.attempt).ledger
      job = next.find((candidate) => candidate.jobId === ready.jobId)!
    }
    if (outcome === undefined) outcome = { kind: 'failure', reason: 'no terminal progress' }
    if (outcome.kind === 'success') {
      next = recordSuccess(next, job.jobId, c.token!, now, {
        bytes: outcome.bytes,
        remotePath: outcome.remotePath,
        ...(outcome.remoteId !== undefined ? { remoteId: outcome.remoteId } : {}),
      }).ledger
    } else if (outcome.kind === 'sourceGone') {
      next = recordSourceGone(next, job.jobId, c.token!, outcome.reason).ledger
    } else {
      next = recordFailure(next, job.jobId, c.token!, now, outcome.reason).ledger
    }
  }
  return next
}

describe('upload pipeline (e2e: ledger × SSRF guard × provider adapter)', () => {
  it('drives a small photo to Drive: enqueue → claim → guarded fetch → multipart → succeeded', async () => {
    const upload = makeUploader(
      makeDriveProviderFetch().fetchImpl,
      makeTwimgFetch({ body: new Uint8Array(1024).fill(7) }),
    )
    let ledger = enqueue([], specFromItem(photo(), 'gdrive'), 0)
    ledger = await drainOnce(ledger, upload, 0)
    expect(ledger[0]).toMatchObject({
      status: 'succeeded',
      bytes: 1024,
      remoteId: 'drive-file-id',
      verifiedAt: 0,
    })
  })

  it('streams a large video to Dropbox via an upload session → succeeded', async () => {
    const twimg = makeTwimgFetch({
      body: new Uint8Array(20 * 1024 * 1024).fill(3),
      contentLength: null,
    })
    const upload = makeUploader(makeDropboxProviderFetch().fetchImpl, twimg)
    let ledger = enqueue([], specFromItem(video(), 'dropbox'), 0)
    ledger = await drainOnce(ledger, upload, 0)
    expect(ledger[0]).toMatchObject({ status: 'succeeded', remoteId: 'id:db-file' })
  })

  it('streams an unknown-size video to Drive via a resumable session (>1 chunk) → succeeded', async () => {
    const twimg = makeTwimgFetch({ body: new Uint8Array(9 * 1024 * 1024), contentLength: null })
    const drive = makeDriveProviderFetch()
    const upload = makeUploader(drive.fetchImpl, twimg)
    let ledger = enqueue([], specFromItem(video({ id: 'req-rs' }), 'gdrive'), 0)
    ledger = await drainOnce(ledger, upload, 0)
    expect(ledger[0]).toMatchObject({ status: 'succeeded', remoteId: 'drive-file-id' })
    expect(drive.putCount()).toBe(2) // one 8 MiB chunk (308) + one 1 MiB final (200)
  })

  it('marks a 403-from-twimg job as skipped (link-rot), never a fake success', async () => {
    const upload = makeUploader(makeDriveProviderFetch().fetchImpl, makeTwimgFetch({ status: 403 }))
    let ledger = enqueue([], specFromItem(photo(), 'gdrive'), 0)
    ledger = await drainOnce(ledger, upload, 0)
    expect(ledger[0]!.status).toBe('skipped')
  })

  it('blocks an SSRF source URL at the guard and records a (retryable) failure', async () => {
    const upload = makeUploader(makeDriveProviderFetch().fetchImpl, makeTwimgFetch({}))
    // A job whose source URL is NOT an X media CDN — the guard must refuse it.
    let ledger = enqueue(
      [],
      specFromItem(photo({ url: 'https://169.254.169.254/latest/meta-data/' }), 'gdrive'),
      0,
    )
    ledger = await drainOnce(ledger, upload, 0)
    expect(ledger[0]!.status).toBe('failed')
    expect(ledger[0]!.error).toMatch(/UnsafeUrlError|private\/link-local/)
  })

  it('retries a transient provider failure on the next drain, then succeeds', async () => {
    const twimg = makeTwimgFetch({ body: new Uint8Array(512) })
    let provider500 = true
    // Provider 500s on the first attempt, then recovers.
    const flaky = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/generateIds'))
        return new Response(JSON.stringify({ ids: ['flaky-id'] }), { status: 200 })
      if (u.includes('/drive/v3/files/flaky-id?fields=id,size,trashed'))
        return new Response('', { status: 404 })
      if (u.includes('uploadType=multipart')) {
        if (provider500) return new Response('temporary', { status: 500 })
        return new Response(JSON.stringify({ id: 'flaky-id' }), { status: 200 })
      }
      if (u.includes('/drive/v3/files?') && (init?.method ?? 'GET') === 'GET')
        return new Response(
          JSON.stringify({
            files: (new URL(u).searchParams.get('q') ?? '').includes(
              "mimeType='application/vnd.google-apps.folder'",
            )
              ? [{ id: 'f' }]
              : [],
          }),
          { status: 200 },
        )
      return new Response('x', { status: 500 })
    }) as unknown as typeof fetch
    const upload = makeUploader(flaky, twimg)

    let ledger = enqueue([], specFromItem(photo(), 'gdrive'), 0)
    ledger = await drainOnce(ledger, upload, 0)
    expect(ledger[0]!.status).toBe('failed')
    expect(ledger[0]!.attempts).toBe(1)

    // Advance the clock past the backoff window and recover the provider.
    provider500 = false
    const due = ledger[0]!.nextAttemptAt
    expect(readyJobs(ledger, due - 1)).toHaveLength(0) // still backing off
    ledger = await drainOnce(ledger, upload, due)
    expect(ledger[0]).toMatchObject({ status: 'succeeded', remoteId: 'flaky-id' })
  })

  it('drains a mixed multi-provider batch in one pass', async () => {
    const twimg = makeTwimgFetch({ body: new Uint8Array(2048) })
    const drive = makeDriveProviderFetch().fetchImpl
    const db = makeDropboxProviderFetch().fetchImpl
    // One fetch capability routes by host (Drive vs Dropbox), as the SW's fetch would.
    const providerFetch = (async (url: string | URL, init?: RequestInit) =>
      String(url).includes('dropboxapi.com')
        ? db(String(url), init)
        : drive(String(url), init)) as unknown as typeof fetch
    const upload = makeUploader(providerFetch, twimg)

    let ledger: JobLedger = []
    ledger = enqueue(ledger, specFromItem(photo({ id: 'a' }), 'gdrive'), 0)
    ledger = enqueue(ledger, specFromItem(photo({ id: 'b' }), 'dropbox'), 0)
    ledger = enqueue(ledger, specFromItem(photo({ id: 'a' }), 'dropbox'), 0) // same media, 2nd provider
    ledger = await drainOnce(ledger, upload, 0)

    expect(summarize(ledger)).toMatchObject({ succeeded: 3, pending: 0, failed: 0 })
  })
})
