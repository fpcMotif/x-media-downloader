import { describe, it, expect, vi } from 'vitest'
import { Schema } from 'effect'
import {
  makeCloudUpload,
  type AlarmPort,
  type AuthFlowPort,
  type BadgePort,
  type CloudRuntimePort as BaseCloudRuntimePort,
  type CloudUploadDeps,
} from './cloud-upload'
import { Settings as SettingsSchema, type Settings } from '../core/schema'
import { PROVIDERS } from '../core/cloud/provider'
import {
  claim,
  decodeLedgerResult,
  decodeLedgerStateResult,
  enqueue,
  LEASE_MS,
  readyJobs,
  recordSuccess,
  summarize,
  type JobLedger,
} from '../core/cloud/upload-job'
import type { UploadInput, UploadOutcome, UploadTarget } from '../core/cloud/types'
import { dropboxStagePath } from '../core/cloud/dropbox'
import type { ProviderOwnershipTransition } from '../core/cloud/provider-ownership-transition'
import type { SettingsWriter } from './settings-writer'
import { providerCredentialsFor, providerOwnerKey } from './cloud-provider-session'
import { DURABLE_SIDE_EFFECT_WATCHDOG_MS } from './durable-wake'

// The cloud-upload SHELL through its injected seams (ADR-0013/0017). The pure
// UploadJob ledger is covered in core/cloud/upload-job.test.ts; these tests pin the
// orchestration the reducer can't: the claim→lease→upload→record→cap→mirror drain,
// disconnect-mid-flight, the re-kick, backoff-wake gating, and the OAuth wiring.

const NOW = 1_000_000
const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const decodeLedger = (raw: unknown): JobLedger => {
  const decoded = decodeLedgerResult(raw)
  if (!decoded.ok) throw new Error('expected available Cloud Upload ledger')
  return decoded.ledger
}
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

type TestDriveUpload = (
  args: { readonly accessToken: string; readonly rootFolderId: string },
  input: UploadInput,
) => Promise<UploadOutcome>
type TestDropboxUpload = (accessToken: string, input: UploadInput) => Promise<UploadOutcome>
type CloudRuntimePort = BaseCloudRuntimePort & {
  readonly uploadDrive: TestDriveUpload
  readonly uploadDropbox: TestDropboxUpload
}

/** Seed a ledger with N ready (pending, claimable at NOW) gdrive jobs. */
const seedJobs = (n: number): JobLedger => {
  let ledger: JobLedger = []
  for (let i = 0; i < n; i += 1)
    ledger = enqueue(
      ledger,
      {
        requestId: `m${i}`,
        provider: 'gdrive',
        url: `https://video.twimg.com/${i}.mp4`,
        target,
      },
      NOW,
    )
  return ledger
}

const ledgerState = (
  jobs: JobLedger,
  ownershipTransitions: ReadonlyArray<ProviderOwnershipTransition> = [],
) => ({
  version: 5 as const,
  jobs,
  legacy: [],
  quarantine: [],
  ownershipTransitions,
})

const ownershipTransition = async (
  kind: ProviderOwnershipTransition['kind'],
  before: Settings,
  after: Settings,
  transitionId = `${kind}-test`,
): Promise<ProviderOwnershipTransition> => ({
  transitionId,
  provider: 'gdrive',
  kind,
  beforeOwnerKey: await providerOwnerKey(providerCredentialsFor(before, 'gdrive')),
  afterOwnerKey: await providerOwnerKey(providerCredentialsFor(after, 'gdrive')),
})

/** An in-memory ledger box — the LedgerStore seam's test adapter. `delay` widens the
 *  read-modify-write window so a serialization regression would surface as a lost update. */
function fakeLedger(initial: unknown = null, opts: { delay?: boolean; failSet?: number } = {}) {
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
      if (box.sets === opts.failSet) throw new Error('ledger write failed')
      box.value = value
    },
  }
  return box
}

const ok = (bytes = 100): UploadOutcome => ({
  kind: 'success',
  bytes,
  remotePath: target.path,
})

const uploadIntent = (id: string, url: string, ext: string, filename: string) => ({
  requestId: id,
  legacyAliases: [id],
  source: { url, ext },
  filename,
})

const fakeRuntime = (over: Partial<CloudRuntimePort> = {}): CloudRuntimePort => {
  const uploadDrive = over.uploadDrive ?? vi.fn<TestDriveUpload>(async () => ok())
  const uploadDropbox = over.uploadDropbox ?? vi.fn<TestDropboxUpload>(async () => ok())
  return {
    uploadDrive,
    uploadDropbox,
    prepareBlobAttempt:
      over.prepareBlobAttempt ??
      vi.fn<BaseCloudRuntimePort['prepareBlobAttempt']>(async (input) =>
        input.provider === 'gdrive'
          ? {
              kind: 'gdrive',
              ownerKey: input.ownerKey,
              fileId: 'drive-file-id',
            }
          : {
              kind: 'dropbox',
              phase: 'prepared',
              ownerKey: input.ownerKey,
              stagePath: await dropboxStagePath(input.jobId),
            },
      ),
    advanceBlobAttempt:
      over.advanceBlobAttempt ??
      vi.fn<BaseCloudRuntimePort['advanceBlobAttempt']>(async (input) =>
        input.provider === 'gdrive'
          ? uploadDrive(
              {
                accessToken: input.accessToken,
                rootFolderId: input.rootFolderId ?? '',
              },
              input.upload,
            )
          : uploadDropbox(input.accessToken, input.upload),
      ),
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
  }
}

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

const fakeSettingsWriter = (current: () => Settings = () => connected()) => {
  const withSnapshotTurn: SettingsWriter['withSnapshotTurn'] = async (callback) =>
    await callback(current())
  return {
    update: vi.fn<SettingsWriter['update']>(async (patch) => ({
      ...current(),
      ...patch,
    })),
    updateWhen: vi.fn<SettingsWriter['updateWhen']>(async (guard, patch) => {
      const settings = current()
      return guard(settings)
        ? { applied: true, settings: { ...settings, ...patch } }
        : { applied: false, settings }
    }),
    withSnapshotTurn,
  }
}

const fakeStatefulSettingsWriter = (state: { current: Settings }) => {
  const writer = fakeSettingsWriter(() => state.current)
  writer.update.mockImplementation(async (patch) => {
    state.current = { ...state.current, ...patch }
    return state.current
  })
  writer.updateWhen.mockImplementation(async (guard, patch) => {
    if (!guard(state.current)) return { applied: false, settings: state.current }
    state.current = { ...state.current, ...patch }
    return { applied: true, settings: state.current }
  })
  return writer
}

/** Construct the shell with safe fake ports by default; a test overrides what it asserts on. */
const makeCU = (over: Partial<CloudUploadDeps> = {}) => {
  const defaults = { current: connected() }
  const getSettings = over.getSettings ?? (async () => defaults.current)
  return makeCloudUpload({
    queueError: () => () => {},
    getSettings,
    getSettingsOwnership: async () => {
      const settings = await getSettings()
      return {
        availability: 'available',
        runtime: settings,
        desired: settings,
      }
    },
    fetchImpl: dummyFetch,
    getBackfillRecords: async () => [],
    now: () => NOW,
    ledger: fakeLedger(),
    runtime: fakeRuntime(),
    alarms: fakeAlarms(),
    badge: fakeBadge(),
    authFlow: fakeAuthFlow(),
    settingsWriter: fakeStatefulSettingsWriter(defaults),
    ...over,
  })
}

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

  it('fences a disconnect and toggle while the post-token read is blocked', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const state = { current: connected() }
    const settingsWriter = fakeStatefulSettingsWriter(state)
    let reads = 0
    let releaseRead: ((settings: Settings) => void) | undefined
    const getSettings = async (): Promise<Settings> => {
      reads += 1
      if (reads === 2)
        return new Promise((resolve) => {
          releaseRead = resolve
        })
      return state.current
    }
    const runtime = fakeRuntime()
    const cu = makeCU({ getSettings, ledger, runtime, settingsWriter })

    const draining = cu.drainUploadJobs()
    await vi.waitFor(() => expect(reads).toBe(2))
    expect((await cu.disconnectProvider('gdrive')).ok).toBe(true)
    state.current = { ...state.current, cloudUploadEnabled: false }
    releaseRead?.(state.current)
    await draining

    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect(decodeLedger(ledger.value)).toEqual([])
  })

  it('discards a stale owner result while the next job uses the current connection', async () => {
    const ledger = fakeLedger(seedJobs(2))
    const state = { current: connected() }
    let releaseFirst!: (outcome: UploadOutcome) => void
    let calls = 0
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(() => {
      calls += 1
      if (calls === 1)
        return new Promise<UploadOutcome>((resolve) => {
          releaseFirst = resolve
        })
      return Promise.resolve(ok())
    })
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime: fakeRuntime({ uploadDrive }),
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    const draining = cu.drainUploadJobs()
    await vi.waitFor(() => expect(uploadDrive).toHaveBeenCalledTimes(1))
    state.current = connected({
      [gd.clientId]: 'reconnected-client',
      [gd.accessToken]: 'reconnected-access',
      [gd.refreshToken]: 'reconnected-refresh',
    })
    releaseFirst({ kind: 'failure', reason: 'old connection failed' })
    await draining

    expect(
      decodeLedger(ledger.value).map((job) => ({
        status: job.status,
        error: job.error,
      })),
    ).toEqual([
      { status: 'uploading', error: null },
      { status: 'succeeded', error: null },
    ])
    expect(uploadDrive).toHaveBeenCalledTimes(2)
  })
})

