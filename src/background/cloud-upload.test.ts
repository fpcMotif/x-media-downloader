import { describe, it, expect, vi } from 'vitest'
import { makeRemoteUpload } from './remote-upload'
import { Schema } from 'effect'
import {
  makeCloudUpload,
  type AlarmPort,
  type AuthFlowPort,
  type BadgePort,
  type CloudHistoryNotice,
  type CloudRuntimePort,
  type CloudUploadDeps,
} from './cloud-upload'
import { Settings as SettingsSchema, type Settings, type JsonValue } from '@/packages/schema'
import { PROVIDERS } from '@/packages/cloud/provider'
import {
  decodeLedger,
  enqueue,
  idempotencyKeyFor,
  readyJobs,
  summarize,
  type JobLedger,
} from '@/packages/cloud/upload-job'
import { decodeUploadedKeys } from '@/packages/cloud/uploaded-set'
import type { UploadOutcome, UploadTarget } from '@/packages/cloud/types'

// The cloud-upload SHELL through its injected seams (ADR-0013/0017). The pure
// UploadJob ledger is covered in core/cloud/upload-job.test.ts; these tests pin the
// orchestration the reducer can't: the claim→lease→upload→record→cap→mirror drain,
// disconnect-mid-flight, the re-kick, backoff-wake gating, and the OAuth wiring.

const NOW = 1_000_000
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const baseSettings: Settings = Schema.decodeUnknownSync(SettingsSchema)({})
const gd = PROVIDERS.gdrive.fields

/** Settings with Cloud upload on and Google Drive connected (valid, non-expired token). */
const connected = (over: Partial<Settings> = {}): Settings => ({
  ...baseSettings,
  cloudUploadEnabled: true,
  [gd.clientId]: 'gdrive-client',
  [gd.accessToken]: 'gdrive-access',
  [gd.refreshToken]: 'gdrive-refresh',
  [gd.expiry]: NOW + 3_600_000, // far future → not expired
  ...over,
})

const dx = PROVIDERS.dropbox.fields

/** Settings with Cloud upload on and Dropbox connected (valid, non-expired token). */
const connectedDropbox = (over: Partial<Settings> = {}): Settings => ({
  ...baseSettings,
  cloudUploadEnabled: true,
  [dx.clientId]: 'dropbox-client',
  [dx.accessToken]: 'dropbox-access',
  [dx.refreshToken]: 'dropbox-refresh',
  [dx.expiry]: NOW + 3_600_000,
  ...over,
})

const target: UploadTarget = {
  path: 'twitter/pic.jpg',
  folder: 'twitter',
  filename: 'pic.jpg',
  contentType: 'image/jpeg',
}

/** Seed a ledger with N ready (pending, claimable at NOW) gdrive jobs. */
const seedJobs = (n: number): JobLedger => {
  let ledger: JobLedger = []
  for (let i = 0; i < n; i += 1)
    ledger = enqueue(
      ledger,
      { mediaId: `m${i}`, provider: 'gdrive', url: `https://video.twimg.com/${i}.mp4`, target },
      NOW,
    )
  return ledger
}

/** An in-memory ledger box — the LedgerStore seam's test adapter. `delay` widens the
 *  read-modify-write window so a serialization regression would surface as a lost update. */
function fakeLedger(initial: JsonValue = null, opts: { delay?: boolean } = {}) {
  const box = {
    value: initial,
    gets: 0,
    sets: 0,
    async get() {
      box.gets += 1
      if (opts.delay) await tick()
      return box.value
    },
    async set(value: JsonValue) {
      box.sets += 1
      if (opts.delay) await tick()
      box.value = value
    },
  }
  return box
}

const fakeUploaded = (initial: JsonValue = null) => fakeLedger(initial)

const ok = (bytes = 100): UploadOutcome => ({ kind: 'success', bytes, remotePath: target.path })

const fakeRuntime = (over: Partial<CloudRuntimePort> = {}): CloudRuntimePort => ({
  uploadDrive: vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok()),
  uploadDropbox: vi.fn<CloudRuntimePort['uploadDropbox']>(async () => ok()),
  resolveDriveRoot: vi.fn<CloudRuntimePort['resolveDriveRoot']>(async () => 'drive-root-id'),
  exchangeCode: vi.fn<CloudRuntimePort['exchangeCode']>(async () => ({
    accessToken: 'x-access',
    refreshToken: 'x-refresh',
    expiresAt: NOW + 3_600_000,
    account: 'alice@example.com',
  })),
  refreshAccessToken: vi.fn<CloudRuntimePort['refreshAccessToken']>(async () => ({
    accessToken: 'fresh-access',
    expiresAt: NOW + 3_600_000,
  })),
  mirror: vi.fn<CloudRuntimePort['mirror']>(async () => {}),
  ...over,
})

const fakeAlarms = (): AlarmPort => ({
  create: vi.fn<AlarmPort['create']>(async () => {}),
  clear: vi.fn<AlarmPort['clear']>(async () => {}),
})
const fakeBadge = (): BadgePort => ({
  set: vi.fn<BadgePort['set']>(async () => {}),
  setColor: vi.fn<BadgePort['setColor']>(async () => {}),
})
const fakeAuthFlow = (over: Partial<AuthFlowPort> = {}): AuthFlowPort => ({
  getRedirectUrl: vi.fn<AuthFlowPort['getRedirectUrl']>(() => 'https://ext.invalid/cb'),
  // A real provider echoes the `state` from the auth URL back on the redirect; mirror that.
  launchFlow: vi.fn<AuthFlowPort['launchFlow']>(async (url) => {
    const state = new URL(url).searchParams.get('state') ?? ''
    return `https://ext.invalid/cb?code=auth-code-xyz&state=${state}`
  }),
  ...over,
})

// SAFETY: `fetchImpl` is only ever forwarded to the default cloud runtime, which
// every test here overrides via `runtime`/`ledger` — this stub is never actually
// called, so its shape only needs to satisfy `typeof fetch`'s type.
const dummyFetch = (async () => new Response()) as typeof fetch

/** Construct the shell with safe fake ports by default; a test overrides what it asserts on. */
const makeCU = (over: Partial<CloudUploadDeps> = {}) =>
  makeCloudUpload({
    queueError: () => () => {},
    getSettings: async () => connected(),
    fetchImpl: dummyFetch,
    getBackfillRecords: async () => [],
    now: () => NOW,
    ledger: fakeLedger(),
    uploaded: fakeUploaded(),
    runtime: fakeRuntime(),
    alarms: fakeAlarms(),
    badge: fakeBadge(),
    authFlow: fakeAuthFlow(),
    setSettings: async () => connected(),
    random: () => 1,
    ...over,
  })

