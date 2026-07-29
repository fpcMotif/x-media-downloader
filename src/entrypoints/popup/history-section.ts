import type { DownloadRecord } from '../../core/history/record'
import { decodeHistoryResponse } from '../../core/history/store'
import { expectReply, safeSend } from '../../core/messaging'
import { plural } from '@/components/capture-copy'

/** Group download records by author handle, preserving newest-first order. */
export function groupByAuthor(
  records: ReadonlyArray<DownloadRecord>,
): ReadonlyArray<{ handle: string; records: ReadonlyArray<DownloadRecord> }> {
  const groups: { handle: string; records: DownloadRecord[] }[] = []
  const index = new Map<string, { handle: string; records: DownloadRecord[] }>()
  for (const r of records) {
    const existing = index.get(r.media.author)
    if (existing === undefined) {
      const group = { handle: r.media.author, records: [r] }
      index.set(r.media.author, group)
      groups.push(group)
    } else {
      existing.records.push(r)
    }
  }
  return groups
}

/** Project a record into the fields the popup renders (display time = finished ?? queued). */
export function formatRecord(r: DownloadRecord): {
  title: string
  link: string
  status: DownloadRecord['status']
  whenMs: number
} {
  return {
    title: r.filename,
    link: r.media.url,
    status: r.status,
    whenMs: r.finishedAt ?? r.queuedAt,
  }
}

/** Empty/disabled state text for the section. */
export function historyEmptyLabel(enabled: boolean, count: number): string {
  if (!enabled) return 'Turn on to keep a local history'
  if (count === 0) return 'No downloads yet — files you save will appear here.'
  return ''
}

// Erase (Tier 1 — local data wipe) is the verb here too: the options History
// panel's "Erase history…" previously wiped with NO confirmation at all
// (audit finding 9, P1) — this is its ConfirmStrip sentence.
export const confirmEraseHistoryCopy = (count: number): string =>
  `Erase all ${plural(count, 'download record')}? This cannot be undone. Files on disk are not touched.`

export type HistoryLoad =
  | { readonly status: 'available'; readonly records: ReadonlyArray<DownloadRecord> }
  | { readonly status: 'unavailable' }

const unavailableHistory = (): HistoryLoad => ({ status: 'unavailable' })

/** Ask the background for durable history. A missing or invalid reply is unavailable, never empty. */
export async function fetchHistory(): Promise<HistoryLoad> {
  const reply = expectReply(
    await safeSend(() => browser.runtime.sendMessage({ _tag: 'HistoryRequest' })),
  )
  if (reply.status !== 'ok') return unavailableHistory()
  const decoded = decodeHistoryResponse(reply.reply)
  return decoded === undefined
    ? unavailableHistory()
    : { status: 'available', records: decoded.records }
}

/** Erase durable history; views change only after the background confirms it. */
export async function requestHistoryErase(): Promise<boolean> {
  const reply = expectReply(
    await safeSend(() => browser.runtime.sendMessage({ _tag: 'ClearHistoryRequest' })),
  )
  return reply.status === 'ok' && isExactEraseHistoryReply(reply.reply)
}

const isExactEraseHistoryReply = (value: unknown): value is { readonly ok: true } => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === 1 && keys[0] === 'ok' && (value as { readonly ok?: unknown }).ok === true
}