describe('drainUploadJobs — lease ordering', () => {
  it('replaces a consumed alarm before persisting a lease or starting the upload', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const alarms = fakeAlarms()
    let release!: (o: UploadOutcome) => void
    const gate = new Promise<UploadOutcome>((r) => {
      release = r
    })
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => gate)
    const cu = makeCU({
      ledger,
      alarms,
      runtime: fakeRuntime({ uploadDrive }),
    })

    const done = cu.drainUploadJobs()
    await vi.waitFor(() => expect(uploadDrive).toHaveBeenCalledTimes(1))
    // The lease + 'uploading' status were persisted before the upload was awaited.
    expect(decodeLedger(ledger.value)[0]?.status).toBe('uploading')
    expect(vi.mocked(alarms.create).mock.calls[0]).toEqual([
      cu.uploadAlarm,
      NOW + DURABLE_SIDE_EFFECT_WATCHDOG_MS,
    ])
    expect(alarms.create).toHaveBeenCalledWith(cu.uploadAlarm, NOW + LEASE_MS)

    release(ok(42))
    await done
    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
    expect(alarms.clear).toHaveBeenCalledWith(cu.uploadAlarm)
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

  it('persists a rebased retry deadline after rollback in a fresh worker', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const first = makeCU({
      ledger,
      runtime: fakeRuntime({
        uploadDrive: vi.fn<CloudRuntimePort['uploadDrive']>(async () => ({
          kind: 'failure',
          reason: 'offline',
        })),
      }),
    })
    await first.drainUploadJobs()
    expect(decodeLedger(ledger.value)[0]?.nextAttemptAt).toBe(NOW + 5_000)

    const alarms = fakeAlarms()
    const restartedRuntime = fakeRuntime()
    const restarted = makeCU({
      ledger,
      alarms,
      runtime: restartedRuntime,
      now: () => 1,
    })
    await restarted.drainUploadJobs()

    expect(restartedRuntime.uploadDrive).not.toHaveBeenCalled()
    expect(decodeLedger(ledger.value)[0]?.nextAttemptAt).toBe(5_001)
    expect(vi.mocked(alarms.create).mock.calls[0]).toEqual([
      restarted.uploadAlarm,
      1 + DURABLE_SIDE_EFFECT_WATCHDOG_MS,
    ])
    expect(alarms.create).toHaveBeenLastCalledWith(restarted.uploadAlarm, 5_001)
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
    const state = {
      current: connected({
        cloudSyncEnabled: true,
        convexUrl: 'https://x.convex.cloud',
        convexSyncSecret: 'sek',
        cloudDeviceId: 'dev-1',
      }),
    }
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
      getSettings: async () => state.current,
      ledger,
      runtime: fakeRuntime({ mirror }),
      settingsWriter: fakeStatefulSettingsWriter(state),
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

  it('re-reads Sync consent after a slow upload before mirroring', async () => {
    const ledger = fakeLedger(seedJobs(1))
    let settings = connected({
      cloudSyncEnabled: true,
      convexUrl: 'https://old.convex.cloud',
      convexSyncSecret: 'old-secret',
      cloudDeviceId: 'old-device',
    })
    let release!: (outcome: UploadOutcome) => void
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(
      () => new Promise<UploadOutcome>((resolve) => (release = resolve)),
    )
    const mirror = vi.fn<CloudRuntimePort['mirror']>(async () => ({}))
    const settingsWriter = fakeSettingsWriter(() => settings)
    settingsWriter.updateWhen.mockImplementation(async (guard, patch) => {
      if (!guard(settings)) return { applied: false, settings }
      settings = { ...settings, ...patch }
      return { applied: true, settings }
    })
    const cu = makeCU({
      getSettings: async () => settings,
      ledger,
      runtime: fakeRuntime({ uploadDrive, mirror }),
      settingsWriter,
    })

    const draining = cu.drainUploadJobs()
    await vi.waitFor(() => expect(uploadDrive).toHaveBeenCalledTimes(1))
    settings = { ...settings, cloudSyncEnabled: false }
    release(ok())
    await draining

    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
    expect(mirror).not.toHaveBeenCalled()
  })
})

describe('drainUploadJobs — token refresh on expiry', () => {
  it('refreshes and persists an expired access token before uploading', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const runtime = fakeRuntime()
    let current = connected({ [gd.expiry]: NOW - 1 })
    const settingsWriter = fakeSettingsWriter(() => current)
    settingsWriter.updateWhen.mockImplementation(async (guard, patch) => {
      if (!guard(current)) return { applied: false, settings: current }
      current = { ...current, ...patch }
      return { applied: true, settings: current }
    })
    const cu = makeCU({
      getSettings: async () => current, // already expired
      ledger,
      runtime,
      settingsWriter,
    })
    await cu.drainUploadJobs()
    expect(runtime.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(settingsWriter.updateWhen).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ [gd.accessToken]: 'fresh-access' }),
    )
    // The REFRESHED token (not the stale one) must reach the uploader.
    expect(runtime.uploadDrive).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fresh-access' }),
      expect.anything(),
    )
  })

  it('refreshes a persisted token once before first use in a fresh worker', async () => {
    const ledger = fakeLedger(seedJobs(2))
    const runtime = fakeRuntime()
    const state = { current: connected() }
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })
    await cu.drainUploadJobs()
    expect(runtime.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(runtime.prepareBlobAttempt).toHaveBeenCalledTimes(2)
    expect(runtime.prepareBlobAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'fresh-access' }),
    )
    expect(runtime.uploadDrive).toHaveBeenCalledTimes(2)
  })

  it('never falls back to a persisted token when first-use refresh fails', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const runtime = fakeRuntime({
      refreshAccessToken: vi.fn<CloudRuntimePort['refreshAccessToken']>(async () => {
        throw new Error('refresh unavailable')
      }),
    })
    const cu = makeCU({ ledger, runtime, now: () => 1 })

    await cu.drainUploadJobs()

    expect(runtime.prepareBlobAttempt).not.toHaveBeenCalled()
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect(decodeLedger(ledger.value)[0]).toMatchObject({
      status: 'failed',
      error: 'refresh unavailable',
    })
  })

  it('invalidates a future-expiry token after a provider 401, then refreshes before retry', async () => {
    const ledger = fakeLedger(seedJobs(1))
    let now = NOW
    let current = connected()
    const settingsWriter = fakeSettingsWriter(() => current)
    settingsWriter.updateWhen.mockImplementation(async (guard, patch) => {
      if (!guard(current)) return { applied: false, settings: current }
      current = { ...current, ...patch }
      return { applied: true, settings: current }
    })
    const uploadDrive = vi
      .fn<CloudRuntimePort['uploadDrive']>()
      .mockResolvedValueOnce({ kind: 'failure', reason: 'denied', status: 401 })
      .mockResolvedValueOnce(ok())
    const cu = makeCU({
      getSettings: async () => current,
      ledger,
      runtime: fakeRuntime({ uploadDrive }),
      settingsWriter,
      now: () => now,
    })
    await cu.drainUploadJobs()
    expect(current[gd.accessToken]).toBe('')
    now = decodeLedger(ledger.value)[0]!.nextAttemptAt
    await cu.drainUploadJobs()
    expect(uploadDrive).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessToken: 'fresh-access' }),
      expect.anything(),
    )
  })

  it('retains the durable claim when connection ownership changes during refresh', async () => {
    const ledger = fakeLedger(seedJobs(1))
    let current = connected({ [gd.expiry]: NOW - 1 })
    let releaseRefresh: ((tokens: { accessToken: string; expiresAt: number }) => void) | undefined
    const runtime = fakeRuntime({
      refreshAccessToken: vi.fn<CloudRuntimePort['refreshAccessToken']>(
        () =>
          new Promise((resolve) => {
            releaseRefresh = resolve
          }),
      ),
    })
    const settingsWriter = fakeSettingsWriter(() => current)
    const cu = makeCU({
      getSettings: async () => current,
      ledger,
      runtime,
      settingsWriter,
    })

    const draining = cu.drainUploadJobs()
    await vi.waitFor(() => expect(runtime.refreshAccessToken).toHaveBeenCalledTimes(1))
    current = connected({
      cloudUploadEnabled: false,
      [gd.refreshToken]: '',
      [gd.expiry]: NOW - 1,
    })
    releaseRefresh?.({
      accessToken: 'fresh-access',
      expiresAt: NOW + 3_600_000,
    })
    await draining

    expect(settingsWriter.updateWhen).toHaveBeenCalledTimes(1)
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect(decodeLedger(ledger.value)[0]).toMatchObject({
      status: 'uploading',
      error: null,
    })
  })
})

