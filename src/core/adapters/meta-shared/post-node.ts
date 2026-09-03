/**
 * Generic "post" identity for Instagram/Threads. Both surface a numeric `pk`
 * plus a separate URL `code`/shortcode alongside a post's media — research-
 * documented (see the "Post id shape" row of
 * docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md). This
 * walker additionally assumes `user.username` sits on the SAME node as
 * `code` — an implementation choice for a single-shape gate, NOT itself
 * stated by the cited research — see the caveat below. The walk itself is
 * structural/envelope-agnostic like X's own `forEachTweetNode`
 * (core/adapters/x/walk.ts): it doesn't assume where in the response tree a
 * post lives, it recognizes ONE by shape and recurses everywhere else.
 *
 * A useful side effect of the plain recursive walk: a Threads quote-post's
 * `quoted_post`/`reposted_post` sub-object — if it ALSO carries its own
 * `code`+`user` — gets visited as its own independent post automatically, no
 * special-casing needed (research recommends resolving both the quoting and
 * the quoted post's media).
 *
 * NEEDS LIVE VERIFICATION before this is relied on for real detection: the
 * `pk`+`code` split is research-documented; the `code`+`user.username`
 * co-location this walker gates on is this implementation's own structural
 * assumption, not independently confirmed against a live response by this
 * codebase. If a real response places the author elsewhere (an `items[]`
 * envelope, an `owner` key, or absent on an ad-mixed wrapper node),
 * `postContext` returns `null` and that node's posts go undetected.
 */

import type { JsonObject, JsonValue } from '@/packages/schema'
import { isJsonNumber, isJsonObject, isJsonString } from '../json-predicates'

export interface PostContext {
  /** Stable numeric-or-string id (`pk`), falling back to the shortcode when absent. */
  readonly postId: string
  /** The URL shortcode (`/p/{code}/`, `/reel/{code}/`, `/post/{code}`). */
  readonly code: string
  readonly author: string
}

function postContext(node: JsonObject): PostContext | null {
  const code = node['code']
  const user = node['user']
  if (!isJsonString(code) || code === '' || !isJsonObject(user)) return null
  const username = user['username']
  if (!isJsonString(username) || username === '') return null
  const pk = node['pk']
  const postId = isJsonString(pk) || isJsonNumber(pk) ? String(pk) : code
  return { postId, code, author: username }
}

/** Whether `node` itself carries a post identity (own `code`+`user.username`).
 *  Exported so `detect.ts` can stop a post's OWN media resolution from
 *  descending into a `carousel_media` child that is independently post-shaped
 *  (a nested repost/quote embedded as a carousel item) — that child is only
 *  ever this outer post's media when it has no post identity of its own;
 *  otherwise `forEachPostNode`'s own recursion already visits it separately. */
export function hasPostIdentity(node: JsonValue): boolean {
  return isJsonObject(node) && postContext(node) !== null
}

/** One depth-first walk of an arbitrary Instagram/Threads API/GraphQL
 *  response, yielding one visit per post-shaped node found. A `WeakSet` of
 *  already-descended objects guards against a circular reference (JSON.parse
 *  output never produces one, but this walker takes an arbitrary parsed
 *  {@link JsonValue} and the design spec's error-handling contract requires
 *  failing closed rather than throwing into the tee's dispatch loop — see
 *  media-node.ts's own identical carousel-recursion gap, fixed the same way
 *  in detect.ts). */
export function forEachPostNode(
  json: JsonValue,
  visit: (ctx: PostContext, node: JsonObject) => void,
): void {
  const visiting = new WeakSet<JsonObject>()
  const walk = (node: JsonValue): void => {
    if (Array.isArray(node)) {
      for (const v of node) walk(v)
      return
    }
    if (!isJsonObject(node)) return
    if (visiting.has(node)) return
    visiting.add(node)
    const ctx = postContext(node)
    if (ctx) visit(ctx, node)
    for (const v of Object.values(node)) walk(v)
  }
  walk(json)
}
