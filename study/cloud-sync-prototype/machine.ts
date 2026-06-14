// ── Cloud Destinations sync machine — PROTOTYPE ──────────────────────────────
// Pure domain + transitions for the Convex Link Catalog + Cloud Destinations
// design.
//   spec: docs/superpowers/specs/2026-06-14-convex-cloud-backup-design.md
//   adr:  docs/adr/0011 · 0012 · 0013
//
// This module is the *keepable* half of the prototype: no I/O, no console, no
// terminal code. The TUI (tui.ts) imports it and calls in; nothing flows back.
// When the design is validated, lift this into the real core (e.g. src/core/sync).
//
// Byte path is PRESIGN-EVERYTHING (§9 Resolved #1): bytes never touch Convex —
// Convex only signs the upload and verifies it out-of-band. There is no `pipe`
// special case; every job streams extension→cloud against a presigned target.

export const MAX_ATTEMPTS = 5
export const BACKOFF_BASE_MS = 5_000
export const BACKOFF_CAP_MS = 300_000
export const LEASE_MS = 30_000

export type MediaType = 'photo' | 'video' | 'gif'
export type Provider = 's3' | 'r2' | 'dropbox' | 'gphotos'
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead' | 'skipped'

// The flexible trigger the user asked for: auto-on-download, on-demand button, or both.
export type SyncTrigger = 'onDownload' | 'onDemand' | 'both'
export type CaptureSource = 'download' | 'on-demand'

export interface MediaItem {
  id: string
  tweetId: string
  handle: string
  type: MediaType
  url: string
  ext: string
  bytes: number
}

export interface Settings {
  cloudSyncEnabled: boolean // master gate — OFF by default (ADR-0011, strictly opt-in)
  syncTrigger: SyncTrigger
}

export const initialSettings = (): Settings => ({ cloudSyncEnabled: false, syncTrigger: 'onDownload' })

export interface Connection {
  id: string
  provider: Provider
  label: string
  enabled: boolean
}

export interface CatalogItem {
  mediaId: string
  tweetId: string
  handle: string
  type: MediaType
  url: string
  ext: string
  capturedAt: number
}

// One un-flushed capture sitting in the durable local:sync-queue. It survives an
// MV3 service-worker recycle; only `flush` (syncItems) turns it into catalog + jobs.
export interface QueuedCapture {
  mediaId: string
  source: CaptureSource
  item: MediaItem
  at: number
}

export interface UploadJob {
  jobId: string
  idempotencyKey: string // `${mediaId}:${provider}` — at-least-once becomes exactly-once
  mediaId: string
  provider: Provider
  objectKey: string // server-derived {handle}/{tweetId}/{file} — client cannot influence
  status: JobStatus
  attempts: number
  nextAttemptAt: number // claimable only when now >= this
  leaseUntil: number | null
  verifiedAt: number | null // set only after out-of-band HEAD verify
  error: string | null
}

export interface MachineState {
  catalog: Record<string, CatalogItem>
  queue: QueuedCapture[] // durable local:sync-queue (survives SW recycle)
  jobs: UploadJob[]
  seq: number
}

export const initialState = (): MachineState => ({ catalog: {}, queue: [], jobs: [], seq: 0 })

export const backoffMs = (attempts: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1))

export interface Step {
  state: MachineState
  log: string
}

const replaceJob = (state: MachineState, job: UploadJob): MachineState => ({
  ...state,
  jobs: state.jobs.map((j) => (j.jobId === job.jobId ? job : j)),
})

// ── the sync seam: should this capture enter the durable queue? ────────────────
// This is the flexible-trigger decision. The local download path is NEVER blocked
// or altered by the outcome here — capture only ever *adds* a backup intent.
export const capture = (
  state: MachineState,
  settings: Settings,
  item: MediaItem,
  source: CaptureSource,
  now: number,
): Step => {
  if (!settings.cloudSyncEnabled) {
    return { state, log: `capture: ${item.id} — cloudSync OFF (master gate) → ignored; download untouched` }
  }
  // A finished download only auto-syncs when the trigger opts in; the on-demand
  // "Back up" button is an explicit intent and always works while sync is enabled.
  const autoOnDownload = settings.syncTrigger === 'onDownload' || settings.syncTrigger === 'both'
  if (source === 'download' && !autoOnDownload) {
    return {
      state,
      log: `capture: ${item.id} downloaded — trigger=${settings.syncTrigger}, no auto-sync (press [b] to back up)`,
    }
  }
  if (state.queue.some((q) => q.mediaId === item.id)) {
    return { state, log: `capture: ${item.id} already queued — deduped (idempotent)` }
  }
  const entry: QueuedCapture = { mediaId: item.id, source, item, at: now }
  return {
    state: { ...state, queue: [...state.queue, entry] },
    log: `capture: ${item.id} → local:sync-queue (${source})`,
  }
}