describe('runOAuthConnect — wiring (NOT the consent popup)', () => {
  // The fake authFlow.launchFlow echoes the auth URL's `state` back on the redirect,
  // exactly as a real provider does — so this proves the parse→exchange→persist WIRING.
  // It does NOT exercise the real browser.identity consent handshake, which stays
  // genuinely browser-bound and must be verified manually. Do not delete that coverage.
  it('parses the redirect, exchanges the code, and persists the tokens', async () => {
    const runtime = fakeRuntime()
    const state = {
      current: connected({ [gd.clientId]: '', [gd.refreshToken]: '' }),
    }
    const settingsWriter = fakeStatefulSettingsWriter(state)
    const cu = makeCU({
      getSettings: async () => state.current,
      runtime,
      settingsWriter,
      authFlow: fakeAuthFlow(),
    })
    const res = await cu.runOAuthConnect('gdrive', 'typed-client-id')
    expect(res.ok).toBe(true)
    expect(res.account).toBe('alice@example.com')
    expect(runtime.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'auth-code-xyz',
        clientId: 'typed-client-id',
      }),
    )
    expect(settingsWriter.updateWhen).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        [gd.refreshToken]: 'x-refresh',
        [gd.accessToken]: 'x-access',
      }),
    )
  })

  it('journals replacement before credentials, then purges the old owner', async () => {
    const state = { current: connected() }
    const ledger = fakeLedger(seedJobs(1))
    const settingsWriter = fakeStatefulSettingsWriter(state)
    settingsWriter.updateWhen.mockImplementation(async (guard, patch) => {
      const decoded = decodeLedgerStateResult(ledger.value)
      expect(decoded.ok && decoded.state.jobs).toHaveLength(1)
      expect(decoded.ok && decoded.state.ownershipTransitions).toEqual([
        expect.objectContaining({ provider: 'gdrive', kind: 'connect' }),
      ])
      if (!guard(state.current)) return { applied: false, settings: state.current }
      state.current = { ...state.current, ...patch }
      return { applied: true, settings: state.current }
    })
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      settingsWriter,
    })

    expect(await cu.runOAuthConnect('gdrive', 'replacement-client')).toEqual(
      expect.objectContaining({ ok: true }),
    )
    expect(state.current[gd.clientId]).toBe('replacement-client')
    expect(state.current[gd.refreshToken]).toBe('x-refresh')
    expect(decodeLedger(ledger.value)).toEqual([])
  })

  it('keeps queued work when reconnect returns the same owner grant', async () => {
    const state = {
      current: connected({
        [gd.clientId]: 'same-client',
        [gd.refreshToken]: 'same-refresh',
        [gd.account]: 'same-account',
      }),
    }
    const ledger = fakeLedger(ledgerState(seedJobs(1)))
    const runtime = fakeRuntime({
      exchangeCode: vi.fn<CloudRuntimePort['exchangeCode']>(async () => ({
        accessToken: 'replacement-access',
        refreshToken: 'same-refresh',
        expiresAt: NOW + 7_200_000,
        account: 'same-account',
      })),
    })
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    expect(await cu.runOAuthConnect('gdrive', 'same-client')).toMatchObject({
      ok: true,
    })

    const decoded = decodeLedgerStateResult(ledger.value)
    expect(decoded.ok && decoded.state.jobs).toHaveLength(1)
    expect(decoded.ok && decoded.state.ownershipTransitions).toEqual([])
    expect(state.current[gd.accessToken]).toBe('replacement-access')
    expect(state.current[gd.expiry]).toBe(NOW + 7_200_000)
  })

  it('clears the old Drive root and resolves the replacement account before upload', async () => {
    const state = {
      current: connected({ gdriveFolderId: 'old-account-root' }),
    }
    const ledger = fakeLedger(seedJobs(1))
    const runtime = fakeRuntime({
      resolveDriveRoot: vi.fn<CloudRuntimePort['resolveDriveRoot']>(
        async () => 'replacement-account-root',
      ),
    })
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    expect(await cu.runOAuthConnect('gdrive', 'replacement-client')).toEqual(
      expect.objectContaining({ ok: true }),
    )
    expect(state.current.gdriveFolderId).toBe('')

    await cu.recordCloudUploads([
      uploadIntent(
        'replacement-upload',
        'https://video.twimg.com/replacement.mp4',
        'mp4',
        'twitter/replacement.mp4',
      ),
    ])
    await vi.waitFor(() => expect(runtime.uploadDrive).toHaveBeenCalledTimes(1))

    expect(runtime.resolveDriveRoot).toHaveBeenCalledWith('x-access')
    expect(runtime.uploadDrive).toHaveBeenCalledWith(
      expect.objectContaining({ rootFolderId: 'replacement-account-root' }),
      expect.anything(),
    )
  })

  it('keeps the old connection when its ownership ledger cannot be purged', async () => {
    const state = { current: connected() }
    const ledger = {
      get: vi.fn<() => Promise<unknown>>(async () => seedJobs(1)),
      set: vi.fn<(value: unknown) => Promise<void>>(async () => {
        throw new Error('disk full')
      }),
    }
    const settingsWriter = fakeStatefulSettingsWriter(state)
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      settingsWriter,
    })

    expect(await cu.runOAuthConnect('gdrive', 'replacement-client')).toEqual(
      expect.objectContaining({ ok: false }),
    )
    expect(settingsWriter.updateWhen).not.toHaveBeenCalled()
    expect(state.current[gd.clientId]).toBe('gdrive-client')
    expect(state.current[gd.refreshToken]).toBe('gdrive-refresh')
  })

  it('does not journal or replace credentials without a recovery wake', async () => {
    const state = { current: connected({ cloudUploadEnabled: false }) }
    const ledger = fakeLedger(ledgerState(seedJobs(1)))
    const alarms: AlarmPort = {
      create: vi.fn<AlarmPort['create']>(async () => {
        throw new Error('alarm unavailable')
      }),
      clear: vi.fn<AlarmPort['clear']>(async () => {}),
    }
    const settingsWriter = fakeStatefulSettingsWriter(state)
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      alarms,
      settingsWriter,
    })

    expect(await cu.runOAuthConnect('gdrive', 'replacement-client')).toMatchObject({
      ok: false,
      detail: 'alarm unavailable',
    })

    const decoded = decodeLedgerStateResult(ledger.value)
    expect(decoded.ok && decoded.state.jobs).toHaveLength(1)
    expect(decoded.ok && decoded.state.ownershipTransitions).toEqual([])
    expect(settingsWriter.updateWhen).not.toHaveBeenCalled()
    expect(state.current[gd.clientId]).toBe('gdrive-client')
  })

  it('aborts an unapplied Settings replacement without deleting old work', async () => {
    const state = { current: connected({ cloudUploadEnabled: false }) }
    const ledger = fakeLedger(ledgerState(seedJobs(1)))
    const settingsWriter = fakeStatefulSettingsWriter(state)
    settingsWriter.updateWhen.mockImplementation(async () => ({
      applied: false,
      settings: state.current,
    }))
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      settingsWriter,
    })

    expect(await cu.runOAuthConnect('gdrive', 'replacement-client')).toMatchObject({
      ok: false,
    })
    const decoded = decodeLedgerStateResult(ledger.value)
    expect(decoded.ok && decoded.state.ownershipTransitions).toEqual([])
    expect(decoded.ok && decoded.state.jobs).toHaveLength(1)
    expect(state.current[gd.refreshToken]).toBe('gdrive-refresh')
  })

  it('commits from Settings truth when the writer persists then throws', async () => {
    const state = { current: connected() }
    const ledger = fakeLedger(ledgerState(seedJobs(1)))
    const settingsWriter = fakeStatefulSettingsWriter(state)
    settingsWriter.updateWhen.mockImplementation(async (guard, patch) => {
      if (!guard(state.current)) return { applied: false, settings: state.current }
      state.current = { ...state.current, ...patch }
      throw new Error('response lost after commit')
    })
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      settingsWriter,
    })

    expect(await cu.runOAuthConnect('gdrive', 'replacement-client')).toMatchObject({
      ok: true,
    })
    expect(state.current[gd.clientId]).toBe('replacement-client')
    expect(decodeLedger(ledger.value)).toEqual([])
  })

  it('recovers after Settings commits but final ledger cleanup dies', async () => {
    const state = { current: connected() }
    const alarms = fakeAlarms()
    let value: unknown = ledgerState(seedJobs(1))
    let sets = 0
    const dyingLedger = {
      get: vi.fn<() => Promise<unknown>>(async () => value),
      set: vi.fn<(next: unknown) => Promise<void>>(async (next) => {
        sets += 1
        if (sets >= 2) throw new Error('worker died before final ledger write')
        value = next
      }),
    }
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger: dyingLedger,
      alarms,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    expect(await cu.runOAuthConnect('gdrive', 'replacement-client')).toMatchObject({
      ok: false,
    })
    await cu.uploadQueue.run(async () => {})
    const stranded = decodeLedgerStateResult(value)
    expect(stranded.ok && stranded.state.jobs).toHaveLength(1)
    expect(stranded.ok && stranded.state.ownershipTransitions).toHaveLength(1)
    expect(state.current[gd.clientId]).toBe('replacement-client')
    expect(alarms.create).toHaveBeenCalledWith(
      cu.uploadAlarm,
      NOW + DURABLE_SIDE_EFFECT_WATCHDOG_MS,
    )

    const restartedLedger = fakeLedger(value)
    const restarted = makeCU({
      getSettings: async () => state.current,
      ledger: restartedLedger,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })
    await restarted.drainUploadJobs()
    const recovered = decodeLedgerStateResult(restartedLedger.value)
    expect(recovered.ok && recovered.state.jobs).toEqual([])
    expect(recovered.ok && recovered.state.ownershipTransitions).toEqual([])
  })

  it('pauses old work during OAuth, then resumes it after cancellation', async () => {
    const state = { current: connected() }
    const ledger = fakeLedger(ledgerState(seedJobs(1)))
    const runtime = fakeRuntime()
    let releaseFlow: ((redirect: string | undefined) => void) | undefined
    const launchFlow = vi.fn<AuthFlowPort['launchFlow']>(
      () =>
        new Promise((resolve) => {
          releaseFlow = resolve
        }),
    )
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
      authFlow: fakeAuthFlow({ launchFlow }),
    })

    const connecting = cu.runOAuthConnect('gdrive', 'typed-client-id')
    await vi.waitFor(() => expect(launchFlow).toHaveBeenCalledOnce())
    await cu.drainUploadJobs()
    expect(decodeLedger(ledger.value)[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
    })
    expect(runtime.prepareBlobAttempt).not.toHaveBeenCalled()
    expect(runtime.uploadDrive).not.toHaveBeenCalled()

    releaseFlow?.(undefined)
    await expect(connecting).resolves.toMatchObject({
      ok: false,
      detail: 'Authorization was cancelled.',
    })
    await vi.waitFor(() => expect(runtime.uploadDrive).toHaveBeenCalledOnce())
    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
  })

  it('does not launch OAuth from a Settings recovery projection', async () => {
    const runtime = connected({
      cloudUploadEnabled: false,
      [gd.clientId]: '',
      [gd.refreshToken]: '',
    })
    const authFlow = fakeAuthFlow()
    const cu = makeCU({
      getSettings: async () => runtime,
      getSettingsOwnership: async () => ({
        availability: 'recovery-required',
        runtime,
        reason: 'recoverable',
      }),
      authFlow,
    })

    await expect(cu.runOAuthConnect('gdrive', 'typed-client-id')).resolves.toEqual({
      ok: false,
      detail: 'Repair or reset Settings before changing cloud connections.',
    })
    expect(authFlow.launchFlow).not.toHaveBeenCalled()
  })

  it('keeps credentials cleared when disconnect supersedes a slow reconnect', async () => {
    const state = { current: connected() }
    let releaseExchange:
      | ((tokens: Awaited<ReturnType<CloudRuntimePort['exchangeCode']>>) => void)
      | undefined
    const runtime = fakeRuntime({
      exchangeCode: vi.fn<CloudRuntimePort['exchangeCode']>(
        () =>
          new Promise((resolve) => {
            releaseExchange = resolve
          }),
      ),
    })
    const cu = makeCU({
      getSettings: async () => state.current,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    const reconnect = cu.runOAuthConnect('gdrive', 'reconnect-client')
    await vi.waitFor(() => expect(runtime.exchangeCode).toHaveBeenCalledTimes(1))
    expect((await cu.disconnectProvider('gdrive')).ok).toBe(true)
    releaseExchange?.({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresAt: NOW + 3_600_000,
      account: 'new@example.com',
    })

    expect((await reconnect).ok).toBe(false)
    expect(state.current[gd.accessToken]).toBe('')
    expect(state.current[gd.refreshToken]).toBe('')
  })

  it('lets the later OAuth intent win when two connects overlap', async () => {
    const state = { current: connected() }
    let releaseFirst:
      | ((tokens: Awaited<ReturnType<CloudRuntimePort['exchangeCode']>>) => void)
      | undefined
    let calls = 0
    const runtime = fakeRuntime({
      exchangeCode: vi.fn<CloudRuntimePort['exchangeCode']>(() => {
        calls += 1
        if (calls === 1)
          return new Promise((resolve) => {
            releaseFirst = resolve
          })
        return Promise.resolve({
          accessToken: 'second-access',
          refreshToken: 'second-refresh',
          expiresAt: NOW + 3_600_000,
          account: 'second@example.com',
        })
      }),
    })
    const cu = makeCU({
      getSettings: async () => state.current,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    const first = cu.runOAuthConnect('gdrive', 'first-client')
    await vi.waitFor(() => expect(runtime.exchangeCode).toHaveBeenCalledTimes(1))
    expect((await cu.runOAuthConnect('gdrive', 'second-client')).ok).toBe(true)
    releaseFirst?.({
      accessToken: 'first-access',
      refreshToken: 'first-refresh',
      expiresAt: NOW + 3_600_000,
      account: 'first@example.com',
    })

    expect((await first).ok).toBe(false)
    expect(state.current[gd.clientId]).toBe('second-client')
    expect(state.current[gd.refreshToken]).toBe('second-refresh')
  })
})

describe('serialized upload queue', () => {
  it('quarantines a raw legacy identity and refuses a matching canonical admission', async () => {
    const legacy = {
      jobId: 'same-id:gdrive',
      idempotencyKey: 'same-id:gdrive',
      mediaId: 'same-id',
      provider: 'gdrive' as const,
      url: 'https://cdninstagram.com/same-id.mp4',
      target,
      status: 'pending' as const,
      attempts: 0,
      nextAttemptAt: NOW,
      leaseUntil: null,
      leaseSeq: 0,
      verifiedAt: null,
      error: null,
    }
    const ledger = fakeLedger([legacy])
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, runtime })

    await expect(
      cu.recordCloudUploads([
        {
          requestId: 'xmd:v1:media:instagram:7:same-id',
          legacyAliases: ['same-id'],
          source: {
            url: 'https://cdninstagram.com/same-id.mp4',
            ext: 'mp4',
          },
          filename: 'a/same-id.mp4',
        },
      ]),
    ).resolves.toEqual({
      tag: 'unavailable',
      reason: 'legacy upload same-id:gdrive has ambiguous request identity',
    })
    expect(ledger.value).toEqual({
      version: 5,
      jobs: [],
      legacy: [legacy],
      quarantine: [],
      ownershipTransitions: [],
    })
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
  })

  it('commits cloud intent and its replay alarm before detached provider I/O', async () => {
    const ledger = fakeLedger(null)
    const alarms = fakeAlarms()
    let releaseUpload!: (outcome: UploadOutcome) => void
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(
      () =>
        new Promise<UploadOutcome>((resolve) => {
          releaseUpload = resolve
        }),
    )
    const cu = makeCU({
      ledger,
      alarms,
      runtime: fakeRuntime({ uploadDrive }),
    })

    await expect(
      cu.recordCloudUploads([
        uploadIntent('durable', 'https://video.twimg.com/durable.mp4', 'mp4', 'a/durable.mp4'),
      ]),
    ).resolves.toEqual({ tag: 'committed' })

    expect(decodeLedger(ledger.value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ requestId: 'durable' })]),
    )
    expect(alarms.create).toHaveBeenCalledWith(
      cu.uploadAlarm,
      NOW + DURABLE_SIDE_EFFECT_WATCHDOG_MS,
    )
    await vi.waitFor(() => expect(uploadDrive).toHaveBeenCalledTimes(1))
    releaseUpload(ok())
    await cu.uploadQueue.run(async () => {})
  })

  it('contains a failed durable admission so the caller can still save locally', async () => {
    const ledger = {
      get: async () => null,
      set: async () => {
        throw new Error('storage full')
      },
    }
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, runtime })

    await expect(
      cu.recordCloudUploads([
        uploadIntent('local-only', 'https://video.twimg.com/local.mp4', 'mp4', 'a/local.mp4'),
      ]),
    ).resolves.toEqual({ tag: 'unavailable', reason: 'storage full' })
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect((await cu.cloudUploadStatus()).lastError).toContain('Cloud upload was not queued')
  })

  it('fails closed when it cannot arm the pre-append watchdog', async () => {
    const ledger = fakeLedger(null)
    const errors: unknown[] = []
    const alarms: AlarmPort = {
      create: async () => {
        throw new Error('alarms unavailable')
      },
      clear: async () => {},
    }
    const uploadDrive = vi.fn<CloudRuntimePort['uploadDrive']>(async () => ok())
    const cu = makeCU({
      ledger,
      alarms,
      runtime: fakeRuntime({ uploadDrive }),
      queueError: () => (error) => {
        errors.push(error)
        throw new Error('observer failed')
      },
    })

    await expect(
      cu.recordCloudUploads([
        uploadIntent('wake', 'https://video.twimg.com/wake.mp4', 'mp4', 'a/wake.mp4'),
      ]),
    ).resolves.toEqual({ tag: 'unavailable', reason: 'alarms unavailable' })
    expect(ledger.value).toBeNull()
    expect(errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: 'alarms unavailable' })]),
    )
    expect(uploadDrive).not.toHaveBeenCalled()
  })

  it('arms a watchdog before a normal admission commits, then reconciles its exact wake', async () => {
    const ledger = fakeLedger(null)
    const order: string[] = []
    const originalSet = ledger.set
    ledger.set = async (value) => {
      order.push('ledger')
      await originalSet(value)
    }
    const alarms: AlarmPort = {
      create: async () => {
        order.push('alarm')
      },
      clear: async () => {},
    }
    const cu = makeCU({ ledger, alarms, runtime: fakeRuntime() })

    await expect(
      cu.recordCloudUploads([
        uploadIntent('death-cut', 'https://video.twimg.com/death.mp4', 'mp4', 'a/death.mp4'),
      ]),
    ).resolves.toEqual({ tag: 'committed' })

    expect(order.slice(0, 2)).toEqual(['alarm', 'ledger'])
    expect(decodeLedger(ledger.value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ requestId: 'death-cut' })]),
    )
  })

  it('leaves a spurious watchdog harmless when the append fails', async () => {
    const ledger = fakeLedger(null, { failSet: 1 })
    const alarms = fakeAlarms()
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, alarms, runtime })

    await expect(
      cu.recordCloudUploads([
        uploadIntent('failed-write', 'https://video.twimg.com/fail.mp4', 'mp4', 'a/fail.mp4'),
      ]),
    ).resolves.toEqual({ tag: 'unavailable', reason: 'ledger write failed' })
    expect(vi.mocked(alarms.create)).toHaveBeenCalledOnce()
    await cu.drainUploadJobs()
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
  })

  it.each([
    ['turns Cloud upload off', () => connected({ cloudUploadEnabled: false })],
    [
      'rotates the provider owner',
      () =>
        connected({
          [gd.clientId]: 'new-client',
          [gd.accessToken]: 'new-access',
          [gd.refreshToken]: 'new-refresh',
        }),
    ],
  ])('withdraws a record admission when Settings %s during watchdog I/O', async (_name, next) => {
    const gate = deferred()
    const armed = deferred()
    let current = connected()
    const alarms: AlarmPort = {
      create: async () => {
        armed.resolve()
        await gate.promise
      },
      clear: async () => {},
    }
    const ledger = fakeLedger(null)
    const cu = makeCU({ ledger, alarms, getSettings: async () => current })

    const admission = cu.recordCloudUploads([
      uploadIntent('withdrawn', 'https://video.twimg.com/withdrawn.mp4', 'mp4', 'a/withdrawn.mp4'),
    ])
    await armed.promise
    current = next()
    gate.resolve()

    await expect(admission).resolves.toEqual({ tag: 'not-requested' })
    expect(ledger.value).toBeNull()
  })

  it('serializes interleaved enqueues so neither batch is lost', async () => {
    // A delayed store widens the read-modify-write window: without FIFO serialization
    // the second enqueue would read the ledger before the first wrote it and clobber it.
    const ledger = fakeLedger(null, { delay: true })
    const cu = makeCU({ ledger, runtime: fakeRuntime() })
    const first = cu.recordCloudUploads([
      uploadIntent('A', 'https://video.twimg.com/a.mp4', 'mp4', 'alice/a.mp4'),
    ])
    const second = cu.recordCloudUploads([
      uploadIntent('B', 'https://video.twimg.com/b.mp4', 'mp4', 'bob/b.mp4'),
    ])
    await Promise.all([first, second])
    await vi.waitFor(() => {
      const ids = decodeLedger(ledger.value).map((j) => j.requestId)
      expect(ids).toContain('A')
      expect(ids).toContain('B')
    })
  })

  it('derives the cloud folder from the filename directory (platform folder, no handle)', async () => {
    // The rendered local path is `twitter/123_0.mp4`; the cloud target must mirror it —
    // folder `twitter`, basename `123_0.mp4` — regardless of the media's author handle.
    const ledger = fakeLedger(null)
    const cu = makeCU({ ledger, runtime: fakeRuntime() })
    await cu.recordCloudUploads([
      uploadIntent('X', 'https://video.twimg.com/x.mp4', 'mp4', 'twitter/123_0.mp4'),
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

  it('keeps new work local when the ledger is full and reports backpressure', async () => {
    const ledger = fakeLedger(null)
    const errors: unknown[] = []
    const runtime = fakeRuntime({
      uploadDrive: vi.fn<CloudRuntimePort['uploadDrive']>(async () => ({
        kind: 'failure',
        reason: 'provider offline',
      })),
    })
    const cu = makeCU({
      ledger,
      runtime,
      maxUploadJobs: 2,
      queueError: () => (error) => errors.push(error),
    })

    await cu.recordCloudUploads(
      ['a', 'b', 'c'].map((id) =>
        uploadIntent(id, `https://video.twimg.com/${id}.mp4`, 'mp4', `alice/${id}.mp4`),
      ),
    )
    await cu.uploadQueue.run(async () => {})

    expect(decodeLedger(ledger.value).map((job) => job.requestId)).toEqual(['a', 'b'])
    expect(errors.some((error) => String(error).includes('queue is full'))).toBe(true)
    expect((await cu.cloudUploadStatus()).lastError).toContain('provider offline')
  })

  it('rejects a queued admission after its provider generation is disconnected', async () => {
    const state = { current: connected() }
    const ledger = fakeLedger(null)
    const runtime = fakeRuntime()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    cu.uploadQueue.push(() => gate)
    const queued = cu.recordCloudUploads([
      uploadIntent('old', 'https://video.twimg.com/old.mp4', 'mp4', 'a/old.mp4'),
    ])
    const disconnect = cu.disconnectProvider('gdrive')
    release()
    await queued
    expect(await disconnect).toEqual({ ok: true })

    expect(decodeLedger(ledger.value)).toEqual([])
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
  })
})

describe('disconnectProvider', () => {
  it('purges all provider jobs before wiping credentials, then permits the same media for a new account', async () => {
    const state = { current: connected() }
    const old = seedJobs(1)
    const claimed = claim(old, old[0]!.jobId, NOW)
    const succeeded = recordSuccess(claimed.ledger, old[0]!.jobId, claimed.token!, NOW, {
      bytes: 1,
      remotePath: target.path,
    }).ledger
    const ledger = fakeLedger(succeeded)
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    expect((await cu.disconnectProvider('gdrive')).ok).toBe(true)
    expect(decodeLedger(ledger.value)).toEqual([])
    expect((await cu.runOAuthConnect('gdrive', 'new-client')).ok).toBe(true)
    await cu.recordCloudUploads([
      uploadIntent('m0', 'https://video.twimg.com/new.mp4', 'mp4', 'alice/new.mp4'),
    ])
    await vi.waitFor(() => expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded'))
  })

  it('keeps credentials when the ownership purge cannot be stored', async () => {
    const state = { current: connected() }
    const ledger = {
      get: vi.fn<() => Promise<unknown>>(async () => seedJobs(1)),
      set: vi.fn<(value: unknown) => Promise<void>>(async () => {
        throw new Error('disk full')
      }),
    }
    const settingsWriter = fakeStatefulSettingsWriter(state)
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      settingsWriter,
    })

    expect(await cu.disconnectProvider('gdrive')).toEqual({ ok: false })
    expect(settingsWriter.updateWhen).not.toHaveBeenCalled()
    expect(state.current[gd.refreshToken]).toBe('gdrive-refresh')
  })

  it('does not restore an in-flight job after disconnect fences and purges it', async () => {
    const state = { current: connected() }
    const ledger = fakeLedger(seedJobs(2))
    let release!: (outcome: UploadOutcome) => void
    const runtime = fakeRuntime({
      uploadDrive: vi.fn<CloudRuntimePort['uploadDrive']>(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      ),
    })
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    cu.uploadQueue.push(() => cu.drainUploadJobs())
    await vi.waitFor(() => expect(runtime.uploadDrive).toHaveBeenCalledTimes(1))
    const disconnect = cu.disconnectProvider('gdrive')
    release(ok())
    expect(await disconnect).toEqual({ ok: true })
    expect(decodeLedger(ledger.value)).toEqual([])
    expect(runtime.uploadDrive).toHaveBeenCalledOnce()
  })

  it('revokes the grant then wipes the local tokens', async () => {
    const state = { current: connected() }
    const settingsWriter = fakeStatefulSettingsWriter(state)
    const cu = makeCU({
      getSettings: async () => state.current,
      settingsWriter,
    })
    const res = await cu.disconnectProvider('gdrive')
    expect(res.ok).toBe(true)
    expect(settingsWriter.updateWhen).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        [gd.accessToken]: '',
        [gd.refreshToken]: '',
        [gd.account]: '',
        [gd.expiry]: 0,
      }),
    )
  })

  it('journals before provider revoke, then wipes tokens and purges', async () => {
    const order: string[] = []
    const state = { current: connected() }
    const ledger = fakeLedger(ledgerState(seedJobs(1)))
    let atRevoke: ReturnType<typeof decodeLedgerStateResult> | undefined
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      atRevoke = decodeLedgerStateResult(ledger.value)
      order.push(`revoke:${String(url)}`)
      return new Response()
    })
    const settingsWriter = fakeStatefulSettingsWriter(state)
    settingsWriter.updateWhen.mockImplementation(async (guard, patch) => {
      order.push('wipe')
      if (!guard(state.current)) return { applied: false, settings: state.current }
      state.current = { ...state.current, ...patch }
      return { applied: true, settings: state.current }
    })
    const cu = makeCU({
      getSettings: async () => state.current,
      fetchImpl,
      ledger,
      settingsWriter,
    })
    await cu.disconnectProvider('gdrive')
    if (!atRevoke?.ok) throw new Error('expected journal at revoke')
    expect(atRevoke.state.jobs).toHaveLength(1)
    expect(atRevoke.state.ownershipTransitions).toEqual([
      expect.objectContaining({ provider: 'gdrive', kind: 'disconnect' }),
    ])
    expect(order).toEqual(['revoke:https://oauth2.googleapis.com/revoke', 'wipe'])
    expect(decodeLedger(ledger.value)).toEqual([])
  })

  it('keeps a live disconnect journal when its watchdog fires during revoke', async () => {
    const state = { current: connected() }
    const ledger = fakeLedger(ledgerState(seedJobs(1)))
    const alarms = fakeAlarms()
    let releaseRevoke: ((response: Response) => void) | undefined
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          releaseRevoke = resolve
        }),
    )
    const cu = makeCU({
      getSettings: async () => state.current,
      fetchImpl,
      ledger,
      alarms,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    const disconnect = cu.disconnectProvider('gdrive')
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce())
    await cu.drainUploadJobs()

    const inFlight = decodeLedgerStateResult(ledger.value)
    expect(inFlight.ok && inFlight.state.jobs).toHaveLength(1)
    expect(inFlight.ok && inFlight.state.ownershipTransitions).toEqual([
      expect.objectContaining({ provider: 'gdrive', kind: 'disconnect' }),
    ])
    expect(alarms.create).toHaveBeenLastCalledWith(
      cu.uploadAlarm,
      NOW + DURABLE_SIDE_EFFECT_WATCHDOG_MS,
    )

    releaseRevoke?.(new Response())
    await expect(disconnect).resolves.toEqual({ ok: true })
  })

  it('aborts a failed Settings wipe and preserves old work', async () => {
    const state = { current: connected({ cloudUploadEnabled: false }) }
    const ledger = fakeLedger(ledgerState(seedJobs(1)))
    const settingsWriter = fakeStatefulSettingsWriter(state)
    settingsWriter.updateWhen.mockRejectedValue(new Error('settings unavailable'))
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      settingsWriter,
    })

    expect(await cu.disconnectProvider('gdrive')).toEqual({ ok: false })
    const decoded = decodeLedgerStateResult(ledger.value)
    expect(decoded.ok && decoded.state.jobs).toHaveLength(1)
    expect(decoded.ok && decoded.state.ownershipTransitions).toEqual([])
    expect(state.current[gd.refreshToken]).toBe('gdrive-refresh')
  })

  it('recovers a committed disconnect after final ledger cleanup dies', async () => {
    const state = { current: connected() }
    let value: unknown = ledgerState(seedJobs(1))
    let sets = 0
    const dyingLedger = {
      get: vi.fn<() => Promise<unknown>>(async () => value),
      set: vi.fn<(next: unknown) => Promise<void>>(async (next) => {
        sets += 1
        if (sets >= 2) throw new Error('worker died before final ledger write')
        value = next
      }),
    }
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger: dyingLedger,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    expect(await cu.disconnectProvider('gdrive')).toEqual({ ok: false })
    await cu.uploadQueue.run(async () => {})
    expect(state.current[gd.refreshToken]).toBe('')
    const stranded = decodeLedgerStateResult(value)
    expect(stranded.ok && stranded.state.ownershipTransitions).toHaveLength(1)

    const restartedLedger = fakeLedger(value)
    const restarted = makeCU({
      getSettings: async () => state.current,
      ledger: restartedLedger,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })
    await restarted.resumeOnBoot()
    const recovered = decodeLedgerStateResult(restartedLedger.value)
    expect(recovered.ok && recovered.state.jobs).toEqual([])
    expect(recovered.ok && recovered.state.ownershipTransitions).toEqual([])
  })

  it('does not revoke newer credentials when its settings read finishes late', async () => {
    const state = { current: connected() }
    let reads = 0
    let releaseDisconnectRead: ((settings: Settings) => void) | undefined
    const getSettings = async (): Promise<Settings> => {
      reads += 1
      if (reads === 1)
        return new Promise((resolve) => {
          releaseDisconnectRead = resolve
        })
      return state.current
    }
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response())
    const cu = makeCU({
      getSettings,
      fetchImpl,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    const disconnect = cu.disconnectProvider('gdrive')
    await vi.waitFor(() => expect(reads).toBe(1))
    expect((await cu.runOAuthConnect('gdrive', 'new-client')).ok).toBe(true)
    releaseDisconnectRead?.(state.current)

    expect((await disconnect).ok).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(state.current[gd.clientId]).toBe('new-client')
    expect(state.current[gd.accessToken]).toBe('x-access')
    expect(state.current[gd.refreshToken]).toBe('x-refresh')
  })

  it('wipes Dropbox tokens with no folderId field (gdrive-only asymmetry)', async () => {
    const settingsWriter = fakeSettingsWriter(() => connectedDropbox())
    const cu = makeCU({
      getSettings: async () => connectedDropbox(),
      settingsWriter,
    })
    await cu.disconnectProvider('dropbox')
    const patch = settingsWriter.updateWhen.mock.calls[0]![1]
    expect(patch).toEqual(expect.objectContaining({ [dx.accessToken]: '', [dx.refreshToken]: '' }))
    expect(Object.keys(patch)).not.toContain('gdriveFolderId')
    expect(Object.keys(patch)).not.toContain('dropboxFolderId')
  })

  it('does not wipe a newer connection after its revoke finishes', async () => {
    const state = { current: connected() }
    let releaseRevoke: ((response: Response) => void) | undefined
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          releaseRevoke = resolve
        }),
    )
    const runtime = fakeRuntime()
    const cu = makeCU({
      getSettings: async () => state.current,
      fetchImpl,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    const disconnect = cu.disconnectProvider('gdrive')
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1))
    expect((await cu.runOAuthConnect('gdrive', 'new-client')).ok).toBe(true)
    releaseRevoke?.(new Response())

    expect((await disconnect).ok).toBe(false)
    expect(state.current[gd.clientId]).toBe('new-client')
    expect(state.current[gd.accessToken]).toBe('x-access')
    expect(state.current[gd.refreshToken]).toBe('x-refresh')
  })
})

