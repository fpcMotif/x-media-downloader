/**
 * DOM-hover resolution helpers for Instagram/Threads — the meta-shared
 * counterpart to `x/dom.ts`. Both platforms serve media off the same
 * cdninstagram.com CDN family (confirmed live 2026-07-05, Chrome Canary,
 * logged-in Instagram + Threads), so one module covers both, same as
 * `detect.ts`/`media-node.ts`/`post-node.ts` already do for the network path.
 */

/** True for any cdninstagram.com host — both Instagram's region-prefixed form
 *  (`scontent-lga3-2.cdninstagram.com`) and Threads' bare form
 *  (`scontent.cdninstagram.com`). LIVE-VERIFIED 2026-07-05 (Chrome Canary):
 *  both forms seen on real logged-in sessions. `endsWith` alone would also
 *  accept a spoofed `evil-cdninstagram.com`, so this checks for an exact
 *  '.cdninstagram.com' suffix boundary (either bare or with a subdomain dot
 *  immediately before it) the same way X's `mediaKeyFromUrl` guards `.twimg.com`. */
export function isCdninstagramHost(hostname: string): boolean {
  return hostname === 'cdninstagram.com' || hostname.endsWith('.cdninstagram.com')
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
 * than a profile picture/avatar. LIVE-VERIFIED 2026-07-05: content families
 * end in `-15` (`t51.82787-15` on both Instagram and Threads, `t51.71878-15`
 * also seen on Threads); avatar families end in `-19` (`t51.2885-19` on
 * Instagram, `t51.82787-19` on Threads — the numeric prefix varies, ONLY the
 * trailing `-15`/`-19` is the load-bearing signal).
 */
export function isContentPathFamily(family: string): boolean {
  return family.endsWith('-15')
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