// ── catalog: idempotent upsert by mediaId; a re-sync is a no-op write ───────────
export const catalogUpsert = (state: MachineState, item: MediaItem, now: number): Step => {
  if (state.catalog[item.id]) {
    return { state, log: `catalog: ${item.id} already present — no-op (idempotent)` }
  }
  const entry: CatalogItem = {
    mediaId: item.id,
    tweetId: item.tweetId,
    handle: item.handle,
    type: item.type,
    url: item.url,
    ext: item.ext,
    capturedAt: now,
  }
  return {
    state: { ...state, catalog: { ...state.catalog, [item.id]: entry } },
    log: `catalog: + ${item.id} (${item.type}, ${(item.bytes / 1e6).toFixed(1)}MB)`,
  }
}

// ── enqueue one job per enabled connection; idempotent by `${mediaId}:${provider}` ──
export const enqueue = (
  state: MachineState,
  item: MediaItem,
  connections: Connection[],
  now: number,
): Step => {
  const entry = state.catalog[item.id]
  if (!entry) return { state, log: `enqueue: ${item.id} not catalogued — skipped` }
  let next = state
  let created = 0
  let deduped = 0
  for (const conn of connections) {
    if (!conn.enabled) continue
    const idempotencyKey = `${item.id}:${conn.provider}`
    if (next.jobs.some((j) => j.idempotencyKey === idempotencyKey)) {
      deduped += 1
      continue
    }
    const job: UploadJob = {
      jobId: `job-${next.seq + 1}`,
      idempotencyKey,
      mediaId: item.id,
      provider: conn.provider,
      objectKey: `${entry.handle}/${entry.tweetId}/${entry.mediaId}.${entry.ext}`,
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      leaseUntil: null,
      verifiedAt: null,
      error: null,
    }
    next = { ...next, jobs: [...next.jobs, job], seq: next.seq + 1 }
    created += 1
  }
  const note = deduped ? `, ${deduped} deduped (idempotent)` : ''
  return { state: next, log: `enqueue: ${item.id} → +${created} job(s)${note}` }
}

// ── flush = the single extension-facing write `syncItems`: drain the durable ───
// queue, upsert catalog, and create one job per enabled connection. In reality
// this fires on download-complete and on popup-open; here it is the [F] key so
// each layer stays visible.
export const flushQueue = (state: MachineState, connections: Connection[], now: number): Step => {
  if (state.queue.length === 0) return { state, log: 'flush(syncItems): sync-queue empty' }
  const flushed = state.queue.length
  let next = state
  let cataloged = 0
  let jobsCreated = 0
  for (const q of state.queue) {
    const had = next.catalog[q.item.id] !== undefined
    next = catalogUpsert(next, q.item, now).state
    if (!had) cataloged += 1
    const before = next.jobs.length
    next = enqueue(next, q.item, connections, now).state
    jobsCreated += next.jobs.length - before
  }
  next = { ...next, queue: [] }
  return {
    state: next,
    log: `flush(syncItems): ${flushed} queued → +${cataloged} catalog, +${jobsCreated} job(s)`,
  }
}

export const isClaimable = (job: UploadJob, now: number): boolean =>
  // pending/failed are normally claimable; a `running` job becomes claimable
  // again only once its lease has expired (crash recovery), never while held.
  (job.status === 'pending' || job.status === 'failed' || job.status === 'running') &&
  job.attempts < MAX_ATTEMPTS &&
  now >= job.nextAttemptAt &&
  (job.leaseUntil === null || job.leaseUntil <= now)

export const readyJobs = (state: MachineState, now: number): UploadJob[] =>
  state.jobs.filter((j) => isClaimable(j, now))

// ── claim with compare-and-set lease — the guard against double-fire ───────────
export const claim = (state: MachineState, jobId: string, now: number, leaseMs = LEASE_MS): Step => {
  const job = state.jobs.find((j) => j.jobId === jobId)
  if (!job) return { state, log: `claim: ${jobId} not found` }
  if (job.status === 'running' && job.leaseUntil !== null && job.leaseUntil > now) {
    return {
      state,
      log: `claim: ${jobId} REFUSED — lease held ${job.leaseUntil - now}ms (no double-fire)`,
    }
  }
  if (!isClaimable(job, now)) {
    const wait = Math.max(0, job.nextAttemptAt - now)
    return {
      state,
      log: `claim: ${jobId} not claimable (status=${job.status}${wait ? `, wait ${wait}ms` : ''})`,
    }
  }
  const reclaimed = job.leaseUntil !== null && job.leaseUntil <= now
  const claimed: UploadJob = { ...job, status: 'running', leaseUntil: now + leaseMs }
  return {
    state: replaceJob(state, claimed),
    log: `claim: ${jobId} → running${reclaimed ? ' (lease expired → reclaimed)' : ''}`,
  }
}

