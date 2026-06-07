import type { MediaItem } from '../schema'

// Intentional: strip control chars + filesystem-illegal chars from path segments.
// oxlint-disable-next-line no-control-regex
const ILLEGAL = /[\x00-\x1f:*?"<>|\\]/g

/** Sanitize one path segment: drop illegal chars and any `..` back-reference. */
function sanitizeSegment(seg: string): string {
  return seg
    .replace(ILLEGAL, '')
    .replace(/\.{2,}/g, '.') // collapse `..` → `.` (kills back-references)
    .replace(/^\.+/, '') // no leading dots
    .trim()
}

/**
 * Render a filename from a template and a MediaItem. Tokens:
 * `{handle} {tweetId} {index} {ext} {type} {date}`. Unknown tokens render empty.
 *
 * Output is always a RELATIVE path (no leading `/`, no `..`, never empty) —
 * `chrome.downloads.download` throws otherwise (ADR-0003, grounding §d).
 */
export function renderFilename(template: string, item: MediaItem, date?: string): string {
  const tokens: Record<string, string> = {
    handle: item.handle,
    tweetId: item.tweetId,
    index: String(item.index),
    ext: item.ext,
    type: item.type,
    date: date ?? '',
  }
  const raw = template.replace(/\{(\w+)\}/g, (_, key: string) => tokens[key] ?? '')
  const path = raw
    .split('/')
    .map(sanitizeSegment)
    .filter((s) => s.length > 0)
    .join('/')
  return path.length > 0 ? path : `${item.tweetId}_${item.index}.${item.ext}`
}
