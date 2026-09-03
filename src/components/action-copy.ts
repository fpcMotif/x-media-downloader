// Single source of truth for every verb/confirm/status string the popup +
// options surfaces render for the Stage redesign's three-verb system (Reset /
// Erase / Release — design contract line 3). Pure string builders only: no
// JSX, no state, no browser API. The one runtime dependency is `plural` from
// capture-copy.ts (already the shared pluralization helper for the capture
// surfaces) — everything else here is self-contained so this module can be
// imported from either the popup or options trees without pulling in adapter
// registry / schema types (which would risk a circular import back out to
// `popup/context.ts`, the other consumer of these strings).
//
// Copy is copied verbatim from spec §2.3 — implementers of Batch B/C should
// import these builders rather than re-typing the sentences inline.

import { plural } from '@/components/capture-copy'

/** The one typed-word gate in the product (whole-list release). */
export const RELEASE_WORD = 'RELEASE'

// ── Release cluster (§2.3 "Release cluster") ──

export const releasePageConfirm =
  "Release every post on this page — un-like on Likes, un-bookmark on Bookmarks. This can't be undone."

export const releaseListConfirm =
  "Release the whole list — scrolls the entire list and releases every post. This can affect hundreds of posts and can't be undone."

export const RELEASE_PAGE_CONFIRM_LABEL = 'Release this page'
export const RELEASE_LIST_CONFIRM_LABEL = 'Release the list'

export interface ReleasePageResult {
  readonly cleared?: number
  readonly reason?: string
}

export const releasedPageResult = (res: ReleasePageResult | null): string => {
  // Off a list page there is nothing this control CAN do, and it is the only
  // control the popup's off-list Release disclosure renders (spec §2.2) — so the
  // refusal has to read as a refusal. A count-only line ("Released 0 posts on
  // this page.") is success-shaped and made the dead trigger unfalsifiable.
  if (res?.reason === 'not-list-page')
    return 'Open a Likes or Bookmarks list — "Release this page" only runs on a list.'
  return `Released ${plural(res?.cleared ?? 0, 'post')} on this page.`
}

export interface ReleaseListResult {
  readonly cleared?: number
  readonly reason?: string
}

export const releasedListResult = (res: ReleaseListResult | null): string => {
  if (res?.reason === 'not-list-page') return 'Open a Likes or Bookmarks list to release it.'
  const n = res?.cleared ?? 0
  // A run the page navigated out from under stops early (list-clear's `scope-changed`).
  // Its count is a PARTIAL, so it must never render as the "across the list" sentence —
  // that reads as "the list is done" and is the whole reason the abort is surfaced.
  if (res?.reason === 'scope-changed')
    return `Stopped after ${plural(n, 'post')} — you left that list.`
  return n === 0
    ? 'No posts to release on this list.'
    : `Released ${plural(n, 'post')} across the list.`
}

// ── Preferences zone — Release-after-download toggle-ON gate (§2.3, §3.3) ──

export const turnOnReleaseConfirm =
  'Turn on release after download? Each saved post will also be removed from its list (un-like on Likes, un-bookmark on Bookmarks) once its media is verified saved.'

export const TURN_ON_RELEASE_LABEL = 'Turn it on'

// ── Stage — download status line (§2.3 "Stage — download status line") ──

/** The drain's TERMINAL reply (`DrainPageResponse`), which settles only after the
 *  background has answered — never the optimistic detection-store size the popup
 *  used to format from. */
export interface DrainResult {
  /** Items the page had detected when the press landed. */
  readonly count?: number
  /** Items the background actually scheduled work for. This — never `ok` — is the
   *  "did anything happen?" test: a fully-deduped batch answers `completed:0 total:0`,
   *  i.e. `ok === true`, with nothing downloading. */
  readonly admitted?: number
  readonly skipped?: number
  readonly ok?: boolean
  /** Whether the page the run happened on owns a list to release from (`pageScope`
   *  resolved). Absent ⇒ treated as off-list: never promise a release we can't see
   *  evidence for. */
  readonly onList?: boolean
}

