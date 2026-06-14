// ── Cloud Destinations sync machine — PROTOTYPE TUI (throwaway shell) ──────────
// Run:  bun study/cloud-sync-prototype/tui.ts   (or: bun run proto:cloud-sync)
//
// Drive the pure machine in machine.ts by hand and watch state change. This shell
// is disposable; the machine is the keepable bit. See NOTES.md for the question.

import {
  type Connection,
  type MachineState,
  type MediaItem,
  type Provider,
  type ProviderBehavior,
  type Settings,
  type SyncTrigger,
  type World,
  attempt,
  capture,
  claim,
  flushQueue,
  initialSettings,
  initialState,
  initialWorld,
  readyJobs,
  recycle,
  rollup,
  stepAllReady,
  stepJob,
} from './machine'

const B = '\x1b[1m'
const D = '\x1b[2m'
const R = '\x1b[0m'
const C = {
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
}

const SAMPLES: MediaItem[] = [
  { id: 'm-photo', tweetId: '1001', handle: 'alice', type: 'photo', url: 'https://pbs.twimg.com/media/AAA?name=orig', ext: 'jpg', bytes: 2_000_000 },
  { id: 'm-video', tweetId: '1002', handle: 'bob', type: 'video', url: 'https://video.twimg.com/ext_tw_video/BBB.mp4?tag=12', ext: 'mp4', bytes: 40_000_000 },
  { id: 'm-gif', tweetId: '1003', handle: 'carol', type: 'gif', url: 'https://video.twimg.com/tweet_video/CCC.mp4', ext: 'mp4', bytes: 3_000_000 },
  { id: 'm-bigphoto', tweetId: '1004', handle: 'dave', type: 'photo', url: 'https://pbs.twimg.com/media/DDD?name=orig', ext: 'png', bytes: 12_000_000 },
]
const PROVIDERS: Provider[] = ['s3', 'r2', 'dropbox', 'gphotos']
const BEHAVIORS: ProviderBehavior[] = ['reliable', 'flaky', 'down', 'liar']
const TRIGGERS: SyncTrigger[] = ['onDownload', 'onDemand', 'both']

let state: MachineState = initialState()
let world: World = initialWorld()
let settings: Settings = initialSettings()
let connections: Connection[] = [
  { id: 'c1', provider: 's3', label: 'AWS S3', enabled: true },
  { id: 'c2', provider: 'r2', label: 'Cloudflare R2', enabled: true },
  { id: 'c3', provider: 'dropbox', label: 'Dropbox', enabled: false },
  { id: 'c4', provider: 'gphotos', label: 'Google Photos', enabled: false },
]
let now = 0
let sampleIdx = 0
let lastItem: MediaItem | null = null
let log = 'cloudSync is OFF — press [s] to enable, [m] to pick a trigger, then [d] download / [b] back up.'

const statusColor = (s: string): string =>
  s === 'succeeded' ? C.green
  : s === 'running' ? C.cyan
  : s === 'failed' ? C.yellow
  : s === 'dead' ? C.red
  : s === 'skipped' ? C.magenta
  : C.gray

const apply = (step: { state: MachineState; log: string }): void => {
  state = step.state
  log = step.log
}

const nextSample = (): MediaItem => SAMPLES[sampleIdx % SAMPLES.length]!

const download = (): void => {
  const item = nextSample()
  sampleIdx += 1
  lastItem = item
  apply(capture(state, settings, item, 'download', now))
}

const backupNow = (): void => {
  const item = lastItem ?? nextSample()
  if (item === lastItem) {
    // re-back-up the focused item (idempotent path)
  } else {
    sampleIdx += 1
    lastItem = item
  }
  apply(capture(state, settings, item, 'on-demand', now))
}

const firstRunning = (): string | null => state.jobs.find((j) => j.status === 'running')?.jobId ?? null
const firstReady = (): string | null => readyJobs(state, now)[0]?.jobId ?? null

