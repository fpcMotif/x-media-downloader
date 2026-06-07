import { detectFromJson } from '../core/adapters/x'
import type { MediaItem } from '../core/schema'

/**
 * ISOLATED content script: receives passive Captures from the MAIN-world tee,
 * detects MediaItems, and offers a grab control. (Per-media Preact overlays —
 * task 010 — are the next UX iteration; this is the functional baseline.)
 */
export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  main() {
    const registry = new Map<string, MediaItem>()

    const button = document.createElement('button')
    button.type = 'button'
    Object.assign(button.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '2147483647',
      display: 'none',
      padding: '10px 14px',
      borderRadius: '9999px',
      border: 'none',
      background: '#0f1419',
      color: '#fff',
      font: '600 13px system-ui, sans-serif',
      boxShadow: '0 2px 12px rgba(0,0,0,.3)',
      cursor: 'pointer',
    })

    const render = (): void => {
      button.textContent = `⬇ Download media (${registry.size})`
      button.style.display = registry.size > 0 ? 'block' : 'none'
    }

    button.addEventListener('click', () => {
      const items = [...registry.values()]
      if (items.length > 0) void browser.runtime.sendMessage({ _tag: 'DownloadRequest', items })
    })

    document.addEventListener('xmd:media-response', (event) => {
      const detail = (event as CustomEvent<{ path: string; body: string }>).detail
      try {
        const json: unknown = JSON.parse(detail.body)
        for (const item of detectFromJson(json)) registry.set(item.id, item)
        render()
      } catch {
        /* ignore non-JSON / unexpected shapes */
      }
    })

    document.body.appendChild(button)
    render()
  },
})
