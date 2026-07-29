/**
 * DOM-hover resolution helpers for Instagram/Threads — the meta-shared
 * counterpart to `x/dom.ts`. Both platforms serve media off the same
 * cdninstagram.com CDN family (confirmed live 2026-07-05, Chrome Canary,
 * logged-in Instagram + Threads), so one module covers both, same as
 * `detect.ts`/`media-node.ts`/`post-node.ts` already do for the network path.
 */
import { isCdnHostnameForPlatform } from '../catalog'

/** True for any cdninstagram.com host — both Instagram's region-prefixed form
 *  (`scontent-lga3-2.cdninstagram.com`) and Threads' bare form
 *  (`scontent.cdninstagram.com`). LIVE-VERIFIED 2026-07-05 (Chrome Canary):
 *  both forms seen on real logged-in sessions. `endsWith` alone would also
 *  accept a spoofed `evil-cdninstagram.com`, so this checks for an exact
 *  '.cdninstagram.com' suffix boundary (either bare or with a subdomain dot
 *  immediately before it) the same way X's `mediaKeyFromUrl` guards `.twimg.com`. */
export function isCdninstagramHost(hostname: string): boolean {
  return isCdnHostnameForPlatform('instagram', hostname)
}

/**
 * The `t{N}.{N}-{N}` path-family segment carried by every cdninstagram.com
 * media URL (e.g. `t51.82787-15`, `t51.71878-15`, `t51.2885-19`). Returns null
 * if no such segment exists in the path.
 */
export function pathFamily(pathname: string): string | null {
  const seg = pathname.split('/').find((p) => /^t\d+\.\d+-\d+$/.test(p))
  return seg ?? null
}

/**
 * Whether a path family is real POST CONTENT (a photo/video asset) rather
 * than a profile picture/avatar. This gate's actual job is EXCLUDING
 * profile-picture/avatar assets, not allowlisting content families — it is
 * a denylist, not an allowlist. Every avatar family ever observed live ends
 * in `-19` (`t51.2885-19` on Instagram, `t51.82787-19` on Threads, both
 * 2026-07-05 — the numeric prefix varies, only the trailing `-19` is the
 * load-bearing signal), so that's the one suffix excluded.
 *
 * FALSIFIED LIVE 2026-07-06: this used to be a `-15`-only allowlist, which
 * returned false for a real Instagram post photo (instagram.com/p/DaM2wDWCH-C/)
 * served on family `t39.30808-6` — a Facebook-style family Meta has started
 * also using for Instagram post content. An allowlist breaks every time Meta
 * introduces a new content family (silently killing the grab affordance on
 * real content, with no visible symptom besides "nothing happens"); a
 * denylist only breaks if a NEW avatar family appears, and that failure mode
 * is a spurious grab affordance offered on an avatar (benign, visible, easy
 * to notice) rather than a silently dead grab on real content (the bug
 * actually reported). Prefer the denylist's failure mode.
 */
export function isContentPathFamily(family: string): boolean {
  return !family.endsWith('-19')
}

/**
 * Whether `url` is a grabbable Instagram/Threads *photo*: a `*.cdninstagram.com`
 * host, on a real post-content path family (not an avatar, not some other
 * cdninstagram asset class, not an unrelated host like a `media4.giphy.com`
 * embed or the extension's own `chrome-extension://…` injected UI — both
 * excluded by the host check alone, since neither is `*.cdninstagram.com`).
 */
export function isGrabbableMetaPhotoUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (!isCdninstagramHost(u.hostname)) return false
  const family = pathFamily(u.pathname)
  return family !== null && isContentPathFamily(family)
}

/**
 * The stable media key for a cdninstagram.com URL: the final path segment,
 * minus extension, minus query string. Already gated on
 * {@link isGrabbableMetaPhotoUrl} — returns null for anything that isn't a
 * grabbable content photo, so callers don't need a separate predicate (unlike
 * X's `mediaKeyFromUrl`, which is deliberately ungated for historical reasons
 * — see `x/adapter.ts`'s combining wrapper).
 *
 * UNVERIFIED ASSUMPTION, NOT SETTLED: this only key-matches a DOM-rendered
 * `<img>` back to the tee's detected MediaItem if every rendition in
 * `image_versions2.candidates[]` for one asset shares the exact same
 * basename (query string aside — that part IS confirmed: see the
 * differently-`stp=`-query test case in dom.test.ts, which only varies the
 * query, not the path). Whether the basename ITSELF is stable across
 * different-dimension renditions (e.g. a 150×150 thumbnail vs. a 1080×1404
 * original) has NOT been independently re-verified against a real captured
 * `image_versions2.candidates[]` array, and a prior live observation this
 * session went the other way — that a rendered `<img>`'s srcset-selected
 * basename can differ from the tee's largest-candidate basename for the
 * same asset. If that's correct, this function under-matches: DOM-hover on
 * a smaller rendition silently fails to resolve to the tee's item (hover
 * badge never appears), or worse, `resolveHoverItem`'s placeholder fallback
 * mints a second, distinct MediaItem for the same asset. Unlike X (whose
 * `upgradePhotoUrl` forces a canonical quality via a `name=orig` QUERY
 * PARAM, leaving the basename itself untouched because X's basename was
 * never rendition-dependent in the first place), no equivalent
 * basename-normalization step exists here — if the assumption above is
 * wrong, one is needed (e.g. keying off the numeric ID prefix shared across
 * renditions rather than the full basename). Re-verify against a real
 * network capture before trusting this for anything beyond the exact-basename
 * case the current tests cover.
 */
