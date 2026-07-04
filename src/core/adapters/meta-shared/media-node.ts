/**
 * Structural media-node walker shared by the (not-yet-built) Instagram and
 * Threads adapters — NOT by X. Both platforms' backends serialize a post's
 * media as `image_versions2.candidates[]` (photo), `video_versions[]`
 * (video), or `carousel_media[]` (a multi-media post, each child recursively
 * shaped the same way) — literally the same field names, since Threads runs
 * on Instagram's backend (confirmed by research, see
 * docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md).
 *
 * Deliberately does NOT hardcode which envelope wraps a post (`items[0]` vs
 * `data.xdt_shortcode_media` vs `edges[].node` vs a `thread_items` entry) —
 * that differs by surface/version and is each platform adapter's own
 * responsibility to locate. This walker only extracts media from ONE
 * already-located post-shaped object.
 */

export interface MetaMediaCandidate {
  readonly url: string
  readonly width?: number
  readonly height?: number
}

export interface MetaMediaNode {
  readonly kind: 'photo' | 'video'
  readonly url: string
  readonly width?: number
  readonly height?: number
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null

const isCandidate = (v: unknown): v is MetaMediaCandidate =>
  isObj(v) && typeof v['url'] === 'string'

/**
 * The largest candidate by width×height (undimensioned candidates rank as
 * 0×0, so any dimensioned candidate beats one with none). First-wins on a
 * tie — mirrors the same "neither beats the other, first stays best" rule
 * this project's X resolver already uses for undimensioned mp4 variants.
 * `undefined` for an empty array.
 */
const candidateArea = (c: MetaMediaCandidate): number => (c.width ?? 0) * (c.height ?? 0)

export function pickLargestCandidate(
  candidates: ReadonlyArray<MetaMediaCandidate>,
): MetaMediaCandidate | undefined {
  if (candidates.length === 0) return undefined
  return candidates.reduce((best, c) => (candidateArea(c) > candidateArea(best) ? c : best))
}

const candidatesOf = (v: unknown): MetaMediaCandidate[] =>
  Array.isArray(v) ? v.filter(isCandidate) : []

/** Build a MetaMediaNode from a picked candidate — `width`/`height` are added
 *  only when present (exactOptionalPropertyTypes forbids an explicit
 *  `undefined` on an optional property). */
const nodeFromCandidate = (kind: 'photo' | 'video', c: MetaMediaCandidate): MetaMediaNode => ({
  kind,
  url: c.url,
  ...(c.width !== undefined ? { width: c.width } : {}),
  ...(c.height !== undefined ? { height: c.height } : {}),
})

/**
 * Extract the MediaItem-precursor node(s) from one post-shaped object: a
 * single photo, a single video, or — for a `carousel_media[]` post — every
 * child's own media, flattened in order. `[]` for a node with none of the
 * three shapes (or a malformed one), so a caller can pass anything without
 * a defensive check of its own.
 *
 * A `WeakSet` of already-descended objects guards the `carousel_media`
 * recursion against a circular reference (fails closed — returns `[]` for the
 * repeat visit — rather than a stack overflow; mirrors the identical guard on
 * `post-node.ts`'s `forEachPostNode`. Not reachable via the real JSON.parse
 * call path, but this function takes arbitrary `unknown`).
 */
export function mediaNodesFromPost(node: unknown, visiting = new WeakSet<Obj>()): MetaMediaNode[] {
  if (!isObj(node)) return []
  if (visiting.has(node)) return []
  visiting.add(node)

  const carousel = node['carousel_media']
  if (Array.isArray(carousel) && carousel.length > 0) {
    return carousel.flatMap((child) => mediaNodesFromPost(child, visiting))
  }

  const videoVersions = candidatesOf(node['video_versions'])
  if (videoVersions.length > 0) {
    const best = pickLargestCandidate(videoVersions)
    /* v8 ignore next -- videoVersions.length > 0 guarantees pickLargestCandidate returns a value */
    if (!best) return []
    return [nodeFromCandidate('video', best)]
  }

  const imageVersions2 = node['image_versions2']
  const imageCandidates = isObj(imageVersions2) ? candidatesOf(imageVersions2['candidates']) : []
  if (imageCandidates.length > 0) {
    const best = pickLargestCandidate(imageCandidates)
    /* v8 ignore next -- imageCandidates.length > 0 guarantees pickLargestCandidate returns a value */
    if (!best) return []
    return [nodeFromCandidate('photo', best)]
  }

  return []
}
