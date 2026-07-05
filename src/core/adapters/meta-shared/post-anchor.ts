/**
 * DOM post-identity anchor for Instagram/Threads video hover resolution. Maps
 * "the DOM region the user is hovering" -> "which post's shortcode that
 * region belongs to", so a hovered <video> (no correlatable URL — blob: src,
 * no poster, per 2026-07-05 live research) can still resolve via its POST's
 * already-tee-detected item(s), instead of needing the <video> element itself
 * to carry identity.
 *
 * Per-platform because the post-boundary selector AND the link-shortcode
 * pattern both differ (Instagram: <article>, /p/{code}/; Threads: zero
 * <article>/[role=article] elements, div[data-pressable-container='true'],
 * /@{user}/post/{code}) — live-verified 2026-07-05, Chrome Canary. Only the
 * "walk up to the nearest matching ancestor, read ITS link fresh, extract via
 * the platform's regex" shape is shared.
 *
 * MUST be called fresh at resolution time, never cached across even a short
 * delay: Threads' virtualization was live-confirmed to recycle a
 * pressable-container's CONTENTS to a different post between two DOM reads
 * without removing the node — a stale element reference or a previously-read
 * href risks silently mismatching to a different post's video.
 *
 * KNOWN v1 SCOPE LIMIT (untested against live markup, not silently assumed
 * away — see `post-anchor.test.ts`'s "returns the FIRST matching link"
 * case): `postCodeFromContainer` returns the first DOM-order matching link
 * inside the container, with no way to distinguish "the post's own
 * permalink" from a DIFFERENT post's permalink nested inside it (e.g. a
 * Threads quote/repost embedding another post's own link). If a container
 * ever holds more than one shortcode-shaped link and the outer post's own
 * link isn't first in DOM order, hover resolves to the wrong post. No live
 * Instagram/Threads markup has been observed where this happens, but it
 * hasn't been ruled out either — flagging here rather than pretending
 * single-link-per-container is guaranteed.
 */

/** Nearest ancestor-or-self of `el` matching `containerSelector` — thin
 *  `Element.closest` wrapper kept as its own function so each platform's
 *  resolver reads as "find my post container" rather than a raw `closest`
 *  call, and so a future non-`closest`-expressible boundary rule has one
 *  place to change. */
export function findPostContainer(el: Element, containerSelector: string): Element | null {
  return el.closest(containerSelector)
}

/** The post shortcode from `container`'s post-permalink link, re-read fresh
 *  (queries `container` live, does not accept a pre-read href) — `codePattern`
 *  must have exactly one capture group (the code). Returns the FIRST matching
 *  link found in document order. */
export function postCodeFromContainer(
  container: Element,
  linkSelector: string,
  codePattern: RegExp,
): string | null {
  for (const a of container.querySelectorAll(linkSelector)) {
    const href = a.getAttribute('href')
    if (!href) continue
    const m = codePattern.exec(href)
    if (m?.[1]) return m[1]
  }
  return null
}
