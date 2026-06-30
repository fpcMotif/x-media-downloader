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
import { sanitizeSegment } from '../core/download/filename'
import { PROVIDERS, revokeViaRecipe } from '../core/cloud/provider'
import { classifyUploadError, type CloudUploadStatus } from '../core/cloud/status'
import { makeSerialQueue, type SerialQueue } from '../core/serial-queue'
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
  /** The fetch the provider/Convex ports use (bound for the MV3 SW; see fetch.ts). */
  readonly fetchImpl: typeof fetch
  /** Past downloads eligible for backfill (from the durable history store). */
  readonly getBackfillRecords: () => Promise<ReadonlyArray<BackfillRecord>>
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

// Narrowed to the structural subset it reads so both the live queue (MediaItem)
// and the backfill (a history record's SyncMediaMeta) share one constructor.
const cloudTargetFor = (
  m: { readonly handle: string; readonly ext: string },
  filename: string,
): UploadTarget => ({
  path: filename,
  // Sanitize the raw scraped handle (the local path goes through the same
  // sanitizer) before it becomes a Drive folder name / Dropbox path segment.
  handle: sanitizeSegment(m.handle) || 'unknown',
  filename: filename.split('/').pop() ?? filename,
  contentType: guessMime(m.ext),
})

const clearUploadBadge = (): void => {
  void browser.action.setBadgeText({ text: '' }).catch(() => {})
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

  // Durable local UploadJob ledger (the source of truth) — drained FIFO through a
  // serialized chain like the metadata outbox. Bytes go extension → provider
  // (Drive/Dropbox) directly; nothing here transits Convex.
  const uploadJobsItem = storage.defineItem<unknown>('local:cloudUploadJobs', { fallback: null })
  const uploadQueue = makeSerialQueue(deps.queueError('upload'))
  // The cloud byte path runs on one runtime built per SW life (ADR-0017): FetchService
  // (binds fetch once), SourceFetch (the SSRF-guarded twimg fetch), and a Ref FolderCache
  // (handle → subfolder id) that persists across uploads. An SW recycle rebuilds the
  // runtime = a fresh cache, matching the prior in-memory Map.
  // `provideMerge` wires the services into the uploaders AND keeps FetchService in
  // the runtime's context, so the Convex/OAuth ports (which read FetchService) run
  // on this same runtime.
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(DriveUploaderLive, DropboxUploaderLive).pipe(
      Layer.provideMerge(makeCloudServicesLive(fetchImpl)),
    ),
  )
  const uploadDrive = (args: DriveArgs, input: UploadInput): Promise<UploadOutcome> =>
    runtime.runPromise(Effect.flatMap(DriveUploader, (u) => u.upload(args, input)))
  const uploadDropbox = (accessToken: string, input: UploadInput): Promise<UploadOutcome> =>
    runtime.runPromise(Effect.flatMap(DropboxUploader, (u) => u.upload({ accessToken }, input)))
  const resolveDriveRoot = (accessToken: string): Promise<string> =>
    runtime.runPromise(Effect.flatMap(DriveUploader, (u) => u.ensureRoot(accessToken)))
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
    settingsQueue.run(() => setSettings(patch))

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
    now: number,
  ): Promise<string> => {
    const t = providerTokens(s, p)
    if (t.accessToken !== '' && !isTokenExpired(t.expiry, now)) return t.accessToken
    const refreshed = await runtime.runPromise(
      refreshAccessToken({
        cfg: PROVIDERS[p].oauth,
        clientId: t.clientId,
        refreshToken: t.refreshToken,
        now,
      }),
    )
    await persistAccessToken(p, refreshed.accessToken, refreshed.expiresAt)
    return refreshed.accessToken
  }

  /** Enqueue one UploadJob per (media item × connected provider) at queue time, in
   *  parallel with the local download. Gated, idempotent, fire-and-forget. */
  const recordCloudUploads = (settings: Settings, items: ReadonlyArray<UploadCandidate>): void => {
    if (!settings.cloudUploadEnabled || items.length === 0) return
    const providers = connectedProviders(settings)
    if (providers.length === 0) return
    const now = Date.now()
    uploadQueue.push(async () => {
      let ledger = decodeLedger(await uploadJobsItem.getValue())
      for (const { item, filename } of items) {
        const target = cloudTargetFor(item, filename)
        for (const p of providers) {
          ledger = enqueue(ledger, { mediaId: item.id, provider: p, url: item.url, target }, now)
        }
      }
      await uploadJobsItem.setValue(ledger)
      await drainUploadJobs()
    })
  }

  /** Dispatch one job to its provider uploader on the cloud runtime. Drive resolves
   *  (and persists) its app root folder once; Dropbox needs only the access token. */
  const runUpload = async (
    job: UploadJob,
    accessToken: string,
    settings: Settings,
  ): Promise<UploadOutcome> => {
    const input: UploadInput = { url: job.url, target: job.target }
    if (job.provider === 'gdrive') {
      let rootId = settings.gdriveFolderId
      if (rootId === '') {
        rootId = await resolveDriveRoot(accessToken)
        await writeCloudSettings({ gdriveFolderId: rootId })
      }
      return uploadDrive({ accessToken, rootFolderId: rootId }, input)
    }
    return uploadDropbox(accessToken, input)
  }

  /** Best-effort mirror of a job's state to the Convex control plane (ADR-0013).
   *  Gated on Cloud Sync config; the local ledger remains authoritative. */
  const mirrorUploadJob = async (settings: Settings, job: UploadJob): Promise<void> => {
    if (!isSyncConfigured(settings) || settings.cloudDeviceId === '') return
    try {
      const port = makeConvexHttpPort({ deploymentUrl: settings.convexUrl })
      await runtime.runPromise(
        port.mutation('uploads:recordUploadJobs', {
          jobs: [toWireUploadJob(job, settings.cloudDeviceId, Date.now())],
          secret: settings.convexSyncSecret,
        }),
      )
    } catch {
      /* control-plane mirror is best-effort; the local ledger is the source of truth */
    }
  }

  /** Arm a durable wake-up at the soonest backoff deadline so failed jobs retry
   *  autonomously even after the SW suspends (setTimeout would not survive). */
  const scheduleUploadWake = async (): Promise<void> => {
    const ledger = decodeLedger(await uploadJobsItem.getValue())
    const now = Date.now()
    const due = ledger
      .filter((j) => !isTerminal(j) && j.attempts < MAX_ATTEMPTS)
      .map((j) => j.nextAttemptAt)
      .filter((t) => t > now)
    if (due.length > 0) await browser.alarms.create(UPLOAD_ALARM, { when: Math.min(...due) })
    else await browser.alarms.clear(UPLOAD_ALARM)
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
    for (let guard = 0; guard < MAX_DRAIN_JOBS_PER_PASS; guard += 1) {
      const now = Date.now()
      const ledger = decodeLedger(await uploadJobsItem.getValue())
      const job = readyJobs(ledger, now)[0]
      if (job === undefined) {
        ranOut = true
        break
      }

      // Provider disconnected mid-flight: fail the job so it backs off → dies,
      // rather than spinning forever as perpetually-ready.
      if (!isProviderConnected(settings, job.provider)) {
        const c = claim(ledger, job.jobId, now)
        const failed = c.claimed
          ? recordFailure(c.ledger, job.jobId, c.token!, now, `${job.provider} disconnected`).ledger
          : c.ledger
        await uploadJobsItem.setValue(capLedger(failed))
        lastUploadError = `${PROVIDERS[job.provider].label} is not connected.`
        continue
      }

      const c = claim(ledger, job.jobId, now)
      if (!c.claimed) {
        await uploadJobsItem.setValue(capLedger(c.ledger)) // 'exhausted' → dead persisted
        continue
      }
      await uploadJobsItem.setValue(c.ledger) // persist 'uploading' + lease BEFORE the slow upload
      const token = c.token!

      let outcome: UploadOutcome
      try {
        const accessToken = await ensureAccessToken(settings, job.provider, now)
        settings = await getSettings() // re-read after a possible token write
        outcome = await runUpload(job, accessToken, settings)
      } catch (err) {
        outcome = { kind: 'failure', reason: err instanceof Error ? err.message : String(err) }
      }

      const after = decodeLedger(await uploadJobsItem.getValue())
      const tnow = Date.now()
      let next: JobLedger
      if (outcome.kind === 'success') {
        next = recordSuccess(after, job.jobId, token, tnow, {
          bytes: outcome.bytes,
          ...(outcome.remoteId !== undefined ? { remoteId: outcome.remoteId } : {}),
        }).ledger
      } else if (outcome.kind === 'sourceGone') {
        next = recordSourceGone(after, job.jobId, token, outcome.reason).ledger
      } else {
        next = recordFailure(after, job.jobId, token, tnow, outcome.reason).ledger
        lastUploadError = classifyUploadError(outcome.reason, outcome.status)
      }
      const settled = next.find((j) => j.jobId === job.jobId)
      await uploadJobsItem.setValue(capLedger(next))
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
      const redirectUri = browser.identity.getRedirectURL()
      const verifier = generateCodeVerifier()
      const challenge = await computeCodeChallenge(verifier)
      const state = randomState()
      const authUrl = buildAuthUrl(cfg, { clientId, redirectUri, codeChallenge: challenge, state })
      const redirect = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true })
      if (redirect === undefined || redirect === '')
        return { ok: false, detail: 'Authorization was cancelled.' }
      const { code } = parseAuthRedirect(redirect, state)
      const tokens = await runtime.runPromise(
        exchangeCode({
          cfg,
          clientId,
          code,
          codeVerifier: verifier,
          redirectUri,
          now: Date.now(),
        }),
      )
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
    const ledger = decodeLedger(await uploadJobsItem.getValue())
    return { summary: summarize(ledger), lastError: lastUploadError }
  }

  const retryDeadUploads = async (): Promise<{ ok: boolean }> => {
    uploadQueue.push(async () => {
      let ledger = decodeLedger(await uploadJobsItem.getValue())
      const now = Date.now()
      for (const j of ledger) {
        if (j.status === 'dead' || j.status === 'failed')
          ledger = retryUploadJob(ledger, j.jobId, now).ledger
      }
      await uploadJobsItem.setValue(ledger)
      await drainUploadJobs()
    })
    return { ok: true }
  }

  /** Reflect permanently-failed (dead) uploads on the toolbar badge so the user
   *  notices without opening the popup — restrained, no notifications permission. */
  const refreshUploadBadge = async (): Promise<void> => {
    const dead = decodeLedger(await uploadJobsItem.getValue()).reduce(
      (n, j) => (j.status === 'dead' ? n + 1 : n),
      0,
    )
    try {
      await browser.action.setBadgeText({ text: dead > 0 ? String(dead) : '' })
      if (dead > 0) await browser.action.setBadgeBackgroundColor({ color: '#dc2626' })
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
        let ledger = decodeLedger(await uploadJobsItem.getValue())
        const before = ledger.length
        const now = Date.now()
        for (const r of records) {
          const target = cloudTargetFor(r.media, r.filename)
          for (const p of providers) {
            ledger = enqueue(
              ledger,
              { mediaId: r.requestId, provider: p, url: r.media.url, target },
              now,
            )
          }
        }
        await uploadJobsItem.setValue(ledger)
        return ledger.length - before
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
      await uploadJobsItem.setValue(capLedger(decodeLedger(await uploadJobsItem.getValue())))
      await drainUploadJobs()
    })
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
