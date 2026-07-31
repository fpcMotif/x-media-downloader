/**
 * Release diagnostics log — the decision-rich core of a durable, capped event log
 * for Release (Likes/Bookmarks clear) diagnostics. It stores `DownloadTraceEntry`
 * events from two disjoint producers that must land in the SAME timeline so a
 * Release run reads as one continuous story across the content-script/service-worker
 * boundary:
 *  - the overlay's in-page drain/sweep/manual-release, which stamps every trace
 *    line `source:'clear'` (see `reportClear` in overlay.content/index.tsx);
 *  - the background clear-session, which stamps `source:'background'` (shared with
 *    unrelated background trace lines, e.g. download scheduling) but always prefixes
 *    its own stage names with `clear-` (`clear-claim`, `clear-resolve`, `clear-settle`,
 *    …; see `traceBackground` call sites in clear-session.ts).
 *
 * The durable state is a WRAPPER (`ReleaseDiagnosticsLog`), not the bare capped array
 * it used to be, because a bare array made log LOSS invisible — and loss is the normal
 * case, not the exception: one released post costs ~7 events, so a 50-post Bookmarks
 * run emits several hundred and the ring silently ate the HEAD of every real run (the
 * opening `clear-sweep-request`, the first `clear-seeded`, the earliest failures — i.e.
 * exactly the evidence a post-hoc diagnosis needs). The cap is now 1000, and the three
 * counters ride alongside the events so the export can state what the window omits:
 *  - `evicted` — entries the ring dropped, so `evicted > 0` says "you are reading a tail";
 *  - `appended` — every event ever offered, so `appended > entries + evicted + decodeDropped`
 *    says storage REFUSED writes (quota/serialization loss), a different failure than either
 *    eviction or a decode drop;
 *  - `decodeDropped` — entries decode has rejected element-wise, CUMULATIVE over the log's
 *    lifetime. It has to be cumulative to be readable at all: the background prunes the
 *    rejected elements the instant it decodes (its append RMW re-persists the pruned
 *    window), so a per-decode count is erased by the very next trace event and every
 *    export would report 0 while silently inflating the `appended` gap above — i.e. it
 *    would blame quota for what was actually corruption.
 *
 * Pure: no `chrome.*`, no storage I/O. The background entrypoint reads/writes the
 * durable log and feeds this module's decode/append/predicate/export functions —
 * mirrors the shape of `history/store.ts` and `download/request-meta.ts`.
 */
import { Schema } from 'effect'
import { DownloadTraceEntry } from '@/packages/schema'
import { computeReleaseCorrelationCounters } from './correlate'

/** The durable Release diagnostics state: the event window plus the accounting that
 *  makes what's MISSING from that window legible (see the module docstring). */
export interface ReleaseDiagnosticsLog {
  readonly events: ReadonlyArray<DownloadTraceEntry>
  /** Total entries the ring has evicted across this log's whole lifetime. */
  readonly evicted: number
  /** Total entries ever appended, evicted ones included. */
  readonly appended: number
  /** Entries decode has rejected element-wise (corrupt/foreign shape), cumulative. */
  readonly decodeDropped: number
}

/**
 * Beyond this many events the oldest are ring-evicted. 5× `history/store.ts`'s cap
 * and 5× this log's own previous 200: a single Release of one post costs ~7 events,
 * so 200 could not hold even 30 posts — a routine Bookmarks run overwrote its own
 * opening events before the user ever exported them.
 */
export const RELEASE_DIAGNOSTICS_CAP = 1000

/** The zero state: also the fallback for an undecodable durable value. */
export const EMPTY_RELEASE_DIAGNOSTICS: ReleaseDiagnosticsLog = {
  events: [],
  evicted: 0,
  appended: 0,
  decodeDropped: 0,
}

