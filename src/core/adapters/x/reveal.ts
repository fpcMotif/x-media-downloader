/**
 * Find — and click — X's "sensitive content" reveal controls in a DOM subtree.
 *
 * X covers media flagged sensitive with a "Content warning" overlay whose only
 * affordance is a reveal button ("Show" / "View"). Revealing matters for this
 * extension because the covered media is NOT in the DOM until the button is
 * clicked: the GraphQL tee still captures it for bulk download, but the on-page
 * hover paths (Quick Grab / the per-media badge) resolve against a rendered
 * `<img>`/`<video>` that the cover withholds — so does the human eye.
 *
 * The reveal button carries NO stable `data-testid`, and its label is localized,
 * so we locate it two ways and union the results:
 *
 *  1. Photo-container scoped (locale-independent): a button inside a
 *     `[data-testid="tweetPhoto"]`. An *uncovered* photo container is an `<a>`
 *     (no button), so a button there is the reveal control — barring the two
 *     non-reveal buttons X can render over a shown photo (the `ALT` badge and
 *     media controls), which are excluded.
 *  2. Label-matched (locale-bound): a `role="button"`/`<button>` inside a tweet
 *     or photo lightbox whose exact text is a known reveal label. This reaches
 *     the post-level cover ("the author flagged this post…"). A non-English X
 *     needs its reveal label added to {@link REVEAL_LABELS}.
 *
 * Anything inside a video player is OFF-LIMITS in both passes (see
 * {@link isOffLimits}): auto-reveal never clicks a video cover or control, so it
 * can never play or fullscreen a video. Sensitive *videos* are still captured for
 * bulk download by the GraphQL tee — only their on-page auto-reveal is skipped.
 *
 * The finder ({@link findSensitiveRevealControls}) is pure — it returns elements,
 * never clicks. {@link clickSensitiveReveals} adds the one effect, deduped by a
 * caller-owned `WeakSet` so a streaming timeline never re-clicks a control.
 *
 * NOTE: X reshuffles this DOM often. The selectors below are the one brittle
 * surface; confirm them against the live page with the probe in
 * `docs/testing` if reveals stop firing.
 */

import { VIDEO_PLAYER_SEL } from './dom'

/** Exact (trimmed) labels X renders on the reveal control. Add locale strings
 *  here for a non-English UI (e.g. 'Mostrar', 'Afficher'). Kept exact, not a
 *  substring test, so a truncated-text "Show more" / "Show this thread" never
 *  matches. */
export const REVEAL_LABELS: ReadonlySet<string> = new Set(['Show', 'View'])

/** Per-photo sensitive covers render inside this container. */
export const PHOTO_COVER_CONTAINER_SEL = '[data-testid="tweetPhoto"]'

/** The tweet/lightbox roots a reveal control may legitimately live under — the
 *  label-matched pass is scoped to these so a stray "Show" elsewhere on the page
 *  is never clicked. */
const REVEAL_SCOPE_SEL = 'article, [role="dialog"], [aria-modal="true"]'

/** A clickable control: a real `<button>` or X's `role="button"` div. */
const isRevealCandidate = (el: Element): el is HTMLElement =>
  el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'

/** Playback / expand controls X overlays on media. None is a reveal cover, and
 *  clicking one can play or FULLSCREEN the video — so they are excluded in every
 *  locale, not just English. */
const NON_REVEAL_CONTROL =
  /\b(play|pause|mute|unmute|volume|fullscreen|full ?screen|settings|seek|scrub|expand|enlarge|theat(?:er|re)|picture.?in.?picture)\b/i

/**
 * True when `el` must never be auto-clicked — the guard that keeps auto-reveal
 * from ever playing or fullscreening a video ("videos go fullscreen on scroll").
 *
 * Ordered locale-independent first, so a non-English X is still safe:
 *  1. It sits inside (or wraps) a video player → the hard guarantee: auto-reveal
 *     touches nothing in a video context, so it can't expand/fullscreen a video.
 *  2. The alt-text badge (text "ALT").
 *  3. Icon-only control: an `aria-label`/title or an SVG glyph but NO worded
 *     label. A real reveal cover always shows words ("Show" / its localization),
 *     so this drops play/pause/fullscreen/expand icons without dropping a reveal.
 *  4. (English net) an aria-label naming a known playback control.
 */
const isOffLimits = (el: HTMLElement): boolean => {
  if (el.closest(VIDEO_PLAYER_SEL) !== null || el.querySelector('video') !== null) return true
  /* v8 ignore next -- Element.textContent is never null per the DOM spec (only document/doctype are) */
  const text = (el.textContent ?? '').trim()
  if (text === 'ALT') return true
  if (text === '' && (el.getAttribute('aria-label') !== null || el.querySelector('svg') !== null))
    return true
  const aria = el.getAttribute('aria-label') ?? ''
  return aria !== '' && NON_REVEAL_CONTROL.test(aria)
}

/**
 * Every sensitive-content reveal control in `root`, de-duplicated, in document
 * order of discovery. Pure: clicks nothing.
 */
export function findSensitiveRevealControls(root: ParentNode): HTMLElement[] {
  const out: HTMLElement[] = []
  const seen = new Set<Element>()
  const add = (el: HTMLElement): void => {
    if (seen.has(el)) return
    seen.add(el)
    out.push(el)
  }

  // 1. A button inside a photo cover container (locale-independent), minus the
  //    ALT badge and anything off-limits (a media control, or a GIF/video player
  //    nested in the photo container).
  for (const container of root.querySelectorAll(PHOTO_COVER_CONTAINER_SEL)) {
    for (const el of container.querySelectorAll<HTMLElement>('[role="button"], button')) {
      if (!isOffLimits(el)) add(el)
    }
  }

  // 2. A reveal-labelled button inside a tweet/lightbox (catches the post-level
  //    cover). The off-limits guard drops anything in a video context, so a video
  //    cover is intentionally NOT auto-revealed — auto-reveal can never fullscreen
  //    a video. Sensitive videos are still grabbed for download by the tee.
  for (const el of root.querySelectorAll<HTMLElement>('[role="button"], button')) {
    /* v8 ignore next -- the selector only yields button/role=button els, so isRevealCandidate is always true */
    if (!isRevealCandidate(el)) continue
    /* v8 ignore next -- Element.textContent is never null per the DOM spec (only document/doctype are) */
    if (!REVEAL_LABELS.has((el.textContent ?? '').trim())) continue
    if (el.closest(REVEAL_SCOPE_SEL) === null) continue
    if (isOffLimits(el)) continue
    add(el)
  }

  return out
}

/**
 * Click every not-yet-clicked reveal control in `root`, recording each in
 * `clicked` so a re-scan (X streams its timeline) never re-fires the same one.
 * Returns how many were clicked this pass.
 */
export function clickSensitiveReveals(root: ParentNode, clicked: WeakSet<Element>): number {
  let n = 0
  for (const control of findSensitiveRevealControls(root)) {
    if (clicked.has(control)) continue
    clicked.add(control)
    control.click()
    n++
  }
  return n
}
