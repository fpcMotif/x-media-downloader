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
 * Pure: no `chrome.*`, no storage I/O. The background entrypoint reads/writes the
 * durable log and feeds this module's decode/append/predicate/export functions —
 * mirrors the shape of `history/store.ts` and `download/request-meta.ts`.
 */
import { Schema } from 'effect'
import { DownloadTraceEntry } from '../schema'

/** Beyond this many events the oldest are ring-evicted (mirrors `history/store.ts`'s DEFAULT_HISTORY_CAP). */
export const RELEASE_DIAGNOSTICS_CAP = 200

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

/** Append one event, ring-evicting the oldest beyond `cap` (mirrors `history/store.ts`'s upsert eviction). */
export function appendReleaseDiagnostics(
  log: ReadonlyArray<DownloadTraceEntry>,
  e: DownloadTraceEntry,
  cap: number = RELEASE_DIAGNOSTICS_CAP,
): ReadonlyArray<DownloadTraceEntry> {
  const next = [...log, e]
  return next.length > cap ? next.slice(next.length - cap) : next
}

const ReleaseDiagnosticsLogSchema = Schema.Array(DownloadTraceEntry)

/** Tolerant decode of persisted JSON → event log. A corrupt/foreign shape — including
 *  a single corrupt element inside an otherwise-valid array — never throws; the WHOLE
 *  decode falls back to `[]`, mirroring `history/store.ts`'s `decodeStore`. */
export function decodeReleaseDiagnostics(raw: unknown): ReadonlyArray<DownloadTraceEntry> {
  try {
    return Schema.decodeUnknownSync(ReleaseDiagnosticsLogSchema)(raw)
  } catch {
    return []
  }
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
 */
export function composeDiagnosticsExport(
  entries: ReadonlyArray<DownloadTraceEntry>,
  now: number,
): { ok: boolean; filename: string; text: string } {
  if (entries.length === 0) return { ok: false, filename: '', text: '' }
  const text = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  return { ok: true, filename: `xmd-release-diagnostics-${utcStamp(now)}.jsonl`, text }
}
