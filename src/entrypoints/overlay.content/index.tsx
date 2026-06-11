import './style.css'
import { render } from 'preact'
import {
  archiveSourceFromPage,
  archiveSourceFromPath,
  detectFromJson,
  detectTweetCaptures,
  findRemovalButton,
  findTweetArticle,
  resolveImageElement,
} from '../../core/adapters/x'
import { mediaKeyFromUrl, isGrabbablePhotoUrl } from '../../core/adapters/x/dom'
import {
  idleQuickGrab,
  pressModifier,
  releaseModifier,
  canGrab,
  markGrabbed,
  isModifierKey,
  modifierHeld,
  type GrabModifier,
  type QuickGrabState,
} from '../../core/quickgrab'
import { getSettings, watchSettings } from '../../core/settings'
import type {
  ArchiveSource,
  ArchiveTweetResult,
  MediaItem,
  Settings,
  TweetCapture,
} from '../../core/schema'

/** Hold-to-grab dwell: fast, but still intentional enough to avoid accidental saves. */
const DWELL_MS = 1000

interface Rect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Alpha of a computed `backgroundColor` (`rgb(…)` / `rgba(…)` / keyword). */
const bgAlpha = (color: string): number => {
  const m = /^rgba?\(([^)]+)\)$/.exec(color)
  if (!m) return color === 'transparent' ? 0 : 1
  const parts = m[1]!.split(',')
  return parts.length === 4 ? Number(parts[3]) : 1
}

/**
 * The topmost `<img>` at a viewport point, unless something visually occludes
 * it: this extension's own shadow host (launcher pill / grab ring), a modal layer
 * the image sits outside of (lightbox backdrop, compose scrim), or any opaque
 * layer. X's transparent hit-target divs over their own photos pass through.
 */
const imgAtPoint = (x: number, y: number): HTMLImageElement | null => {
  const stack = document.elementsFromPoint(x, y)
  const at = stack.findIndex((el) => el.tagName === 'IMG')
  if (at < 0) return null
  const img = stack[at] as HTMLImageElement
  for (const el of stack.slice(0, at)) {
    if (el.tagName === 'XMD-OVERLAY') return null
    if (el.contains(img)) continue
    const modal = el.closest('[aria-modal="true"], [role="dialog"]')
    if (modal && !modal.contains(img)) return null
    if (bgAlpha(getComputedStyle(el).backgroundColor) >= 0.5) return null
  }
  return img
}

const send = (items: ReadonlyArray<MediaItem>): void => {
  if (items.length > 0) void browser.runtime.sendMessage({ _tag: 'DownloadRequest', items })
}

/** Send one tracked request; false when the background reports a start failure. */
const sendTracked = (items: ReadonlyArray<MediaItem>): Promise<boolean> =>
  browser.runtime
    .sendMessage({ _tag: 'DownloadRequest', items })
    .then((reply) => {
      const r = reply as { completed?: number; total?: number } | undefined
      return r?.completed !== undefined && r.completed === r.total
    })
    .catch(() => false)

/**
 * ISOLATED content script: detects MediaItems from the MAIN-world tee, then
 * renders a global launcher for bulk downloads and the Quick Grab ring for the
 * precise hover path, in a style-isolated Shadow Root (grounding §e).
 *
 * Quick Grab (the literal hover path): hold the configured modifier and a photo
 * under the cursor downloads itself at Original quality after a short dwell. A
 * ring + progress charge shows what's about to happen (and a window to bail); the
 * pure `core/quickgrab` state machine fires each photo at most once per press.
 *
 * Note: the hover anchor matches rendered `<img>` elements to detected items by
 * twimg media key — robust for photos; video posters and exact placement need a
 * live x.com pass (handoff §6, the `web-browser` skill) to finalise selectors.
 */
