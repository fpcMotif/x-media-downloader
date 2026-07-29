// Single source of truth for every verb/confirm/status string the popup +
// options surfaces render for the Stage redesign's three-verb system (Reset /
// Erase / Release — design contract line 3). Pure string builders only: no
// JSX, no state, no browser API. The one runtime dependency is `plural` from
// capture-copy.ts (already the shared pluralization helper for the capture
// surfaces). The list-scope link is type-only and disappears from runtime
// bundles. This module therefore stays safe for both popup and options trees
// without importing the popup tree back into shared components.
//
// Copy is copied verbatim from spec §2.3 — implementers of Batch B/C should
// import these builders rather than re-typing the sentences inline.

import { plural } from '@/components/capture-copy'
import type { MembershipScope } from '@/core/clear/scope'

// ── Preferences zone — Release-after-download toggle-ON gate (§2.3, §3.3) ──

export const turnOnReleaseConfirm =
  'Turn on release after download? Each saved post will also be removed from its list (un-like on Likes, un-bookmark on Bookmarks) once its media is verified saved.'

export const TURN_ON_RELEASE_LABEL = 'Turn it on'

// ── Stage — download status line (§2.3 "Stage — download status line") ──

export const drainResult = (n: number, willClear: boolean): string => {
  if (n === 0) return 'No media detected yet — scroll to load posts, then try again.'
  return willClear
    ? `Downloading ${plural(n, 'item')} — each post releases as it finishes.`
    : `Downloading ${plural(n, 'item')}.`
}

export interface SweepResult {
  readonly queued?: number
  readonly skipped?: number
  readonly reason?: string
}

export const sweepResult = (res: SweepResult | null, willClear: boolean): string => {
  if (res?.reason === 'not-list-page')
    return 'Open a Likes or Bookmarks page — the sweep only runs on a list.'
  if (res?.reason === 'context') return SWEEP_STALE_CONTEXT
  const q = res?.queued ?? 0
  const s = res?.skipped ?? 0
  if (q === 0 && s === 0) return 'No new media detected — scroll to load posts, then run again.'
  if (willClear) {
    const skippedClause = s > 0 ? `, skipped ${s} already released` : ''
    return `Queued ${plural(q, 'post')}${skippedClause}. Each releases from this list as its download finishes — scroll and run again.`
  }
  return `Queued ${plural(q, 'post')} for download. Turn on "Release after download" below to also remove each from this list.`
}

export const PAGE_UNREACHABLE = 'Could not reach the page — reload the X tab and try again.'
export const NO_ACTIVE_TAB = 'No active tab.'
export const SWEEP_STALE_CONTEXT = 'Reload the X tab (the extension was updated), then try again.'
export const DOWNLOAD_START_FAILED =
  'The download could not start in the background — reload the X tab and try again.'
export const INVALID_RESPONSE =
  'The page returned an unexpected response — reload the X tab and try again.'

// ── Cluster status lifecycle (§2.6) ──

/** The actionable errors that must survive the 6s auto-clear: they persist
 *  until the next action in that same cluster starts (spec §2.6's
 *  persist-list). Every other status line self-clears after 6s. */
const PERSISTENT_STATUS_MESSAGES: ReadonlySet<string> = new Set([
  PAGE_UNREACHABLE,
  NO_ACTIVE_TAB,
  SWEEP_STALE_CONTEXT,
  DOWNLOAD_START_FAILED,
  INVALID_RESPONSE,
])

export const isPersistentStatus = (m: string | null): boolean =>
  m !== null && PERSISTENT_STATUS_MESSAGES.has(m)

// ── Context strip (§2.3 "Context strip") ──

/** Narrow local mirror of `popup/context.ts`'s `TabContext` — kept as an
 *  inline literal union (not imported) so this module has no dependency on
 *  the popup tree; the two types are structurally identical. */
export type ContextLabelInput = 'x-list' | 'x' | 'instagram' | 'threads' | 'none'

/** The list-page scope rendered in the context label. */
export type ContextLabelScope = MembershipScope

export const contextLabel = (ctx: ContextLabelInput, scope?: ContextLabelScope): string => {
  switch (ctx) {
    case 'x-list':
      if (scope === 'bookmark') return 'X · Bookmarks list'
      if (scope === 'like') return 'X · Likes list'
      return 'X · list page'
    case 'x':
      return 'X · ready'
    case 'instagram':
      return 'Instagram · ready'
    case 'threads':
      return 'Threads · ready'
    case 'none':
      return 'Not on X, Instagram, or Threads'
  }
}

// ── Teaching copy (§2.3 "First-run strip", "Stage — IG/Threads teaching") ──

export type QuickGrabModifier = 'alt' | 'shift' | 'ctrl' | 'meta'

const MODIFIER_LABEL: Record<QuickGrabModifier, string> = {
  alt: 'Alt',
  shift: 'Shift',
  ctrl: 'Control',
  meta: 'Cmd',
}

/** `{mod}` — the quick-grab modifier's display name, same mapping general.tsx
 *  uses for its Select options (just shorter labels for prose). */
export const modifierLabel = (mod: QuickGrabModifier): string => MODIFIER_LABEL[mod]

/** `{mod2}` — the whole-post second key: mirrors general.tsx line 44
 *  (`quickGrabModifier === 'meta' ? 'Alt' : 'Cmd'`). */
export const secondModifierLabel = (mod: QuickGrabModifier): string =>
  mod === 'meta' ? 'Alt' : 'Cmd'

export const hoverGrabLine = (mod: string): string =>
  `Hover a photo or video and hold ${mod} to grab it.`

export const wholePostLine = (mod: string, mod2: string): string =>
  `Hold ${mod} + ${mod2} to grab a whole post, or use the download dock.`

export const firstRunBody = (mod: string): string =>
  `Hover a photo or video and hold ${mod} to grab it. The buttons below handle the whole page.`
