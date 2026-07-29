import { storage } from 'wxt/utils/storage'
import { CLOUD_PROVIDERS, type Settings } from '../core/schema'
import type { SettingsOwnershipSnapshot } from '../core/settings'
import { Effect, Layer, ManagedRuntime } from 'effect'
import { makeConvexHttpPort } from '../core/sync/convex'
import { makeCloudServicesLive } from '../core/cloud/cloud-services'
import { DriveUploader, DriveUploaderLive } from '../core/cloud/drive'
import { DropboxUploader, DropboxUploaderLive } from '../core/cloud/dropbox'
import {
  guessMime,
  type CloudProviderId,
  type RemoteAttempt,
  type UploadOutcome,
  type UploadTarget,
} from '../core/cloud/types'
import { exchangeCode, refreshAccessToken } from '../core/cloud/oauth'
import {
  bindRemoteAttempt,
  capLedger,
  claim,
  decodeLedgerStateResult,
  enqueueBounded,
  isTerminal,
  legacyConflict,
  quarantineConflict,
  rebaseUploadDeadlines,
  MAX_ATTEMPTS,
  MAX_UPLOAD_JOBS,
  readyJobs,
  recordFailure,
  recordRemoteProgress,
  recordSourceGone,
  recordSuccess,
  retry as retryUploadJob,
  summarize,
  type JobLedger,
  type UploadLedgerState,
} from '../core/cloud/upload-job'
import {
  beginProviderOwnershipTransition,
  discardProviderOwnership,
  ownershipTransitionFor,
  reconcileProviderOwnership,
  type ProviderOwnershipTransition,
} from '../core/cloud/provider-ownership-transition'
import { PROVIDERS } from '../core/cloud/provider'
import { classifyUploadError, type CloudUploadStatus } from '../core/cloud/status'
import { makeSerialQueue, type SerialQueue } from '../core/serial-queue'
import {
  makeCloudProviderSession,
  providerCredentialsFor,
  providerCredentialsPatch,
  providerOwnerKey,
  sameProviderCredentials,
  type AuthFlowPort,
  type ConnectOwnershipCommit,
  type DisconnectOwnershipCommit,
  type ProviderCredentialSnapshot,
  type ProviderRuntime,
} from './cloud-provider-session'
import type { SettingsWriter } from './settings-writer'
import { DURABLE_SIDE_EFFECT_WATCHDOG_MS } from './durable-wake'
import { makeUploadJobMirror, type UploadJobMirrorTransport } from './upload-job-mirror'
import { boundedDiagnosticText } from '../core/diagnostic-text'
import { cloudDeadline } from '../core/cloud/time'

/** A media item + its on-disk filename — the unit recordCloudUploads enqueues. */
export interface CloudUploadIntent {
  /** Canonical global identity. */
  readonly requestId: string
  /** Raw pre-v2 identities for collision checks against quarantined rows. */
  readonly legacyAliases: ReadonlyArray<string>
  readonly source: {
    readonly url: string
    readonly ext: string
  }
  readonly filename: string
}

/** A past download (from history) eligible for backfill. */
export interface BackfillRecord {
  readonly requestId: string
  readonly filename: string
  readonly media: {
    readonly url: string
    readonly handle: string
    readonly ext: string
  }
}

/** Durable UploadJob-ledger storage seam — the wxt `local:cloudUploadJobs` item in
 *  the SW, an in-memory box in tests. Strict decode validates its opaque payload. */
export interface LedgerStore {
  get(): Promise<unknown>
  set(value: unknown): Promise<void>
}

/** Everything that executes on the ONE per-SW-life cloud runtime (ADR-0017): the
 *  provider byte uploaders, Drive's root-folder resolve, the OAuth token grants, and
 *  the best-effort Convex mirror. Folding them behind one port keeps the single
 *  shared ManagedRuntime invariant (FetchService/SourceFetch/FolderCache) — and lets
 *  a test substitute a plain-async fake with no Effect/Layer ceremony. */
