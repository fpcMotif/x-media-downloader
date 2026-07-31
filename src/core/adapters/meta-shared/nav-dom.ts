/**
 * Keyboard Navigation (issue #58) — the DOM read seam: turning the live page
 * into the pure machine's {@link NavSnapshot}. Pure reads only — no clicks, no
 * mutation, no timers (the overlay controller owns all three). Every function
 * re-queries its root fresh on each call: Threads' virtualization recycles
 * post containers between reads (see `post-anchor.ts`'s module doc), so no
 * result of one call may inform a later one.
 *
 * The column heuristic is platform-neutral: a COLUMN is a non-post subtree of
 * a common ancestor that (a) contains posts and (b) has at least one sibling
 * subtree that also contains posts, with strictly fewer such subtrees than
 * posts — clause (b) is what keeps a single feed that wraps every post in its
 * own div reading as ONE column (each wrapper holds exactly one post), while
 * Threads' multi-column layout (many posts per feed column) groups correctly.
 * Unknown/degraded layouts fall back to a single implicit column so j/k
 * always works even when ←/→ has nothing to switch between.
 */
import type { NavSnapshot } from '../../nav/machine'

/** One enumerated feed column: its posts in document order. `container` is
 *  null for the single implicit column (single-column platforms, degraded
 *  layouts) — the "no grouping found" shape, distinct from a real column. */
export interface NavColumnDom {
  readonly container: Element | null
  readonly posts: Element[]
}

/**
 * The column subtree containing `post`: the child of the nearest ancestor
 * whose children split into ≥2 post-bearing, non-post subtrees holding MORE
 * posts in total than there are such subtrees — or null when no such ancestor
 * exists up to (and excluding) `stopAt`, meaning the post lives in a single
 * un-grouped feed.
 */
function columnGroupOf(post: Element, postSelector: string, stopAt: ParentNode): Element | null {
  let child: Element = post
  let el: Element | null = post.parentElement
  while (el !== null && el !== stopAt) {
    const groups = [...el.children].filter(
      (c) => !c.matches(postSelector) && c.querySelector(postSelector) !== null,
    )
    const postsInside = el.querySelectorAll(postSelector).length
    if (groups.length >= 2 && postsInside > groups.length && !child.matches(postSelector)) {
      return child
    }
    child = el
    el = el.parentElement
  }
  return null
}

/**
 * Every post under `root`, grouped into columns left→right (first-appearance
 * order), posts top→bottom within each column. Zero posts → `[]`; no grouping
 * → one implicit column holding every post in document order.
 */
export function enumerateNavColumns(root: ParentNode, postSelector: string): NavColumnDom[] {
  const posts = [...root.querySelectorAll(postSelector)]
  if (posts.length === 0) return []
  const byContainer = new Map<Element | null, Element[]>()
  for (const post of posts) {
    const container = columnGroupOf(post, postSelector, root)
    const bucket = byContainer.get(container)
    if (bucket) bucket.push(post)
    else byContainer.set(container, [post])
  }
  return [...byContainer.entries()].map(([container, columnPosts]) => ({
    container,
    posts: columnPosts,
  }))
}

/**
 * The machine-facing snapshot for enumerated columns. `idOf` supplies the
 * platform post shortcode (re-read fresh per sync); posts without one get a
 * positional `anon-<column>-<index>` id, degrading reconcile to
 * nearest-survivor-by-index — the same outcome a stable id would produce.
 */
export function buildNavSnapshot(
  columns: ReadonlyArray<NavColumnDom>,
  idOf: (post: Element) => string | null,
): NavSnapshot {
  return {
    columns: columns.map((column, colIdx) => ({
      posts: column.posts.map((post, postIdx) => ({
        id: idOf(post) ?? `anon-${colIdx}-${postIdx}`,
      })),
    })),
  }
}

/**
 * A post's carousel prev/next buttons, by their English `aria-label`s
 * ("Go back" / "Next") — Meta's shared design system gives Instagram and
 * Threads carousels the same labels. LOCALE-FRAGILE by construction: a
 * non-English UI labels these differently, the controls simply don't resolve,
 * and the spatial keys degrade to column movement (never a wrong click).
 * Selector ownership stays here so a label rename is a one-line fix.
 */
export function carouselControlsByAria(post: Element): {
  readonly prev: Element | null
  readonly next: Element | null
} {
  return {
    prev: post.querySelector('button[aria-label="Go back"]'),
    next: post.querySelector('button[aria-label="Next"]'),
  }
}

/**
 * The first in-post control carrying any of `labels` as its `aria-label` —
 * the like/reply/repost action lookup behind the adapters' nav descriptors.
 * Same locale fragility as {@link carouselControlsByAria}, same fail-safe:
 * no match → no command → nothing happens.
 */
export function actionControlByAria(post: Element, labels: ReadonlyArray<string>): Element | null {
  for (const label of labels) {
    const control = post.querySelector(`[aria-label="${label}"]`)
    if (control !== null) return control
  }
  return null
}
