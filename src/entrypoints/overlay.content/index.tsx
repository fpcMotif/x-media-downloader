import './style.css'
import { render } from 'preact'
import {
  detectFromJson,
  detectRenderedImageElements,
  resolveImageElement,
} from '../../core/adapters/x'
import { mediaKeyFromUrl, isGrabbableMediaPreviewUrl } from '../../core/adapters/x/dom'
import {
  idleQuickGrab,
  pressModifier,
  releaseModifier,
  canGrab,
  markGrabbed,
  isModifierKey,
  syncModifierFromFlags,
  quickGrabDwellMs,
  quickGrabBadgeLabel,
  type GrabModifier,
  type QuickGrabState,
  type QuickGrabUiPhase,
} from '../../core/quickgrab'
import {
  badgeNudgeDelayMs,
  badgeSavedRevertMs,
  beginSave,
  enterMedia,
  hiddenBadge,
  leaveMedia,
  nudgeBadge,
  resolveSave,
  type BadgeState,
} from '../../core/badge'
import { getSettings, watchSettings } from '../../core/settings'
import type { MediaItem, Settings } from '../../core/schema'

interface Rect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

type HoverMediaElement = HTMLImageElement | HTMLVideoElement

const isImageElement = (el: Element): el is HTMLImageElement => el.tagName === 'IMG'
const isVideoElement = (el: Element): el is HTMLVideoElement => el.tagName === 'VIDEO'

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect()
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

/** Alpha of a computed `backgroundColor` (`rgb(…)` / `rgba(…)` / keyword). */
const bgAlpha = (color: string): number => {
  const m = /^rgba?\(([^)]+)\)$/.exec(color)
  if (!m) return color === 'transparent' ? 0 : 1
  const parts = m[1]!.split(',')
  return parts.length === 4 ? Number(parts[3]) : 1
}

/**
 * The topmost hoverable media element at a viewport point, unless something visually occludes
 * it: this extension's own shadow host (launcher pill / grab ring), a modal layer
 * the media sits outside of (lightbox backdrop, compose scrim), or any opaque
 * layer. X's transparent hit-target divs over their own media pass through.
 */
const mediaAtPoint = (x: number, y: number): HoverMediaElement | null => {
  const stack = document.elementsFromPoint(x, y)
  const at = stack.findIndex((el) => isImageElement(el) || isVideoElement(el))
  if (at < 0) return null
  const media = stack[at] as HoverMediaElement
  for (const el of stack.slice(0, at)) {
    if (el.tagName === 'XMD-OVERLAY') return null
    if (el.contains(media)) continue
    const modal = el.closest('[aria-modal="true"], [role="dialog"]')
    if (modal && !modal.contains(media)) return null
    if (bgAlpha(getComputedStyle(el).backgroundColor) >= 0.5) return null
  }
  return media
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

const traceDownloadUi =
  (source: 'quickgrab' | 'badge') =>
  (
    stage: string,
    opts: {
      readonly item?: MediaItem
      readonly key?: string
      readonly elapsedMs?: number
      readonly detail?: string
    } = {},
  ): void => {
    void browser.runtime
      .sendMessage({
        _tag: 'DownloadTraceEvent',
        source,
        stage,
        t: Date.now(),
        ...(opts.item
          ? { itemId: opts.item.id, tweetId: opts.item.tweetId, type: opts.item.type }
          : {}),
        ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}),
        ...((opts.detail ?? opts.key) ? { detail: opts.detail ?? `key ${opts.key}` } : {}),
      })
      .catch(() => {})
  }

const traceQuickGrab = traceDownloadUi('quickgrab')
const traceBadge = traceDownloadUi('badge')

/** Accessible name for the badge by the one Media Item it downloads. */
const BADGE_ARIA: Record<MediaItem['type'], string> = {
  photo: 'Download photo',
  video: 'Download video',
  gif: 'Download GIF',
}

const previewSrcFromMedia = (media: HoverMediaElement): string =>
  isVideoElement(media)
    ? media.poster || media.currentSrc || media.src
    : media.currentSrc || media.src

const previewKeyFromMedia = (media: HoverMediaElement | null): string | null => {
  const src = media ? previewSrcFromMedia(media) : ''
  return media && isGrabbableMediaPreviewUrl(src) ? mediaKeyFromUrl(src) : null
}