/**
 * True when `e` belongs in the Release diagnostics timeline. This is a stage-prefix
 * test, not a source allowlist: `source` alone can't discriminate the background
 * clear-session's lines from its OTHER trace lines (both share `source:'background'`),
 * so the `clear-` stage prefix is the only reliable signal for that producer. The
 * overlay side needs no prefix check — it never reports anything else as `'clear'`.
 */
export function isReleaseDiagnosticsEvent(e: DownloadTraceEntry): boolean {
  return e.source === 'clear' || e.stage.startsWith('clear-')
}

/**
 * Append N events in ONE eviction pass, ring-evicting the oldest beyond `cap` and
 * booking what that pass actually dropped. The batch form is the hot path — the
 * background coalesces a burst of trace lines into a single read-modify-write — and
 * folding them here keeps the whole burst O(n) instead of re-copying the window per
 * event. An empty batch returns the SAME object so the caller can skip the write.
 */
export function appendManyReleaseDiagnostics(
  log: ReleaseDiagnosticsLog,
  events: ReadonlyArray<DownloadTraceEntry>,
  cap: number = RELEASE_DIAGNOSTICS_CAP,
): ReleaseDiagnosticsLog {
  if (events.length === 0) return log
  const next = [...log.events, ...events]
  const dropped = next.length > cap ? next.length - cap : 0
  return {
    events: dropped > 0 ? next.slice(dropped) : next,
    evicted: log.evicted + dropped,
    appended: log.appended + events.length,
    // Carried, never added to: only a DECODE drops entries. Carrying it is what makes
    // the counter cumulative across RMW cycles (see `decodeReleaseDiagnostics`).
    decodeDropped: log.decodeDropped,
  }
}

/** Append one event (the single-event door onto `appendManyReleaseDiagnostics`, so
 *  eviction accounting has exactly one implementation). */
export function appendReleaseDiagnostics(
  log: ReleaseDiagnosticsLog,
  e: DownloadTraceEntry,
  cap: number = RELEASE_DIAGNOSTICS_CAP,
): ReleaseDiagnosticsLog {
  return appendManyReleaseDiagnostics(log, [e], cap)
}

/** Persisted counters are advisory — they only feed the export header — so a corrupt
 *  one degrades to `fallback` instead of discarding an otherwise-good event window. */
const count = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isInteger(v) ? v : fallback

type WrapperShape = {
  readonly events: ReadonlyArray<unknown>
  readonly evicted?: unknown
  readonly appended?: unknown
  readonly decodeDropped?: unknown
}

const isWrapper = (raw: unknown): raw is WrapperShape =>
  typeof raw === 'object' && raw !== null && 'events' in raw && Array.isArray(raw.events)

/** Decode elements ONE BY ONE: a corrupt entry costs that entry and nothing more.
 *  Whole-array fallback (what `history/store.ts`'s `decodeStore` does, and what this
 *  module used to do) is catastrophic here — the background persists whatever decode
 *  returns, so one bad element used to erase the entire Release log on the next write. */
function decodeEvents(raw: ReadonlyArray<unknown>): {
  events: ReadonlyArray<DownloadTraceEntry>
  dropped: number
} {
  const events: DownloadTraceEntry[] = []
  let dropped = 0
  for (const el of raw) {
    try {
      events.push(Schema.decodeUnknownSync(DownloadTraceEntry)(el))
    } catch {
      dropped++
    }
  }
  return { events, dropped }
}

/**
 * Tolerant decode of the persisted value → log. Accepts BOTH the wrapper and the
 * LEGACY BARE ARRAY already sitting in users' `local:releaseDiagnostics`; the legacy
 * shape lifts with `appended = events.length` (all we can honestly claim: pre-wrapper
 * writes kept no accounting) and `evicted = 0`. No version key — the two shapes are
 * distinguishable by inspection, and a version key would only add a migration that
 * could fail. Anything else (null, garbage, a non-array object) yields the zero state.
 */