export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    const byId = new Map<string, MediaItem>()
    const byKey = new Map<string, MediaItem>()
    // Saved tweets captured from Bookmarks/Likes responses — the Archive units.
    const captures: Record<ArchiveSource, Map<string, TweetCapture>> = {
      bookmarks: new Map(),
      likes: new Map(),
    }
    let removeAfterSave = false
    // Archive button phases; `removed` is null when removal was not enabled.
    let archiveUi:
      | { phase: 'running' }
      | { phase: 'done'; saved: number; already: number; failed: number; removed: number | null }
      | { phase: 'failed' }
      | null = null
    let host: HTMLElement | null = null

    // Quick Grab state. `qgEnabled` fails CLOSED: a user who turned the feature
    // off must never see it fire in the window before stored settings arrive.
    let qgEnabled = false
    let qgModifier: GrabModifier = 'alt'
    let grab: QuickGrabState = idleQuickGrab
    let hoverImg: HTMLImageElement | null = null
    let hoverKey: string | null = null
    // Phases: charging (dwell running / reply pending) → saved | failed; `noted`
    // re-acknowledges an already-grabbed photo without replaying the save pulse.
    let grabUi: {
      key: string
      rect: Rect
      phase: 'charging' | 'saved' | 'noted' | 'failed'
    } | null = null
    let dwell: ReturnType<typeof setTimeout> | null = null
    let cursorStyle: HTMLStyleElement | null = null
    let lastX = 0
    let lastY = 0
    let pointerSeen = false

    const rerender = (): void => {
      if (host) render(<Overlay />, host)
    }

    const clearDwell = (): void => {
      if (dwell !== null) {
        clearTimeout(dwell)
        dwell = null
      }
    }

    /**
     * Remove the bookmark/like of each archived tweet by clicking X's OWN
     * action-bar button — the passive-first path: a user-gesture click that X
     * turns into its own mutation, no API replay (ADR-0009). Only articles still
     * rendered in the virtualized timeline can be clicked; the rest stay saved
     * on X and are picked up (idempotently skipped, then removed) by a later run.
     * Clicks are staggered so X's backend sees a human-ish pace.
     */
    const removeSaved = async (
      source: ArchiveSource,
      results: ReadonlyArray<ArchiveTweetResult>,
    ): Promise<number> => {
      let removed = 0
      for (const result of results) {
        if (!result.ok) continue
        const article = findTweetArticle(document, result.tweetId)
        const button = article ? findRemovalButton(article, source) : null
        if (!button) continue
        button.click()
        removed++
        // Intentionally sequential: each click is a mutation X performs itself.
        // oxlint-disable-next-line no-await-in-loop
        await delay(350)
      }
      return removed
    }

    const runArchive = async (source: ArchiveSource): Promise<void> => {
      if (archiveUi?.phase === 'running') return
      const tweets = [...captures[source].values()]
      if (tweets.length === 0) return
      archiveUi = { phase: 'running' }
      rerender()
      const reply = await browser.runtime
        .sendMessage({ _tag: 'ArchiveRequest', source, tweets })
        .catch(() => null)
      const res = reply as { results?: ReadonlyArray<ArchiveTweetResult> } | null
      if (!res?.results) {
        archiveUi = { phase: 'failed' }
      } else {
        const ok = res.results.filter((r) => r.ok)
        const removed = removeAfterSave ? await removeSaved(source, ok) : null
        archiveUi = {
          phase: 'done',
          saved: ok.filter((r) => !r.alreadyArchived).length,
          already: ok.filter((r) => r.alreadyArchived).length,
          failed: res.results.length - ok.length,
          removed,
        }
      }
      rerender()
      setTimeout(() => {
        if (archiveUi !== null && archiveUi.phase !== 'running') {
          archiveUi = null
          rerender()
        }
      }, 6000)
    }

    const archiveLabel = (source: ArchiveSource): string => {
      if (archiveUi?.phase === 'running') return 'Archiving…'
      if (archiveUi?.phase === 'failed') return '⚠ Archive failed'
      if (archiveUi?.phase === 'done') {
        const parts = [`Saved ${archiveUi.saved}`]
        if (archiveUi.already > 0) parts.push(`${archiveUi.already} already saved`)
        if (archiveUi.failed > 0) parts.push(`${archiveUi.failed} failed`)
        if (archiveUi.removed !== null) parts.push(`removed ${archiveUi.removed}`)
        return parts.join(' · ')
      }
      return source === 'bookmarks' ? 'Archive bookmarks' : 'Archive likes'
    }

    /** Toggle a page-level grab cursor on eligible photos while the modifier is held. */
    const setCursorActive = (on: boolean): void => {
      if (on && !cursorStyle) {
        cursorStyle = document.createElement('style')
        cursorStyle.textContent = `img[src*="pbs.twimg.com/media"],img[srcset*="pbs.twimg.com/media"]{cursor:copy}`
        document.head.appendChild(cursorStyle)
      } else if (!on && cursorStyle) {
        cursorStyle.remove()
        cursorStyle = null
      }
    }

    const fireGrab = (img: HTMLImageElement, key: string): void => {
      dwell = null
      // The node may have been recycled, detached, or scrolled out from under the
      // pointer during the dwell (X's timeline is virtualized) — bail unless it is
      // still the same media, attached, and actually at the pointer's position.
      if (
        !img.isConnected ||
        mediaKeyFromUrl(img.currentSrc || img.src) !== key ||
        !document.elementsFromPoint(lastX, lastY).includes(img)
      ) {
        grabUi = null
        rerender()
        return
      }
      const item = byKey.get(key) ?? resolveImageElement(img, location.pathname)
      if (!item) {
        grabUi = null
        rerender()
        return
      }
      grab = markGrabbed(grab, key)
      // Honest badge: hold the charged ring until the background's QueueUpdate
      // reply says the download actually started, then flip to saved/failed.
      grabUi = { key, rect: rectOf(img), phase: 'charging' }
      rerender()
      void (async () => {
        const ok = await sendTracked([item])
        if (grabUi === null || grabUi.key !== key) return
        grabUi = { ...grabUi, phase: ok ? 'saved' : 'failed' }
        rerender()
      })()
    }

    /** Begin (or, if already grabbed this press, just acknowledge) a hovered photo. */
    const armHover = (img: HTMLImageElement, key: string): void => {
      if (canGrab(grab, key)) {
        grabUi = { key, rect: rectOf(img), phase: 'charging' }
        rerender()
        dwell = setTimeout(() => fireGrab(img, key), DWELL_MS)
      } else {
        grabUi = { key, rect: rectOf(img), phase: 'noted' }
        rerender()
      }
    }

    /** Move the hover focus to `img`/`key` (either may be null), re-arming as needed. */
    const focusHover = (img: HTMLImageElement | null, key: string | null): void => {
      if (key === hoverKey && img === hoverImg) return
      clearDwell()
      hoverImg = img
      hoverKey = key
      if (grab.active && img && key) {
        armHover(img, key)
      } else {
        grabUi = null
        rerender()
      }
    }

    const releaseAll = (): void => {
      if (!grab.active && grabUi === null) return
      grab = releaseModifier()
      clearDwell()
      setCursorActive(false)
      grabUi = null
      rerender()
    }

    // Settings reach open tabs live (popup writes → storage watch). Any change
    // disarms an active grab: a swapped modifier would otherwise never see its
    // keyup, leaving grab mode stuck on.
    const applySettings = (s: Settings): void => {
      qgEnabled = s.quickGrabEnabled
      qgModifier = s.quickGrabModifier
      removeAfterSave = s.archiveRemoveAfterSave
      releaseAll()
    }
    void getSettings().then(applySettings)
    ctx.onInvalidated(watchSettings(applySettings))

    function Overlay() {
      const source = archiveSourceFromPage(location.pathname)
      const tweetCount = source === null ? 0 : captures[source].size
      return (
        <>
          {source !== null && tweetCount > 0 && (
            <button
              type="button"
              class="xmd-launcher xmd-launcher--archive"
              disabled={archiveUi?.phase === 'running'}
              aria-label={`Archive ${tweetCount} saved tweets from ${source}`}
              onClick={() => void runArchive(source)}
            >
              <span class="xmd-launcher__label">{archiveLabel(source)}</span>
              {(archiveUi === null || archiveUi.phase === 'running') && (
                <span class="xmd-launcher__count">{tweetCount}</span>
              )}
            </button>
          )}
          {grabUi && (
            <div
              key={grabUi.key}
              class={`xmd-grab xmd-grab--${grabUi.phase}`}
              style={{
                top: `${grabUi.rect.top}px`,
                left: `${grabUi.rect.left}px`,
                width: `${grabUi.rect.width}px`,
                height: `${grabUi.rect.height}px`,
                '--xmd-dwell': `${DWELL_MS}ms`,
              }}
            >
              <span class="xmd-grab__badge">
                {grabUi.phase === 'charging'
                  ? 'Grabbing'
                  : grabUi.phase === 'failed'
                    ? '⚠ Failed'
                    : '✓ Saved'}
              </span>
              {grabUi.phase === 'charging' && (
                <span key={`${grabUi.key}:charge`} class="xmd-grab__frame" aria-hidden="true">
                  <span class="xmd-grab__edge xmd-grab__edge--top" />
                  <span class="xmd-grab__edge xmd-grab__edge--right" />
                  <span class="xmd-grab__edge xmd-grab__edge--bottom" />
                  <span class="xmd-grab__edge xmd-grab__edge--left" />
                </span>
              )}
            </div>
          )}
          {byId.size > 0 && (
            <button
              type="button"
              class="xmd-launcher"
              aria-label={`Download all detected media (${byId.size})`}
              onClick={() => send([...byId.values()])}
            >
              <span class="xmd-launcher__label">Download all</span>
              <span class="xmd-launcher__count">{byId.size}</span>
            </button>
          )}
        </>
      )
    }

    const ui = await createShadowRootUi(ctx, {
      name: 'xmd-overlay',
      position: 'inline',
      anchor: 'body',
      onMount: (container) => {
        host = container
        rerender()
        return container
      },
      onRemove: (container) => {
        host = null
        if (container) render(null, container)
      },
    })
    ui.mount()

    document.addEventListener('xmd:media-response', (event) => {
      const detail = (event as CustomEvent<{ path: string; body: string }>).detail
      try {
        const json: unknown = JSON.parse(detail.body)
        for (const item of detectFromJson(json)) {
          byId.set(item.id, item)
          const key = mediaKeyFromUrl(item.url)
          if (key) byKey.set(key, item)
        }
        const source = archiveSourceFromPath(detail.path)
        if (source !== null) {
          for (const capture of detectTweetCaptures(json)) {
            captures[source].set(capture.tweetId, capture)
          }
        }
        rerender()
      } catch {
        /* ignore non-JSON / unexpected shapes */
      }
    })

    // Quick Grab hover tracking: hold the configured modifier and hover a real
    // X media image for the dwell window. No competing per-hover buttons.
    ctx.addEventListener(document, 'mousemove', (event) => {
      const e = event as MouseEvent
      lastX = e.clientX
      lastY = e.clientY
      pointerSeen = true
      if (!qgEnabled) return
      // Self-heal a swallowed keyup (native context menu, OS shortcut grabbing
      // the key): the event's live modifier flags are the ground truth.
      if (grab.active && !modifierHeld(e, qgModifier)) {
        releaseAll()
        return
      }
      if (!grab.active) return
      const target = e.target as Element | null
      const img =
        (target?.closest('img') as HTMLImageElement | null) ?? imgAtPoint(e.clientX, e.clientY)
      const src = img ? img.currentSrc || img.src : ''
      const key = img && isGrabbablePhotoUrl(src) ? mediaKeyFromUrl(src) : null
      focusHover(img, key)
    })

    // Scroll moves content without firing mousemove: re-run the hit-test so the
    // dwell and ring track what is actually under the pointer, and refresh the
    // rect when the same photo merely shifted.
    ctx.addEventListener(
      document,
      'scroll',
      () => {
        if (!grab.active || !pointerSeen) return
        const img = imgAtPoint(lastX, lastY)
        const src = img ? img.currentSrc || img.src : ''
        const key = img && isGrabbablePhotoUrl(src) ? mediaKeyFromUrl(src) : null
        if (img === hoverImg && key === hoverKey) {
          if (grabUi !== null && img !== null) {
            grabUi = { ...grabUi, rect: rectOf(img) }
            rerender()
          }
          return
        }
        focusHover(img, key)
      },
      { capture: true, passive: true },
    )

    ctx.addEventListener(window, 'keydown', (event) => {
      const e = event as KeyboardEvent
      if (!qgEnabled || !isModifierKey(e.key, qgModifier)) return
      const was = grab.active
      grab = pressModifier(grab)
      if (grab.active && !was) {
        setCursorActive(true)
        // Arm the photo under the cursor — but only if a real pointer position is
        // known (no mousemove yet ⇒ lastX/lastY are still 0,0, not a real hover).
        const img = pointerSeen ? imgAtPoint(lastX, lastY) : null
        const src = img ? img.currentSrc || img.src : ''
        const key = img && isGrabbablePhotoUrl(src) ? mediaKeyFromUrl(src) : null
        hoverImg = img
        hoverKey = key
        if (img && key) armHover(img, key)
        else rerender() // keep the page quiet when the press lands off a photo
      }
    })

    ctx.addEventListener(window, 'keyup', (event) => {
      if (isModifierKey((event as KeyboardEvent).key, qgModifier)) releaseAll()
    })
    ctx.addEventListener(window, 'blur', () => releaseAll())
    ctx.addEventListener(document, 'mouseleave', () => focusHover(null, null))

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      releaseAll()
      focusHover(null, null)
      rerender()
    })

    const handleRuntimeMessage = (
      message: unknown,
      _sender: unknown,
      sendResponse: (r: unknown) => void,
    ): void => {
      if ((message as Record<string, unknown>)?._tag !== 'ClearDetectedMediaRequest') return
      const cleared = byId.size
      byId.clear()
      byKey.clear()
      captures.bookmarks.clear()
      captures.likes.clear()
      if (archiveUi?.phase !== 'running') archiveUi = null
      clearDwell()
      setCursorActive(false)
      grab = idleQuickGrab
      grabUi = null
      let rescanned = 0
      const req = message as { _tag: string; rescanVisible?: boolean }
      if (req.rescanVisible) {
        for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
          const item = resolveImageElement(img, location.pathname)
          if (item && !byId.has(item.id)) {
            byId.set(item.id, item)
            const key = mediaKeyFromUrl(item.url)
            if (key) byKey.set(key, item)
            rescanned++
          }
        }
      }
      rerender()
      sendResponse({ _tag: 'ClearDetectedMediaResponse', cleared, rescanned })
    }
    browser.runtime.onMessage.addListener(handleRuntimeMessage)

    ctx.onInvalidated(() => {
      clearDwell()
      setCursorActive(false)
      grab = idleQuickGrab
      grabUi = null
      browser.runtime.onMessage.removeListener(handleRuntimeMessage)
    })
  },
})