it('routes experimental Cloud-only acceptance exclusively to Convex, including after settings change', async () => {
  const settings = connected({
    saveToDisk: false,
    convexDriveEnabled: true,
    convexDriveConnected: true,
    convexUrl: 'https://test.convex.cloud',
    convexSyncSecret: 'test-secret',
    cloudDeviceId: 'device',
  })
  const runtime = fakeRuntime()
  const ledger = fakeLedger()
  const requests: string[] = []
  const remote = makeRemoteUpload({
    getSettings: async () => settings,
    store: fakeLedger(),
    onHistoryNotice: () => {},
    fetchImpl: async (url) => {
      requests.push(String(url))
      return Response.json({ status: 'success', value: { id: 'server-id', created: true } })
    },
  })
  const cu = makeCU({ remote, runtime, ledger })
  const candidates = [
    {
      item: {
        id: 'remote-item',
        url: 'https://pbs.twimg.com/media/test.jpg',
        handle: 'alice',
        ext: 'jpg',
      },
      filename: 'twitter/test.jpg',
      estimatedBytes: 4,
    },
  ]
  expect(await cu.recordCloudUploads(settings, candidates)).toEqual(['remote-item'])
  expect(
    await cu.recordCloudUploads({ ...settings, convexDriveEnabled: false }, candidates),
  ).toEqual([])
  await cu.drainUploadJobs()
  expect(decodeLedger(ledger.value)).toEqual([])
  expect(runtime.uploadDrive).not.toHaveBeenCalled()
  expect(runtime.uploadDropbox).not.toHaveBeenCalled()
  expect(requests.every((url) => url.startsWith(settings.convexUrl))).toBe(true)
})

describe('cloudUploadStatus', () => {
  it('reports the ledger summary read through the store seam', async () => {
    const ledger = fakeLedger(seedJobs(3))
    const cu = makeCU({ ledger })
    const status = await cu.cloudUploadStatus()
    expect(status.summary).toEqual(summarize(seedJobs(3)))
    expect(status.summary.pending).toBe(3)
    expect(status.lastError).toBeNull()
  })
})

describe('drainUploadJobs — disconnect mid-flight', () => {
  it('fails the job without uploading and records why', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDrive })
    const cu = makeCU({
      getSettings: async () => connected({ [gd.refreshToken]: '' }), // gdrive no longer connected
      ledger,
      runtime,
    })
    await cu.drainUploadJobs()
    expect(decodeLedger(ledger.value)[0]?.status).toBe('failed')
    expect(uploadDrive).not.toHaveBeenCalled()
    expect((await cu.cloudUploadStatus()).lastError).toBe('Google Drive is not connected.')
  })
})

describe('drainUploadJobs — lease ordering', () => {
  it('persists the uploading lease BEFORE the slow upload runs', async () => {
    const ledger = fakeLedger(seedJobs(1))
    let release!: (o: UploadOutcome) => void
    const gate = new Promise<UploadOutcome>((r) => {
      release = r
    })
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => gate)
    const cu = makeCU({ ledger, runtime: fakeRuntime({ uploadDrive }) })

    const done = cu.drainUploadJobs()
    await vi.waitFor(() => expect(uploadDrive).toHaveBeenCalledTimes(1))
    // The lease + 'uploading' status were persisted before the upload was awaited.
    expect(decodeLedger(ledger.value)[0]?.status).toBe('uploading')

    release(ok(42))
    await done
    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
  })
})

describe('drainUploadJobs — drain cap re-kick', () => {
  it('re-kicks itself onto the queue when one pass hits the job cap', async () => {
    // 3 ready jobs with a cap of 2: one pass cannot finish, so the drain must continue
    // on a fresh serialized task — else the 3rd job is stranded. (The cap is injected
    // only to exercise this without seeding a thousand jobs; prod uses 1000.)
    const ledger = fakeLedger(seedJobs(3))
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDrive })
    const cu = makeCU({ ledger, runtime, maxDrainPerPass: 2 })
    await cu.drainUploadJobs()
    await vi.waitFor(() => expect(uploadDrive).toHaveBeenCalledTimes(3))
    expect(readyJobs(decodeLedger(ledger.value), NOW)).toHaveLength(0)
  })
})

describe('drainUploadJobs — backoff-wake gating', () => {
  it('arms a wake-up alarm at the soonest backoff deadline after a failure', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const create = vi.fn<AlarmPort['create']>(async () => {})
    const clear = vi.fn<AlarmPort['clear']>(async () => {})
    const alarms: AlarmPort = { create, clear }
    const runtime = fakeRuntime({
      uploadDrive: vi.fn<CloudRuntimePort['uploadDrive']>(async () => ({
        kind: 'failure',
        reason: 'boom',
      })),
    })
    const cu = makeCU({ ledger, runtime, alarms })
    await cu.drainUploadJobs()
    // one failure → nextAttemptAt = NOW + backoff(1) = NOW + 5000; the alarm fires there.
    expect(create).toHaveBeenCalledWith(cu.uploadAlarm, NOW + 5000)
    expect(clear).not.toHaveBeenCalled()
  })

  it('clears the alarm when nothing is left to retry', async () => {
    const create = vi.fn<AlarmPort['create']>(async () => {})
    const clear = vi.fn<AlarmPort['clear']>(async () => {})
    const alarms: AlarmPort = { create, clear }
    const cu = makeCU({ ledger: fakeLedger(null), alarms })
    await cu.drainUploadJobs()
    expect(clear).toHaveBeenCalledWith(cu.uploadAlarm)
    expect(create).not.toHaveBeenCalled()
  })
})

describe('drainUploadJobs — cap then best-effort mirror', () => {
  it('keeps a persisted success even when the control-plane mirror throws', async () => {
    const ledger = fakeLedger(seedJobs(1))
    // Observe state AT mirror-call time (captured, not asserted inside — mirrorUploadJob
    // swallows throws, so an in-fake assertion would be swallowed too). The success must
    // already be persisted locally AND reflected on the wire job before the mirror fires.
    let persistedStatusAtMirror: string | undefined
    let wireStatusAtMirror: string | undefined
    const mirror = vi.fn<CloudRuntimePort['mirror']>(async ({ jobs }) => {
      persistedStatusAtMirror = decodeLedger(ledger.value)[0]?.status
      wireStatusAtMirror = jobs[0]?.status
      throw new Error('convex 500')
    })
    const cu = makeCU({
      getSettings: async () =>
        connected({
          cloudSyncEnabled: true,
          convexUrl: 'https://x.convex.cloud',
          convexSyncSecret: 'sek',
          cloudDeviceId: 'dev-1',
        }),
      ledger,
      runtime: fakeRuntime({ mirror }),
    })
    await cu.drainUploadJobs()
    expect(mirror).toHaveBeenCalledTimes(1)
    // The local ledger is persisted (and capped) BEFORE the mirror — so a mirror-first
    // regression would observe 'uploading' here and fail this assertion.
    expect(persistedStatusAtMirror).toBe('succeeded')
    expect(wireStatusAtMirror).toBe('succeeded')
    // And the throw is harmless: the persisted success survives.
    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
  })
})

describe('drainUploadJobs — token refresh on expiry', () => {
  it('refreshes and persists an expired access token before uploading', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const refreshAccessToken = vi.fn<CloudRuntimePort['refreshAccessToken']>(async () => ({
      accessToken: 'fresh-access',
      expiresAt: NOW + 3_600_000,
    }))
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ refreshAccessToken, uploadDrive })
    const setSettings = vi.fn<NonNullable<CloudUploadDeps['setSettings']>>(async (patch) =>
      connected(patch),
    )
    const cu = makeCU({
      getSettings: async () => connected({ [gd.expiry]: NOW - 1 }), // already expired
      ledger,
      runtime,
      setSettings,
    })
    await cu.drainUploadJobs()
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ [gd.accessToken]: 'fresh-access' }),
    )
    // The REFRESHED token (not the stale one) must reach the uploader.
    expect(uploadDrive).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fresh-access' }),
      expect.anything(),
    )
  })

  it('skips refresh when the token is still valid', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const refreshAccessToken = vi.fn<CloudRuntimePort['refreshAccessToken']>(async () => ({
      accessToken: 'fresh-access',
      expiresAt: NOW + 3_600_000,
    }))
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ refreshAccessToken, uploadDrive })
    const cu = makeCU({ ledger, runtime }) // connected() default → far-future expiry
    await cu.drainUploadJobs()
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(uploadDrive).toHaveBeenCalledTimes(1)
  })
})

