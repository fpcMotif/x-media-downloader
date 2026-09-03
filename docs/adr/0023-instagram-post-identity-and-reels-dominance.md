# ADR-0023 — Instagram post identity and Reels viewport dominance

- **Status:** Accepted (2026-07-06)
- **Builds on:** ADR-0019 (Platform identity derives from the adapter registry),
  `docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md`.

## Context

On Instagram, hover resolution maps a hovered DOM element (image, video poster,
or custom element) to its canonical post ID and media item.

In feed contexts, Instagram anchors each post inside a stable `<article>`
element carrying an `<a href="/p/{code}/">` link. Walking up from a hovered
element to its nearest `<article>` and parsing `/p/{code}/` yields the exact
post identity cleanly.

However, standalone permalinks and Reels pages break this invariant:

1. **Standalone permalinks (`/p/{code}/` and `/reel/{code}/`)** render zero
   `<article>` elements anywhere on the page (live-verified:
   `document.querySelector('article') === null`).
2. **Reels immersive player (`/reels/{code}/`)** is also `<article>`-less, but
   unlike standalone permalinks (which mount exactly 1 `<video>`), it mounts 2+
   sibling `<video>` elements simultaneously (observed between 2 and 11 across
   sessions). The ancestor chain from visible video to React mount root contains
   zero `data-*`, `id`, or `aria-*` identity, and no `<a href>` in the document
   carries the reel's code.

The current page's `location.pathname` is the only reliable signal of which
post/reel is active. However, blindly falling back to `pathname` creates two
hazards:

- **Suggested content on permalink pages:** A standalone `/p/{code}/` page may
  render a "More posts" section below the main post with links to other posts.
  If those secondary posts carried videos, a blind pathname fallback would
  misattribute them to the main post. (Live testing confirmed that the "More
  posts" section renders thumbnail images only; the page mounts exactly one
  video matching the real post).
- **Multiple mounted videos in Reels player:** In the Reels viewer, multiple
  sibling videos are mounted simultaneously (both active and off-screen
  preloaded videos). A naive pathname fallback assigns the current pathname to
  every mounted video element, collapsing all sibling media into the same post
  key.
- **Over-correction failure:** An earlier safeguard refused the pathname
  fallback whenever more than one `<video>` was reachable. Because Reels
  always mounts 2+ sibling videos, hover resolution broke completely on Reels
  (e.g., cannot download `instagram.com/reels/DaH4la4pRtC/`).

## Decision

1. **Standalone single-video permalink:** When no `<article>` ancestor exists
   and exactly one `<video>` is reachable from the root, trust `pathname`
   unconditionally.
2. **Reels player multi-video viewport dominance:** When 2+ `<video>` elements
   are reachable, trust `pathname` only for the **viewport-dominant video** —
   strictly the video with the largest visible-in-viewport area
   (`visibleAreaInViewport`), requiring visible area > 0.
   - An off-screen video has visible area 0 and is immediately excluded.
   - An exact area tie (during scroll transitions, or in headless/test environments
     with unmeasured zero rects) resolves to `null` on both sides rather than
     guessing.
3. **Detached testing compatibility:** Post ID resolution queries via
   `getRootNode()` rather than `el.ownerDocument` so detached fixture fragments
   behave correctly in test suites.

## Consequences

- Standalone Instagram permalinks and Reels pages resolve correct post IDs
  without `<article>` tags in the DOM.
- Off-screen preloaded Reels videos never misfire with the active reel's key.
- The 61-line architecture rationale in `adapter.ts` shrinks to the calling
  contract, referencing this ADR for provenance and tradeoffs.