export interface CloudRuntimePort extends ProviderRuntime, UploadJobMirrorTransport {
  /** Provider I/O and control-plane transport share one SW-lifetime runtime. */
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
export type { AuthFlowPort } from './cloud-provider-session'

export interface CloudUpload {
  /** The serialized upload chain — boot resume + alarm wake push onto it. */
  readonly uploadQueue: SerialQueue
  /** Drain ready upload jobs FIFO (claim → upload → record → mirror). */
  readonly drainUploadJobs: () => Promise<void>
  /** Commit one UploadJob per (media item × connected provider) before the local
   * launch. A failed commit is contained: the caller may still save locally. */
  readonly recordCloudUploads: (items: ReadonlyArray<CloudUploadIntent>) => Promise<CloudAdmission>
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
  readonly backfillCloudUploads: () => Promise<{
    ok: boolean
    queued: number
    detail: string
  }>
  /** Recover ownership intent, compact, then resume or pause before boot opens. */
  readonly resumeOnBoot: () => Promise<void>
  /** Resume durable retries after Cloud upload is turned back on. */
  readonly resumeWhenEnabled: () => void
  /** Stop retry wakes while Cloud upload is off. Durable jobs stay intact. */
  readonly pauseWhenDisabled: () => Promise<void>
  /** The durable wake-up alarm name (the entrypoint registers the onAlarm listener). */
  readonly uploadAlarm: string
}

/** A durable cloud-admission decision. `unavailable` means the local save may
 * proceed, but this request has no cloud replay record. */
export type CloudAdmission =
  | { readonly tag: 'not-requested' }
  | { readonly tag: 'committed' }
  | { readonly tag: 'unavailable'; readonly reason: string }

export interface CloudUploadDeps {
  /** Build the queue's error observer (traces through the background's chain). */
  readonly queueError: (label: string) => (err: unknown) => void
  /** Read the current settings blob. */
  readonly getSettings: () => Promise<Settings>
  /** Recovery-required projections cannot authorize ownership cleanup. */
  readonly getSettingsOwnership: () => Promise<SettingsOwnershipSnapshot>
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
  /** The background's sole Settings mutation seam. */
  readonly settingsWriter: SettingsWriter
  /** The clock (default: `Date.now`). Injected so backoff/expiry assertions are deterministic. */
  readonly now?: () => number
  /** Jobs drained per pass before yielding to a fresh serialized task (default
   *  {@link MAX_DRAIN_JOBS_PER_PASS}). Injected only so the re-kick is testable without
   *  seeding a thousand jobs. */
  readonly maxDrainPerPass?: number
  /** Production uses {@link MAX_UPLOAD_JOBS}; tests lower it to exercise admission. */
  readonly maxUploadJobs?: number
}

const UPLOAD_ALARM = 'cloud-upload-drain'

// Safety cap on jobs drained in a single pass before yielding to a fresh
// serialized task (the `if (!ranOut)` re-kick below) — bounds one drain so a
// large ledger can't monopolize the SW.
const MAX_DRAIN_JOBS_PER_PASS = 1000
const CORRUPT_LEDGER_ERROR =
  'Cloud upload data is corrupt. Uploads are paused to preserve it; local downloads still work.'

/** The live UploadJob-ledger store: the durable `local:cloudUploadJobs` wxt item. */
const defaultLedgerStore = (): LedgerStore => {
  const item = storage.defineItem<unknown>('local:cloudUploadJobs', {
    fallback: null,
  })
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
    prepareBlobAttempt: ({ provider, jobId, ownerKey, accessToken }) =>
      provider === 'gdrive'
        ? runtime
            .runPromise(Effect.flatMap(DriveUploader, (u) => u.generateFileId(accessToken)))
            .then((fileId) => ({ kind: 'gdrive' as const, ownerKey, fileId }))
        : runtime.runPromise(
            Effect.flatMap(DropboxUploader, (u) =>
              Effect.promise(() => u.prepare(jobId, ownerKey)),
            ),
          ),
    advanceBlobAttempt: ({ provider, accessToken, rootFolderId, upload, attempt }) => {
      if (provider === 'gdrive') {
        if (attempt.kind !== 'gdrive' || rootFolderId === undefined)
          return Promise.resolve({
            kind: 'failure' as const,
            reason: 'Google Drive upload attempt is invalid.',
          })
        return runtime.runPromise(
          Effect.flatMap(DriveUploader, (u) =>
            u.advance({ accessToken, rootFolderId }, upload, attempt.fileId),
          ),
        )
      }
      return runtime.runPromise(
        Effect.flatMap(DropboxUploader, (u) => u.advance({ accessToken }, upload, attempt)),
      )
    },
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

const disconnectedCredentials = (
  before: ProviderCredentialSnapshot,
): ProviderCredentialSnapshot => ({
  ...before,
  accessToken: '',
  refreshToken: '',
  expiry: 0,
  account: '',
  ...(before.folderId === undefined ? {} : { folderId: '' }),
})

const ownershipRecoveryError = (provider: CloudProviderId): string =>
  `${PROVIDERS[provider].label} connection needs recovery. Reconnect or disconnect to discard its ambiguous queued uploads.`

export const makeCloudUpload = (deps: CloudUploadDeps): CloudUpload => {
  const { getSettings, fetchImpl } = deps
  // Resolve each side-effect seam to its live binding unless a test injected one.
  // Internal names avoid colliding with the `ledger`/`now` locals in the drain loop.
  const nowFn = deps.now ?? (() => Date.now())
  const store = deps.ledger ?? defaultLedgerStore()
  const rt = deps.runtime ?? defaultRuntimePort(fetchImpl)
  const alarms = deps.alarms ?? defaultAlarmPort()
  const badge = deps.badge ?? defaultBadgePort()
  const authFlow = deps.authFlow ?? defaultAuthFlowPort()
  const maxDrainPerPass = deps.maxDrainPerPass ?? MAX_DRAIN_JOBS_PER_PASS
  const maxUploadJobs = deps.maxUploadJobs ?? MAX_UPLOAD_JOBS

  // Durable local UploadJob ledger (the source of truth) — drained FIFO through a
  // serialized chain like the metadata outbox. Bytes go extension → provider
  // (Drive/Dropbox) directly; nothing here transits Convex.
  const reportUploadError = deps.queueError('upload')
  const reportUploadDiagnostic = (error: unknown): void => {
    try {
      reportUploadError(error)
    } catch {
      /* diagnostics cannot break durable upload work */
    }
  }
  const uploadQueue = makeSerialQueue(reportUploadError)
  // Last non-skip failure, for the popup's status line (diagnostic; resets on recycle).
  let lastUploadError: string | null = null
  const setLastUploadError = (reason: string): void => {
    lastUploadError = boundedDiagnosticText(reason)
  }
  const clearOwnershipRecoveryError = (provider: CloudProviderId): void => {
    if (lastUploadError === ownershipRecoveryError(provider)) lastUploadError = null
  }
  const readLedgerState = async (): Promise<{
    state: UploadLedgerState
    migrationNeeded: boolean
  }> => {
    const decoded = decodeLedgerStateResult(await store.get())
    if (decoded.ok) {
      if (decoded.state.quarantine.length > 0 && lastUploadError === null)
        setLastUploadError(
          'An older in-flight cloud upload has an unknown remote result. It is quarantined, not retried.',
        )
      return { state: decoded.state, migrationNeeded: decoded.migrationNeeded }
    }
    setLastUploadError(CORRUPT_LEDGER_ERROR)
    throw new Error(CORRUPT_LEDGER_ERROR)
  }
  const writeLedger = async (state: UploadLedgerState, ledger: JobLedger): Promise<void> =>
    store.set({ ...state, jobs: ledger })
  const persistRebasedUploadDeadlines = async (
    state: UploadLedgerState,
  ): Promise<UploadLedgerState> => {
    const rebased = rebaseUploadDeadlines(state.jobs, nowFn())
    if (!rebased.changed) return state
    // A fresh worker can move a retry deadline earlier. The old alarm may have
    // been consumed, so establish a conservative recovery wake before that
    // shortened durable state exists.
    await alarms.create(UPLOAD_ALARM, cloudDeadline(nowFn(), DURABLE_SIDE_EFFECT_WATCHDOG_MS))
    const next = { ...state, jobs: rebased.ledger }
    await store.set(next)
    return next
  }
  const readLedger = async (): Promise<JobLedger> => {
    const { state } = await readLedgerState()
    return state.jobs
  }
  const reportCapacity = (rejected: number): void => {
    if (rejected === 0) return
    setLastUploadError(
      `Cloud upload queue is full (${maxUploadJobs} jobs). ${rejected} new upload${rejected === 1 ? '' : 's'} stayed local.`,
    )
    reportUploadDiagnostic(new Error(lastUploadError ?? 'Cloud upload queue is full.'))
  }
  const providers = makeCloudProviderSession({
    getSettings,
    settingsWriter: deps.settingsWriter,
    runtime: rt,
    authFlow,
    fetchImpl,
    now: nowFn,
  })
  const mirror = makeUploadJobMirror({
    getSettings,
    now: nowFn,
    transport: rt,
  })

  const recoverOwnershipTransitions = async (
    existing?: Awaited<ReturnType<typeof readLedgerState>>,
    options: { readonly skipPending?: boolean } = {},
  ): Promise<UploadLedgerState> => {
    const decoded = existing ?? (await readLedgerState())
    let state = decoded.state
    let changed = decoded.migrationNeeded
    if (state.ownershipTransitions.length === 0) {
      if (changed) {
        // A codec migration does not invent rows, but it can re-project an
        // existing runnable row. Protect that durable rewrite just like any
        // other replay-enabling state change; empty normalization needs no wake.
        if (
          (await getSettings()).cloudUploadEnabled &&
          state.jobs.some((job) => !isTerminal(job) && job.attempts < MAX_ATTEMPTS)
        )
          await alarms.create(UPLOAD_ALARM, cloudDeadline(nowFn(), DURABLE_SIDE_EFFECT_WATCHDOG_MS))
        await store.set(state)
      }
      return state
    }
    try {
      await alarms.create(UPLOAD_ALARM, cloudDeadline(nowFn(), DURABLE_SIDE_EFFECT_WATCHDOG_MS))
    } catch (error) {
      reportUploadDiagnostic(error)
      // A consumed alarm cannot be treated as recovery proof. Leave the journal
      // byte-for-byte intact until a future invocation can establish its wake.
      throw error
    }
    const ownership = await deps.getSettingsOwnership()
    if (ownership.availability === 'recovery-required') {
      if (changed) await store.set(state)
      return state
    }
    const settings = ownership.runtime
    const ownerKeys = await Promise.all(
      state.ownershipTransitions
        .filter((transition) => !options.skipPending || !providers.isPending(transition.provider))
        .map(async (transition) => ({
          provider: transition.provider,
          ownerKey: await providerOwnerKey(providerCredentialsFor(settings, transition.provider)),
        })),
    )
    for (const { provider, ownerKey } of ownerKeys) {
      const reconciled = reconcileProviderOwnership(state, provider, ownerKey)
      if (reconciled.outcome === 'blocked') setLastUploadError(ownershipRecoveryError(provider))
      state = reconciled.state
      changed ||= reconciled.changed
    }
    if (changed) await store.set(state)
    return state
  }

  const commitOwnershipReplacement = async (
    input: ConnectOwnershipCommit | DisconnectOwnershipCommit,
  ): Promise<boolean> => {
    // Capture the owner outside the upload queue. Slow storage cannot stop a
    // newer intent. The queued turn rejects any owner drift before journaling.
    const expectedOwnership = await deps.getSettingsOwnership()
    if (expectedOwnership.availability === 'recovery-required')
      throw new Error('Settings recovery is required before changing cloud connections.')
    const expectedBefore = providerCredentialsFor(expectedOwnership.runtime, input.provider)
    const prepared = await uploadQueue.run(async () => {
      let state = await recoverOwnershipTransitions()
      if (providers.generation(input.provider) !== input.generation) return false

      const currentOwnership = await deps.getSettingsOwnership()
      if (currentOwnership.availability === 'recovery-required')
        throw new Error('Settings recovery is required before changing cloud connections.')
      const before = providerCredentialsFor(currentOwnership.runtime, input.provider)
      if (!sameProviderCredentials(before, expectedBefore)) return false
      if (providers.generation(input.provider) !== input.generation) return false
      const after = input.kind === 'connect' ? input.after : disconnectedCredentials(before)
      if (after.provider !== input.provider)
        throw new Error('Cloud ownership replacement has the wrong provider.')
      const beforeOwnerKey = await providerOwnerKey(before)
      const afterOwnerKey = await providerOwnerKey(after)
      if (input.kind === 'connect' && afterOwnerKey === null)
        throw new Error(`${PROVIDERS[input.provider].label} returned incomplete credentials.`)

      const recoveredByDiscard = ownershipTransitionFor(state, input.provider) !== undefined
      if (recoveredByDiscard) state = discardProviderOwnership(state, input.provider)
      if (input.kind === 'connect' && beforeOwnerKey === afterOwnerKey) {
        if (recoveredByDiscard) await store.set(state)
        return { before, after, transition: undefined, recoveredByDiscard }
      }

      const transition: ProviderOwnershipTransition = {
        transitionId: crypto.randomUUID(),
        provider: input.provider,
        kind: input.kind,
        beforeOwnerKey,
        afterOwnerKey,
      }
      const begun = beginProviderOwnershipTransition(state, transition)
      if (!begun.begun)
        throw new Error(`${PROVIDERS[input.provider].label} connection needs recovery.`)
      state = begun.state
      // A journal without a future wake can strand after either following write.
      // Arm recovery first; a spurious wake after a failed journal write is safe.
      await alarms.create(UPLOAD_ALARM, cloudDeadline(nowFn(), DURABLE_SIDE_EFFECT_WATCHDOG_MS))
      await store.set(state)
      return { before, after, transition, recoveredByDiscard }
    })
    if (prepared === false) return false

    if (input.kind === 'disconnect' && providers.generation(input.provider) === input.generation)
      await input.revoke(prepared.before)

    return await uploadQueue.run(async () => {
      if (prepared.transition !== undefined) {
        const activeState = await readLedgerState()
        const active = ownershipTransitionFor(activeState.state, input.provider)
        if (active?.transitionId !== prepared.transition.transitionId) return false
      }
      let writeError: unknown
      const ownershipBeforeWrite = await deps.getSettingsOwnership()
      if (
        providers.generation(input.provider) === input.generation &&
        ownershipBeforeWrite.availability === 'available'
      ) {
        try {
          await deps.settingsWriter.updateWhen(
            (current) =>
              providers.generation(input.provider) === input.generation &&
              (input.kind === 'disconnect' || current.cloudUploadEnabled) &&
              sameProviderCredentials(
                providerCredentialsFor(current, input.provider),
                prepared.before,
              ),
            providerCredentialsPatch(prepared.after),
          )
        } catch (error) {
          writeError = error
        }
      }

      const afterWrite = await readLedgerState()
      const currentOwnership = await deps.getSettingsOwnership()
      if (currentOwnership.availability === 'recovery-required') {
        if (writeError !== undefined) throw writeError
        throw new Error('Settings recovery is required before changing cloud connections.')
      }
      const currentOwnerKey = await providerOwnerKey(
        providerCredentialsFor(currentOwnership.runtime, input.provider),
      )
      if (prepared.transition === undefined) {
        const current = providerCredentialsFor(currentOwnership.runtime, input.provider)
        if (sameProviderCredentials(current, prepared.after)) {
          if (prepared.recoveredByDiscard) clearOwnershipRecoveryError(input.provider)
          return true
        }
        if (sameProviderCredentials(current, prepared.before)) {
          if (writeError !== undefined) throw writeError
          return false
        }
        throw new Error(`${PROVIDERS[input.provider].label} connection needs recovery.`)
      }
      const reconciled = reconcileProviderOwnership(
        afterWrite.state,
        input.provider,
        currentOwnerKey,
      )
      if (reconciled.changed || afterWrite.migrationNeeded) await store.set(reconciled.state)
      if (reconciled.outcome === 'committed' || reconciled.outcome === 'retained') {
        if (prepared.recoveredByDiscard) clearOwnershipRecoveryError(input.provider)
        return true
      }
      if (reconciled.outcome === 'aborted') {
        if (writeError !== undefined) throw writeError
        return false
      }
      throw new Error(`${PROVIDERS[input.provider].label} connection needs recovery.`)
    })
  }

  /** Commit cloud intent before local launch. Network work is detached only after
   * the ledger write and its replay alarm are durable. */
  const recordCloudUploads = async (
    items: ReadonlyArray<CloudUploadIntent>,
  ): Promise<CloudAdmission> => {
    if (items.length === 0) return { tag: 'not-requested' }
    try {
      return await uploadQueue.run(async (): Promise<CloudAdmission> => {
        const current = await getSettings()
        if (!current.cloudUploadEnabled) return { tag: 'not-requested' }
        const decoded = await readLedgerState()
        const blocked = new Set(
          decoded.state.ownershipTransitions.map((transition) => transition.provider),
        )
        const owned = providers.owners(current).filter((owner) => !blocked.has(owner.provider))
        if (owned.length === 0) {
          const pending = CLOUD_PROVIDERS.some(
            (provider) => providers.isPending(provider) || blocked.has(provider),
          )
          return pending
            ? {
                tag: 'unavailable',
                reason: 'Cloud connection change is pending.',
              }
            : { tag: 'not-requested' }
        }
        const latest = await getSettings()
        if (
          !latest.cloudUploadEnabled ||
          !owned.every((owner) => providers.stillOwns(latest, owner))
        )
          return { tag: 'not-requested' }
        const state = decoded.state
        let ledger = state.jobs
        let changed = false
        let rejected = 0
        const conflictingLegacy = items
          .flatMap((candidate) =>
            owned.flatMap((owner) =>
              candidate.legacyAliases.map((alias) =>
                legacyConflict(state, [alias], owner.provider),
              ),
            ),
          )
          .find((legacy) => legacy !== undefined)
        if (conflictingLegacy !== undefined) {
          if (decoded.migrationNeeded) await writeLedger(state, ledger)
          throw new Error(`legacy upload ${conflictingLegacy.jobId} has ambiguous request identity`)
        }
        const conflictingQuarantine = items
          .flatMap((candidate) =>
            owned.map((owner) => quarantineConflict(state, candidate.requestId, owner.provider)),
          )
          .find((candidate) => candidate !== undefined)
        if (conflictingQuarantine !== undefined) {
          if (decoded.migrationNeeded) await writeLedger(state, ledger)
          throw new Error(
            `upload ${conflictingQuarantine.jobId} has an ambiguous pre-v4 provider result`,
          )
        }
        const now = nowFn()
        for (const intent of items) {
          const target = cloudTargetFor(intent.source, intent.filename)
          for (const { provider } of owned) {
            const admission = enqueueBounded(
              ledger,
              {
                requestId: intent.requestId,
                provider,
                url: intent.source.url,
                target,
              },
              now,
              Math.max(0, maxUploadJobs - state.legacy.length - state.quarantine.length),
            )
            if (!admission.admitted) rejected += 1
            changed ||= admission.ledger !== ledger
            ledger = admission.ledger
          }
        }
        if (changed || decoded.migrationNeeded) {
          const committed = await commitLedgerAppend(state, ledger, async () => {
            const latestSettings = await getSettings()
            return (
              latestSettings.cloudUploadEnabled &&
              owned.every((owner) => providers.stillOwns(latestSettings, owner))
            )
          })
          if (!committed) return { tag: 'not-requested' }
        }
        reportCapacity(rejected)
        // The durable alarm and ledger now own replay. Do not make local launch
        // wait on provider I/O.
        uploadQueue.push(() => drainUploadJobs())
        return { tag: 'committed' }
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      setLastUploadError(`Cloud upload was not queued: ${reason}`)
      return { tag: 'unavailable', reason }
    }
  }

  /** Arm the soonest future retry. Ready work uses one bounded watchdog instead
   *  of a due-now alarm that can be consumed before provider I/O settles. */
  const scheduleUploadWake = async (): Promise<void> => {
    const state = await persistRebasedUploadDeadlines((await readLedgerState()).state)
    const blocked = new Set(state.ownershipTransitions.map((transition) => transition.provider))
    const ledger = state.jobs.filter(
      (job) => !providers.isPending(job.provider) && !blocked.has(job.provider),
    )
    const now = nowFn()
    if (
      state.ownershipTransitions.length === 0 &&
      ledger.every((job) => isTerminal(job) || job.attempts >= MAX_ATTEMPTS)
    ) {
      await alarms.clear(UPLOAD_ALARM)
      return
    }
    const due = [
      ...(state.ownershipTransitions.length === 0
        ? []
        : [cloudDeadline(now, DURABLE_SIDE_EFFECT_WATCHDOG_MS)]),
      ...ledger
        .filter((j) => !isTerminal(j) && j.attempts < MAX_ATTEMPTS)
        .map((j) =>
          j.nextAttemptAt <= now
            ? cloudDeadline(now, DURABLE_SIDE_EFFECT_WATCHDOG_MS)
            : j.nextAttemptAt,
        ),
    ]
    if (due.length > 0) await alarms.create(UPLOAD_ALARM, Math.min(...due))
    else await alarms.clear(UPLOAD_ALARM)
  }

  /** A newly durable row must never be the only recovery record. Arm a bounded
   * watchdog first; a spurious alarm after a failed write only performs a safe
   * empty drain. The exact ledger deadline replaces it after the commit. */
  const commitLedgerAppend = async (
    state: UploadLedgerState,
    ledger: JobLedger,
    stillAdmitted: () => Promise<boolean>,
  ): Promise<boolean> => {
    await alarms.create(UPLOAD_ALARM, cloudDeadline(nowFn(), DURABLE_SIDE_EFFECT_WATCHDOG_MS))
    // Alarm I/O yields. Cloud Settings owns consent and provider identity, so a
    // later OFF/reconnect withdraws this admission before its durable append.
    if (!(await stillAdmitted())) return false
    await writeLedger(state, ledger)
    try {
      await scheduleUploadWake()
    } catch (error) {
      // The pre-commit watchdog remains durable. Keep the append; boot recovers it.
      reportUploadDiagnostic(error)
    }
    return true
  }

  const clearDisabledProjection = async (): Promise<void> => {
    try {
      const state = (await readLedgerState()).state
      if (state.ownershipTransitions.length > 0)
        await alarms.create(UPLOAD_ALARM, cloudDeadline(nowFn(), DURABLE_SIDE_EFFECT_WATCHDOG_MS))
      else await alarms.clear(UPLOAD_ALARM)
    } catch (error) {
      reportUploadDiagnostic(error)
    }
    try {
      await badge.set('')
    } catch {
      /* the action API may be unavailable in some contexts */
    }
  }

  /** One serialized opt-out owner. It removes retry work, never ledger work. */
  const pauseWhenDisabled = (): Promise<void> =>
    uploadQueue.run(async () => {
      if (!(await getSettings()).cloudUploadEnabled) await clearDisabledProjection()
    })

  /** Drain ready upload jobs FIFO: claim (persist the lease) → upload → record the
   *  outcome → persist (capped) → mirror. Each job has independent backoff, so one
   *  failure never stops the others. On guard exhaustion it re-kicks itself; on a
   *  natural drain it arms a backoff alarm so retries fire without a new download. */
  const drainUploadJobs = async (): Promise<void> => {
    await recoverOwnershipTransitions(undefined, { skipPending: true })
    let ranOut = false
    // oxlint-disable no-await-in-loop -- FIFO: each job is processed sequentially
    jobLoop: for (let guard = 0; guard < maxDrainPerPass; guard += 1) {
      let settings = await getSettings()
      if (!settings.cloudUploadEnabled) {
        await clearDisabledProjection()
        return
      }
      let now = nowFn()
      let decodedBefore = await readLedgerState()
      let rebasedState = await persistRebasedUploadDeadlines(decodedBefore.state)
      let before = { ...decodedBefore, state: rebasedState }
      let ledger = before.state.jobs
      let durablePending = new Set(
        before.state.ownershipTransitions.map((transition) => transition.provider),
      )
      let job = readyJobs(ledger, now).find(
        (candidate) =>
          !providers.isPending(candidate.provider) && !durablePending.has(candidate.provider),
      )
      if (job === undefined) {
        ranOut = true
        break
      }

      // An alarm event is consumed before its listener runs. Replace it before
      // any durable claim, then rebuild every authorization input after alarm
      // I/O yields. If that arm fails, no lease or provider effect is allowed.
      try {
        await alarms.create(UPLOAD_ALARM, cloudDeadline(now, DURABLE_SIDE_EFFECT_WATCHDOG_MS))
      } catch (error) {
        reportUploadDiagnostic(error)
        return
      }
      settings = await getSettings()
      if (!settings.cloudUploadEnabled) {
        await clearDisabledProjection()
        return
      }
      now = nowFn()
      decodedBefore = await readLedgerState()
      rebasedState = await persistRebasedUploadDeadlines(decodedBefore.state)
      before = { ...decodedBefore, state: rebasedState }
      ledger = before.state.jobs
      durablePending = new Set(
        before.state.ownershipTransitions.map((transition) => transition.provider),
      )
      job = readyJobs(ledger, now).find(
        (candidate) =>
          !providers.isPending(candidate.provider) && !durablePending.has(candidate.provider),
      )
      if (job === undefined) {
        ranOut = true
        break
      }

      // Provider disconnected mid-flight: fail the job so it backs off → dies,
      // rather than spinning forever as perpetually-ready.
      const owner = providers
        .owners(settings)
        .find((candidate) => candidate.provider === job.provider)
      if (owner === undefined) {
        const c = claim(ledger, job.jobId, now)
        const failed = c.claimed
          ? recordFailure(c.ledger, job.jobId, c.token!, now, `${job.provider} disconnected`).ledger
          : c.ledger
        await writeLedger(before.state, capLedger(failed))
        setLastUploadError(`${PROVIDERS[job.provider].label} is not connected.`)
        continue
      }

      const c = claim(ledger, job.jobId, now)
      if (!c.claimed) {
        await writeLedger(before.state, capLedger(c.ledger)) // 'exhausted' → dead persisted
        continue
      }
      await writeLedger(before.state, c.ledger) // persist 'uploading' + lease BEFORE the slow upload
      try {
        await scheduleUploadWake()
      } catch (error) {
        // The persisted lease still fences replay. Report a missing accelerator,
        // but do not relabel the durable claim or block its provider attempt.
        reportUploadDiagnostic(error)
      }
      const token = c.token!
      let liveJob = c.ledger.find((candidate) => candidate.jobId === job.jobId)!

      if (liveJob.remoteAttempt === undefined) {
        let prepared: RemoteAttempt
        try {
          prepared = await providers.prepareAttempt(liveJob, owner)
        } catch (error) {
          const failedState = await readLedgerState()
          if (!providers.stillOwns(await getSettings(), owner)) continue
          const reason = boundedDiagnosticText(
            error instanceof Error ? error.message : String(error),
          )
          const failed = recordFailure(failedState.state.jobs, job.jobId, token, nowFn(), reason)
          if (!failed.changed) continue
          setLastUploadError(classifyUploadError(reason))
          await writeLedger(failedState.state, capLedger(failed.ledger))
          const settled = failed.ledger.find((candidate) => candidate.jobId === job.jobId)
          if (settled !== undefined) await mirror.record(settled)
          continue
        }
        const preparedState = await readLedgerState()
        if (!providers.stillOwns(await getSettings(), owner)) continue
        const bound = bindRemoteAttempt(preparedState.state.jobs, job.jobId, token, prepared)
        if (!bound.changed) continue
        await writeLedger(preparedState.state, bound.ledger)
        liveJob = bound.ledger.find((candidate) => candidate.jobId === job.jobId)!
      }

      let outcome: UploadOutcome | undefined
      // Dropbox has one durable progress cut (stage proof before move). Drive has none.
      for (let step = 0; step < 2; step += 1) {
        let advanced
        try {
          advanced = await providers.advanceAttempt(liveJob, owner)
        } catch (error) {
          advanced = {
            kind: 'failure' as const,
            reason: boundedDiagnosticText(error instanceof Error ? error.message : String(error)),
          }
        }
        const advancedState = await readLedgerState()
        if (!providers.stillOwns(await getSettings(), owner)) continue jobLoop
        if (advanced.kind !== 'progress') {
          outcome = advanced
          break
        }
        const progressed = recordRemoteProgress(
          advancedState.state.jobs,
          job.jobId,
          token,
          advanced.attempt,
        )
        if (!progressed.changed) continue jobLoop
        await writeLedger(advancedState.state, progressed.ledger)
        liveJob = progressed.ledger.find((candidate) => candidate.jobId === job.jobId)!
      }
      if (outcome === undefined)
        outcome = {
          kind: 'failure',
          reason: 'Cloud provider attempt made no terminal progress.',
        }

      const afterState = await readLedgerState()
      if (!providers.stillOwns(await getSettings(), owner)) continue
      const tnow = nowFn()
      let settledTransition
      if (outcome.kind === 'success') {
        settledTransition = recordSuccess(afterState.state.jobs, job.jobId, token, tnow, {
          bytes: outcome.bytes,
          remotePath: outcome.remotePath,
          ...(outcome.remoteId !== undefined ? { remoteId: outcome.remoteId } : {}),
        })
      } else if (outcome.kind === 'sourceGone') {
        settledTransition = recordSourceGone(
          afterState.state.jobs,
          job.jobId,
          token,
          outcome.reason,
        )
      } else {
        if (outcome.status === 401) await providers.invalidateAccessToken(owner)
        settledTransition = recordFailure(
          afterState.state.jobs,
          job.jobId,
          token,
          tnow,
          outcome.reason,
        )
        setLastUploadError(classifyUploadError(outcome.reason, outcome.status))
      }
      if (!settledTransition.changed) continue
      await writeLedger(afterState.state, capLedger(settledTransition.ledger))
      const settled = settledTransition.ledger.find((candidate) => candidate.jobId === job.jobId)
      if (settled !== undefined) await mirror.record(settled)
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

  const resumeAfterOwnershipIntent = (): void => {
    uploadQueue.push(async () => {
      await recoverOwnershipTransitions()
      if ((await getSettings()).cloudUploadEnabled) await drainUploadJobs()
      else await clearDisabledProjection()
    })
  }

  /** Run the PKCE OAuth flow for a provider in the SW (survives the popup closing),
   *  then replace its durable ownership and tokens. Returns a popup-facing result. */
  const runOAuthConnect = async (
    provider: CloudProviderId,
    clientIdArg: string,
  ): Promise<{ ok: boolean; detail: string; account?: string }> => {
    const ownership = await deps.getSettingsOwnership()
    if (ownership.availability === 'recovery-required')
      return {
        ok: false,
        detail: 'Repair or reset Settings before changing cloud connections.',
      }
    const settings = ownership.runtime
    // The popup sends the typed client ID with the request (it never writes the
    // settings blob itself — single-writer, ADR-0005); fall back to a stored one.
    const clientId =
      clientIdArg !== '' ? clientIdArg : settings[PROVIDERS[provider].fields.clientId]
    if (clientId === '')
      return {
        ok: false,
        detail: `Enter the ${PROVIDERS[provider].label} client ID first.`,
      }
    try {
      await readLedger()
    } catch {
      return { ok: false, detail: lastUploadError ?? CORRUPT_LEDGER_ERROR }
    }
    const result = await providers.connect(provider, clientId, commitOwnershipReplacement)
    resumeAfterOwnershipIntent()
    return result.ok ? result : { ...result, detail: classifyUploadError(result.detail) }
  }

  const disconnectProvider = async (provider: CloudProviderId): Promise<{ ok: boolean }> => {
    try {
      return await providers.disconnect(provider, commitOwnershipReplacement)
    } catch (error) {
      reportUploadDiagnostic(error)
      return { ok: false }
    } finally {
      resumeAfterOwnershipIntent()
    }
  }

  const cloudUploadStatus = async (): Promise<CloudUploadStatus> => {
    try {
      return {
        summary: summarize(await readLedger()),
        lastError: lastUploadError,
      }
    } catch {
      return { summary: summarize([]), lastError: lastUploadError }
    }
  }

  const retryDeadUploads = async (): Promise<{ ok: boolean }> => {
    uploadQueue.push(async () => {
      const retryable = (jobs: JobLedger): JobLedger => {
        let next = jobs
        const now = nowFn()
        for (const job of next) {
          if (job.status === 'dead' || job.status === 'failed')
            next = retryUploadJob(next, job.jobId, now).ledger
        }
        return next
      }
      let state = await readLedgerState()
      let ledger = retryable(state.state.jobs)
      if (ledger === state.state.jobs) return
      try {
        await alarms.create(UPLOAD_ALARM, cloudDeadline(nowFn(), DURABLE_SIDE_EFFECT_WATCHDOG_MS))
      } catch (error) {
        reportUploadDiagnostic(error)
        return
      }
      // Alarm I/O yields. Do not revive rows after a later opt-out; rebuild the
      // retry from durable truth so a concurrent recovery cannot be clobbered.
      if (!(await getSettings()).cloudUploadEnabled) return
      state = await readLedgerState()
      ledger = retryable(state.state.jobs)
      if (ledger === state.state.jobs) return
      await writeLedger(state.state, ledger)
      try {
        await scheduleUploadWake()
      } catch (error) {
        reportUploadDiagnostic(error)
      }
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
    const owners = providers.owners(settings)
    if (owners.length === 0)
      return {
        ok: false,
        queued: 0,
        detail: CLOUD_PROVIDERS.some((provider) => providers.isPending(provider))
          ? 'Cloud connection change is pending.'
          : 'Connect Google Drive or Dropbox first.',
      }
    const records = (await deps.getBackfillRecords()).filter((r) => r.media.url !== '')
    if (records.length === 0)
      return {
        ok: false,
        queued: 0,
        detail: 'No past downloads on record — turn on Download history to capture them.',
      }
    // Enqueue on the serial chain and await just that step. Failures become a
    // popup result; the queue observer still traces them.
    const admission = await uploadQueue
      .run(async () => {
        const current = await getSettings()
        if (!current.cloudUploadEnabled)
          return {
            queued: 0,
            rejected: 0,
            changed: false,
            ownershipChanged: true,
          }
        const decoded = await readLedgerState()
        const durablePending = new Set(
          decoded.state.ownershipTransitions.map((transition) => transition.provider),
        )
        const owned = owners.filter(
          (owner) => providers.stillOwns(current, owner) && !durablePending.has(owner.provider),
        )
        if (owned.length === 0)
          return {
            queued: 0,
            rejected: 0,
            changed: false,
            ownershipChanged: true,
          }
        const state = decoded.state
        if (state.legacy.length > 0 || state.quarantine.length > 0) {
          if (decoded.migrationNeeded) await writeLedger(state, state.jobs)
          return {
            queued: 0,
            rejected: 0,
            changed: false,
            ownershipChanged: false,
            legacyBlocked: true,
          }
        }
        let ledger = state.jobs
        let changed = false
        let queued = 0
        let rejected = 0
        const now = nowFn()
        for (const r of records) {
          const target = cloudTargetFor(r.media, r.filename)
          for (const { provider } of owned) {
            const result = enqueueBounded(
              ledger,
              {
                requestId: r.requestId,
                provider,
                url: r.media.url,
                target,
              },
              now,
              Math.max(0, maxUploadJobs - state.legacy.length - state.quarantine.length),
            )
            if (result.admitted && result.added) queued += 1
            if (!result.admitted) rejected += 1
            changed ||= result.ledger !== ledger
            ledger = result.ledger
          }
        }
        if (changed || decoded.migrationNeeded) {
          const committed = await commitLedgerAppend(state, ledger, async () => {
            const latest = await getSettings()
            return (
              latest.cloudUploadEnabled &&
              owned.every((owner) => providers.stillOwns(latest, owner))
            )
          })
          if (!committed)
            return {
              queued: 0,
              rejected: 0,
              changed: false,
              ownershipChanged: true,
            }
        }
        reportCapacity(rejected)
        return { queued, rejected, changed, ownershipChanged: false }
      })
      .catch(() => null)
    if (admission === null)
      return {
        ok: false,
        queued: 0,
        detail: lastUploadError ?? 'Cloud uploads could not be queued.',
      }
    if (admission.ownershipChanged)
      return {
        ok: false,
        queued: 0,
        detail: 'Cloud connection changed. Nothing was queued.',
      }
    if (admission.legacyBlocked)
      return {
        ok: false,
        queued: 0,
        detail: 'Legacy cloud uploads need review before backfill can prove no duplicate.',
      }
    if (admission.changed) uploadQueue.push(() => drainUploadJobs())
    if (admission.rejected > 0)
      return {
        ok: admission.queued > 0,
        queued: admission.queued,
        detail:
          admission.queued > 0
            ? `Queued ${admission.queued} upload${admission.queued === 1 ? '' : 's'}; ${admission.rejected} stayed local because the cloud queue is full.`
            : `Cloud upload queue is full (${maxUploadJobs} jobs). Nothing was queued.`,
      }
    return {
      ok: true,
      queued: admission.queued,
      detail:
        admission.queued > 0
          ? `Queued ${admission.queued} upload${admission.queued === 1 ? '' : 's'} from past downloads.`
          : 'Past downloads are already uploaded or queued.',
    }
  }

  const resumeOnBoot = (): Promise<void> =>
    uploadQueue.run(async () => {
      const state = await persistRebasedUploadDeadlines(await recoverOwnershipTransitions())
      const needsWake =
        state.ownershipTransitions.length > 0 ||
        state.jobs.some((job) => !isTerminal(job) && job.attempts < MAX_ATTEMPTS)
      if (needsWake)
        await alarms.create(UPLOAD_ALARM, cloudDeadline(nowFn(), DURABLE_SIDE_EFFECT_WATCHDOG_MS))
      await writeLedger(state, capLedger(state.jobs))
      if ((await getSettings()).cloudUploadEnabled) await drainUploadJobs()
      else await clearDisabledProjection()
    })

  const resumeWhenEnabled = (): void => {
    uploadQueue.push(async () => {
      // The preceding disabled projection may have cleared the only alarm.
      // Re-establish a conservative wake before recovery or a fresh drain.
      try {
        await alarms.create(UPLOAD_ALARM, cloudDeadline(nowFn(), DURABLE_SIDE_EFFECT_WATCHDOG_MS))
      } catch (error) {
        reportUploadDiagnostic(error)
        return
      }
      await recoverOwnershipTransitions()
      if ((await getSettings()).cloudUploadEnabled) await drainUploadJobs()
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
    resumeWhenEnabled,
    pauseWhenDisabled,
    uploadAlarm: UPLOAD_ALARM,
  }
}
