import { Option } from 'effect'
import type { ClearScope } from '../schema/clear'

/** A list-membership scope cleared by one verified button flip. */
export type MembershipScope = Exclude<ClearScope, 'notInterested'>

/**
 * The membership Worklist scope for an X List page. Manual Sweep is list-only;
 * the broader DOM-aware download policy stays in `clearer.ts`.
 */
export function pageScope(pathname: string): Option.Option<MembershipScope> {
  if (/\/likes\/?$/.test(pathname)) return Option.some('like')
  if (/\/bookmarks(\/|$)/.test(pathname)) return Option.some('bookmark')
  return Option.none()
}