export const drainResult = (res: DrainResult | null, willClear: boolean): string => {
  const count = res?.count ?? 0
  if (count === 0) return 'No media detected yet — scroll to load posts, then try again.'
  const admitted = res?.admitted ?? 0
  const failed = res?.ok === false
  // A release needs BOTH halves: `willClear` is the setting, `onList` is the page.
  // On a profile/search page `handleDrainPage` has already resolved the scope to null
  // and terminated the run as `clear-download-page-skip` — so the release sentence
  // there promises something the run itself already ruled out.
  const releases = willClear && res?.onList === true
  // Nothing scheduled AND the send failed ⇒ the request never landed (dead channel /
  // background throw), which is a different story from "everything was a duplicate"
  // and gets the actionable, persistent line. Order matters: both cases have
  // `admitted === 0`.
  if (admitted === 0)
    return failed
      ? DOWNLOAD_REQUEST_FAILED
      : releases
        ? `Nothing new to download — ${plural(count, 'item')} already saved or filtered, so nothing releases.`
        : `Nothing new to download — ${plural(count, 'item')} already saved or filtered.`
  if (failed) return `Queued ${plural(admitted, 'item')} — some failed to start.`
  if (releases)
    return `Downloading ${plural(admitted, 'item')} — each post releases as it finishes.`
  // Release is ON but this page has no list: say so, rather than silently dropping the
  // clause and leaving the user to wonder why nothing un-bookmarked.
  return willClear
    ? `Downloading ${plural(admitted, 'item')} — nothing releases off a Likes or Bookmarks list.`
    : `Downloading ${plural(admitted, 'item')}.`
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
  if (res?.reason === 'malformed-reply') return SWEEP_REQUEST_FAILED
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
/** The drain reached the page but the page could not reach the extension (dead
 *  runtime channel / a throw inside the background's DownloadRequest handler). */
export const DOWNLOAD_REQUEST_FAILED =
  'The download request never reached the extension — reload the X tab, then try again.'
/** The sweep reached the page, the page reached the extension, and the extension
 *  answered with something that is not a sweep result (a throw inside the
 *  background's SweepEnqueueRequest handler). Kept distinct from the empty-sweep
 *  line: nothing was queued because the extension failed, NOT because the list had
 *  nothing new — blaming the list would send the user scrolling for no reason. */
export const SWEEP_REQUEST_FAILED =
  'The sweep never reached the extension — reload the X tab, then try again.'

// ── Cluster status lifecycle (§2.6) ──

/** The actionable errors that must survive the 6s auto-clear: they persist
 *  until the next action in that same cluster starts (spec §2.6's
 *  persist-list). Every other status line self-clears after 6s. */
const PERSISTENT_STATUS_MESSAGES: ReadonlySet<string> = new Set([
  PAGE_UNREACHABLE,
  NO_ACTIVE_TAB,
  SWEEP_STALE_CONTEXT,
  DOWNLOAD_REQUEST_FAILED,
  SWEEP_REQUEST_FAILED,
])

export const isPersistentStatus = (m: string | null): boolean =>
  m !== null && PERSISTENT_STATUS_MESSAGES.has(m)

// ── Context strip (§2.3 "Context strip") ──

/** Narrow local mirror of `popup/context.ts`'s `TabContext` — kept as an
 *  inline literal union (not imported) so this module has no dependency on
 *  the popup tree; the two types are structurally identical. */
export type ContextLabelInput = 'x-list' | 'x' | 'instagram' | 'threads' | 'none'

/** Narrow local mirror of `MembershipScope` (`@/core/clear/clearer`) for the
 *  same reason: structural, not imported. */
export type ContextLabelScope = 'bookmark' | 'like'

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

const MODIFIER_LABEL = {
  alt: 'Alt',
  shift: 'Shift',
  ctrl: 'Control',
  meta: 'Cmd',
} satisfies Record<QuickGrabModifier, string>

/** `{mod}` — the quick-grab modifier's display name, same mapping saving.tsx
 *  uses for its Select options (just shorter labels for prose). */
export const modifierLabel = (mod: QuickGrabModifier): string => MODIFIER_LABEL[mod]

/** `{mod2}` — the whole-post second key: mirrors saving.tsx
 *  (`quickGrabModifier === 'meta' ? 'Alt' : 'Cmd'`). */
export const secondModifierLabel = (mod: QuickGrabModifier): string =>
  mod === 'meta' ? 'Alt' : 'Cmd'

export const hoverGrabLine = (mod: string): string =>
  `Hover a photo or video and hold ${mod} to grab it.`

export const wholePostLine = (mod: string, mod2: string): string =>
  `Hold ${mod} + ${mod2} to grab a whole post, or use the download dock.`

export const firstRunBody = (mod: string): string =>
  `Hover a photo or video and hold ${mod} to grab it. The buttons below handle the whole page.`