describe('Cloud-only history verdicts (issue #95)', () => {
  /** Drive + Dropbox both connected, so the enabled set follows the switches. */
  const bothConnected = (over: Partial<Settings> = {}): Settings => ({
    ...connected(),
    [dx.clientId]: 'dropbox-client',
    [dx.accessToken]: 'dropbox-access',
    [dx.refreshToken]: 'dropbox-refresh',
    [dx.expiry]: NOW + 3_600_000,
    ...over,
  })

  const deadDropboxForM0 = {
    ...enqueue(
      [],
      { mediaId: 'm0', provider: 'dropbox', url: 'https://video.twimg.com/m0.mp4', target },
      NOW,
    )[0]!,
    status: 'dead' as const,
    cloudOnly: true,
  }

  it('notifies completed when the sole enabled job succeeds with saveToDisk off', async () => {
    const ledger = fakeLedger([{ ...seedJobs(1)[0]!, cloudOnly: true }])
    const notices: CloudHistoryNotice[] = []
    const cu = makeCU({
      ledger,
      getSettings: async () => connected({ saveToDisk: false }),
      onHistoryNotice: (n) => void notices.push(n),
    })
    await cu.drainUploadJobs()
    expect(notices).toEqual([{ mediaId: 'm0', kind: 'completed', at: NOW }])
  })

  it('stays silent while saveToDisk is on — history follows disk Settle', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const notices: CloudHistoryNotice[] = []
    const cu = makeCU({ ledger, onHistoryNotice: (n) => void notices.push(n) })
    await cu.drainUploadJobs()
    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
    expect(notices).toEqual([])
  })

  it('notifies a media once — later reconciles stay quiet', async () => {
    const ledger = fakeLedger([{ ...seedJobs(1)[0]!, cloudOnly: true }])
    const notices: CloudHistoryNotice[] = []
    const cu = makeCU({
      ledger,
      getSettings: async () => connected({ saveToDisk: false }),
      onHistoryNotice: (n) => void notices.push(n),
    })
    await cu.drainUploadJobs()
    await cu.reconcileCloudOnlyHistory()
    expect(notices).toHaveLength(1)
  })

  it('reconcile resolves a mixed result once the dead provider is paused', async () => {
    const drive = { ...seedJobs(1)[0]!, status: 'succeeded' as const, cloudOnly: true }
    const ledger = fakeLedger([drive, deadDropboxForM0])
    const notices: CloudHistoryNotice[] = []
    const cu = makeCU({
      ledger,
      getSettings: async () => bothConnected({ saveToDisk: false, dropboxUploadEnabled: false }),
      onHistoryNotice: (n) => void notices.push(n),
    })
    await cu.reconcileCloudOnlyHistory()
    expect(notices).toEqual([{ mediaId: 'm0', kind: 'completed', at: NOW }])
  })

  it('reconcile stays silent on a mixed result while both providers are enabled', async () => {
    const drive = { ...seedJobs(1)[0]!, status: 'succeeded' as const, cloudOnly: true }
    const ledger = fakeLedger([drive, deadDropboxForM0])
    const notices: CloudHistoryNotice[] = []
    const cu = makeCU({
      ledger,
      getSettings: async () => bothConnected({ saveToDisk: false }),
      onHistoryNotice: (n) => void notices.push(n),
    })
    await cu.reconcileCloudOnlyHistory()
    expect(notices).toEqual([])
  })

  it('uses persisted cloud ownership after disk saving is enabled and suppresses restart duplicates', async () => {
    const ledger = fakeLedger([{ ...seedJobs(1)[0]!, cloudOnly: true }])
    const notices: CloudHistoryNotice[] = []
    const deps = {
      ledger,
      getSettings: async () => connected({ saveToDisk: true }),
      onHistoryNotice: (notice: CloudHistoryNotice) => void notices.push(notice),
    }
    await makeCU(deps).drainUploadJobs()
    expect(notices).toEqual([{ mediaId: 'm0', kind: 'completed', at: NOW }])
    await makeCU(deps).reconcileCloudOnlyHistory()
    expect(notices).toHaveLength(1)
  })

  it('keeps local history owned by disk after disk saving is disabled', async () => {
    const notices: CloudHistoryNotice[] = []
    const cu = makeCU({
      ledger: fakeLedger(seedJobs(1)),
      getSettings: async () => connected({ saveToDisk: false }),
      onHistoryNotice: (notice) => void notices.push(notice),
    })
    await cu.drainUploadJobs()
    await cu.reconcileCloudOnlyHistory()
    expect(notices).toEqual([])
  })

  it.each([false, true])(
    'reports successful retry after failure with worker restart=%s',
    async (restart) => {
      const ledger = fakeLedger([{ ...seedJobs(1)[0]!, cloudOnly: true, status: 'dead' }])
      const notices: CloudHistoryNotice[] = []
      const deps = {
        ledger,
        getSettings: async () => connected({ saveToDisk: false }),
        onHistoryNotice: (notice: CloudHistoryNotice) => void notices.push(notice),
      }
      const first = makeCU(deps)
      await first.reconcileCloudOnlyHistory()
      expect(notices).toEqual([{ mediaId: 'm0', kind: 'failed', at: NOW }])
      const retryWorker = restart ? makeCU(deps) : first
      await retryWorker.reconcileCloudOnlyHistory()
      expect(notices).toHaveLength(1)
      await retryWorker.retryDeadUploads()
      await vi.waitFor(() => expect(notices).toHaveLength(2))
      expect(notices[1]).toEqual({ mediaId: 'm0', kind: 'completed', at: NOW })
      await makeCU(deps).reconcileCloudOnlyHistory()
      expect(notices).toHaveLength(2)
    },
  )
})

describe('runOAuthConnect — wiring (NOT the consent popup)', () => {
  // The fake authFlow.launchFlow echoes the auth URL's `state` back on the redirect,
  // exactly as a real provider does — so this proves the parse→exchange→persist WIRING.
  // It does NOT exercise the real browser.identity consent handshake, which stays
  // genuinely browser-bound and must be verified manually. Do not delete that coverage.
  it('parses the redirect, exchanges the code, and persists the tokens', async () => {
    const exchangeCode = vi.fn<CloudRuntimePort['exchangeCode']>(async () => ({
      accessToken: 'x-access',
      refreshToken: 'x-refresh',
      expiresAt: NOW + 3_600_000,
      account: 'alice@example.com',
    }))
    const runtime = fakeRuntime({ exchangeCode })
    const setSettings = vi.fn<NonNullable<CloudUploadDeps['setSettings']>>(async (patch) =>
      connected(patch),
    )
    const cu = makeCU({
      getSettings: async () => connected({ [gd.clientId]: '', [gd.refreshToken]: '' }),
      runtime,
      setSettings,
      authFlow: fakeAuthFlow(),
    })
    const res = await cu.runOAuthConnect('gdrive', 'typed-client-id')
    expect(res.ok).toBe(true)
    expect(res.account).toBe('alice@example.com')
    expect(exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'auth-code-xyz', clientId: 'typed-client-id' }),
    )
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ [gd.refreshToken]: 'x-refresh', [gd.accessToken]: 'x-access' }),
    )
  })

  it('reports cancellation when the consent flow returns no redirect', async () => {
    const cu = makeCU({
      authFlow: fakeAuthFlow({
        launchFlow: vi.fn<AuthFlowPort['launchFlow']>(async () => undefined),
      }),
    })
    const res = await cu.runOAuthConnect('gdrive', 'typed-client-id')
    expect(res.ok).toBe(false)
    expect(res.detail).toBe('Authorization was cancelled.')
  })
})

