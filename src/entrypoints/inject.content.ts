import { adapterForHostname, ALL_ADAPTERS } from '../core/adapters/registry'

/**
 * MAIN-world passive tee (ADR-0001, grounding §c; widened to Instagram/Threads
 * by docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md).
 * Patches XHR + fetch to copy the current platform's own media-bearing network
 * responses to the ISOLATED content script via a document CustomEvent. Issues
 * no requests of its own; always returns the page's response.
 */
export default defineContentScript({
  matches: [...new Set(ALL_ADAPTERS.flatMap((a) => a.hostMatch))],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const adapter = adapterForHostname(location.hostname)
    if (!adapter) return // fail closed: no platform recognized, tee nothing

    const isTrackedUrl = (url: string): boolean => adapter.isTrackedResponseUrl(url)

    const emit = (path: string, body: string): void => {
      document.dispatchEvent(new CustomEvent('xmd:media-response', { detail: { path, body } }))
    }

    const origOpen = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ): void {
      if (isTrackedUrl(String(url))) {
        this.addEventListener('load', () => {
          if (this.status === 200) {
            try {
              emit(new URL(this.responseURL).pathname, this.responseText)
            } catch {
              /* never break the page */
            }
          }
        })
      }
      ;(origOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest])
    }

    const origFetch = window.fetch
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const promise = origFetch(input, init)
      try {
        const reqUrl =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (isTrackedUrl(reqUrl)) {
          void promise.then((res) => {
            if (res.ok) {
              void res
                .clone()
                .text()
                .then((body) => emit(new URL(reqUrl, location.origin).pathname, body))
                .catch(() => {})
            }
          })
        }
      } catch {
        /* never break the page */
      }
      return promise
    }
  },
})
