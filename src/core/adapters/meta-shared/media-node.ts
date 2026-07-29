import { MAX_MEDIA_DIMENSION, MAX_MEDIA_URL_LENGTH } from '../../schema/media'

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

/** A real post has few variants/carousel entries; larger hostile shapes are dropped. */
export const MAX_MEDIA_NODES_PER_POST = 64
const MAX_MEDIA_CANDIDATES_PER_NODE = 128

const isDimension = (value: unknown): value is number | undefined =>
  value === undefined ||
  (typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_MEDIA_DIMENSION)

const isCandidate = (v: unknown): v is MetaMediaCandidate =>
  isObj(v) &&
  typeof v['url'] === 'string' &&
  v['url'].length > 0 &&
  v['url'].length <= MAX_MEDIA_URL_LENGTH &&
  isDimension(v['width']) &&
  isDimension(v['height'])

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

const candidatesOf = (v: unknown): MetaMediaCandidate[] | undefined => {
  if (!Array.isArray(v)) return []
  if (v.length > MAX_MEDIA_CANDIDATES_PER_NODE) return undefined
  return v.filter(isCandidate)
}

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
 * An explicit stack plus output and candidate caps bounds hostile carousels.
 * Repeated objects are skipped, so arbitrary caller input cannot recurse.
 */
export function mediaNodesFromPost(node: unknown): MetaMediaNode[] | undefined {
  const visiting = new WeakSet<Obj>()
  const stack: unknown[] = [node]
  const output: MetaMediaNode[] = []
  try {
    while (stack.length > 0) {
      const current = stack.pop()
      if (!isObj(current)) continue
      if (visiting.has(current)) continue
      visiting.add(current)
      const carousel = current['carousel_media']
      if (Array.isArray(carousel) && carousel.length > 0) {
        if (carousel.length > MAX_MEDIA_NODES_PER_POST) return undefined
        for (let index = carousel.length - 1; index >= 0; index -= 1) stack.push(carousel[index])
        continue
      }

      const videoVersions = candidatesOf(current['video_versions'])
      if (videoVersions === undefined) return undefined
      if (videoVersions.length > 0) {
        const best = pickLargestCandidate(videoVersions)
        /* v8 ignore next -- videoVersions.length > 0 guarantees pickLargestCandidate returns a value */
        if (best) output.push(nodeFromCandidate('video', best))
      } else {
        const imageVersions2 = current['image_versions2']
        const imageCandidates = candidatesOf(
          isObj(imageVersions2) ? imageVersions2['candidates'] : undefined,
        )
        if (imageCandidates === undefined) return undefined
        if (imageCandidates.length > 0) {
          const best = pickLargestCandidate(imageCandidates)
          /* v8 ignore next -- imageCandidates.length > 0 guarantees pickLargestCandidate returns a value */
          if (best) output.push(nodeFromCandidate('photo', best))
        }
      }
      if (output.length > MAX_MEDIA_NODES_PER_POST) return undefined
    }
  } catch {
    return undefined
  }
  return output
}