describe('serialized upload queue', () => {
  it('serializes interleaved enqueues so neither batch is lost', async () => {
    // A delayed store widens the read-modify-write window: without FIFO serialization
    // the second enqueue would read the ledger before the first wrote it and clobber it.
    const ledger = fakeLedger(null, { delay: true })
    const cu = makeCU({ ledger, runtime: fakeRuntime() })
    cu.recordCloudUploads(connected(), [
      {
        item: { id: 'A', url: 'https://video.twimg.com/a.mp4', handle: 'alice', ext: 'mp4' },
        filename: 'alice/a.mp4',
      },
    ])
    cu.recordCloudUploads(connected(), [
      {
        item: { id: 'B', url: 'https://video.twimg.com/b.mp4', handle: 'bob', ext: 'mp4' },
        filename: 'bob/b.mp4',
      },
    ])
    await vi.waitFor(() => {
      const ids = decodeLedger(ledger.value).map((j) => j.mediaId)
      expect(ids).toContain('A')
      expect(ids).toContain('B')
    })
  })

  it('derives the cloud folder from the filename directory (platform folder, no handle)', async () => {
    // The rendered local path is `twitter/123_0.mp4`; the cloud target must mirror it —
    // folder `twitter`, basename `123_0.mp4` — regardless of the media's author handle.
    const ledger = fakeLedger(null)
    const cu = makeCU({ ledger, runtime: fakeRuntime() })
    cu.recordCloudUploads(connected(), [
      {
        item: { id: 'X', url: 'https://video.twimg.com/x.mp4', handle: 'alice', ext: 'mp4' },
        filename: 'twitter/123_0.mp4',
      },
    ])
    await vi.waitFor(() => {
      const job = decodeLedger(ledger.value)[0]
      expect(job?.target).toMatchObject({
        path: 'twitter/123_0.mp4',
        folder: 'twitter',
        filename: '123_0.mp4',
      })
    })
  })
})

describe('disconnectProvider', () => {
  it('revokes the grant then wipes the local tokens', async () => {
    const setSettings = vi.fn<NonNullable<CloudUploadDeps['setSettings']>>(async (patch) =>
      connected(patch),
    )
    const cu = makeCU({ getSettings: async () => connected(), setSettings })
    const res = await cu.disconnectProvider('gdrive')
    expect(res.ok).toBe(true)
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        [gd.accessToken]: '',
        [gd.refreshToken]: '',
        [gd.account]: '',
        [gd.expiry]: 0,
      }),
    )
  })

  it('revokes at the provider BEFORE wiping local tokens', async () => {
    const order: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const endpoint = url instanceof URL ? url.href : url instanceof Request ? url.url : url
      order.push(`revoke:${endpoint}`)
      return new Response()
    })
    const setSettings = vi.fn<NonNullable<CloudUploadDeps['setSettings']>>(async (patch) => {
      order.push('wipe')
      return connected(patch)
    })
    const cu = makeCU({ getSettings: async () => connected(), fetchImpl, setSettings })
    await cu.disconnectProvider('gdrive')
    expect(order).toEqual(['revoke:https://oauth2.googleapis.com/revoke', 'wipe'])
  })

  it('wipes Dropbox tokens with no folderId field (gdrive-only asymmetry)', async () => {
    const setSettings = vi.fn<NonNullable<CloudUploadDeps['setSettings']>>(async (patch) =>
      connectedDropbox(patch),
    )
    const cu = makeCU({ getSettings: async () => connectedDropbox(), setSettings })
    await cu.disconnectProvider('dropbox')
    const patch = setSettings.mock.calls[0]![0]
    expect(patch).toEqual(expect.objectContaining({ [dx.accessToken]: '', [dx.refreshToken]: '' }))
    expect(Object.keys(patch)).not.toContain('gdriveFolderId')
    expect(Object.keys(patch)).not.toContain('dropboxFolderId')
  })
})

describe('retryDeadUploads', () => {
  it('re-arms a dead job to pending and drains it', async () => {
    const dead = { ...seedJobs(1)[0]!, status: 'dead' as const, attempts: 5, error: 'boom' }
    const ledger = fakeLedger([dead])
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDrive })
    const cu = makeCU({ ledger, runtime })
    await cu.retryDeadUploads()
    await vi.waitFor(() => expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded'))
    expect(uploadDrive).toHaveBeenCalledTimes(1)
  })
})