const render = (): void => {
  const lines: string[] = []
  lines.push(`${B}Cloud Destinations — sync state machine prototype${R}   ${D}clock now=${(now / 1000).toFixed(0)}s${R}`)
  lines.push('')

  // settings — the flexible trigger surface
  const sync = settings.cloudSyncEnabled ? `${C.green}ON${R}` : `${C.red}OFF${R}`
  const focus = lastItem ? lastItem.id : `${D}(next: ${nextSample().id})${R}`
  lines.push(`${B}settings${R}    cloudSync=${sync}   trigger=${C.cyan}${settings.syncTrigger}${R}   ${D}focus=${R}${focus}`)

  // world: providers + expired sources
  const prov = PROVIDERS.map((p) => {
    const beh = world.providers[p]
    const col = beh === 'reliable' ? C.green : beh === 'flaky' ? C.yellow : beh === 'liar' ? C.magenta : C.red
    return `${p}=${col}${beh}${R}`
  }).join('  ')
  lines.push(`${B}providers${R}   ${prov}`)
  const expired = Object.entries(world.sources).filter(([, s]) => s === 'expired').map(([m]) => m)
  lines.push(`${B}sources${R}     ${expired.length ? `${C.magenta}expired:${R} ${expired.join(', ')}` : `${D}all live${R}`}`)

  // connections
  const conns = connections.map((c) => `${c.enabled ? C.green + '●' + R : D + '○' + R} ${c.label}`).join('   ')
  lines.push(`${B}destinations${R} ${conns}`)
  lines.push('')

  // durable local sync-queue (survives SW recycle)
  lines.push(`${B}local:sync-queue${R} ${D}(${state.queue.length} captured, awaiting flush)${R}`)
  for (const q of state.queue) lines.push(`  ${q.mediaId.padEnd(11)} ${D}${q.source}${R}`)
  if (state.queue.length === 0) lines.push(`  ${D}(empty)${R}`)
  lines.push('')

  // catalog with rollup
  lines.push(`${B}catalog${R} ${D}(${Object.keys(state.catalog).length} items in Convex)${R}`)
  for (const item of Object.values(state.catalog)) {
    const r = rollup(state, item.mediaId)
    const col =
      r.label === 'safe' ? C.green
      : r.label === 'failed' ? C.red
      : r.label === 'sourceGone' ? C.magenta
      : r.label === 'syncing' ? C.cyan
      : C.gray
    lines.push(`  ${item.mediaId.padEnd(11)} ${D}${item.type.padEnd(5)}${R} ${col}${r.label.padEnd(10)}${R} ${D}${r.safe}/${r.total} landed${R}`)
  }
  if (Object.keys(state.catalog).length === 0) lines.push(`  ${D}(empty)${R}`)
  lines.push('')

  // jobs table — presign everything; "landed" only after HEAD verify
  lines.push(`${B}jobs${R} ${D}(${state.jobs.length})${R}`)
  if (state.jobs.length) {
    lines.push(`  ${D}${'job'.padEnd(7)}${'media'.padEnd(11)}${'prov'.padEnd(9)}${'status'.padEnd(11)}${'try'.padEnd(5)}${'next/lease'.padEnd(13)}error${R}`)
    for (const j of state.jobs) {
      const next =
        j.status === 'failed' ? `+${Math.max(0, j.nextAttemptAt - now)}ms`
        : j.leaseUntil ? `lease ${Math.max(0, j.leaseUntil - now)}ms`
        : ''
      lines.push(
        `  ${j.jobId.padEnd(7)}${j.mediaId.padEnd(11)}${j.provider.padEnd(9)}` +
          `${statusColor(j.status)}${j.status.padEnd(11)}${R}${String(j.attempts).padEnd(5)}${D}${next.padEnd(13)}${R}${j.error ? C.gray + j.error + R : ''}`,
      )
    }
  } else lines.push(`  ${D}(none)${R}`)
  lines.push('')

  lines.push(`${D}last:${R} ${log}`)
  lines.push('')
  lines.push(
    `${B}[s]${R}${D}cloudSync${R}  ${B}[m]${R}${D}trigger${R}  ${B}[d]${R}${D}download-complete${R}  ${B}[b]${R}${D}backup-now (button)${R}  ${B}[F]${R}${D}flush→syncItems${R}  ${B}[k]${R}${D}recycle SW${R}`,
  )
  lines.push(
    `${B}[n]${R}${D}step ready${R}  ${B}[A]${R}${D}auto all ready${R}  ${B}[t]${R}${D}tick +60s${R}  ${B}[c]${R}${D}claim${R}  ${B}[r]${R}${D}run${R}  ${B}[f]${R}${D}double-fire (lease guard)${R}  ${B}[x]${R}${D}source 403${R}`,
  )
  lines.push(
    `${B}[1-4]${R}${D}provider behavior${R}  ${B}[5-8]${R}${D}toggle destination${R}  ${B}[z]${R}${D}reset${R}  ${B}[q]${R}${D}quit${R}`,
  )

  process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n')
}