export function decodeReleaseDiagnostics(raw: unknown): ReleaseDiagnosticsLog {
  if (Array.isArray(raw)) {
    const { events, dropped } = decodeEvents(raw)
    return { events, evicted: 0, appended: events.length, decodeDropped: dropped }
  }
  if (isWrapper(raw)) {
    const { events, dropped } = decodeEvents(raw.events)
    return {
      events,
      evicted: count(raw.evicted, 0),
      appended: count(raw.appended, events.length),
      // ACCUMULATE onto the persisted count instead of replacing it. The rejected
      // elements are gone from storage as soon as the next append re-persists this
      // window, so a decode that reported only its own drops would read 0 forever
      // after and the loss would be misattributed to refused writes.
      decodeDropped: count(raw.decodeDropped, 0) + dropped,
    }
  }
  return EMPTY_RELEASE_DIAGNOSTICS
}

const pad = (n: number) => String(n).padStart(2, '0')

/** UTC 'YYYY-MM-DD-HHmm' stamp for an epoch-ms instant. UTC (not local, unlike
 *  `daily-budget.ts`'s `localDay`) so the exported filename is stable regardless of
 *  which machine pulled the diagnostics. */
function utcStamp(nowMs: number): string {
  const d = new Date(nowMs)
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`
  return `${date}-${time}`
}

/**
 * Compose the Release diagnostics export: one JSON-stringified event per line
 * (JSONL, mirrors `capture/build-export.ts`'s compose-export pattern), trailing
 * newline. An empty log has nothing worth exporting — `ok:false` lets the caller
 * skip the download instead of writing a zero-byte file.
 *
 * The first line is a synthetic `clear-export-meta` event — itself valid JSONL and
 * itself a Release event by `isReleaseDiagnosticsEvent`, so nothing downstream has to
 * special-case it — carrying the accounting the events alone can't show. The four loss
 * counters partition every event ever offered, so each kind of loss is attributable on
 * its own: `evicted > 0` means this file is a TAIL, `decodeDropped > 0` means entries
 * were persisted but came back corrupt, and the remainder — `appended - entries -
 * evicted - decodeDropped > 0` — means storage refused writes (quota/serialization
 * loss). That last reading is what makes the "No Release diagnostics recorded yet"
 * empty state interpretable rather than misleading: an empty log is one thing when
 * nothing was ever offered and quite another when hundreds of events were offered and
 * none of them stuck.
 *
 * The mismatch counters (ticket #65, extended by #66 with the confirm-branch split
 * and `reappearances`) are DERIVED from `log.events` fresh on every export — never
 * separately persisted, so they can only ever agree with the events that follow them
 * in this same file (see `computeReleaseCorrelationCounters`'s own docstring on why a
 * parallel running total was deliberately not built). The SAME function feeds the
 * popup's Release summary (`background.ts`'s `MetricsRequest` handler), so the two
 * surfaces can never disagree with each other either.
 */
export function composeDiagnosticsExport(
  log: ReleaseDiagnosticsLog,
  now: number,
): { ok: boolean; filename: string; text: string } {
  if (log.events.length === 0) return { ok: false, filename: '', text: '' }
  const { clears, clearsByBranch, mutations, serverRejects, reAddFingerprints, reappearances } =
    computeReleaseCorrelationCounters(log.events)
  const meta: DownloadTraceEntry = {
    source: 'clear',
    stage: 'clear-export-meta',
    t: now,
    detail: `entries=${log.events.length} evicted=${log.evicted} appended=${log.appended} decodeDropped=${log.decodeDropped} cap=${RELEASE_DIAGNOSTICS_CAP} clears=${clears} clearsTestid=${clearsByBranch.testid} clearsDetached=${clearsByBranch.detached} clearsAlreadyCleared=${clearsByBranch.alreadyCleared} mutations=${mutations} serverRejects=${serverRejects} reAddFingerprints=${reAddFingerprints} reappearances=${reappearances}`,
  }
  const text = [meta, ...log.events].map((e) => JSON.stringify(e)).join('\n') + '\n'
  return { ok: true, filename: `xmd-release-diagnostics-${utcStamp(now)}.jsonl`, text }
}