describe('backfillCloudUploads', () => {
  it('enqueues past downloads from history and drains them', async () => {
    const ledger = fakeLedger(null)
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDrive })
    const cu = makeCU({
      ledger,
      runtime,
      getBackfillRecords: async () => [
        {
          requestId: 'r1',
          filename: 'alice/old.mp4',
          media: { url: 'https://video.twimg.com/old.mp4', handle: 'alice', ext: 'mp4' },
        },
      ],
    })
    const res = await cu.backfillCloudUploads()
    expect(res.ok).toBe(true)
    expect(res.queued).toBe(1)
    await vi.waitFor(() => expect(uploadDrive).toHaveBeenCalledTimes(1))
  })

  it('reports when there are no past downloads to back-fill', async () => {
    const cu = makeCU({ getBackfillRecords: async () => [] })
    const res = await cu.backfillCloudUploads()
    expect(res.ok).toBe(false)
    expect(res.queued).toBe(0)
  })

  it('skips a paused provider when backfilling', async () => {
    const ledger = fakeLedger(null)
    const runtime = fakeRuntime()
    const bothPausedDropbox: Settings = {
      ...connected(),
      [dx.clientId]: 'dropbox-client',
      [dx.accessToken]: 'dropbox-access',
      [dx.refreshToken]: 'dropbox-refresh',
      [dx.expiry]: NOW + 3_600_000,
      dropboxUploadEnabled: false,
    }
    const cu = makeCU({
      ledger,
      runtime,
      getSettings: async () => bothPausedDropbox,
      getBackfillRecords: async () => [
        {
          requestId: 'r1',
          filename: 'alice/old.mp4',
          media: { url: 'https://video.twimg.com/old.mp4', handle: 'alice', ext: 'mp4' },
        },
      ],
    })
    const res = await cu.backfillCloudUploads()
    expect(res.ok).toBe(true)
    expect(res.queued).toBe(1)
    await vi.waitFor(() => expect(runtime.uploadDrive).toHaveBeenCalledTimes(1))
    expect(runtime.uploadDropbox).not.toHaveBeenCalled()
  })

  it('backfill replies while a drain is in flight', async () => {
    const ledger = fakeLedger(null)
    let releaseUpload: ((outcome: UploadOutcome) => void) | undefined
    let calls = 0
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(() => {
      calls += 1
      if (calls === 1) {
        return new Promise<UploadOutcome>((resolve) => {
          releaseUpload = resolve
        })
      }
      return Promise.resolve(ok())
    })
    const runtime = fakeRuntime({ uploadDrive })
    const cu = makeCU({
      ledger,
      runtime,
      getBackfillRecords: async () => [
        {
          requestId: 'r1',
          filename: 'alice/old.mp4',
          media: { url: 'https://video.twimg.com/old.mp4', handle: 'alice', ext: 'mp4' },
        },
      ],
    })
    await cu.recordCloudUploads(connected(), [
      {
        item: { id: 'm0', url: 'https://video.twimg.com/0.mp4', handle: 'alice', ext: 'mp4' },
        filename: 'twitter/pic.jpg',
      },
    ])
    await vi.waitFor(() => expect(uploadDrive).toHaveBeenCalledTimes(1))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const blocked = new Promise<'blocked'>((resolve) => {
        timer = setTimeout(() => resolve('blocked'), 200)
      })
      const result = await Promise.race([cu.backfillCloudUploads(), blocked])
      expect(result).toEqual(expect.objectContaining({ ok: true, queued: 1 }))
    } finally {
      clearTimeout(timer)
      releaseUpload?.(ok())
      await cu.uploadQueue.run(async () => {})
    }
  })

  it('backfill does not re-queue media whose succeeded rows were pruned', async () => {
    const ledger = fakeLedger(null)
    const uploaded = fakeUploaded()
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDrive })
    const records = Array.from({ length: 60 }, (_, i) => ({
      requestId: `r${i}`,
      filename: `alice/old-${i}.mp4`,
      media: { url: `https://video.twimg.com/old-${i}.mp4`, handle: 'alice', ext: 'mp4' },
    }))
    const cu = makeCU({
      ledger,
      uploaded,
      runtime,
      getBackfillRecords: async () => records,
    })
    const first = await cu.backfillCloudUploads()
    expect(first.ok).toBe(true)
    expect(first.queued).toBe(60)
    await cu.uploadQueue.run(async () => {})
    expect(uploadDrive).toHaveBeenCalledTimes(60)
    const succeededRows = decodeLedger(ledger.value).filter((j) => j.status === 'succeeded')
    expect(succeededRows.length).toBeLessThanOrEqual(50)

    const second = await cu.backfillCloudUploads()
    await cu.uploadQueue.run(async () => {})
    expect(second.queued).toBe(0)
    expect(uploadDrive).toHaveBeenCalledTimes(60)
  })
})

describe('resumeOnBoot', () => {
  it('compacts the ledger and drains pending uploads on boot', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDrive })
    const cu = makeCU({ ledger, runtime })
    cu.resumeOnBoot()
    await vi.waitFor(() => expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded'))
    expect(uploadDrive).toHaveBeenCalledTimes(1)
  })

  it('boot sweep remembers succeeded rows', async () => {
    const idempotencyKey = idempotencyKeyFor('m0', 'gdrive')
    const ledger = fakeLedger([
      {
        jobId: idempotencyKey,
        idempotencyKey,
        mediaId: 'm0',
        provider: 'gdrive',
        url: 'https://video.twimg.com/0.mp4',
        target: {
          path: target.path,
          folder: target.folder,
          filename: target.filename,
          contentType: target.contentType,
        },
        status: 'succeeded',
        attempts: 0,
        nextAttemptAt: NOW,
        leaseUntil: null,
        leaseSeq: 0,
        verifiedAt: NOW,
        error: null,
      },
    ])
    const uploaded = fakeUploaded()
    const cu = makeCU({ ledger, uploaded })
    cu.resumeOnBoot()
    await cu.uploadQueue.run(async () => {})
    expect(decodeUploadedKeys(uploaded.value)).toEqual([idempotencyKey])
  })
})

describe('drainUploadJobs — sourceGone (link-rot, never a fake save)', () => {
  it('marks the job skipped without arming a retry or recording an error', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const create = vi.fn<AlarmPort['create']>(async () => {})
    const clear = vi.fn<AlarmPort['clear']>(async () => {})
    const alarms: AlarmPort = { create, clear }
    const runtime = fakeRuntime({
      uploadDrive: vi.fn<CloudRuntimePort['uploadDrive']>(async () => ({
        kind: 'sourceGone',
        reason: 'source HTTP 410',
      })),
    })
    const cu = makeCU({ ledger, runtime, alarms })
    await cu.drainUploadJobs()
    // 'skipped' is terminal and honest — distinct from a retryable failure.
    expect(decodeLedger(ledger.value)[0]?.status).toBe('skipped')
    expect(create).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledWith(cu.uploadAlarm)
    // The sourceGone arm never sets lastUploadError (unlike the failure arm).
    expect((await cu.cloudUploadStatus()).lastError).toBeNull()
  })
})

describe('drainUploadJobs — Drive root folder resolution', () => {
  it('resolves and persists the Drive root once when unset, passing it to the upload', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const resolveDriveRoot = vi.fn<CloudRuntimePort['resolveDriveRoot']>(
      async () => 'drive-root-id',
    )
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ resolveDriveRoot, uploadDrive })
    const setSettings = vi.fn<NonNullable<CloudUploadDeps['setSettings']>>(async (patch) =>
      connected(patch),
    )
    const cu = makeCU({ ledger, runtime, setSettings }) // connected(): gdriveFolderId is ''
    await cu.drainUploadJobs()
    expect(resolveDriveRoot).toHaveBeenCalledTimes(1)
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ gdriveFolderId: 'drive-root-id' }),
    )
    expect(uploadDrive).toHaveBeenCalledWith(
      expect.objectContaining({ rootFolderId: 'drive-root-id' }),
      expect.anything(),
    )
  })

  it('reuses a stored Drive root without re-resolving', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const resolveDriveRoot = vi.fn<CloudRuntimePort['resolveDriveRoot']>(
      async () => 'drive-root-id',
    )
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ resolveDriveRoot, uploadDrive })
    const cu = makeCU({
      ledger,
      runtime,
      getSettings: async () => connected({ gdriveFolderId: 'pre-resolved' }),
    })
    await cu.drainUploadJobs()
    expect(resolveDriveRoot).not.toHaveBeenCalled()
    expect(uploadDrive).toHaveBeenCalledWith(
      expect.objectContaining({ rootFolderId: 'pre-resolved' }),
      expect.anything(),
    )
  })
})

describe('drainUploadJobs — Dropbox provider', () => {
  it('routes a dropbox job to uploadDropbox, never uploadDrive', async () => {
    const ledger = fakeLedger(
      enqueue(
        [],
        { mediaId: 'd0', provider: 'dropbox', url: 'https://video.twimg.com/d.mp4', target },
        NOW,
      ),
    )
    const uploadDropbox = vi.fn<CloudRuntimePort['uploadDropbox']>(async () => ok())
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDropbox, uploadDrive })
    const cu = makeCU({ getSettings: async () => connectedDropbox(), ledger, runtime })
    await cu.drainUploadJobs()
    expect(uploadDropbox).toHaveBeenCalledTimes(1)
    expect(uploadDrive).not.toHaveBeenCalled()
    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
  })
})

