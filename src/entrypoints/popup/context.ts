import { Option } from 'effect'
import { adapterForUrl } from '@/core/adapters/registry'
import { pageScope, type MembershipScope } from '@/core/clear/clearer'
import { contextLabel as contextLabelCopy } from '@/components/action-copy'

/** The popup's tab-context state matrix (spec §2.2) — the single input that
 *  decides which zones render. `x-list` is a strict subset of `x` (an X list
 *  page unlocks the Release cluster's whole-list row on top of everything a
 *  plain X tab gets). */
export type TabContext = 'x-list' | 'x' | 'instagram' | 'threads' | 'none'

/** Derive the popup's tab context from a tab URL — the single seam between
 *  the platform-adapter registry + the X list-page scope check (`pageScope`)
 *  and the popup's zone-rendering decisions. Never throws: an unparsable URL
 *  (e.g. a `chrome://` page, or `tabs.query` racing a navigating tab) is
 *  simply `'none'`, same as a tab with no matching adapter at all. */
export function tabContext(url: string): TabContext {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return 'none'
  }
  const adapter = adapterForUrl(url)
  if (!adapter) return 'none'
  const { platform } = adapter
  if (platform !== 'x') return platform
  return Option.isSome(pageScope(pathname)) ? 'x-list' : 'x'
}

/** The X list scope (Likes vs Bookmarks) for a tab URL — `undefined` off a
 *  list page, off X entirely, or for an unparsable URL. Feeds `contextLabel`'s
 *  optional second argument for the `x-list` context. */
export function tabScope(url: string): MembershipScope | undefined {
  try {
    return Option.getOrUndefined(pageScope(new URL(url).pathname))
  } catch {
    return undefined
  }
}

/** Whether a context is one of the two X contexts (`x` / `x-list`) — the
 *  gate for every X-only zone (Release cluster, Release/Capture preference
 *  rows). */
export function isXContext(ctx: TabContext): boolean {
  return ctx === 'x-list' || ctx === 'x'
}

// Context-strip copy is owned by action-copy.ts (the single source for
// verb/confirm/label strings across popup + options); re-exported here so
// callers deriving TabContext and rendering its label can both import from
// this one module.
export const contextLabel = contextLabelCopy
