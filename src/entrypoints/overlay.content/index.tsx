import './style.css'
import { render } from 'preact'
import { detectFromJson } from '../../core/adapters/x'
import { mediaKeyFromUrl, groupByTweet } from '../../core/adapters/x/dom'
import { emptySelection, selectTweet, resolveSelection } from '../../core/selection'
import type { MediaItem } from '../../core/schema'

/**
 * ISOLATED content script: detects MediaItems from the MAIN-world tee, then
 * renders precise per-media hover overlays ("grab this" / "grab tweet") plus a
 * global launcher, in a style-isolated Shadow Root (grounding §e). Selection is
 * driven by the pure `core/selection` model.
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
    let hovered: { item: MediaItem; top: number; left: number } | null = null
    let host: HTMLElement | null = null

    const send = (items: ReadonlyArray<MediaItem>): void => {
      if (items.length > 0) void browser.runtime.sendMessage({ _tag: 'DownloadRequest', items })
    }

    const tweetItems = (tweetId: string): MediaItem[] => {
      const registry = groupByTweet([...byId.values()])
      return resolveSelection(registry, selectTweet(emptySelection(), registry, tweetId))
    }

    const rerender = (): void => {
      if (host) render(<Overlay />, host)
    }

    function Overlay() {
      return (
        <>
          {hovered && (
            <div class="xmd-hover" style={`top:${hovered.top}px;left:${hovered.left}px`}>
              <button
                class="xmd-btn"
                onClick={() => {
                  if (hovered) send([hovered.item])
                }}
              >
                ⬇ this
              </button>
              <button
                class="xmd-btn"
                onClick={() => {
                  if (hovered) send(tweetItems(hovered.item.tweetId))
                }}
              >
                ⬇ tweet
              </button>
            </div>
          )}
          {byId.size > 0 && (
            <button class="xmd-launcher" onClick={() => send([...byId.values()])}>
              ⬇ Download media ({byId.size})
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
        rerender()
      } catch {
        /* ignore non-JSON / unexpected shapes */
      }
    })

    ctx.addEventListener(document, 'mouseover', (event) => {
      const target = event.target as HTMLElement | null
      const img = target?.closest('img')
      if (!img) return
      const key = mediaKeyFromUrl(img.src)
      const item = key ? byKey.get(key) : undefined
      if (!item) return
      const rect = img.getBoundingClientRect()
      hovered = { item, top: rect.top + 8, left: rect.left + 8 }
      rerender()
    })

    ctx.addEventListener(window, 'wxt:locationchange', () => {
      hovered = null
      rerender()
    })
  },
})