export function mediaKeyFromMetaUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!isGrabbableMetaPhotoUrl(url)) return null
  const base = u.pathname.slice(u.pathname.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const key = dot >= 0 ? base.slice(0, dot) : base
  return key.length > 0 ? key : null
}

/**
 * File extension for a live cdninstagram `<img>` photo: the path extension,
 * or `jpg` if none (cdninstagram doesn't use X's `?format=` query-param
 * convention for photos, per everything observed live this session).
 */
export function extFromMetaImgUrl(url: string): string {
  try {
    const u = new URL(url)
    const base = u.pathname.slice(u.pathname.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    return dot >= 0 ? base.slice(dot + 1) : 'jpg'
  } catch {
    return 'jpg'
  }
}

/**
 * The bare `t{N}` path-family segment carried by a cdninstagram.com *video*
 * URL (e.g. `t16` in `/o1/v/t16/f2/m84/{token}.mp4`) — deliberately NOT the
 * same shape as {@link pathFamily}'s `t{N}.{N}-{N}` photo convention. LIVE-
 * VERIFIED 2026-07-05: a real Instagram `/p/{code}/` inline video post
 * (instagram.com/p/DaSs_DTmWdw/) and a real Threads carousel video slide
 * (threads.com/@zuck/post/DZ7eGA1G7wU) both serve `t16` with NO dot-suffix at
 * all — unlike photos, whose family always carries a `.{N}-{N}` suffix.
 * Returns null if no bare `t{N}` segment exists in the path (a whole-segment
 * match, so a photo family like `t51.82787-15` — which also "contains" a
 * `t51` prefix conceptually — correctly does NOT match here: the full segment
 * text differs).
 */
export function videoPathFamily(pathname: string): string | null {
  const seg = pathname.split('/').find((p) => /^t\d+$/.test(p))
  return seg ?? null
}

/**
 * Whether `url` is a grabbable Instagram/Threads *video*: a
 * `*.cdninstagram.com` host on a real `tN`-shaped video path segment. Kept as
 * its OWN predicate rather than widening {@link isGrabbableMetaPhotoUrl} —
 * every existing caller of that function (the photo DOM-hover resolution
 * path) assumes "photo" by its very name and return shape; conflating the two
 * risks a photo-path caller silently starting to accept video assets it isn't
 * prepared to handle. No avatar-equivalent exclusion is applied here (unlike
 * the photo family's `-19` vs `-15` split): LIVE-VERIFIED 2026-07-05 — a full
 * `performance.getEntriesByType('resource')` sweep of a real `/p/` video post
 * page found no `t16`-shaped profile-picture/avatar video asset at all (only
 * `-19`-suffixed PHOTO avatars, plus an unrelated `t2/f2/mNNN` asset family —
 * see the module-level outlier caveat on {@link mediaKeyFromMetaVideoUrl}).
 */
export function isGrabbableMetaVideoUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (!isCdninstagramHost(u.hostname)) return false
  return videoPathFamily(u.pathname) !== null
}

/**
 * The stable media key for a cdninstagram.com *video* URL: the final path
 * segment, minus extension, minus query string — identical extraction rule
 * to {@link mediaKeyFromMetaUrl}, just gated on {@link isGrabbableMetaVideoUrl}
 * instead of the photo predicate. Already gated — returns null for anything
 * that isn't a grabbable content video.
 *
 * SAME UNVERIFIED ASSUMPTION as `mediaKeyFromMetaUrl` carries for photos,
 * now inherited here for video: whether a video ever has multiple renditions
 * with DIFFERING basenames (the way a photo's `image_versions2.candidates[]`
 * might) has not been independently re-verified — not proven impossible, just
 * unverified.
 *
 * KNOWN OUTLIER, NOT GENERALIZED AWAY: exactly one unusual Threads post this
 * session showed a `t2/f2/m367`-shaped video-ish asset (not `t16`) — this
 * predicate's generalized `tN` matching would also accept a `t2`-shaped
 * asset if one were ever hover-targeted directly, and no live case has ruled
 * that out as a non-content asset class. Treated as acceptably low-risk per
 * research's otherwise-clean negative result (19 images inspected, all
 * `t51.*`; only one `t2` sighting, on an unrelated resource, not a hovered
 * `<video>`'s own src), not proven safe.
 */
export function mediaKeyFromMetaVideoUrl(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (!isGrabbableMetaVideoUrl(url)) return null
  const base = u.pathname.slice(u.pathname.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  const key = dot >= 0 ? base.slice(0, dot) : base
  return key.length > 0 ? key : null
}

/**
 * The combined photo-or-video media key for a cdninstagram.com URL: tries
 * the photo path first ({@link mediaKeyFromMetaUrl}), then the video path
 * ({@link mediaKeyFromMetaVideoUrl}), returning null only if neither resolves.
 * This is what `PlatformAdapter.mediaKeyFromUrl` should point at (for both
 * Instagram and Threads) instead of the photo-only function directly, so a
 * hovered `<video>` with a real (non-`blob:`) `tN`-shaped URL resolves via the
 * existing url-based key path with zero DOM-anchor machinery needed — see
 * `instagram/adapter.ts` and `threads/adapter.ts`.
 */
export function mediaKeyFromMetaCombinedUrl(url: string): string | null {
  return mediaKeyFromMetaUrl(url) ?? mediaKeyFromMetaVideoUrl(url)
}
