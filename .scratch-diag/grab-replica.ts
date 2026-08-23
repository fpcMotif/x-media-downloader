// Live-page harness built from the REAL repo modules. Reproduces both grab paths
// (Alt = single Quick Grab, Cmd+Alt = whole-post) at a point, WITHOUT downloading:
// it stops at the exact decision fireGrab makes, and reports which branch fired.
import { instagramAdapter } from '@/core/adapters/instagram/adapter'
import { threadsAdapter } from '@/core/adapters/threads/adapter'
import { makeDetectionStore, type DetectionStore } from '@/core/adapters/detection-store'
import { inlineDataPayloads } from '@/core/adapters/meta-shared/inline-data'
import { partitionAllowedMediaItems } from '@/packages/sync/url-guard'
import { previewKeyFromMedia, resolveHoverMedia } from '@/core/adapters/hover-resolve'
import { wholePostItemsFor } from '@/entrypoints/overlay.content/post-grab'
import type { MediaItem } from '@/packages/schema'

const adapter = location.hostname.includes('threads') ? threadsAdapter : instagramAdapter
let store: DetectionStore = makeDetectionStore({ mediaKeyFromUrl: adapter.mediaKeyFromUrl })
const ingestLog: any[] = []
const now = () => Math.round(performance.now())

/** Mirrors the overlay's wxt:locationchange reset, so the harness can run with the
 *  extension's real lifecycle (clearOnRoute=true) or without it (false). */
let clearOnRoute = true
let lastPath = location.pathname
const routeLog: any[] = []

function ingestBody(path: string, body: string) {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return
  }
  try {
    const raw = adapter.detectFromResponse(path, json)
    const checked = partitionAllowedMediaItems(raw)
    const added = store.addDetected(checked.allowed)
    const codes = adapter.extractPostCodes?.(json)
    if (codes) for (const [postId, code] of codes) store.registerPostCode(postId, code)
    if (raw.length > 0 || (codes && codes.size > 0))
      ingestLog.push({ t: now(), path, len: body.length, detected: raw.length, rejected: checked.rejected.length, added: added.length, codes: codes ? codes.size : 0, storeCount: store.count })
  } catch (e) {
    ingestLog.push({ t: now(), path, err: 'THREW ' + String(e).slice(0, 100) })
  }
}

function replayInline() {
  const bodies = inlineDataPayloads(document.scripts)
  for (const b of bodies) ingestBody('inline:document', b)
  return { replayed: bodies.length, storeCount: store.count }
}

function onRouteChange(to: string) {
  routeLog.push({ t: now(), to, before: store.count, cleared: clearOnRoute })
  if (clearOnRoute) store.clear()
}

function watchRoute() {
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname
      onRouteChange(lastPath)
    }
  }, 120)
}

function installTee() {
  const tracked = (u: string) => /\/api\/graphql|\/graphql\/query|\/api\/v1\//.test(String(u))
  const origOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: any, ...rest: any[]) {
    if (tracked(String(url)))
      this.addEventListener('load', () => {
        if (this.status === 200) {
          try { ingestBody(new URL(this.responseURL).pathname, this.responseText) } catch {}
        }
      })
    return (origOpen as any).apply(this, [method, url, ...rest])
  }
  const origFetch = window.fetch
  window.fetch = function (input: any, init?: any) {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const p = origFetch.apply(this, arguments as any)
    if (tracked(u))
      p.then((res: Response) => {
        if (res.ok) res.clone().text().then((t) => ingestBody(new URL(u, location.origin).pathname, t)).catch(() => {})
      }).catch(() => {})
    return p
  }
}

/**
 * The user's exact symptom, measured at one point:
 *   alt   = does plain Quick Grab resolve one Media Item? (would download)
 *   cmdAlt= does whole-post resolve a non-empty payload? (would download)
 * RED when alt succeeds and cmdAlt returns zero — "Alt works, Cmd+Alt does nothing".
 */
function probeGrab(x: number, y: number) {
  const stack = document.elementsFromPoint(x, y)
  const media = resolveHoverMedia(stack[0] ?? null, stack, x, y)
  if (!media) return { verdict: 'NO_MEDIA' as const, x, y, stack: stack.slice(0, 3).map((e) => e.tagName) }
  const key = previewKeyFromMedia(adapter, media, location.pathname)
  if (!key)
    return { verdict: 'NO_KEY' as const, x, y, mediaTag: media.tagName, src: (((media as any).currentSrc || (media as any).src) ?? '').slice(0, 60) }
  const idx = store.keyIndex()
  const item = adapter.resolveHoverItem(media, key, idx, location.pathname)

  // whole-post path, with the fallback reason captured
  let fallback: { code: string | null } | null = null
  const items: MediaItem[] = item
    ? wholePostItemsFor(
        { adapter, store, pathname: () => location.pathname, onWholePostFallback: (info) => { fallback = { code: info.code } } },
        media,
        item,
      )
    : []

  const code = adapter.postCodeFromElement?.(media, location.pathname) ?? null
  const alt = item !== null
  const cmdAlt = items.length > 0
  const verdict = !alt ? ('BOTH_FAIL' as const) : cmdAlt ? ('BOTH_OK' as const) : ('ALT_OK_CMDALT_FAILS' as const)
  return {
    verdict,
    x,
    y,
    mediaTag: media.tagName,
    inLi: !!media.closest('li'),
    key,
    teed: idx.has(key),
    code,
    postIdForCode: code ? (store.postIdForCode(code) ?? null) : null,
    altItem: item ? { id: item.id.slice(0, 18), type: item.type, postId: item.postId, index: item.index, domFallback: item.postId === item.id } : null,
    cmdAltCount: items.length,
    cmdAltItems: items.map((i) => `${i.type}#${i.index}`),
    fallbackReason: fallback ? ((fallback as any).code ? `code ${(fallback as any).code} not registered` : 'no post code from DOM') : null,
    itemsForPostId: item ? store.valuesForTweet(item.postId).length : 0,
  }
}

/** Probe every media element currently visible, so one call yields a distribution. */
function probeVisible() {
  const out: any[] = []
  const els = [...document.querySelectorAll('img,video')] as (HTMLImageElement | HTMLVideoElement)[]
  const seen = new Set<string>()
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.width < 120 || r.height < 120) continue
    if (r.top > innerHeight - 20 || r.bottom < 20) continue
    const x = Math.round(r.left + r.width / 2)
    const y = Math.round(Math.max(20, Math.min(r.top + r.height / 2, innerHeight - 20)))
    const sig = `${el.tagName}@${Math.round(r.top)},${Math.round(r.left)}`
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push(probeGrab(x, y))
  }
  return out
}

;(window as any).__xmdGrab = {
  probeGrab, probeVisible, replayInline, ingestBody, ingestLog, routeLog, store, adapter,
  setClearOnRoute: (v: boolean) => { clearOnRoute = v },
  reset: () => { store = makeDetectionStore({ mediaKeyFromUrl: adapter.mediaKeyFromUrl }) },
  storeCount: () => store.count,
}
installTee()
watchRoute()