describe('recordCloudUploads — gating (no side effects)', () => {
  const item = {
    item: { id: 'A', url: 'https://video.twimg.com/a.mp4', handle: 'alice', ext: 'mp4' },
    filename: 'alice/a.mp4',
  }

  it('returns unique media IDs only after their jobs are persisted', async () => {
    const ledger = fakeLedger()
    const cu = makeCU({ ledger })
    const accepted = await cu.recordCloudUploads(connected({ saveToDisk: false }), [item, item])
    expect(accepted).toEqual(['A'])
    expect(decodeLedger(ledger.value)).toEqual([
      expect.objectContaining({ mediaId: 'A', cloudOnly: true }),
    ])
  })

  it.each(['succeeded', 'uploading'])(
    'does not accept an existing %s job again',
    async (status) => {
      const initial = enqueue(
        [],
        {
          mediaId: item.item.id,
          provider: 'gdrive',
          url: item.item.url,
          target,
        },
        NOW,
      )
      const ledger = fakeLedger([{ ...initial[0]!, status, leaseUntil: NOW + 60_000 }])
      const cu = makeCU({ ledger })
      expect(await cu.recordCloudUploads(connected(), [item])).toEqual([])
    },
  )

  it('rejects when ledger storage fails instead of accepting the media', async () => {
    const ledger = fakeLedger()
    const storageError = new Error('storage write failed')
    const cu = makeCU({
      ledger: {
        get: ledger.get,
        set: async () => {
          throw storageError
        },
      },
    })
    await expect(cu.recordCloudUploads(connected(), [item])).rejects.toBe(storageError)
    expect(decodeLedger(ledger.value)).toEqual([])
  })

  it('does nothing when Cloud upload is disabled', async () => {
    const ledger = fakeLedger()
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDrive })
    makeCU({ ledger, runtime }).recordCloudUploads(connected({ cloudUploadEnabled: false }), [item])
    await tick()
    expect(ledger.gets).toBe(0)
    expect(ledger.sets).toBe(0)
    expect(uploadDrive).not.toHaveBeenCalled()
  })

  it('does nothing for an empty item batch', async () => {
    const ledger = fakeLedger()
    makeCU({ ledger }).recordCloudUploads(connected(), [])
    await tick()
    expect(ledger.sets).toBe(0)
  })

  it('does nothing when no provider is connected', async () => {
    const ledger = fakeLedger()
    makeCU({ ledger }).recordCloudUploads(connected({ [gd.refreshToken]: '' }), [item])
    await tick()
    expect(ledger.sets).toBe(0)
  })

  it('does nothing when every connected provider is paused', async () => {
    const ledger = fakeLedger()
    makeCU({ ledger }).recordCloudUploads(connected({ gdriveUploadEnabled: false }), [item])
    await tick()
    expect(ledger.sets).toBe(0)
  })

  it('enqueues only the unpaused provider when both are connected', async () => {
    const both: Settings = {
      ...connected(),
      [dx.clientId]: 'dropbox-client',
      [dx.accessToken]: 'dropbox-access',
      [dx.refreshToken]: 'dropbox-refresh',
      [dx.expiry]: NOW + 3_600_000,
      dropboxUploadEnabled: false,
    }
    const ledger = fakeLedger()
    const runtime = fakeRuntime()
    makeCU({ ledger, runtime }).recordCloudUploads(both, [item])
    await vi.waitFor(() => expect(decodeLedger(ledger.value)).toHaveLength(1))
    expect(decodeLedger(ledger.value)[0]?.provider).toBe('gdrive')
    expect(runtime.uploadDropbox).not.toHaveBeenCalled()
  })

  it('skips remembered keys on repeat non-cloud-only enqueue after pruning', async () => {
    const ledger = fakeLedger(null)
    const uploaded = fakeUploaded([idempotencyKeyFor(item.item.id, 'gdrive')])
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDrive })
    const cu = makeCU({ ledger, uploaded, runtime })
    const accepted = await cu.recordCloudUploads(connected({ saveToDisk: true }), [item])
    await cu.uploadQueue.run(async () => {})
    expect(accepted).toEqual([])
    expect(decodeLedger(ledger.value)).toEqual([])
    expect(uploadDrive).not.toHaveBeenCalled()
  })

  it('still enqueues remembered keys for cloud-only saves', async () => {
    const ledger = fakeLedger(null)
    const uploaded = fakeUploaded([idempotencyKeyFor(item.item.id, 'gdrive')])
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDrive })
    const cu = makeCU({
      ledger,
      uploaded,
      runtime,
      getSettings: async () => connected({ saveToDisk: false }),
    })
    const accepted = await cu.recordCloudUploads(connected({ saveToDisk: false }), [item])
    expect(accepted).toEqual(['A'])
    expect(decodeLedger(ledger.value)).toEqual([
      expect.objectContaining({ mediaId: 'A', cloudOnly: true }),
    ])
    await cu.uploadQueue.run(async () => {})
    expect(uploadDrive).toHaveBeenCalledTimes(1)
  })
})

describe('drainUploadJobs — exhausted claim', () => {
  it('marks a crashed job dead when its lease expired at the attempt cap', async () => {
    // status 'uploading' + attempts 4 + expired lease: isClaimable is true, but claim()
    // consumes the 5th attempt and refuses as 'exhausted' → dead, no upload.
    const crashed = {
      ...seedJobs(1)[0]!,
      status: 'uploading' as const,
      attempts: 4,
      leaseUntil: NOW - 1,
      nextAttemptAt: NOW - 1,
      leaseSeq: 3,
    }
    const ledger = fakeLedger([crashed])
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ uploadDrive })
    const cu = makeCU({ ledger, runtime })
    await cu.drainUploadJobs()
    expect(decodeLedger(ledger.value)[0]?.status).toBe('dead')
    expect(uploadDrive).not.toHaveBeenCalled()
    expect(readyJobs(decodeLedger(ledger.value), NOW)).toHaveLength(0)
  })
})

describe('badge', () => {
  it('clearUploadBadge clears the toolbar text', async () => {
    const set = vi.fn<BadgePort['set']>(async () => {})
    const setColor = vi.fn<BadgePort['setColor']>(async () => {})
    const badge: BadgePort = { set, setColor }
    makeCU({ badge }).clearUploadBadge()
    await tick()
    expect(set).toHaveBeenCalledWith('')
  })

  it('reflects the permanently-dead count after a drain', async () => {
    const set = vi.fn<BadgePort['set']>(async () => {})
    const setColor = vi.fn<BadgePort['setColor']>(async () => {})
    const badge: BadgePort = { set, setColor }
    const dead = { ...seedJobs(1)[0]!, status: 'dead' as const, attempts: 5, error: 'boom' }
    const cu = makeCU({ ledger: fakeLedger([dead]), badge })
    await cu.drainUploadJobs()
    expect(set).toHaveBeenCalledWith('1')
    expect(setColor).toHaveBeenCalledWith('#dc2626')
  })
})

const toLedgerJson = (jobs: JobLedger): JsonValue =>
  jobs.map((job) => ({
    jobId: job.jobId,
    idempotencyKey: job.idempotencyKey,
    mediaId: job.mediaId,
    provider: job.provider,
    url: job.url,
    target: {
      path: job.target.path,
      folder: job.target.folder,
      filename: job.target.filename,
      contentType: job.target.contentType,
    },
    status: job.status,
    attempts: job.attempts,
    nextAttemptAt: job.nextAttemptAt,
    leaseUntil: job.leaseUntil,
    leaseSeq: job.leaseSeq,
    verifiedAt: job.verifiedAt,
    error: job.error,
    ...(job.cloudOnly !== undefined ? { cloudOnly: job.cloudOnly } : {}),
    ...(job.historyOutcome !== undefined ? { historyOutcome: job.historyOutcome } : {}),
    ...(job.remoteId !== undefined ? { remoteId: job.remoteId } : {}),
    ...(job.bytes !== undefined ? { bytes: job.bytes } : {}),
    ...(job.transientFailures !== undefined ? { transientFailures: job.transientFailures } : {}),
  }))

