import type { ClearLogOutcome } from '@/core/clear/log-client'

const RECENT_LIMIT = 3

const scopeLabel = (scope: 'bookmark' | 'like' | 'notInterested'): string =>
  ({ bookmark: 'Bookmark', like: 'Like', notInterested: 'For You' })[scope]

const fmtTime = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

export function ClearLogSection({ log }: { log: ClearLogOutcome | null }) {
  return (
    <section aria-label="Clear log" className="grid gap-2 border-t border-border px-3.5 py-4">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground">
        Clear log
      </span>

      {log === null ? (
        <output className="text-xs text-muted-foreground">Loading verified clears…</output>
      ) : log.status === 'unavailable' ? (
        <p className="text-xs leading-snug text-muted-foreground">Clear log unavailable.</p>
      ) : log.records.length === 0 ? (
        <p className="text-xs leading-snug text-muted-foreground">No verified clears yet.</p>
      ) : (
        <ol className="grid gap-2" aria-label="Latest verified clears">
          {log.records.slice(0, RECENT_LIMIT).map((record) => (
            <li
              key={`${record.tweetId}/${record.scope}`}
              className="flex items-start justify-between gap-3 text-xs"
            >
              <span className="min-w-0">
                <span className="font-medium">{scopeLabel(record.scope)}</span>
                <span className="font-mono tabular-nums text-muted-foreground">
                  {' '}
                  · {fmtTime(record.at)}
                </span>
              </span>
              <a
                href={record.permalink}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-sm text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                Post
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