const handle = (key: string): void => {
  switch (key) {
    case 's':
      settings = { ...settings, cloudSyncEnabled: !settings.cloudSyncEnabled }
      log = `cloudSync → ${settings.cloudSyncEnabled ? 'ON' : 'OFF'} (master gate)`
      break
    case 'm': {
      const i = TRIGGERS.indexOf(settings.syncTrigger)
      settings = { ...settings, syncTrigger: TRIGGERS[(i + 1) % TRIGGERS.length]! }
      log = `trigger → ${settings.syncTrigger}`
      break
    }
    case 'd':
      download()
      break
    case 'b':
      backupNow()
      break
    case 'F':
      apply(flushQueue(state, connections, now))
      break
    case 'k':
      apply(recycle(state, now))
      break
    case 'n': {
      const id = firstReady()
      if (id) apply(stepJob(state, world, id, now))
      else log = 'no ready job (tick the clock if backing off, or flush the queue first)'
      break
    }
    case 'A':
      apply(stepAllReady(state, world, now))
      break
    case 'c': {
      const id = firstReady()
      if (id) apply(claim(state, id, now))
      else log = 'no ready job to claim'
      break
    }
    case 'r': {
      const id = firstRunning()
      if (id) apply(attempt(state, world, id, now))
      else log = 'no running job (claim one with [c])'
      break
    }
    case 'f': {
      const id = firstRunning()
      if (id) apply(claim(state, id, now)) // expect REFUSED — lease held
      else log = 'no running job to double-fire; [c] claim one first'
      break
    }
    case 't':
      now += 60_000
      log = `clock → ${(now / 1000).toFixed(0)}s (backed-off retries may be ready)`
      break
    case 'x':
      if (lastItem) {
        const cur = world.sources[lastItem.id] ?? 'ok'
        world = { ...world, sources: { ...world.sources, [lastItem.id]: cur === 'expired' ? 'ok' : 'expired' } }
        log = `source ${lastItem.id} → ${world.sources[lastItem.id]} (link-rot toggle)`
      } else log = 'nothing in focus yet ([d] or [b] first)'
      break
    case '1':
    case '2':
    case '3':
    case '4': {
      const p = PROVIDERS[Number(key) - 1]!
      const cur = BEHAVIORS.indexOf(world.providers[p])
      const beh = BEHAVIORS[(cur + 1) % BEHAVIORS.length]!
      world = { ...world, providers: { ...world.providers, [p]: beh } }
      log = `${p} behavior → ${beh}`
      break
    }
    case '5':
    case '6':
    case '7':
    case '8': {
      const i = Number(key) - 5
      connections = connections.map((c, idx) => (idx === i ? { ...c, enabled: !c.enabled } : c))
      log = `${connections[i]!.label} → ${connections[i]!.enabled ? 'enabled' : 'disabled'}`
      break
    }
    case 'z':
      state = initialState()
      world = initialWorld()
      settings = initialSettings()
      now = 0
      sampleIdx = 0
      lastItem = null
      log = 'reset'
      break
    case 'q':
    case '':
      process.stdout.write('\x1b[2J\x1b[H')
      process.exit(0)
  }
  render()
}

process.stdin.setRawMode?.(true)
process.stdin.resume()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (k: string) => {
  for (const ch of k) handle(ch)
})
render()
