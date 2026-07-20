import { storage } from 'wxt/utils/storage'
import { CLOUD_PROVIDERS, type Settings } from '../core/schema'
import { setSettings } from '../core/settings'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { makeConvexHttpPort } from '../core/sync/convex'
import { makeCloudServicesLive } from '../core/cloud/cloud-services'
import { DriveUploader, DriveUploaderLive, type DriveArgs } from '../core/cloud/drive'
import { DropboxUploader, DropboxUploaderLive } from '../core/cloud/dropbox'
import {
  guessMime,
  type CloudProviderId,
  type OAuthConfig,
  type OAuthTokens,
  type UploadInput,
  type UploadOutcome,
  type UploadTarget,
} from '../core/cloud/types'
import {
  buildAuthUrl,
  computeCodeChallenge,
  exchangeCode,
  generateCodeVerifier,
  isTokenExpired,
  parseAuthRedirect,
  randomState,
  refreshAccessToken,
} from '../core/cloud/oauth'
import {
  capLedger,
  claim,
  decodeLedger,
  enqueue,
  isTerminal,
  MAX_ATTEMPTS,
  readyJobs,
  recordFailure,
  recordSourceGone,
  recordSuccess,
  retry as retryUploadJob,
  summarize,
  toWireUploadJob,
  type JobLedger,
  type UploadJob,
} from '../core/cloud/upload-job'
import { PROVIDERS, revokeViaRecipe } from '../core/cloud/provider'
import { classifyUploadError, type CloudUploadStatus } from '../core/cloud/status'
import { makeSerialQueue, type SerialQueue } from '../core/serial-queue'
import { runSerializedRmw, type DurableStore } from '../core/durable-store'
import { isSyncConfigured } from './sync-config'

/** A media item + its on-disk filename — the unit recordCloudUploads enqueues. */
export interface UploadCandidate {
  readonly item: {
    readonly id: string
    readonly url: string
    readonly handle: string
    readonly ext: string
  }
  readonly filename: string
}

/** A past download (from history) eligible for backfill. */
export interface BackfillRecord {
  readonly requestId: string
  readonly filename: string
  readonly media: { readonly url: string; readonly handle: string; readonly ext: string }
}

/** Durable UploadJob-ledger storage seam — the wxt `local:cloudUploadJobs` item in
 *  the SW, an in-memory box in tests. The stored payload is opaque (`decodeLedger`
 *  validates it on read), so this carries `unknown`. */
export type LedgerStore = DurableStore

/** Everything that executes on the ONE per-SW-life cloud runtime (ADR-0017): the
 *  provider byte uploaders, Drive's root-folder resolve, the OAuth token grants, and
 *  the best-effort Convex mirror. Folding them behind one port keeps the single
 *  shared ManagedRuntime invariant (FetchService/SourceFetch/FolderCache) — and lets
 *  a test substitute a plain-async fake with no Effect/Layer ceremony. */
export interface CloudRuntimePort {
  uploadDrive(args: DriveArgs, input: UploadInput): Promise<UploadOutcome>
  uploadDropbox(accessToken: string, input: UploadInput): Promise<UploadOutcome>
  resolveDriveRoot(accessToken: string): Promise<string>
  exchangeCode(input: {
    readonly cfg: OAuthConfig
    readonly clientId: string
    readonly code: string
    readonly codeVerifier: string
    readonly redirectUri: string
    readonly now: number
  }): Promise<OAuthTokens>
  refreshAccessToken(input: {
    readonly cfg: OAuthConfig
    readonly clientId: string
    readonly refreshToken: string
    readonly now: number
  }): Promise<{ readonly accessToken: string; readonly expiresAt: number }>
  /** Run the control-plane mirror mutation. The gate + the best-effort swallow stay
   *  on the SHELL side (mirrorUploadJob), so a test injects a throwing mirror to
   *  prove the drain survives. */
  mirror(input: {
    readonly deploymentUrl: string
    readonly jobs: ReadonlyArray<ReturnType<typeof toWireUploadJob>>
    readonly secret: string
  }): Promise<unknown>
}

/** Durable wake-up alarm seam (one backoff alarm; the entrypoint owns the listener). */
export interface AlarmPort {
  create(name: string, when: number): Promise<void>
  clear(name: string): Promise<void>
}

