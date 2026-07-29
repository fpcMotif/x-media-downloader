import type { MetricsSnapshot } from '../schema'

/** A timestamped progress sample for one queued item. */
export interface Sample {
  readonly id: string
  readonly bytesReceived: number
  readonly totalBytes: number
  readonly t: number
}

export type ItemOutcome = 'complete' | 'failed'

/** Rolling window (ms) over which throughput is averaged. */
const WINDOW_MS = 5000

interface ItemProgress {
  readonly bytesReceived: number
  readonly totalBytes: number
  readonly t: number
}

interface TimelinePoint {
  readonly t: number
  readonly agg: number
}

/** Opaque accumulator threaded through the pure reducers. */
export interface MetricsState {
  readonly total: number
  readonly concurrencyCap: number
  readonly startedAt: number
  readonly completed: number
  readonly failed: number
  readonly retries: number
  readonly items: ReadonlyMap<string, ItemProgress>
  readonly outcomes: ReadonlySet<string>
  readonly timeline: readonly TimelinePoint[]
}

/** Seed an empty accumulator for a queue of `total` items. */
export function emptyMetrics(opts: {
  readonly total: number
  readonly concurrencyCap: number
  readonly startedAt: number
}): MetricsState {
  return {
    total: opts.total,
    concurrencyCap: opts.concurrencyCap,
    startedAt: opts.startedAt,
    completed: 0,
    failed: 0,
    retries: 0,
    items: new Map(),
    outcomes: new Set(),
    timeline: [],
  }
}

/**
 * Grow an existing accumulator by `addTotal` more items (raising the cap if the
 * new batch allows more concurrency). Used when a new download batch starts
 * while a prior one is still in flight, so the monitor keeps reflecting both.
 */
export function extendTotal(
  state: MetricsState,
  addTotal: number,
  concurrencyCap: number,
): MetricsState {
  return {
    ...state,
    total: state.total + addTotal,
    concurrencyCap: Math.max(state.concurrencyCap, concurrencyCap),
  }
}

/** Sum each item's latest `bytesReceived`. */
function aggregateBytesReceived(items: ReadonlyMap<string, ItemProgress>): number {
  let sum = 0
  for (const p of items.values()) sum += p.bytesReceived
  return sum
}

/**
 * Drop timeline points older than the rolling window can ever reference. The
 * window ref is the most recent point with `t <= now - WINDOW_MS`, so the single
 * newest point at-or-before that cutoff is the oldest one any future snapshot can
 * use — everything strictly before it is dead weight. Pruning it keeps memory and
 * per-snapshot scan cost bounded without changing any computed metric.
 */
function pruneTimeline(timeline: readonly TimelinePoint[], now: number): readonly TimelinePoint[] {
  const cutoff = now - WINDOW_MS
  let keepFrom = 0
  for (let i = 0; i < timeline.length; i++) {
    if (timeline[i]!.t <= cutoff) keepFrom = i
    else break
  }
  return keepFrom === 0 ? timeline : timeline.slice(keepFrom)
}

/**
 * Store the item's latest progress (replacing any earlier sample) and append a
 * timeline point of the running aggregate `bytesReceived` at `sample.t`.
 */
export function recordSample(state: MetricsState, sample: Sample): MetricsState {
  const items = new Map(state.items)
  items.set(sample.id, {
    bytesReceived: sample.bytesReceived,
    totalBytes: sample.totalBytes,
    t: sample.t,
  })
  const agg = aggregateBytesReceived(items)
  return {
    ...state,
    items,
    timeline: [...pruneTimeline(state.timeline, sample.t), { t: sample.t, agg }],
  }
}

/**
 * Mark an item terminal: `complete` or `failed`. Removes it from active.
 * Idempotent — a repeat outcome for the same id (e.g. a late `onChanged` or a
 * retry event) is ignored, so counts never exceed `total`.
 */
export function recordOutcome(
  state: MetricsState,
  id: string,
  outcome: ItemOutcome,
  _t: number,
): MetricsState {
  if (state.outcomes.has(id)) return state
  const outcomes = new Set(state.outcomes)
  outcomes.add(id)
  return {
    ...state,
    outcomes,
    completed: outcome === 'complete' ? state.completed + 1 : state.completed,
    failed: outcome === 'failed' ? state.failed + 1 : state.failed,
  }
}

/** Count one retry attempt against an item. */
export function recordRetry(state: MetricsState, _id: string): MetricsState {
  return { ...state, retries: state.retries + 1 }
}

/**
 * Throughput (bytes/s) over the rolling window ending at `now`: pick `ref` as
 * the most recent point with `t <= now - WINDOW_MS`, else the earliest point.
 * Zero when there are <2 points, the span is non-positive (out-of-order
 * samples), or the aggregate would imply a negative rate — never negative.
 */
function throughputBps(timeline: readonly TimelinePoint[], now: number): number {
  if (timeline.length < 2) return 0
  const latest = timeline[timeline.length - 1]!
  const cutoff = now - WINDOW_MS
  let ref = timeline[0]!
  for (const p of timeline) {
    if (p.t <= cutoff) ref = p
  }
  const spanMs = latest.t - ref.t
  if (spanMs <= 0) return 0
  return Math.max(0, (latest.agg - ref.agg) / (spanMs / 1000))
}

/** Project the accumulator to a `MetricsSnapshot` at wall-clock `now`. */
export function snapshot(state: MetricsState, now: number): MetricsSnapshot {
  let bytesReceived = 0
  let bytesTotal = 0
  let active = 0
  for (const [id, p] of state.items) {
    bytesReceived += p.bytesReceived
    if (p.totalBytes > 0) bytesTotal += p.totalBytes
    if (!state.outcomes.has(id)) active += 1
  }
  const bps = throughputBps(state.timeline, now)
  const eta =
    bps > 0 && bytesTotal > 0 && bytesTotal > bytesReceived
      ? (bytesTotal - bytesReceived) / bps
      : undefined
  const elapsed = now - state.startedAt
  return {
    total: state.total,
    completed: state.completed,
    failed: state.failed,
    active,
    retries: state.retries,
    concurrencyCap: state.concurrencyCap,
    bytesReceived,
    bytesTotal,
    throughputBps: bps,
    elapsedMs: Number.isFinite(elapsed)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(elapsed)))
      : 0,
    ...(eta !== undefined ? { etaSeconds: eta } : {}),
  }
}

/** One row from `chrome.downloads.search({ id })` (byte progress; §d). */
export interface SearchRow {
  readonly id: number
  readonly bytesReceived: number
  readonly totalBytes: number
}

/**
 * Convert `downloads.search` rows into samples, re-keyed from the browser
 * `downloadId` to our request id via `requestIdByDownloadId`. Rows whose
 * downloadId is unknown (not one of ours) are skipped.
 */
export function samplesFromSearch(
  rows: ReadonlyArray<SearchRow>,
  requestIdByDownloadId: ReadonlyMap<number, string>,
  t: number,
): Sample[] {
  const out: Sample[] = []
  for (const row of rows) {
    const id = requestIdByDownloadId.get(row.id)
    if (id === undefined) continue
    out.push({ id, bytesReceived: row.bytesReceived, totalBytes: row.totalBytes, t })
  }
  return out
}

/**
 * Map a `downloads.onChanged` state transition to a terminal outcome, or null
 * while still in progress (§d: `complete` | `interrupted` are terminal).
 */
export function outcomeFromState(state: string | undefined): ItemOutcome | null {
  if (state === 'complete') return 'complete'
  if (state === 'interrupted') return 'failed'
  return null
}
