import { describe, it, expect, vi } from 'vitest'
import { Schema } from 'effect'
import {
  makeCloudUpload,
  type AlarmPort,
  type AuthFlowPort,
  type BadgePort,
  type CloudRuntimePort,
  type CloudUploadDeps,
} from './cloud-upload'
import { Settings as SettingsSchema, type Settings } from '@/packages/schema'
import { PROVIDERS } from '@/packages/cloud/provider'
import {
  decodeLedger,
  enqueue,
  readyJobs,
  summarize,
  type JobLedger,
} from '@/packages/cloud/upload-job'
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
function fakeLedger(initial: unknown = null, opts: { delay?: boolean } = {}) {
  const box = {
    value: initial as unknown,
    gets: 0,
    sets: 0,
    async get() {
      box.gets += 1
      if (opts.delay) await tick()
      return box.value
    },
    async set(value: unknown) {
      box.sets += 1
      if (opts.delay) await tick()
      box.value = value
    },
  }
  return box
}

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
  mirror: vi.fn<CloudRuntimePort['mirror']>(async () => ({})),
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

const dummyFetch = (async () => new Response()) as unknown as typeof fetch

/** Construct the shell with safe fake ports by default; a test overrides what it asserts on. */
const makeCU = (over: Partial<CloudUploadDeps> = {}) =>
  makeCloudUpload({
    queueError: () => () => {},
    getSettings: async () => connected(),
    fetchImpl: dummyFetch,
    getBackfillRecords: async () => [],
    now: () => NOW,
    ledger: fakeLedger(),
    runtime: fakeRuntime(),
    alarms: fakeAlarms(),
    badge: fakeBadge(),
    authFlow: fakeAuthFlow(),
    setSettings: async () => connected(),
    ...over,
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
    const runtime = fakeRuntime()
    const cu = makeCU({
      getSettings: async () => connected({ [gd.refreshToken]: '' }), // gdrive no longer connected
      ledger,
      runtime,
    })
    await cu.drainUploadJobs()
    expect(decodeLedger(ledger.value)[0]?.status).toBe('failed')
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
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
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, runtime, maxDrainPerPass: 2 })
    await cu.drainUploadJobs()
    await vi.waitFor(() => expect(runtime.uploadDrive).toHaveBeenCalledTimes(3))
    expect(readyJobs(decodeLedger(ledger.value), NOW)).toHaveLength(0)
  })
})

describe('drainUploadJobs — backoff-wake gating', () => {
  it('arms a wake-up alarm at the soonest backoff deadline after a failure', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const alarms = fakeAlarms()
    const runtime = fakeRuntime({
      uploadDrive: vi.fn<CloudRuntimePort['uploadDrive']>(async () => ({
        kind: 'failure',
        reason: 'boom',
      })),
    })
    const cu = makeCU({ ledger, runtime, alarms })
    await cu.drainUploadJobs()
    // one failure → nextAttemptAt = NOW + backoff(1) = NOW + 5000; the alarm fires there.
    expect(alarms.create).toHaveBeenCalledWith(cu.uploadAlarm, NOW + 5000)
    expect(alarms.clear).not.toHaveBeenCalled()
  })

  it('clears the alarm when nothing is left to retry', async () => {
    const alarms = fakeAlarms()
    const cu = makeCU({ ledger: fakeLedger(null), alarms })
    await cu.drainUploadJobs()
    expect(alarms.clear).toHaveBeenCalledWith(cu.uploadAlarm)
    expect(alarms.create).not.toHaveBeenCalled()
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
    const runtime = fakeRuntime()
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
    expect(runtime.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ [gd.accessToken]: 'fresh-access' }),
    )
    // The REFRESHED token (not the stale one) must reach the uploader.
    expect(runtime.uploadDrive).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fresh-access' }),
      expect.anything(),
    )
  })

  it('skips refresh when the token is still valid', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, runtime }) // connected() default → far-future expiry
    await cu.drainUploadJobs()
    expect(runtime.refreshAccessToken).not.toHaveBeenCalled()
    expect(runtime.uploadDrive).toHaveBeenCalledTimes(1)
  })
})

describe('runOAuthConnect — wiring (NOT the consent popup)', () => {
  // The fake authFlow.launchFlow echoes the auth URL's `state` back on the redirect,
  // exactly as a real provider does — so this proves the parse→exchange→persist WIRING.
  // It does NOT exercise the real browser.identity consent handshake, which stays
  // genuinely browser-bound and must be verified manually. Do not delete that coverage.
  it('parses the redirect, exchanges the code, and persists the tokens', async () => {
    const runtime = fakeRuntime()
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
    expect(runtime.exchangeCode).toHaveBeenCalledWith(
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
      order.push(`revoke:${String(url)}`)
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
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, runtime })
    await cu.retryDeadUploads()
    await vi.waitFor(() => expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded'))
    expect(runtime.uploadDrive).toHaveBeenCalledTimes(1)
  })
})

