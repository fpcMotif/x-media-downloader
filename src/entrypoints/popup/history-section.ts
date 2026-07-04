import type { DownloadRecord } from '../../core/history/record'

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
  if (count === 0) return 'No downloads yet'
  return ''
}

/** Ask the background for the durable download history; never throws (returns [] on failure). */
export async function fetchHistory(): Promise<ReadonlyArray<DownloadRecord>> {
  return browser.runtime
    .sendMessage({ _tag: 'HistoryRequest' })
    .then((r) => (r as { records?: ReadonlyArray<DownloadRecord> } | null)?.records ?? [])
    .catch(() => [])
}