describe('retryDeadUploads', () => {
  it('arms before reviving a dead job, then drains it', async () => {
    const dead = {
      ...seedJobs(1)[0]!,
      status: 'dead' as const,
      attempts: 5,
      error: 'boom',
    }
    const ledger = fakeLedger([dead])
    const order: string[] = []
    const originalSet = ledger.set
    ledger.set = async (value) => {
      order.push('ledger')
      await originalSet(value)
    }
    const alarms: AlarmPort = {
      create: async () => {
        order.push('alarm')
      },
      clear: async () => {},
    }
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, runtime, alarms })
    await cu.retryDeadUploads()
    await vi.waitFor(() => expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded'))
    expect(order.slice(0, 2)).toEqual(['alarm', 'ledger'])
    expect(runtime.uploadDrive).toHaveBeenCalledTimes(1)
  })

  it('does not revive a dead job when its watchdog cannot arm', async () => {
    const dead = {
      ...seedJobs(1)[0]!,
      status: 'dead' as const,
      attempts: 5,
      error: 'boom',
    }
    const ledger = fakeLedger([dead])
    const runtime = fakeRuntime()
    const cu = makeCU({
      ledger,
      runtime,
      alarms: {
        create: async () => {
          throw new Error('alarm unavailable')
        },
        clear: async () => {},
      },
    })

    await cu.retryDeadUploads()
    await cu.uploadQueue.run(async () => {})
    expect(decodeLedger(ledger.value)[0]?.status).toBe('dead')
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
  })
})