const keysForItem = (item: MediaItem): string[] => {
  const keys = new Set<string>()
  const primary = mediaKeyFromUrl(item.url)
  const preview = item.previewUrl ? mediaKeyFromUrl(item.previewUrl) : null
  if (primary) keys.add(primary)
  if (preview) keys.add(preview)
  return [...keys]
}

/**
 * ISOLATED content script: detects MediaItems from the MAIN-world tee, then
 * renders a global launcher for bulk downloads and the Quick Grab ring for the
 * precise hover path, in a style-isolated Shadow Root (grounding §e).
 *
 * Quick Grab (the literal hover path): hold the configured modifier and media
 * under the cursor downloads itself at Original quality after a short dwell. A
 * ring + progress charge shows what's about to happen (and a window to bail); the
 * pure `core/quickgrab` state machine fires each media item at most once per press.
 *
 * Note: the hover anchor matches rendered `<img>`/`<video poster>` elements to detected items by
 * twimg media key. Photos can also fall back to a DOM-only resolver; videos/GIFs
 * need the passive GraphQL tee so their poster can map to the MP4 item.
 */
export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    const byId = new Map<string, MediaItem>()
    const byKey = new Map<string, MediaItem>()
    let host: HTMLElement | null = null

    // Quick Grab state. `qgEnabled` fails CLOSED: a user who turned the feature
    // off must never see it fire in the window before stored settings arrive.
    let qgEnabled = false
    let qgModifier: GrabModifier = 'alt'
    let grab: QuickGrabState = idleQuickGrab
    let hoverMedia: HoverMediaElement | null = null
    let hoverKey: string | null = null
    // Phases: charging (dwell running) → queued (background handoff pending) →
    // saved | failed; `noted` re-acknowledges an already-grabbed item.
    let grabUi: {
      key: string
      rect: Rect
      phase: QuickGrabUiPhase
    } | null = null
    let dwell: ReturnType<typeof setTimeout> | null = null
    let cursorStyle: HTMLStyleElement | null = null
    let lastX = 0
    let lastY = 0
    let pointerSeen = false
    let hoverArmedAt = 0
    let renderedScanQueued = false

    // Download badge (per-media fast path). `badgeEnabled` fails closed like
    // `qgEnabled`: nothing renders until stored settings arrive.
    let badgeEnabled = false
    let badge: BadgeState = hiddenBadge
    let badgeMedia: HoverMediaElement | null = null
    let badgeNudge: ReturnType<typeof setTimeout> | null = null
    let badgeRevert: ReturnType<typeof setTimeout> | null = null

    const rerender = (): void => {
      if (host) render(<Overlay />, host)
    }

    const addDetectedItems = (items: ReadonlyArray<MediaItem>): number => {
      let added = 0
      for (const item of items) {
        if (!byId.has(item.id)) added++
        byId.set(item.id, item)
        for (const key of keysForItem(item)) byKey.set(key, item)
      }
      return added
    }

    const scanRenderedMedia = (): void => {
      if (addDetectedItems(detectRenderedImageElements(document, location.pathname)) > 0) {
        rerender()
      }
    }

    const queueRenderedMediaScan = (): void => {
      if (renderedScanQueued) return
      renderedScanQueued = true
      ctx.requestAnimationFrame(() => {
        renderedScanQueued = false
        scanRenderedMedia()
      })
    }

    const clearDwell = (): void => {
      if (dwell !== null) {
        clearTimeout(dwell)
        dwell = null
      }
    }

    /** Toggle a page-level grab cursor on eligible media previews while the modifier is held. */
    const setCursorActive = (on: boolean): void => {
      if (on && !cursorStyle) {
        cursorStyle = document.createElement('style')
        cursorStyle.textContent = `${[
          'img[src*="pbs.twimg.com/media"]',
          'img[srcset*="pbs.twimg.com/media"]',
          'img[src*="pbs.twimg.com/tweet_video_thumb"]',
          'img[src*="pbs.twimg.com/ext_tw_video_thumb"]',
          'img[src*="pbs.twimg.com/amplify_video_thumb"]',
          'video[poster*="pbs.twimg.com/tweet_video_thumb"]',
          'video[poster*="pbs.twimg.com/ext_tw_video_thumb"]',
          'video[poster*="pbs.twimg.com/amplify_video_thumb"]',
        ].join(',')}{cursor:copy}`
        document.head.appendChild(cursorStyle)
      } else if (!on && cursorStyle) {
        cursorStyle.remove()
        cursorStyle = null
      }
    }

    const fireGrab = (media: HoverMediaElement, key: string): void => {
      dwell = null
      // The node may have been recycled, detached, or scrolled out from under the
      // pointer during the dwell (X's timeline is virtualized) — bail unless it is
      // still the same media, attached, and actually at the pointer's position.
      if (
        !media.isConnected ||
        previewKeyFromMedia(media) !== key ||
        !document.elementsFromPoint(lastX, lastY).includes(media)
      ) {
        grabUi = null
        rerender()
        return
      }
      const item =
        byKey.get(key) ??
        (isImageElement(media) ? resolveImageElement(media, location.pathname) : null)
      if (!item) {
        traceQuickGrab('no-item-for-hover', { key })
        grabUi = null
        rerender()
        return
      }
      grab = markGrabbed(grab, key)
      // After the dwell completes, move out of the charge state immediately.
      // The background reply then confirms whether the browser/aria2 handoff started.
      grabUi = { key, rect: rectOf(media), phase: 'queued' }
      rerender()
      void (async () => {
        const sendStartedAt = Date.now()
        traceQuickGrab('queued', { item, elapsedMs: sendStartedAt - hoverArmedAt })
        const ok = await sendTracked([item])
        traceQuickGrab(ok ? 'start-ack' : 'start-failed', {
          item,
          elapsedMs: Date.now() - sendStartedAt,
        })
        if (grabUi === null || grabUi.key !== key) return
        grabUi = { ...grabUi, phase: ok ? 'saved' : 'failed' }
        rerender()
      })()
    }

    /** Begin (or, if already grabbed this press, just acknowledge) a hovered media item. */
    const armHover = (media: HoverMediaElement, key: string): void => {
      if (canGrab(grab, key)) {
        grabUi = { key, rect: rectOf(media), phase: 'charging' }
        rerender()
        hoverArmedAt = Date.now()
        traceQuickGrab('armed', { key })
        dwell = setTimeout(() => fireGrab(media, key), quickGrabDwellMs)
      } else {
        grabUi = { key, rect: rectOf(media), phase: 'noted' }
        rerender()
      }
    }

    /** Move the hover focus to `media`/`key` (either may be null), re-arming as needed. */
    const focusHover = (media: HoverMediaElement | null, key: string | null): void => {
      if (key === hoverKey && media === hoverMedia) return
      clearDwell()
      hoverMedia = media
      hoverKey = key
      if (grab.active && media && key) {
        armHover(media, key)
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

    const syncGrabFromPointer = (e: MouseEvent): boolean => {
      const next = syncModifierFromFlags(grab, e, qgModifier)
      if (next === grab) return grab.active
      if (!next.active) {
        releaseAll()
        return false
      }
      grab = next
      setCursorActive(true)
      return true
    }

    const clearBadgeTimers = (): void => {
      if (badgeNudge !== null) {
        clearTimeout(badgeNudge)
        badgeNudge = null
      }
      if (badgeRevert !== null) {
        clearTimeout(badgeRevert)
        badgeRevert = null
      }
    }

    const resetBadge = (): void => {
      clearBadgeTimers()
      badge = hiddenBadge
      badgeMedia = null
    }

    const badgeInput = (media: HoverMediaElement | null, key: string | null) => ({
      enabled: badgeEnabled,
      // Photos can resolve from the DOM alone at click time; videos/GIFs need the tee.
      resolvable: key !== null && media !== null && (byKey.has(key) || isImageElement(media)),
      modifierHeld: grab.active,
    })

    /** Move the badge entrance to the hovered media (either may be null). */
    const focusBadge = (media: HoverMediaElement | null, key: string | null): void => {
      const next = media && key ? enterMedia(badge, key, badgeInput(media, key)) : leaveMedia(badge)
      if (next === badge) return
      clearBadgeTimers()
      badge = next
      badgeMedia = next.phase === 'hidden' ? null : media
      if (next.phase === 'shown') {
        traceBadge('shown', next.key ? { key: next.key } : {})
        badgeNudge = setTimeout(() => {
          badgeNudge = null
          const nudged = nudgeBadge(badge)
          if (nudged === badge) return
          badge = nudged
          traceBadge('nudged', badge.key ? { key: badge.key } : {})
          rerender()
        }, badgeNudgeDelayMs)
      }
      rerender()
    }

    /** Hand the badge's one Media Item to the queue; failed retries, in-flight doesn't re-fire. */
    const onBadgeClick = (e: MouseEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const media = badgeMedia
      const key = badge.key
      const next = beginSave(badge)
      if (!media || !key || next === badge) return
      // The node may have been recycled or detached during the entrance (X's
      // timeline is virtualized) — bail unless it is still the same media.
      if (!media.isConnected || previewKeyFromMedia(media) !== key) {
        resetBadge()
        rerender()
        return
      }
      const item =
        byKey.get(key) ??
        (isImageElement(media) ? resolveImageElement(media, location.pathname) : null)
      if (!item) {
        traceBadge('no-item-for-hover', { key })
        resetBadge()
        rerender()
        return
      }
      clearBadgeTimers()
      badge = next
      rerender()
      void (async () => {
        const sendStartedAt = Date.now()
        traceBadge('queued', { item })
        const ok = await sendTracked([item])
        traceBadge(ok ? 'start-ack' : 'start-failed', {
          item,
          elapsedMs: Date.now() - sendStartedAt,
        })
        if (badge.key !== key || badge.phase !== 'queued') return
        badge = resolveSave(badge, ok)
        rerender()
        if (badge.phase !== 'saved') return
        badgeRevert = setTimeout(() => {
          badgeRevert = null
          if (badge.phase !== 'saved' || badge.key !== key) return
          // Linger, then revert to the idle arrow without a second nudge.
          badge = { phase: 'shown', key }
          rerender()
        }, badgeSavedRevertMs)
      })()
    }

    // Settings reach open tabs live (popup writes → storage watch). Any change
    // disarms an active grab: a swapped modifier would otherwise never see its
    // keyup, leaving grab mode stuck on.
    const applySettings = (s: Settings): void => {
      qgEnabled = s.quickGrabEnabled
      qgModifier = s.quickGrabModifier
      badgeEnabled = s.downloadBadgeEnabled
      resetBadge()
      releaseAll()
      rerender()
    }
    void getSettings().then(applySettings)
    ctx.onInvalidated(watchSettings(applySettings))

    /** The per-media download badge, anchored to the photo's bottom-right corner. */
    function BadgeButton({ media }: { readonly media: HoverMediaElement }) {
      const r = rectOf(media)
      const lightbox = media.closest('[aria-modal="true"], [role="dialog"]') !== null
      const size = lightbox ? 40 : 34
      const inset = lightbox ? 12 : 10
      const type = badge.key ? byKey.get(badge.key)?.type : undefined
      return (
        <button
          type="button"
          class={`xmd-badge xmd-badge--${badge.phase}${lightbox ? ' xmd-badge--lightbox' : ''}`}
          style={{
            top: `${r.top + r.height - size - inset}px`,
            left: `${r.left + r.width - size - inset}px`,
          }}
          aria-label={BADGE_ARIA[type ?? 'photo']}
          onClick={onBadgeClick}
        >
          <span class="xmd-badge__icon xmd-badge__icon--arrow" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <path
                d="M10 3.75v8.5m0 0 3.25-3.25M10 12.25 6.75 9M5 15.75h10"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.9"
              />
            </svg>
          </span>
          <span class="xmd-badge__icon xmd-badge__icon--spinner" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <circle
                cx="10"
                cy="10"
                r="6.5"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-dasharray="28 13"
              />
            </svg>
          </span>
          <span class="xmd-badge__icon xmd-badge__icon--check" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <path
                d="M5.5 10.5l3 3L14.5 7"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2.2"
              />
            </svg>
          </span>
          <span class="xmd-badge__icon xmd-badge__icon--alert" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <path
                d="M10 4.5v7m0 3.5v.01"
                fill="none"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-width="2.2"
              />
            </svg>
          </span>
        </button>
      )
    }

    function Overlay() {
      return (
        <>
          {grabUi && (
            <div
              key={grabUi.key}
              class={`xmd-grab xmd-grab--${grabUi.phase}`}
              style={{
                top: `${grabUi.rect.top}px`,
                left: `${grabUi.rect.left}px`,
                width: `${grabUi.rect.width}px`,
                height: `${grabUi.rect.height}px`,
                '--xmd-dwell': `${quickGrabDwellMs}ms`,
              }}
            >
              <span class="xmd-grab__badge">{quickGrabBadgeLabel(grabUi.phase)}</span>
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
          {badge.phase !== 'hidden' && badgeMedia?.isConnected && (
            <BadgeButton key={badge.key} media={badgeMedia} />
          )}
          {byId.size > 0 && (
            <button
              type="button"
              class="xmd-launcher"
              aria-label={`Download all detected media (${byId.size})`}
              onClick={() => send([...byId.values()])}
            >
              <span class="xmd-launcher__icon" aria-hidden="true">
                <svg viewBox="0 0 20 20" focusable="false">
                  <path
                    d="M10 3.75v8.5m0 0 3.25-3.25M10 12.25 6.75 9M5 15.75h10"
                    fill="none"
                    stroke="currentColor"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="1.8"
                  />
                </svg>
              </span>
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
        queueRenderedMediaScan()
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
        if (addDetectedItems(detectFromJson(json)) > 0) rerender()
      } catch {
        /* ignore non-JSON / unexpected shapes */
      }
    })

    // Quick Grab hover tracking: hold the configured modifier and hover a real
    // X media image/poster for the dwell window. No competing per-hover buttons.
    ctx.addEventListener(document, 'mousemove', (event) => {
      const e = event as MouseEvent
      lastX = e.clientX
      lastY = e.clientY
      pointerSeen = true
      if (!qgEnabled && !badgeEnabled) return
      // Pointer events are the ground truth. They both self-heal a swallowed
      // keyup and cover the common "hold modifier, then hover media" path where
      // the page never saw the initial keydown.
      const grabbing = qgEnabled && syncGrabFromPointer(e)
      const target = e.target as Element | null
      // Hovering this extension's own UI (the badge) must not read as leaving
      // the media underneath it — the entrance would hide before the click.
      if (target?.tagName === 'XMD-OVERLAY') return
      const media =
        (target?.closest('img,video') as HoverMediaElement | null) ??
        mediaAtPoint(e.clientX, e.clientY)
      const key = previewKeyFromMedia(media)
      if (grabbing) focusHover(media, key)
      focusBadge(media, key)
    })

    // Scroll moves content without firing mousemove: re-run the hit-test so the
    // dwell and ring track what is actually under the pointer, and refresh the
    // rect when the same media preview merely shifted.
    ctx.addEventListener(
      document,
      'scroll',
      () => {
        queueRenderedMediaScan()
        if (!pointerSeen || (!grab.active && badge.phase === 'hidden')) return
        // Pointer parked on our own badge: the media underneath didn't change,
        // only its rect did — refresh in place rather than re-hit-testing.
        const top = document.elementsFromPoint(lastX, lastY)[0] as Element | undefined
        if (top?.tagName === 'XMD-OVERLAY') {
          if (badge.phase !== 'hidden') rerender()
          return
        }
        const media = mediaAtPoint(lastX, lastY)
        const key = previewKeyFromMedia(media)
        if (media === badgeMedia && key === badge.key) {
          if (badge.phase !== 'hidden') rerender()
        } else if (badge.phase !== 'hidden') {
          focusBadge(media, key)
        }
        if (!grab.active) return
        if (media === hoverMedia && key === hoverKey) {
          if (grabUi !== null && media !== null) {
            grabUi = { ...grabUi, rect: rectOf(media) }
            rerender()
          }
          return
        }
        focusHover(media, key)
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
        // One affordance at a time: the ring owns the hover while the modifier is held.
        resetBadge()
        // Arm the media under the cursor — but only if a real pointer position is
        // known (no mousemove yet ⇒ lastX/lastY are still 0,0, not a real hover).
        const media = pointerSeen ? mediaAtPoint(lastX, lastY) : null
        const key = previewKeyFromMedia(media)
        hoverMedia = media
        hoverKey = key
        if (media && key) armHover(media, key)
        else rerender() // keep the page quiet when the press lands off media
      }
    })

    ctx.addEventListener(window, 'keyup', (event) => {
      if (isModifierKey((event as KeyboardEvent).key, qgModifier)) releaseAll()
    })
    ctx.addEventListener(window, 'blur', () => releaseAll())
    ctx.addEventListener(document, 'mouseleave', () => {
      focusHover(null, null)
      focusBadge(null, null)
    })

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      releaseAll()
      resetBadge()
      focusHover(null, null)
      queueRenderedMediaScan()
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
      clearDwell()
      setCursorActive(false)
      grab = idleQuickGrab
      grabUi = null
      resetBadge()
      let rescanned = 0
      const req = message as { _tag: string; rescanVisible?: boolean }
      if (req.rescanVisible) {
        for (const item of detectRenderedImageElements(document, location.pathname)) {
          if (!byId.has(item.id)) rescanned++
          byId.set(item.id, item)
          for (const key of keysForItem(item)) byKey.set(key, item)
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
      resetBadge()
      renderedScanQueued = false
      browser.runtime.onMessage.removeListener(handleRuntimeMessage)
    })
  },
})
