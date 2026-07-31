import type { MediaItem, Platform } from '@/packages/schema'
import { mediaNodesFromPost } from './media-node'
import { forEachPostNode, isPostShaped } from './post-node'

/* v8 ignore next -- String.split always yields a non-empty array; `?? url` is unreachable */
const stripQuery = (url: string): string => url.split('?')[0] ?? url

/** The stable media key for an Instagram/Threads CDN url — the final path
 *  segment without its extension. Mirrors X's own `mediaKeyFromUrl` role
 *  (dedup + identity), generalized since neither platform's exact CDN path
 *  shape has been live-verified yet. */
function mediaKeyFromUrl(url: string): string {
  const path = stripQuery(url)
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(0, dot) : base
}

function extFromUrl(url: string, fallback: string): string {
  const path = stripQuery(url)
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot >= 0 ? base.slice(dot + 1) : fallback
}

/** `node`'s own `carousel_media`, with any entry that is independently
 *  post-shaped (own `code`+`user.username` — a nested repost/quote embedded
 *  as a carousel item) removed. Those children are never this post's OWN
 *  media: `forEachPostNode`'s recursive walk already visits them separately
 *  (as their own post, under their own postId), so leaving them in would
 *  double-count them under BOTH the outer post and their own. Cheap for the
 *  overwhelmingly common case (no carousel, or a carousel of plain media
 *  nodes): `Array.isArray` + an already-required object check, no-op copy. */
function ownMediaNode(node: Record<string, unknown>): Record<string, unknown> {
  const carousel = node['carousel_media']
  if (!Array.isArray(carousel)) return node
  const filtered = carousel.filter((child) => !isPostShaped(child))
  if (filtered.length === carousel.length) return node
  return { ...node, carousel_media: filtered }
}

/**
 * The full `PlatformAdapter.detectFromResponse` pipeline for Instagram AND
 * Threads — identical apart from the `platform` tag, since both share the
 * same backend media schema (confirmed by research). Walks every post-shaped
 * node in the response (`forEachPostNode`), resolves each post's OWN media
 * (`mediaNodesFromPost`, recursing through `carousel_media` — excluding any
 * child that is itself post-shaped, see {@link ownMediaNode}), and builds one
 * MediaItem per resolved media node, indexed per-post (0-based, matching X's
 * per-tweet indexing convention). Dedup is scoped PER POST ID, not response-
 * wide: two distinct posts that happen to reference the identical CDN url
 * (e.g. a bare repost sharing its original's asset) each still get their own
 * MediaItem — only the same post's own media resolution collapses a url seen
 * twice within itself (including when the walk visits that same post more
 * than once, e.g. a self-referential wrapper).
 *
 * Like post-node.ts's own walker, this pipeline is structurally sound per
 * 2024-2025 reverse-engineering research, not independently verified against
 * a live Instagram/Threads response — real adapter integration must
 * re-verify the envelope/media shapes against live network captures.
 */
export function detectMediaItems(json: unknown, platform: Platform): MediaItem[] {
  const out: MediaItem[] = []
  const seenByPost = new Map<string, Set<string>>()
  let postsFound = 0
  forEachPostNode(json, (ctx, node) => {
    postsFound++
    let seen = seenByPost.get(ctx.postId)
    if (!seen) {
      seen = new Set<string>()
      seenByPost.set(ctx.postId, seen)
    }
    const mediaBefore = out.length
    mediaNodesFromPost(ownMediaNode(node)).forEach((m, index) => {
      const id = mediaKeyFromUrl(m.url)
      if (id === '' || seen.has(id)) return
      seen.add(id)
      out.push({
        id,
        platform,
        postId: ctx.postId,
        author: ctx.author,
        type: m.kind === 'video' ? 'video' : 'photo',
        url: m.url,
        ext: extFromUrl(m.url, m.kind === 'video' ? 'mp4' : 'jpg'),
        index,
        ...(m.width !== undefined ? { width: m.width } : {}),
        ...(m.height !== undefined ? { height: m.height } : {}),
      })
    })
    if (import.meta.env.DEV && out.length > mediaBefore)
      console.debug(
        `[XMD] detect · ${platform} · post ${ctx.postId} (@${ctx.author}) → ${out.length - mediaBefore} media item(s)`,
      )
  })
  if (import.meta.env.DEV)
    console.debug(
      `[XMD] detect · ${platform} · ${postsFound} post(s) found → ${out.length} media item(s) total`,
    )
  return out
}

/**
 * Per-post `code` (URL shortcode) for every postId detected in this response,
 * so a DOM-derived shortcode (which the hover-path walker never sees, only
 * `postId` does) can be mapped back to the tee's `postId` identity — see
 * `PlatformAdapter.extractPostCodes` and `DetectionStore.registerPostCode`.
 * Companion to `detectMediaItems` — same underlying walk (`forEachPostNode`),
 * called from the same response, kept as a separate pure function (not merged
 * into `detectMediaItems`'s signature) so that function's existing, already-
 * tested `MediaItem[]` return shape stays untouched.
 */
export function postCodesInResponse(json: unknown): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  forEachPostNode(json, (ctx) => out.set(ctx.postId, ctx.code))
  return out
}