describe('backfillCloudUploads', () => {
  it('arms a watchdog before a backfill commit, then reconciles its exact wake', async () => {
    const ledger = fakeLedger(null)
    const order: string[] = []
    const originalSet = ledger.set
    ledger.set = async (value) => {
      order.push('ledger')
      await originalSet(value)
    }
    const alarms: AlarmPort = {
      create: async () => {
        order.push('alarm')
      },
      clear: async () => {},
    }
    const cu = makeCU({
      ledger,
      alarms,
      getBackfillRecords: async () => [
        {
          requestId: 'backfill-death-cut',
          filename: 'alice/old.mp4',
          media: {
            url: 'https://video.twimg.com/old.mp4',
            handle: 'alice',
            ext: 'mp4',
          },
        },
      ],
    })

    await expect(cu.backfillCloudUploads()).resolves.toMatchObject({ ok: true, queued: 1 })
    expect(order.slice(0, 2)).toEqual(['alarm', 'ledger'])
    expect(decodeLedger(ledger.value)).toEqual(
      expect.arrayContaining([expect.objectContaining({ requestId: 'backfill-death-cut' })]),
    )
  })

  it('fails closed when a backfill watchdog cannot be armed', async () => {
    const ledger = fakeLedger(null)
    const cu = makeCU({
      ledger,
      alarms: {
        create: async () => {
          throw new Error('backfill alarm unavailable')
        },
        clear: async () => {},
      },
      getBackfillRecords: async () => [
        {
          requestId: 'backfill-no-wake',
          filename: 'alice/old.mp4',
          media: {
            url: 'https://video.twimg.com/old.mp4',
            handle: 'alice',
            ext: 'mp4',
          },
        },
      ],
    })

    await expect(cu.backfillCloudUploads()).resolves.toMatchObject({ ok: false, queued: 0 })
    expect(ledger.value).toBeNull()
  })

  it.each([
    ['turns Cloud upload off', () => connected({ cloudUploadEnabled: false })],
    [
      'rotates the provider owner',
      () =>
        connected({
          [gd.clientId]: 'new-client',
          [gd.accessToken]: 'new-access',
          [gd.refreshToken]: 'new-refresh',
        }),
    ],
  ])('withdraws a backfill admission when Settings %s during watchdog I/O', async (_name, next) => {
    const gate = deferred()
    const armed = deferred()
    let current = connected()
    const ledger = fakeLedger(null)
    const cu = makeCU({
      ledger,
      alarms: {
        create: async () => {
          armed.resolve()
          await gate.promise
        },
        clear: async () => {},
      },
      getSettings: async () => current,
      getBackfillRecords: async () => [
        {
          requestId: 'backfill-withdrawn',
          filename: 'alice/old.mp4',
          media: {
            url: 'https://video.twimg.com/old.mp4',
            handle: 'alice',
            ext: 'mp4',
          },
        },
      ],
    })

    const admission = cu.backfillCloudUploads()
    await armed.promise
    current = next()
    gate.resolve()

    await expect(admission).resolves.toMatchObject({ ok: false, queued: 0 })
    expect(ledger.value).toBeNull()
  })

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
          media: {
            url: 'https://video.twimg.com/old.mp4',
            handle: 'alice',
            ext: 'mp4',
          },
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

  it('partially admits backfill during an outage without dropping queued work', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const runtime = fakeRuntime({
      uploadDrive: vi.fn<CloudRuntimePort['uploadDrive']>(async () => ({
        kind: 'failure',
        reason: 'provider offline',
      })),
    })
    const cu = makeCU({
      ledger,
      runtime,
      maxUploadJobs: 2,
      getBackfillRecords: async () =>
        ['r1', 'r2'].map((requestId) => ({
          requestId,
          filename: `alice/${requestId}.mp4`,
          media: {
            url: `https://video.twimg.com/${requestId}.mp4`,
            handle: 'alice',
            ext: 'mp4',
          },
        })),
    })

    const result = await cu.backfillCloudUploads()
    expect(result).toMatchObject({ ok: true, queued: 1 })
    expect(result.detail).toContain('1 stayed local')
    expect(decodeLedger(ledger.value).map((job) => job.requestId)).toEqual(['m0', 'r1'])
    await cu.uploadQueue.run(async () => {})
    expect(decodeLedger(ledger.value)).toHaveLength(2)
  })
})

