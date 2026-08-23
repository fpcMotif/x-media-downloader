// Bundled with the REAL repo modules, injected into the live page to reproduce
// the exact overlay pipeline: inline replay -> detect -> store -> hover key -> resolve.
import { instagramAdapter } from '@/core/adapters/instagram/adapter'
import { makeDetectionStore } from '@/core/adapters/detection-store'
import { inlineDataPayloads } from '@/core/adapters/meta-shared/inline-data'
import { partitionAllowedMediaItems } from '@/packages/sync/url-guard'
import { previewKeyFromMedia, resolveHoverMedia } from '@/core/adapters/hover-resolve'

const adapter = instagramAdapter
const store = makeDetectionStore({ mediaKeyFromUrl: adapter.mediaKeyFromUrl })
const log: any[] = []
const now = () => Math.round(performance.now())

function ingestJson(path: string, json: unknown, len: number) {
  try {
    const raw = adapter.detectFromResponse(path, json)
    const checked = partitionAllowedMediaItems(raw)
    const added = store.addDetected(checked.allowed)
    const codes = adapter.extractPostCodes?.(json)
    if (codes) for (const [postId, code] of codes) store.registerPostCode(postId, code)
    const rec = {
      t: now(),
      path,
      len,
      detected: raw.length,
      allowed: checked.allowed.length,
      rejected: checked.rejected.length,
      rejectedReasons: checked.rejected.slice(0, 3),
      added: added.length,
      codes: codes ? codes.size : 0,
      storeCount: store.count,
    }
    if (rec.detected > 0 || rec.codes > 0) log.push(rec)
    return rec
  } catch (e) {
    const rec = { t: now(), path, len, err: 'THREW ' + String(e).slice(0, 120) }
    log.push(rec)
    return rec
  }
}

function ingestBody(path: string, body: string) {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { t: now(), path, len: body.length, err: 'non-JSON' }
  }
  return ingestJson(path, json, body.length)
}

function ingestInline() {
  const bodies = inlineDataPayloads(document.scripts)
  let n = 0
  for (const body of bodies) {
    const r = ingestBody('inline:document', body) as any
    if (r.detected > 0) n++
  }
  return { replayed: bodies.length, withMedia: n, storeCount: store.count }
}

/** Page-level tee mirroring inject.content.ts, so the replica sees the same bodies. */
function installTee() {
  const tracked = (u: string) => /\/api\/graphql|\/graphql\/query|\/api\/v1\//.test(String(u))
  const origOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: any, ...rest: any[]) {
    if (tracked(String(url))) {
      this.addEventListener('load', () => {
        if (this.status === 200) {
          try {
            ingestBody(new URL(this.responseURL).pathname, this.responseText)
          } catch {}
        }
      })
    }
    return (origOpen as any).apply(this, [method, url, ...rest])
  }
  const origFetch = window.fetch
  window.fetch = function (input: any, init?: any) {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const p = origFetch.apply(this, arguments as any)
    if (tracked(u))
      p.then((res: Response) => {
        if (res.ok)
          res
            .clone()
            .text()
            .then((t) => ingestBody(new URL(u, location.origin).pathname, t))
            .catch(() => {})
      }).catch(() => {})
    return p
  }
}

function probeAt(x: number, y: number) {
  const stack = document.elementsFromPoint(x, y)
  const media = resolveHoverMedia(stack[0] ?? null, stack, x, y)
  const key = previewKeyFromMedia(adapter, media, location.pathname)
  const idx = store.keyIndex()
  const item = media && key ? adapter.resolveHoverItem(media, key, idx, location.pathname) : null
  const code = media ? (adapter.postCodeFromElement?.(media, location.pathname) ?? null) : null
  const article = media?.closest('article') ?? null
  return {
    stack: stack.slice(0, 4).map((e) => e.tagName),
    mediaTag: media?.tagName ?? null,
    mediaSrc: media ? (((media as any).currentSrc || (media as any).src || '') as string).slice(0, 60) : null,
    inLi: media ? !!media.closest('li') : null,
    inArticle: !!article,
    articleLinks: article
      ? [...article.querySelectorAll('a[href]')]
          .map((a) => a.getAttribute('href'))
          .filter((h) => h && /\/(p|reels?)\//.test(h))
          .slice(0, 5)
      : null,
    key,
    code,
    teed: key ? idx.has(key) : false,
    canResolve: media && key ? adapter.canResolveHoverItem(media, key, idx) : false,
    item: item ? { id: item.id.slice(0, 20), type: item.type, postId: item.postId, index: item.index } : null,
    postIdForCode: code ? (store.postIdForCode(code) ?? null) : null,
    keysForCode: code ? [...idx.keys()].filter((k) => k.includes(code)) : [],
    itemsForPost: code && store.postIdForCode(code)
      ? store.valuesForTweet(store.postIdForCode(code)!).map((i) => `${i.type}#${i.index}`)
      : [],
  }
}

;(window as any).__xmdReplica = { ingestInline, ingestBody, probeAt, installTee, store, adapter, log }
installTee()