describe('backfillCloudUploads', () => {
  it('enqueues past downloads from history and drains them', async () => {
    const ledger = fakeLedger(null)
    const runtime = fakeRuntime()
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
    await vi.waitFor(() => expect(runtime.uploadDrive).toHaveBeenCalledTimes(1))
  })

  it('reports when there are no past downloads to back-fill', async () => {
    const cu = makeCU({ getBackfillRecords: async () => [] })
    const res = await cu.backfillCloudUploads()
    expect(res.ok).toBe(false)
    expect(res.queued).toBe(0)
  })
})

describe('resumeOnBoot', () => {
  it('compacts the ledger and drains pending uploads on boot', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, runtime })
    cu.resumeOnBoot()
    await vi.waitFor(() => expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded'))
    expect(runtime.uploadDrive).toHaveBeenCalledTimes(1)
  })
})

describe('drainUploadJobs — sourceGone (link-rot, never a fake save)', () => {
  it('marks the job skipped without arming a retry or recording an error', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const alarms = fakeAlarms()
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
    expect(alarms.create).not.toHaveBeenCalled()
    expect(alarms.clear).toHaveBeenCalledWith(cu.uploadAlarm)
    // The sourceGone arm never sets lastUploadError (unlike the failure arm).
    expect((await cu.cloudUploadStatus()).lastError).toBeNull()
  })
})

describe('drainUploadJobs — Drive root folder resolution', () => {
  it('resolves and persists the Drive root once when unset, passing it to the upload', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const runtime = fakeRuntime()
    const setSettings = vi.fn<NonNullable<CloudUploadDeps['setSettings']>>(async (patch) =>
      connected(patch),
    )
    const cu = makeCU({ ledger, runtime, setSettings }) // connected(): gdriveFolderId is ''
    await cu.drainUploadJobs()
    expect(runtime.resolveDriveRoot).toHaveBeenCalledTimes(1)
    expect(setSettings).toHaveBeenCalledWith(
      expect.objectContaining({ gdriveFolderId: 'drive-root-id' }),
    )
    expect(runtime.uploadDrive).toHaveBeenCalledWith(
      expect.objectContaining({ rootFolderId: 'drive-root-id' }),
      expect.anything(),
    )
  })

  it('reuses a stored Drive root without re-resolving', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const runtime = fakeRuntime()
    const cu = makeCU({
      ledger,
      runtime,
      getSettings: async () => connected({ gdriveFolderId: 'pre-resolved' }),
    })
    await cu.drainUploadJobs()
    expect(runtime.resolveDriveRoot).not.toHaveBeenCalled()
    expect(runtime.uploadDrive).toHaveBeenCalledWith(
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
    const runtime = fakeRuntime()
    const cu = makeCU({ getSettings: async () => connectedDropbox(), ledger, runtime })
    await cu.drainUploadJobs()
    expect(runtime.uploadDropbox).toHaveBeenCalledTimes(1)
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
  })
})

describe('recordCloudUploads — gating (no side effects)', () => {
  const item = {
    item: { id: 'A', url: 'https://video.twimg.com/a.mp4', handle: 'alice', ext: 'mp4' },
    filename: 'alice/a.mp4',
  }

  it('does nothing when Cloud upload is disabled', async () => {
    const ledger = fakeLedger()
    const runtime = fakeRuntime()
    makeCU({ ledger, runtime }).recordCloudUploads(connected({ cloudUploadEnabled: false }), [item])
    await tick()
    expect(ledger.gets).toBe(0)
    expect(ledger.sets).toBe(0)
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
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
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, runtime })
    await cu.drainUploadJobs()
    expect(decodeLedger(ledger.value)[0]?.status).toBe('dead')
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect(readyJobs(decodeLedger(ledger.value), NOW)).toHaveLength(0)
  })
})

describe('badge', () => {
  it('clearUploadBadge clears the toolbar text', async () => {
    const badge = fakeBadge()
    makeCU({ badge }).clearUploadBadge()
    await tick()
    expect(badge.set).toHaveBeenCalledWith('')
  })

  it('reflects the permanently-dead count after a drain', async () => {
    const badge = fakeBadge()
    const dead = { ...seedJobs(1)[0]!, status: 'dead' as const, attempts: 5, error: 'boom' }
    const cu = makeCU({ ledger: fakeLedger([dead]), badge })
    await cu.drainUploadJobs()
    expect(badge.set).toHaveBeenCalledWith('1')
    expect(badge.setColor).toHaveBeenCalledWith('#dc2626')
  })
})