// ── attempt: fetch source → presigned PUT → OUT-OF-BAND HEAD verify → succeed/fail ──
// "saved" means landed (HEAD-verified), never merely started. A provider that acks
// the PUT but never lands the object (`liar`) is caught here, not trusted.
export const attempt = (state: MachineState, world: World, jobId: string, now: number): Step => {
  const job = state.jobs.find((j) => j.jobId === jobId)
  if (!job) return { state, log: `run: ${jobId} not found` }
  if (job.status !== 'running') return { state, log: `run: ${jobId} not running — claim first` }

  const source = world.sources[job.mediaId] ?? 'ok'
  if (source === 'expired') {
    const skipped: UploadJob = { ...job, status: 'skipped', leaseUntil: null, error: 'sourceGone (403)' }
    return {
      state: replaceJob(state, skipped),
      log: `run: ${jobId} source 403 (link-rot) → skipped/sourceGone (honest: NOT saved)`,
    }
  }

  const behavior = world.providers[job.provider]
  const attemptN = job.attempts + 1
  let ok = false
  let reason = ''
  switch (behavior) {
    case 'reliable':
      ok = true
      break
    case 'flaky':
      if (attemptN >= 2) ok = true
      else reason = 'upload neterr (flaky)'
      break
    case 'down':
      reason = 'upload neterr (down)'
      break
    case 'liar':
      reason = 'PUT acked but HEAD missing — out-of-band verify caught it'
      break
  }

  if (ok) {
    const done: UploadJob = { ...job, status: 'succeeded', leaseUntil: null, verifiedAt: now, error: null }
    return {
      state: replaceJob(state, done),
      log: `run: ${jobId} presigned PUT → HEAD verified → succeeded (landed)`,
    }
  }
  if (attemptN >= MAX_ATTEMPTS) {
    const dead: UploadJob = { ...job, status: 'dead', attempts: attemptN, leaseUntil: null, error: reason }
    return { state: replaceJob(state, dead), log: `run: ${jobId} ${reason} → ${attemptN}/${MAX_ATTEMPTS} → DEAD` }
  }
  const wait = backoffMs(attemptN)
  const failed: UploadJob = {
    ...job,
    status: 'failed',
    attempts: attemptN,
    leaseUntil: null,
    nextAttemptAt: now + wait,
    error: reason,
  }
  return {
    state: replaceJob(state, failed),
    log: `run: ${jobId} ${reason} → ${attemptN}/${MAX_ATTEMPTS} → failed, retry in ${wait}ms`,
  }
}

// claim + attempt in one move (the common path)
export const stepJob = (state: MachineState, world: World, jobId: string, now: number): Step => {
  const c = claim(state, jobId, now)
  const job = c.state.jobs.find((j) => j.jobId === jobId)
  if (!job || job.status !== 'running') return c
  return attempt(c.state, world, jobId, now)
}

export const stepAllReady = (state: MachineState, world: World, now: number): Step => {
  const ready = readyJobs(state, now)
  if (ready.length === 0) return { state, log: 'auto: no ready jobs' }
  let next = state
  for (const j of ready) next = stepJob(next, world, j.jobId, now).state
  return { state: next, log: `auto: stepped ${ready.length} ready job(s)` }
}

// ── MV3 service-worker recycle: the worker dies mid-flight. The durable queue and
// the server-side catalog/jobs persist; only in-memory leases are forgotten, so a
// held job becomes reclaimable (no attempt is consumed). This is the durability the
// design hangs on — capture intent is never lost to a recycle.
export const recycle = (state: MachineState, now: number): Step => {
  const held = state.jobs.filter(
    (j) => j.status === 'running' && j.leaseUntil !== null && j.leaseUntil > now,
  )
  const jobs = state.jobs.map((j) =>
    j.status === 'running' && j.leaseUntil !== null && j.leaseUntil > now ? { ...j, leaseUntil: now } : j,
  )
  return {
    state: { ...state, jobs },
    log: `recycle(SW killed): local:sync-queue (${state.queue.length}) intact · ${held.length} lease(s) released for reclaim · catalog/jobs durable`,
  }
}

// ── catalog rollup status, derived purely from the item's jobs ─────────────────
export interface Rollup {
  label: 'cataloged' | 'syncing' | 'safe' | 'failed' | 'sourceGone'
  safe: number
  total: number
}
export const rollup = (state: MachineState, mediaId: string): Rollup => {
  const js = state.jobs.filter((j) => j.mediaId === mediaId)
  const total = js.length
  const safe = js.filter((j) => j.status === 'succeeded').length
  if (total === 0) return { label: 'cataloged', safe, total }
  if (js.some((j) => j.status === 'pending' || j.status === 'running' || j.status === 'failed'))
    return { label: 'syncing', safe, total }
  if (js.some((j) => j.status === 'dead')) return { label: 'failed', safe, total }
  if (js.some((j) => j.status === 'skipped')) return { label: 'sourceGone', safe, total }
  return { label: 'safe', safe, total }
}

// ── the fake world (env), owned by the TUI; transitions read it but never mutate it ──
export type ProviderBehavior = 'reliable' | 'flaky' | 'down' | 'liar'
export type SourceState = 'ok' | 'expired'

export interface World {
  providers: Record<Provider, ProviderBehavior>
  sources: Record<string, SourceState>
}

export const initialWorld = (): World => ({
  providers: { s3: 'reliable', r2: 'flaky', dropbox: 'reliable', gphotos: 'reliable' },
  sources: {},
})