describe('resumeOnBoot', () => {
  it('compacts the ledger and drains pending uploads on boot', async () => {
    const ledger = fakeLedger(ledgerState(seedJobs(1)))
    const order: string[] = []
    const originalSet = ledger.set
    ledger.set = async (value) => {
      order.push('ledger')
      await originalSet(value)
    }
    const alarms: AlarmPort = {
      create: async () => {
        order.push('alarm')
      },
      clear: async () => {},
    }
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, runtime, alarms })
    await cu.resumeOnBoot()
    expect(order.slice(0, 2)).toEqual(['alarm', 'ledger'])
    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
    expect(runtime.uploadDrive).toHaveBeenCalledTimes(1)
  })

  it('quarantines corrupt storage without overwrite or network work', async () => {
    const raw = { malformed: 'ledger' }
    const ledger = fakeLedger(raw)
    const runtime = fakeRuntime()
    const errors: unknown[] = []
    const cu = makeCU({
      ledger,
      runtime,
      queueError: () => (error) => errors.push(error),
    })

    await expect(cu.resumeOnBoot()).rejects.toThrow('data is corrupt')

    expect(ledger.value).toBe(raw)
    expect(ledger.sets).toBe(0)
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect(runtime.uploadDropbox).not.toHaveBeenCalled()
    expect(runtime.refreshAccessToken).not.toHaveBeenCalled()
    expect(runtime.resolveDriveRoot).not.toHaveBeenCalled()
    expect(runtime.mirror).not.toHaveBeenCalled()
    expect(errors.some((error) => String(error).includes('data is corrupt'))).toBe(true)
    expect((await cu.cloudUploadStatus()).lastError).toContain('data is corrupt')
  })

  it('migrates an empty legacy value to a valid empty ledger', async () => {
    const ledger = fakeLedger(null)
    const runtime = fakeRuntime()
    const cu = makeCU({ ledger, runtime })

    await cu.resumeOnBoot()

    expect(ledger.value).toEqual({
      version: 5,
      jobs: [],
      legacy: [],
      quarantine: [],
      ownershipTransitions: [],
    })
    expect(ledger.sets).toBe(1)
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
  })

  it('leaves an ownership journal untouched when its recovery watchdog cannot arm', async () => {
    const oldOwner = connected({ cloudUploadEnabled: false })
    const newOwner = connected({
      cloudUploadEnabled: false,
      [gd.clientId]: 'replacement-client',
      [gd.refreshToken]: 'replacement-refresh',
    })
    const transition = await ownershipTransition('connect', oldOwner, newOwner)
    const ledger = fakeLedger(ledgerState(seedJobs(1), [transition]))
    let failArm = true
    const alarms: AlarmPort = {
      create: async () => {
        if (failArm) throw new Error('alarm unavailable')
      },
      clear: async () => {},
    }
    const settingsWriter = fakeSettingsWriter(() => oldOwner)
    const cu = makeCU({
      getSettings: async () => oldOwner,
      ledger,
      alarms,
      settingsWriter,
    })

    await expect(cu.resumeOnBoot()).rejects.toThrow('alarm unavailable')
    expect(ledger.value).toEqual(ledgerState(seedJobs(1), [transition]))
    expect(ledger.sets).toBe(0)
    expect(settingsWriter.updateWhen).not.toHaveBeenCalled()

    failArm = false
    await cu.resumeOnBoot()
    const recovered = decodeLedgerStateResult(ledger.value)
    expect(recovered.ok && recovered.state.ownershipTransitions).toEqual([])
    expect(recovered.ok && recovered.state.jobs).toHaveLength(1)
  })

  it('aborts a journal on the old owner and preserves its rows', async () => {
    const oldOwner = connected({ cloudUploadEnabled: false })
    const newOwner = connected({
      cloudUploadEnabled: false,
      [gd.clientId]: 'replacement-client',
      [gd.refreshToken]: 'replacement-refresh',
    })
    const transition = await ownershipTransition('connect', oldOwner, newOwner)
    const ledger = fakeLedger(ledgerState(seedJobs(1), [transition]))
    const cu = makeCU({ getSettings: async () => oldOwner, ledger })

    await cu.resumeOnBoot()

    const decoded = decodeLedgerStateResult(ledger.value)
    expect(decoded.ok && decoded.state.jobs).toHaveLength(1)
    expect(decoded.ok && decoded.state.ownershipTransitions).toEqual([])
  })

  it('commits a journal on the new owner and purges old rows', async () => {
    const oldOwner = connected({ cloudUploadEnabled: false })
    const newOwner = connected({
      cloudUploadEnabled: false,
      [gd.clientId]: 'replacement-client',
      [gd.refreshToken]: 'replacement-refresh',
    })
    const transition = await ownershipTransition('connect', oldOwner, newOwner)
    const ledger = fakeLedger(ledgerState(seedJobs(1), [transition]))
    const cu = makeCU({ getSettings: async () => newOwner, ledger })

    await cu.resumeOnBoot()

    const decoded = decodeLedgerStateResult(ledger.value)
    expect(decoded.ok && decoded.state.jobs).toEqual([])
    expect(decoded.ok && decoded.state.ownershipTransitions).toEqual([])
  })

  it('keeps an unknown owner blocked without claiming or uploading', async () => {
    const oldOwner = connected()
    const newOwner = connected({
      [gd.clientId]: 'replacement-client',
      [gd.refreshToken]: 'replacement-refresh',
    })
    const unknownOwner = connected({
      [gd.clientId]: 'third-client',
      [gd.refreshToken]: 'third-refresh',
    })
    const transition = await ownershipTransition('connect', oldOwner, newOwner)
    const ledger = fakeLedger(ledgerState(seedJobs(1), [transition]))
    const runtime = fakeRuntime()
    const cu = makeCU({
      getSettings: async () => unknownOwner,
      ledger,
      runtime,
    })

    await cu.resumeOnBoot()

    const decoded = decodeLedgerStateResult(ledger.value)
    expect(decoded.ok && decoded.state.jobs[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
    })
    expect(decoded.ok && decoded.state.ownershipTransitions).toEqual([transition])
    expect(runtime.prepareBlobAttempt).not.toHaveBeenCalled()
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
  })

  it('uses reconnect as explicit recovery for an unknown owner', async () => {
    const oldOwner = connected()
    const intendedOwner = connected({
      [gd.clientId]: 'intended-client',
      [gd.refreshToken]: 'intended-refresh',
    })
    const state = {
      current: connected({
        [gd.clientId]: 'third-client',
        [gd.refreshToken]: 'third-refresh',
      }),
    }
    const transition = await ownershipTransition('connect', oldOwner, intendedOwner)
    const ledger = fakeLedger(ledgerState(seedJobs(1), [transition]))
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    expect(await cu.runOAuthConnect('gdrive', 'recovered-client')).toMatchObject({ ok: true })

    const decoded = decodeLedgerStateResult(ledger.value)
    expect(decoded.ok && decoded.state.jobs).toEqual([])
    expect(decoded.ok && decoded.state.ownershipTransitions).toEqual([])
    expect(state.current[gd.clientId]).toBe('recovered-client')
    expect((await cu.cloudUploadStatus()).lastError).toBeNull()
  })

  it('keeps the other provider draining while one owner is blocked', async () => {
    const oldOwner = connected()
    const newOwner = connected({
      [gd.clientId]: 'replacement-client',
      [gd.refreshToken]: 'replacement-refresh',
    })
    const state = {
      current: connected({
        [gd.clientId]: 'third-client',
        [gd.refreshToken]: 'third-refresh',
        [dx.clientId]: 'dropbox-client',
        [dx.accessToken]: 'dropbox-access',
        [dx.refreshToken]: 'dropbox-refresh',
        [dx.expiry]: NOW + 3_600_000,
      }),
    }
    const transition = await ownershipTransition('connect', oldOwner, newOwner)
    const jobs = enqueue(
      seedJobs(1),
      {
        requestId: 'dropbox-ready',
        provider: 'dropbox',
        url: 'https://video.twimg.com/dropbox.mp4',
        target,
      },
      NOW,
    )
    const ledger = fakeLedger(ledgerState(jobs, [transition]))
    const runtime = fakeRuntime()
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    await cu.resumeOnBoot()

    expect(decodeLedger(ledger.value).map((job) => [job.provider, job.status])).toEqual([
      ['gdrive', 'pending'],
      ['dropbox', 'succeeded'],
    ])
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect(runtime.uploadDropbox).toHaveBeenCalledOnce()
  })

  it('never treats a recovery projection as proof of disconnect', async () => {
    const oldOwner = connected({ cloudUploadEnabled: false })
    const disconnected = connected({
      cloudUploadEnabled: false,
      [gd.accessToken]: '',
      [gd.refreshToken]: '',
      [gd.expiry]: 0,
      [gd.account]: '',
    })
    const transition = await ownershipTransition('disconnect', oldOwner, disconnected)
    const ledger = fakeLedger(ledgerState(seedJobs(1), [transition]))
    const cu = makeCU({
      getSettings: async () => disconnected,
      getSettingsOwnership: async () => ({
        availability: 'recovery-required',
        runtime: disconnected,
        reason: 'recoverable',
      }),
      ledger,
    })

    await cu.resumeOnBoot()

    const decoded = decodeLedgerStateResult(ledger.value)
    expect(decoded.ok && decoded.state.jobs).toHaveLength(1)
    expect(decoded.ok && decoded.state.ownershipTransitions).toEqual([transition])
  })
})