/** Toolbar badge seam (the dead-upload count). */
export interface BadgePort {
  set(text: string): Promise<void>
  setColor(color: string): Promise<void>
}

/** Interactive OAuth seam. `launchFlow` is genuinely browser-bound (the consent
 *  popup) and CANNOT be unit-tested end to end; a test fakes it to a canned redirect
 *  string (or undefined for cancel) to cover only the parse→exchange→persist tail. */
export interface AuthFlowPort {
  getRedirectUrl(): string
  launchFlow(url: string): Promise<string | undefined>
}

export interface CloudUpload {
  /** The serialized upload chain — boot resume + alarm wake push onto it. */
  readonly uploadQueue: SerialQueue
  /** Drain ready upload jobs FIFO (claim → upload → record → mirror). */
  readonly drainUploadJobs: () => Promise<void>
  /** Enqueue one UploadJob per (media item × connected provider) at queue time. */
  readonly recordCloudUploads: (settings: Settings, items: ReadonlyArray<UploadCandidate>) => void
  /** PKCE OAuth connect in the SW; persists tokens. Popup-facing result. */
  readonly runOAuthConnect: (
    provider: CloudProviderId,
    clientIdArg: string,
  ) => Promise<{ ok: boolean; detail: string; account?: string }>
  /** Revoke at provider, then wipe local tokens (gdrive-only folderId clear). */
  readonly disconnectProvider: (provider: CloudProviderId) => Promise<{ ok: boolean }>
  /** Ledger summary + last error for the popup. */
  readonly cloudUploadStatus: () => Promise<CloudUploadStatus>
  /** Re-arm dead/failed jobs and drain. */
  readonly retryDeadUploads: () => Promise<{ ok: boolean }>
  /** Enqueue cloud uploads for already-downloaded media from history. */
  readonly backfillCloudUploads: () => Promise<{ ok: boolean; queued: number; detail: string }>
  /** Compact a historically-grown ledger once and resume pending uploads on boot. */
  readonly resumeOnBoot: () => void
  /** Clear the upload-failure toolbar badge (Cloud upload switched off). */
  readonly clearUploadBadge: () => void
  /** The durable wake-up alarm name (the entrypoint registers the onAlarm listener). */
  readonly uploadAlarm: string
}

export interface CloudUploadDeps {
  /** Build the queue's error observer (traces through the background's chain). */
  readonly queueError: (label: string) => (err: unknown) => void
  /** Read the current settings blob. */
  readonly getSettings: () => Promise<Settings>
  /** The fetch the provider/Convex ports use (bound for the MV3 SW; see fetch.ts).
   *  Only consumed to build the default cloud runtime; ignored when `runtime` is injected. */
  readonly fetchImpl: typeof fetch
  /** Past downloads eligible for backfill (from the durable history store). */
  readonly getBackfillRecords: () => Promise<ReadonlyArray<BackfillRecord>>
  // Injectable side-effect seams. Each defaults to its live binding, so the entrypoint
  // passes NONE of them; a test passes only the few ports its path exercises.
  /** The durable UploadJob ledger (default: the `local:cloudUploadJobs` wxt item). */
  readonly ledger?: LedgerStore
  /** The per-SW-life cloud runtime operations (default: a real ManagedRuntime). */
  readonly runtime?: CloudRuntimePort
  /** The backoff wake-up alarm (default: `browser.alarms`). */
  readonly alarms?: AlarmPort
  /** The dead-upload toolbar badge (default: `browser.action`). */
  readonly badge?: BadgePort
  /** The interactive OAuth flow (default: `browser.identity`). */
  readonly authFlow?: AuthFlowPort
  /** The settings writer (default: the core `setSettings`). Always re-serialized
   *  through the SW-side settingsQueue inside, so ADR-0005 single-writer holds. */
  readonly setSettings?: (patch: Partial<Settings>) => Promise<Settings>
  /** The clock (default: `Date.now`). Injected so backoff/expiry assertions are deterministic. */
  readonly now?: () => number
  /** Jobs drained per pass before yielding to a fresh serialized task (default
   *  {@link MAX_DRAIN_JOBS_PER_PASS}). Injected only so the re-kick is testable without
   *  seeding a thousand jobs. */
  readonly maxDrainPerPass?: number
}

