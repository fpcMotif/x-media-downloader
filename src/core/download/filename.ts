import type { MediaItem } from '../schema'

// Intentional: strip control chars + filesystem-illegal chars from path segments.
// oxlint-disable-next-line no-control-regex
const ILLEGAL = /[\x00-\x1f:*?"<>|\\]/g

/** Sanitize one path segment: drop illegal chars and any `..` back-reference. */
export function sanitizeSegment(seg: string): string {
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
  // Sanitize every `/`-separated segment and drop the empties → a safe relative path.
  const toRelPath = (raw: string): string =>
    raw
      .split('/')
      .map(sanitizeSegment)
      .filter((s) => s.length > 0)
      .join('/')
  const path = toRelPath(template.replace(/\{(\w+)\}/g, (_, key: string) => tokens[key] ?? ''))
  if (path.length > 0) return path
  // The template sanitized away to nothing — run the id/index fallback through the
  // SAME pipeline so a degenerate tweetId can't reintroduce a `..`, an illegal char,
  // or a `/` and break the relative-path contract; a final default covers all-empty.
  const fallback = toRelPath(`${item.tweetId}_${item.index}.${item.ext}`)
  return fallback.length > 0 ? fallback : `media_${item.index}`
}