describe('resumeWhenEnabled', () => {
  it('clears a consumed alarm while disabled, then drains after re-enable', async () => {
    const state = { current: connected({ cloudUploadEnabled: false }) }
    const ledger = fakeLedger(seedJobs(1))
    const runtime = fakeRuntime()
    const alarms = fakeAlarms()
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime,
      alarms,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })

    cu.uploadQueue.push(() => cu.drainUploadJobs()) // alarm wake while disabled
    await cu.uploadQueue.run(async () => {})
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect(alarms.clear).toHaveBeenCalledWith(cu.uploadAlarm)
    expect(alarms.create).not.toHaveBeenCalled()
    expect(decodeLedger(ledger.value)[0]?.status).toBe('pending')

    state.current = connected()
    cu.resumeWhenEnabled()
    await vi.waitFor(() => expect(runtime.uploadDrive).toHaveBeenCalledTimes(1))
    expect(vi.mocked(alarms.create).mock.calls[0]).toEqual([
      cu.uploadAlarm,
      NOW + DURABLE_SIDE_EFFECT_WATCHDOG_MS,
    ])
    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
  })
})

describe('drainUploadJobs — sourceGone (link-rot, never a fake save)', () => {
  it('marks the job skipped, clears its watchdog, and records no error', async () => {
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
    expect(alarms.create).toHaveBeenCalledWith(cu.uploadAlarm, NOW + LEASE_MS)
    expect(alarms.clear).toHaveBeenCalledWith(cu.uploadAlarm)
    // The sourceGone arm never sets lastUploadError (unlike the failure arm).
    expect((await cu.cloudUploadStatus()).lastError).toBeNull()
  })
})