describe('drainUploadJobs — auth pause and Retry-After (#113)', () => {
  it('pauses a provider whose refresh token is revoked', async () => {
    const ledger = fakeLedger(toLedgerJson(seedJobs(3)))
    const create = vi.fn<AlarmPort['create']>(async () => {})
    const clear = vi.fn<AlarmPort['clear']>(async () => {})
    const alarms: AlarmPort = { create, clear }
    const refreshAccessToken = vi.fn<CloudRuntimePort['refreshAccessToken']>(async () => {
      throw new Error('invalid_grant: Token has been expired or revoked.')
    })
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ refreshAccessToken, uploadDrive })
    const cu = makeCU({
      getSettings: async () => connected({ [gd.expiry]: NOW - 1 }),
      ledger,
      runtime,
      alarms,
    })

    await cu.drainUploadJobs()

    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(uploadDrive).not.toHaveBeenCalled()
    const jobs = decodeLedger(ledger.value)
    expect(jobs).toHaveLength(3)
    for (const job of jobs) {
      expect(job.status).toBe('pending')
      expect(job.attempts).toBe(0)
    }
    expect((await cu.cloudUploadStatus()).lastError).toBe(
      'Authorization expired — reconnect the provider.',
    )
    expect(create).not.toHaveBeenCalled()
  })

  it('does not arm an alarm for a paused provider even when it has a future-backoff job', async () => {
    const seeded = seedJobs(2)
    const futureJob = {
      ...seeded[1]!,
      status: 'failed' as const,
      attempts: 1,
      nextAttemptAt: NOW + 30_000,
    }
    const ledger = fakeLedger(toLedgerJson([seeded[0]!, futureJob]))
    const create = vi.fn<AlarmPort['create']>(async () => {})
    const clear = vi.fn<AlarmPort['clear']>(async () => {})
    const alarms: AlarmPort = { create, clear }
    const runtime = fakeRuntime({
      refreshAccessToken: vi.fn<CloudRuntimePort['refreshAccessToken']>(async () => {
        throw new Error('invalid_grant: Token has been expired or revoked.')
      }),
    })
    const cu = makeCU({
      getSettings: async () => connected({ [gd.expiry]: NOW - 1 }),
      ledger,
      runtime,
      alarms,
    })

    await cu.drainUploadJobs()

    expect(create).not.toHaveBeenCalled()
    expect(clear).toHaveBeenCalledWith(cu.uploadAlarm)
  })

  it('records an ordinary failure without pausing when token refresh fails transiently', async () => {
    const ledger = fakeLedger(toLedgerJson(seedJobs(1)))
    const create = vi.fn<AlarmPort['create']>(async () => {})
    const clear = vi.fn<AlarmPort['clear']>(async () => {})
    const alarms: AlarmPort = { create, clear }
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({
      refreshAccessToken: vi.fn<CloudRuntimePort['refreshAccessToken']>(async () => {
        throw new Error('token endpoint HTTP 503')
      }),
      uploadDrive,
    })
    const cu = makeCU({
      getSettings: async () => connected({ [gd.expiry]: NOW - 1 }),
      ledger,
      runtime,
      alarms,
    })

    await cu.drainUploadJobs()

    expect(uploadDrive).not.toHaveBeenCalled()
    const job = decodeLedger(ledger.value)[0]!
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(1)
    expect(create).toHaveBeenCalledWith(cu.uploadAlarm, NOW + 5_000)
  })

  it('resumes a paused provider after reconnect', async () => {
    const ledger = fakeLedger(toLedgerJson(seedJobs(3)))
    let currentSettings = connected({ [gd.expiry]: NOW - 1 })
    let revoked = true
    const refreshAccessToken = vi.fn<CloudRuntimePort['refreshAccessToken']>(async () => {
      if (revoked) throw new Error('invalid_grant: Token has been expired or revoked.')
      return { accessToken: 'fresh-access', expiresAt: NOW + 3_600_000 }
    })
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const runtime = fakeRuntime({ refreshAccessToken, uploadDrive })
    const cu = makeCU({
      getSettings: async () => currentSettings,
      setSettings: async (patch) => {
        currentSettings = { ...currentSettings, ...patch }
        return currentSettings
      },
      ledger,
      runtime,
    })

    await cu.drainUploadJobs()
    expect(decodeLedger(ledger.value).every((j) => j.status === 'pending')).toBe(true)

    revoked = false
    const res = await cu.runOAuthConnect('gdrive', 'gdrive-client')
    expect(res.ok).toBe(true)
    await cu.uploadQueue.run(async () => {})

    const jobs = decodeLedger(ledger.value)
    expect(jobs).toHaveLength(3)
    expect(jobs.every((j) => j.status === 'succeeded')).toBe(true)
    expect(uploadDrive).toHaveBeenCalledTimes(3)
  })

  it('a paused provider does not block another provider', async () => {
    let seeded = enqueue(
      [],
      { mediaId: 'd0', provider: 'gdrive', url: 'https://video.twimg.com/d0.mp4', target },
      NOW,
    )
    seeded = enqueue(
      seeded,
      { mediaId: 'b0', provider: 'dropbox', url: 'https://video.twimg.com/b0.mp4', target },
      NOW,
    )
    const ledger = fakeLedger(toLedgerJson(seeded))
    const refreshAccessToken = vi.fn<CloudRuntimePort['refreshAccessToken']>(async () => {
      throw new Error('invalid_grant: Token has been expired or revoked.')
    })
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const uploadDropbox = vi.fn<CloudRuntimePort['uploadDropbox']>(async () => ok())
    const runtime = fakeRuntime({ refreshAccessToken, uploadDrive, uploadDropbox })
    const bothSettings = {
      ...connected({ [gd.expiry]: NOW - 1 }),
      [dx.clientId]: 'dropbox-client',
      [dx.accessToken]: 'dropbox-access',
      [dx.refreshToken]: 'dropbox-refresh',
      [dx.expiry]: NOW + 3_600_000,
    } satisfies Settings
    const cu = makeCU({
      getSettings: async () => bothSettings,
      ledger,
      runtime,
    })

    await cu.drainUploadJobs()

    const jobs = decodeLedger(ledger.value)
    const driveJob = jobs.find((j) => j.provider === 'gdrive')
    const dropboxJob = jobs.find((j) => j.provider === 'dropbox')
    expect(driveJob?.status).toBe('pending')
    expect(driveJob?.attempts).toBe(0)
    expect(dropboxJob?.status).toBe('succeeded')
    expect(uploadDrive).not.toHaveBeenCalled()
    expect(uploadDropbox).toHaveBeenCalledTimes(1)
  })

  it('a 401 upload forces a token refresh, not a pause', async () => {
    const ledger = fakeLedger(toLedgerJson(seedJobs(1)))
    let now = NOW
    let currentSettings = connected()
    let calls = 0
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => {
      calls += 1
      if (calls === 1) return { kind: 'failure', reason: 'gdrive HTTP 401', status: 401 }
      return ok()
    })
    const refreshAccessToken = vi.fn<CloudRuntimePort['refreshAccessToken']>(async () => ({
      accessToken: 'fresh-access',
      expiresAt: now + 3_600_000,
    }))
    const runtime = fakeRuntime({ uploadDrive, refreshAccessToken })
    const cu = makeCU({
      now: () => now,
      getSettings: async () => currentSettings,
      setSettings: async (patch) => {
        currentSettings = { ...currentSettings, ...patch }
        return currentSettings
      },
      ledger,
      runtime,
    })

    await cu.drainUploadJobs()
    const after401 = decodeLedger(ledger.value)[0]!
    expect(after401.status).toBe('failed')
    expect(after401.attempts).toBe(0)
    expect(currentSettings[gd.accessToken]).toBe('')

    now = after401.nextAttemptAt
    await cu.drainUploadJobs()

    const afterRetry = decodeLedger(ledger.value)[0]!
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(afterRetry.status).toBe('succeeded')
    expect(afterRetry.attempts).toBe(0)
    expect(uploadDrive).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessToken: 'fresh-access' }),
      expect.anything(),
    )
  })

  it('a rate-limited upload waits for Retry-After', async () => {
    const ledger = fakeLedger(
      toLedgerJson(
        enqueue(
          [],
          { mediaId: 'r0', provider: 'dropbox', url: 'https://video.twimg.com/r0.mp4', target },
          NOW,
        ),
      ),
    )
    const create = vi.fn<AlarmPort['create']>(async () => {})
    const clear = vi.fn<AlarmPort['clear']>(async () => {})
    const alarms: AlarmPort = { create, clear }
    const runtime = fakeRuntime({
      uploadDropbox: vi.fn<CloudRuntimePort['uploadDropbox']>(async () => ({
        kind: 'failure',
        reason: 'dropbox HTTP 429',
        status: 429,
        transient: true,
        retryAfterMs: 120_000,
      })),
    })
    const cu = makeCU({
      getSettings: async () => connectedDropbox(),
      ledger,
      runtime,
      alarms,
      random: () => 0,
    })

    await cu.drainUploadJobs()

    const job = decodeLedger(ledger.value)[0]!
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(0)
    expect(job.nextAttemptAt).toBe(NOW + 120_000)
    expect(create).toHaveBeenCalledWith(cu.uploadAlarm, NOW + 120_000)
  })

  it('forwards the injected random source to jitter backoff delays', async () => {
    const ledger = fakeLedger(toLedgerJson(seedJobs(1)))
    const create = vi.fn<AlarmPort['create']>(async () => {})
    const clear = vi.fn<AlarmPort['clear']>(async () => {})
    const alarms: AlarmPort = { create, clear }
    const runtime = fakeRuntime({
      uploadDrive: vi.fn<CloudRuntimePort['uploadDrive']>(async () => ({
        kind: 'failure',
        reason: 'drive HTTP 503',
        status: 503,
        transient: true,
      })),
    })
    const cu = makeCU({
      ledger,
      runtime,
      alarms,
      random: () => 0.5,
    })

    await cu.drainUploadJobs()

    const job = decodeLedger(ledger.value)[0]!
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(0)
    expect(job.nextAttemptAt).toBe(NOW + 2_500)
    expect(create).toHaveBeenCalledWith(cu.uploadAlarm, NOW + 2_500)
  })

  it('a 401 from resolveDriveRoot clears the cached access token and retries without burning attempts', async () => {
    const ledger = fakeLedger(toLedgerJson(seedJobs(1)))
    let now = NOW
    let currentSettings = connected()
    let rootCalls = 0
    const seenAuthHeaders: string[] = []
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const endpoint = url instanceof URL ? url.href : url instanceof Request ? url.url : url
      if (endpoint.includes('/drive/v3/files/root')) {
        rootCalls += 1
        seenAuthHeaders.push(new Headers(init?.headers).get('authorization') ?? '')
        if (rootCalls === 1) return new Response('unauthorized', { status: 401 })
        return new Response(JSON.stringify({ id: 'root-id' }), { status: 200 })
      }
      if (endpoint === PROVIDERS.gdrive.oauth.tokenEndpoint) {
        return new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (endpoint === 'https://video.twimg.com/0.mp4') {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '3' },
        })
      }
      if (endpoint.includes('/drive/v3/files?')) {
        return new Response(JSON.stringify({ files: [{ id: 'folder-id' }] }), { status: 200 })
      }
      if (endpoint.includes('/upload/drive/v3/files')) {
        return new Response(JSON.stringify({ id: 'uploaded-file-id' }), { status: 200 })
      }
      return new Response('unexpected', { status: 500 })
    })
    const cu = makeCloudUpload({
      queueError: () => () => {},
      getSettings: async () => currentSettings,
      setSettings: async (patch) => {
        currentSettings = { ...currentSettings, ...patch }
        return currentSettings
      },
      fetchImpl,
      getBackfillRecords: async () => [],
      now: () => now,
      ledger,
      uploaded: fakeUploaded(),
      alarms: fakeAlarms(),
      badge: fakeBadge(),
      authFlow: fakeAuthFlow(),
      random: () => 1,
    })

    await cu.drainUploadJobs()

    const after401 = decodeLedger(ledger.value)[0]!
    expect(after401.status).toBe('failed')
    expect(after401.attempts).toBe(0)
    expect(currentSettings[gd.accessToken]).toBe('')
    expect(currentSettings[gd.expiry]).toBe(0)
    expect((await cu.cloudUploadStatus()).lastError).toBe(
      'Authorization expired — reconnect the provider.',
    )

    now = after401.nextAttemptAt
    await cu.drainUploadJobs()

    const afterRetry = decodeLedger(ledger.value)[0]!
    expect(afterRetry.status).toBe('succeeded')
    expect(afterRetry.attempts).toBe(0)
    expect(seenAuthHeaders).toEqual(['Bearer gdrive-access', 'Bearer fresh-access'])
  })

  it('a 429 from resolveDriveRoot honors Retry-After and retries as transient without burning attempts', async () => {
    const ledger = fakeLedger(toLedgerJson(seedJobs(1)))
    const create = vi.fn<AlarmPort['create']>(async () => {})
    const clear = vi.fn<AlarmPort['clear']>(async () => {})
    const alarms: AlarmPort = { create, clear }
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const endpoint = url instanceof URL ? url.href : url instanceof Request ? url.url : url
      if (endpoint.includes('/drive/v3/files/root')) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '90' } })
      }
      return new Response('unexpected', { status: 500 })
    })
    const cu = makeCloudUpload({
      queueError: () => () => {},
      getSettings: async () => connected(),
      setSettings: async () => connected(),
      fetchImpl,
      getBackfillRecords: async () => [],
      now: () => NOW,
      ledger,
      uploaded: fakeUploaded(),
      alarms,
      badge: fakeBadge(),
      authFlow: fakeAuthFlow(),
      random: () => 0,
    })

    await cu.drainUploadJobs()

    const job = decodeLedger(ledger.value)[0]!
    expect(job.status).toBe('failed')
    expect(job.attempts).toBe(0)
    expect(job.nextAttemptAt).toBe(NOW + 90_000)
    expect(create).toHaveBeenCalledWith(cu.uploadAlarm, NOW + 90_000)
    expect((await cu.cloudUploadStatus()).lastError).toBe(
      'Provider rate-limited the upload — retrying with backoff.',
    )
  })
})