const UPLOAD_ALARM = 'cloud-upload-drain'

// Safety cap on jobs drained in a single pass before yielding to a fresh
// serialized task (the `if (!ranOut)` re-kick below) — bounds one drain so a
// large ledger can't monopolize the SW.
const MAX_DRAIN_JOBS_PER_PASS = 1000

// Single source of truth for the provider enumeration (schema/index.ts).
const ALL_PROVIDERS: ReadonlyArray<CloudProviderId> = CLOUD_PROVIDERS

// The per-provider Settings-field layout lives on the Cloud Provider record
// (`provider.fields`); token reads/writes, connect, and disconnect read it from
// there instead of forking on the provider.

interface ProviderTokens {
  readonly clientId: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiry: number
  readonly account: string
}

/** The live UploadJob-ledger store: the durable `local:cloudUploadJobs` wxt item. */
const defaultLedgerStore = (): LedgerStore => {
  const item = storage.defineItem<unknown>('local:cloudUploadJobs', { fallback: null })
  return { get: () => item.getValue(), set: (value) => item.setValue(value) }
}

/** The live cloud runtime (ADR-0017): one ManagedRuntime per SW life wiring FetchService
 *  (binds fetch once), SourceFetch (the SSRF-guarded twimg fetch), and a Ref FolderCache
 *  (handle → subfolder id) that persists across uploads. `provideMerge` keeps FetchService
 *  in the runtime's context so the Convex/OAuth ports (which read FetchService) run on it. */
const defaultRuntimePort = (fetchImpl: typeof fetch): CloudRuntimePort => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(DriveUploaderLive, DropboxUploaderLive).pipe(
      Layer.provideMerge(makeCloudServicesLive(fetchImpl)),
    ),
  )
  return {
    uploadDrive: (args, input) =>
      runtime.runPromise(Effect.flatMap(DriveUploader, (u) => u.upload(args, input))),
    uploadDropbox: (accessToken, input) =>
      runtime.runPromise(Effect.flatMap(DropboxUploader, (u) => u.upload({ accessToken }, input))),
    resolveDriveRoot: (accessToken) =>
      runtime.runPromise(Effect.flatMap(DriveUploader, (u) => u.ensureRoot(accessToken))),
    exchangeCode: (input) => runtime.runPromise(exchangeCode(input)),
    refreshAccessToken: (input) => runtime.runPromise(refreshAccessToken(input)),
    mirror: ({ deploymentUrl, jobs, secret }) => {
      const port = makeConvexHttpPort({ deploymentUrl })
      return runtime.runPromise(port.mutation('uploads:recordUploadJobs', { jobs, secret }))
    },
  }
}

/** The live backoff wake-up alarm (`browser.alarms`). */
const defaultAlarmPort = (): AlarmPort => ({
  create: async (name, when) => {
    await browser.alarms.create(name, { when })
  },
  clear: async (name) => {
    await browser.alarms.clear(name)
  },
})

/** The live dead-upload toolbar badge (`browser.action`). */
const defaultBadgePort = (): BadgePort => ({
  set: async (text) => {
    await browser.action.setBadgeText({ text })
  },
  setColor: async (color) => {
    await browser.action.setBadgeBackgroundColor({ color })
  },
})

/** The live interactive OAuth flow (`browser.identity`). */
const defaultAuthFlowPort = (): AuthFlowPort => ({
  getRedirectUrl: () => browser.identity.getRedirectURL(),
  launchFlow: (url) => browser.identity.launchWebAuthFlow({ url, interactive: true }),
})

// The cloud destination MIRRORS the local plan: the folder is the directory of the
// rendered filename (e.g. `twitter` from `twitter/123_0.jpg`), so a media item lands
// in the SAME platform folder locally and in the cloud — no per-handle subfolder.
// renderFilename already sanitized every segment, so there's nothing to re-clean.
// Narrowed to the structural subset it reads so both the live queue (MediaItem) and
// the backfill (a history record) share one constructor.
const cloudTargetFor = (m: { readonly ext: string }, filename: string): UploadTarget => {
  const slash = filename.lastIndexOf('/')
  return {
    path: filename,
    folder: slash >= 0 ? filename.slice(0, slash) : '',
    filename: slash >= 0 ? filename.slice(slash + 1) : filename,
    contentType: guessMime(m.ext),
  }
}