describe('drainUploadJobs — Drive root folder resolution', () => {
  it('resolves and persists the Drive root once when unset, passing it to the upload', async () => {
    const ledger = fakeLedger(seedJobs(1))
    const runtime = fakeRuntime()
    const state = { current: connected() }
    const settingsWriter = fakeStatefulSettingsWriter(state)
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime,
      settingsWriter,
    })
    await cu.drainUploadJobs()
    expect(runtime.resolveDriveRoot).toHaveBeenCalledTimes(1)
    expect(settingsWriter.updateWhen).toHaveBeenCalledWith(
      expect.any(Function),
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
    const state = { current: connected({ gdriveFolderId: 'pre-resolved' }) }
    const cu = makeCU({
      ledger,
      runtime,
      getSettings: async () => state.current,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })
    await cu.drainUploadJobs()
    expect(runtime.resolveDriveRoot).not.toHaveBeenCalled()
    expect(runtime.uploadDrive).toHaveBeenCalledWith(
      expect.objectContaining({ rootFolderId: 'pre-resolved' }),
      expect.anything(),
    )
  })

  it('retains the durable claim when connection ownership changes during root resolution', async () => {
    const ledger = fakeLedger(seedJobs(1))
    let current = connected()
    let releaseRoot: ((rootId: string) => void) | undefined
    const runtime = fakeRuntime({
      resolveDriveRoot: vi.fn<CloudRuntimePort['resolveDriveRoot']>(
        () =>
          new Promise((resolve) => {
            releaseRoot = resolve
          }),
      ),
    })
    const settingsWriter = fakeSettingsWriter(() => current)
    settingsWriter.updateWhen.mockImplementation(async (guard, patch) => {
      if (!guard(current)) return { applied: false, settings: current }
      current = { ...current, ...patch }
      return { applied: true, settings: current }
    })
    const cu = makeCU({
      getSettings: async () => current,
      ledger,
      runtime,
      settingsWriter,
    })

    const draining = cu.drainUploadJobs()
    await vi.waitFor(() => expect(runtime.resolveDriveRoot).toHaveBeenCalledTimes(1))
    current = connected({ cloudUploadEnabled: false, [gd.refreshToken]: '' })
    releaseRoot?.('drive-root-id')
    await draining

    expect(settingsWriter.updateWhen).toHaveBeenCalledTimes(2)
    expect(settingsWriter.update).not.toHaveBeenCalled()
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect(decodeLedger(ledger.value)[0]).toMatchObject({
      status: 'uploading',
      error: null,
    })
  })
})

describe('drainUploadJobs — Dropbox provider', () => {
  it('routes a dropbox job to uploadDropbox, never uploadDrive', async () => {
    const ledger = fakeLedger(
      enqueue(
        [],
        {
          requestId: 'd0',
          provider: 'dropbox',
          url: 'https://video.twimg.com/d.mp4',
          target,
        },
        NOW,
      ),
    )
    const runtime = fakeRuntime()
    const state = { current: connectedDropbox() }
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      runtime,
      settingsWriter: fakeStatefulSettingsWriter(state),
    })
    await cu.drainUploadJobs()
    expect(runtime.uploadDropbox).toHaveBeenCalledTimes(1)
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
    expect(decodeLedger(ledger.value)[0]?.status).toBe('succeeded')
  })
})

describe('recordCloudUploads — gating (no side effects)', () => {
  const item = uploadIntent('A', 'https://video.twimg.com/a.mp4', 'mp4', 'alice/a.mp4')

  it('does nothing when Cloud upload is disabled', async () => {
    const ledger = fakeLedger()
    const runtime = fakeRuntime()
    await expect(
      makeCU({
        ledger,
        runtime,
        getSettings: async () => connected({ cloudUploadEnabled: false }),
      }).recordCloudUploads([item]),
    ).resolves.toEqual({ tag: 'not-requested' })
    expect(ledger.gets).toBe(0)
    expect(ledger.sets).toBe(0)
    expect(runtime.uploadDrive).not.toHaveBeenCalled()
  })

  it('does nothing for an empty item batch', async () => {
    const ledger = fakeLedger()
    await expect(makeCU({ ledger }).recordCloudUploads([])).resolves.toEqual({
      tag: 'not-requested',
    })
    expect(ledger.sets).toBe(0)
  })

  it('does nothing when no provider is connected', async () => {
    const ledger = fakeLedger()
    await expect(
      makeCU({
        ledger,
        getSettings: async () => connected({ [gd.refreshToken]: '' }),
      }).recordCloudUploads([item]),
    ).resolves.toEqual({ tag: 'not-requested' })
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
  it('pauseWhenDisabled clears the alarm and badge without touching due work', async () => {
    const state = { current: connected({ cloudUploadEnabled: false }) }
    const ledger = fakeLedger(seedJobs(1))
    const alarms = fakeAlarms()
    const badge = fakeBadge()
    const cu = makeCU({
      getSettings: async () => state.current,
      ledger,
      alarms,
      badge,
    })

    await cu.pauseWhenDisabled()

    expect(alarms.clear).toHaveBeenCalledWith(cu.uploadAlarm)
    expect(alarms.create).not.toHaveBeenCalled()
    expect(badge.set).toHaveBeenCalledWith('')
    expect(decodeLedger(ledger.value)[0]?.status).toBe('pending')
  })

  it('reflects the permanently-dead count after a drain', async () => {
    const badge = fakeBadge()
    const dead = {
      ...seedJobs(1)[0]!,
      status: 'dead' as const,
      attempts: 5,
      error: 'boom',
    }
    const cu = makeCU({ ledger: fakeLedger([dead]), badge })
    await cu.drainUploadJobs()
    expect(badge.set).toHaveBeenCalledWith('1')
    expect(badge.setColor).toHaveBeenCalledWith('#dc2626')
  })
})