const providerTokens = (s: Settings, p: CloudProviderId): ProviderTokens => {
  const f = PROVIDERS[p].fields
  return {
    clientId: s[f.clientId] as string,
    accessToken: s[f.accessToken] as string,
    refreshToken: s[f.refreshToken] as string,
    expiry: s[f.expiry] as number,
    account: s[f.account] as string,
  }
}

export const makeCloudUpload = (deps: CloudUploadDeps): CloudUpload => {
  const { getSettings, fetchImpl } = deps
  // Resolve each side-effect seam to its live binding unless a test injected one.
  // Internal names avoid colliding with the `ledger`/`now` locals in the drain loop.
  const nowFn = deps.now ?? (() => Date.now())
  const writeSettingsImpl = deps.setSettings ?? setSettings
  const store = deps.ledger ?? defaultLedgerStore()
  const rt = deps.runtime ?? defaultRuntimePort(fetchImpl)
  const alarms = deps.alarms ?? defaultAlarmPort()
  const badge = deps.badge ?? defaultBadgePort()
  const authFlow = deps.authFlow ?? defaultAuthFlowPort()
  const maxDrainPerPass = deps.maxDrainPerPass ?? MAX_DRAIN_JOBS_PER_PASS

  // Durable local UploadJob ledger (the source of truth) — drained FIFO through a
  // serialized chain like the metadata outbox. Bytes go extension → provider
  // (Drive/Dropbox) directly; nothing here transits Convex.
  const uploadQueue = makeSerialQueue(deps.queueError('upload'))
  const storeQueue = makeSerialQueue(deps.queueError('uploadStore'))
  const readLedger = (): Promise<JobLedger> =>
    storeQueue.run(async () => decodeLedger(await store.get()))
  const updateLedger = (update: (ledger: JobLedger) => JobLedger | Promise<JobLedger>) =>
    runSerializedRmw(storeQueue, store, decodeLedger, update)
  // Last non-skip failure, for the popup's status line (diagnostic; resets on recycle).
  let lastUploadError: string | null = null

  const isProviderConnected = (s: Settings, p: CloudProviderId): boolean => {
    const t = providerTokens(s, p)
    return t.clientId !== '' && t.refreshToken !== ''
  }
  const connectedProviders = (s: Settings): CloudProviderId[] =>
    ALL_PROVIDERS.filter((p) => isProviderConnected(s, p))

  // Serialize ALL SW-side cloud settings writes (token refresh / connect /
  // disconnect / folder-id) on one chain so they can't lost-update each other's
  // fields during a concurrent drain (the popup no longer writes token/clientId
  // fields — those flow through messages — so this closes the SW-side races).
  const settingsQueue = makeSerialQueue(deps.queueError('cloudSettings'))
  const writeCloudSettings = (patch: Partial<Settings>): Promise<Settings> =>
    settingsQueue.run(() => writeSettingsImpl(patch))

  const persistAccessToken = (
    p: CloudProviderId,
    accessToken: string,
    expiresAt: number,
  ): Promise<Settings> => {
    const f = PROVIDERS[p].fields
    return writeCloudSettings({ [f.accessToken]: accessToken, [f.expiry]: expiresAt })
  }

  /** A fresh access token for the provider; refresh + persist if near expiry. */
  const ensureAccessToken = async (
    s: Settings,
    p: CloudProviderId,
    nowMs: number,
  ): Promise<string> => {
    const t = providerTokens(s, p)
    if (t.accessToken !== '' && !isTokenExpired(t.expiry, nowMs)) return t.accessToken
    const refreshed = await rt.refreshAccessToken({
      cfg: PROVIDERS[p].oauth,
      clientId: t.clientId,
      refreshToken: t.refreshToken,
      now: nowMs,
    })
    await persistAccessToken(p, refreshed.accessToken, refreshed.expiresAt)
    return refreshed.accessToken
  }

  /** Enqueue one UploadJob per (media item × connected provider) at queue time, in
   *  parallel with the local download. Gated, idempotent, fire-and-forget. */
  const recordCloudUploads = (settings: Settings, items: ReadonlyArray<UploadCandidate>): void => {
    if (!settings.cloudUploadEnabled || items.length === 0) return
    const providers = connectedProviders(settings)
    if (providers.length === 0) return
    const now = nowFn()
    uploadQueue.push(async () => {
      await updateLedger((current) => {
        let next = current
        for (const { item, filename } of items) {
          const target = cloudTargetFor(item, filename)
          for (const p of providers) {
            next = enqueue(next, { mediaId: item.id, provider: p, url: item.url, target }, now)
          }
        }
        return next
      })
      await drainUploadJobs()
    })
  }

  /** Dispatch one job to its provider uploader on the cloud runtime. Drive resolves
   *  (and persists) its app root folder once; Dropbox needs only the access token. */
  const dispatchToProvider = async (
    job: UploadJob,
    accessToken: string,
    settings: Settings,
  ): Promise<UploadOutcome> => {
    const input: UploadInput = { url: job.url, target: job.target }
    if (job.provider === 'gdrive') {
      let rootId = settings.gdriveFolderId
      if (rootId === '') {
        rootId = await rt.resolveDriveRoot(accessToken)
        await writeCloudSettings({ gdriveFolderId: rootId })
      }
      return rt.uploadDrive({ accessToken, rootFolderId: rootId }, input)
    }
    return rt.uploadDropbox(accessToken, input)
  }

  /** Best-effort mirror of a job's state to the Convex control plane (ADR-0013).
   *  Gated on Cloud Sync config; the local ledger remains authoritative. */
  const mirrorUploadJob = async (settings: Settings, job: UploadJob): Promise<void> => {
    if (!isSyncConfigured(settings) || settings.cloudDeviceId === '') return
    try {
      await rt.mirror({
        deploymentUrl: settings.convexUrl,
        jobs: [toWireUploadJob(job, settings.cloudDeviceId, nowFn())],
        secret: settings.convexSyncSecret,
      })
    } catch {
      /* control-plane mirror is best-effort; the local ledger is the source of truth */
    }
  }

  /** Arm a durable wake-up at the soonest backoff deadline so failed jobs retry
   *  autonomously even after the SW suspends (setTimeout would not survive). */
  const scheduleUploadWake = async (): Promise<void> => {
    const ledger = await readLedger()
    const now = nowFn()
    const due = ledger
      .filter((j) => !isTerminal(j) && j.attempts < MAX_ATTEMPTS)
      .map((j) => j.nextAttemptAt)
      .filter((t) => t > now)
    if (due.length > 0) await alarms.create(UPLOAD_ALARM, Math.min(...due))
    else await alarms.clear(UPLOAD_ALARM)
  }

  /** Drain ready upload jobs FIFO: claim (persist the lease) → upload → record the
   *  outcome → persist (capped) → mirror. Each job has independent backoff, so one
   *  failure never stops the others. On guard exhaustion it re-kicks itself; on a
   *  natural drain it arms a backoff alarm so retries fire without a new download. */
  const drainUploadJobs = async (): Promise<void> => {
    let settings = await getSettings()
    if (!settings.cloudUploadEnabled) return
    let ranOut = false
    // oxlint-disable no-await-in-loop -- FIFO: each job is processed sequentially
    for (let guard = 0; guard < maxDrainPerPass; guard += 1) {
      const now = nowFn()
      const ledger = await readLedger()
      const job = readyJobs(ledger, now)[0]
      if (job === undefined) {
        ranOut = true
        break
      }

      // Provider disconnected mid-flight: fail the job so it backs off → dies,
      // rather than spinning forever as perpetually-ready.
      if (!isProviderConnected(settings, job.provider)) {
        await updateLedger((current) => {
          const c = claim(current, job.jobId, now)
          const failed = c.claimed
            ? recordFailure(c.ledger, job.jobId, c.token!, now, `${job.provider} disconnected`)
                .ledger
            : c.ledger
          return capLedger(failed)
        })
        lastUploadError = `${PROVIDERS[job.provider].label} is not connected.`
        continue
      }

      let claimed = false
      let token: number | undefined
      await updateLedger((current) => {
        const c = claim(current, job.jobId, now)
        claimed = c.claimed
        token = c.token
        return capLedger(c.ledger)
      })
      if (!claimed || token === undefined) continue

      let outcome: UploadOutcome
      try {
        const accessToken = await ensureAccessToken(settings, job.provider, now)
        settings = await getSettings() // re-read after a possible token write
        outcome = await dispatchToProvider(job, accessToken, settings)
      } catch (err) {
        outcome = { kind: 'failure', reason: err instanceof Error ? err.message : String(err) }
      }

      const tnow = nowFn()
      const next = await updateLedger((current) => {
        let settled: JobLedger
        if (outcome.kind === 'success') {
          settled = recordSuccess(current, job.jobId, token!, tnow, {
            bytes: outcome.bytes,
            ...(outcome.remoteId !== undefined ? { remoteId: outcome.remoteId } : {}),
          }).ledger
        } else if (outcome.kind === 'sourceGone') {
          settled = recordSourceGone(current, job.jobId, token!, outcome.reason).ledger
        } else {
          settled = recordFailure(current, job.jobId, token!, tnow, outcome.reason).ledger
          lastUploadError = classifyUploadError(outcome.reason, outcome.status)
        }
        return capLedger(settled)
      })
      const settled = next.find((j) => j.jobId === job.jobId)
      if (settled !== undefined) await mirrorUploadJob(settings, settled)
    }
    // oxlint-enable no-await-in-loop

    if (!ranOut) {
      // Guard hit with work likely remaining — continue on a fresh serialized task.
      void uploadQueue.push(() => drainUploadJobs())
      return
    }
    // Nothing ready now: arm a wake-up for the soonest backoff deadline (if any),
    // and reflect any permanently-failed uploads on the toolbar badge.
    await scheduleUploadWake()
    await refreshUploadBadge()
  }

  /** Run the PKCE OAuth flow for a provider in the SW (survives the popup closing),
   *  then persist the tokens. Returns a popup-facing result. */
  const runOAuthConnect = async (
    provider: CloudProviderId,
    clientIdArg: string,
  ): Promise<{ ok: boolean; detail: string; account?: string }> => {
    const settings = await getSettings()
    // The popup sends the typed client ID with the request (it never writes the
    // settings blob itself — single-writer, ADR-0005); fall back to a stored one.
    const clientId = clientIdArg !== '' ? clientIdArg : providerTokens(settings, provider).clientId
    if (clientId === '')
      return { ok: false, detail: `Enter the ${PROVIDERS[provider].label} client ID first.` }
    try {
      const cfg = PROVIDERS[provider].oauth
      const redirectUri = authFlow.getRedirectUrl()
      const verifier = generateCodeVerifier()
      const challenge = await computeCodeChallenge(verifier)
      const state = randomState()
      const authUrl = buildAuthUrl(cfg, { clientId, redirectUri, codeChallenge: challenge, state })
      const redirect = await authFlow.launchFlow(authUrl)
      if (redirect === undefined || redirect === '')
        return { ok: false, detail: 'Authorization was cancelled.' }
      const { code } = parseAuthRedirect(redirect, state)
      const tokens = await rt.exchangeCode({
        cfg,
        clientId,
        code,
        codeVerifier: verifier,
        redirectUri,
        now: nowFn(),
      })
      const f = PROVIDERS[provider].fields
      await writeCloudSettings({
        [f.clientId]: clientId,
        [f.accessToken]: tokens.accessToken,
        [f.refreshToken]: tokens.refreshToken,
        [f.expiry]: tokens.expiresAt,
        [f.account]: tokens.account ?? '',
      })
      return {
        ok: true,
        detail: `Connected ${PROVIDERS[provider].label}.`,
        ...(tokens.account !== undefined ? { account: tokens.account } : {}),
      }
    } catch (err) {
      return {
        ok: false,
        detail: classifyUploadError(err instanceof Error ? err.message : String(err)),
      }
    }
  }

  const disconnectProvider = async (provider: CloudProviderId): Promise<{ ok: boolean }> => {
    // Best-effort revoke the grant at the provider BEFORE clearing local tokens, so
    // disconnect actually withdraws access (not just a local wipe). Never blocks.
    const t = providerTokens(await getSettings(), provider)
    await revokeViaRecipe(
      PROVIDERS[provider].revoke,
      { accessToken: t.accessToken, refreshToken: t.refreshToken },
      fetchImpl,
    )
    const f = PROVIDERS[provider].fields
    // gdrive-ONLY: clearing folderId forces a fresh root-folder resolution on the
    // next connect. Dropbox has no such field, so `f.folderId` is undefined for it
    // and the spread contributes nothing — Dropbox must NOT clear folderId.
    await writeCloudSettings({
      [f.accessToken]: '',
      [f.refreshToken]: '',
      [f.expiry]: 0,
      [f.account]: '',
      ...('folderId' in f ? { [f.folderId]: '' } : {}),
    })
    return { ok: true }
  }

  const cloudUploadStatus = async (): Promise<CloudUploadStatus> => {
    const ledger = await readLedger()
    return { summary: summarize(ledger), lastError: lastUploadError }
  }

  const retryDeadUploads = async (): Promise<{ ok: boolean }> => {
    uploadQueue.push(async () => {
      const now = nowFn()
      await updateLedger((current) => {
        let next = current
        for (const j of next) {
          if (j.status === 'dead' || j.status === 'failed')
            next = retryUploadJob(next, j.jobId, now).ledger
        }
        return next
      })
      await drainUploadJobs()
    })
    return { ok: true }
  }

  /** Reflect permanently-failed (dead) uploads on the toolbar badge so the user
   *  notices without opening the popup — restrained, no notifications permission. */
  const refreshUploadBadge = async (): Promise<void> => {
    const dead = (await readLedger()).reduce((n, j) => (j.status === 'dead' ? n + 1 : n), 0)
    try {
      await badge.set(dead > 0 ? String(dead) : '')
      if (dead > 0) await badge.setColor('#dc2626')
    } catch {
      /* the action API may be unavailable in some contexts */
    }
  }

  /** Enqueue cloud uploads for already-downloaded media, from the durable history
   *  store — the "sync my existing library" path. Reports the count immediately;
   *  the drain runs in the background so the popup gets a fast reply. */
  const backfillCloudUploads = async (): Promise<{
    ok: boolean
    queued: number
    detail: string
  }> => {
    const settings = await getSettings()
    if (!settings.cloudUploadEnabled)
      return { ok: false, queued: 0, detail: 'Turn on Cloud upload first.' }
    const providers = connectedProviders(settings)
    if (providers.length === 0)
      return { ok: false, queued: 0, detail: 'Connect Google Drive or Dropbox first.' }
    const records = (await deps.getBackfillRecords()).filter((r) => r.media.url !== '')
    if (records.length === 0)
      return {
        ok: false,
        queued: 0,
        detail: 'No past downloads on record — turn on Download history to capture them.',
      }
    // Enqueue on the serial chain and await just that step; the queue already
    // orders the work, so no hand-rolled Promise is needed. `.catch(() => 0)`
    // preserves never-reject behavior (an enqueue failure is surfaced via the
    // queue's onError observer), so the reply still lands.
    const queued = await uploadQueue
      .run(async () => {
        const now = nowFn()
        let added = 0
        await updateLedger((current) => {
          let next = current
          const before = current.length
          for (const r of records) {
            const target = cloudTargetFor(r.media, r.filename)
            for (const p of providers) {
              next = enqueue(
                next,
                { mediaId: r.requestId, provider: p, url: r.media.url, target },
                now,
              )
            }
          }
          added = next.length - before
          return next
        })
        return added
      })
      .catch(() => 0)
    uploadQueue.push(() => drainUploadJobs()) // drain in the background; don't block the reply
    return {
      ok: true,
      queued,
      detail:
        queued > 0
          ? `Queued ${queued} upload${queued === 1 ? '' : 's'} from past downloads.`
          : 'Past downloads are already uploaded or queued.',
    }
  }

  const resumeOnBoot = (): void => {
    uploadQueue.push(async () => {
      await updateLedger((ledger) => capLedger(ledger))
      await drainUploadJobs()
    })
  }

  const clearUploadBadge = (): void => {
    void badge.set('').catch(() => {})
  }

  return {
    uploadQueue,
    drainUploadJobs,
    recordCloudUploads,
    runOAuthConnect,
    disconnectProvider,
    cloudUploadStatus,
    retryDeadUploads,
    backfillCloudUploads,
    resumeOnBoot,
    clearUploadBadge,
    uploadAlarm: UPLOAD_ALARM,
  }
}
