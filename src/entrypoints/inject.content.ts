import { isGraphqlMediaUrl } from './inject/tee'

/**
 * MAIN-world passive tee (ADR-0001, grounding §c). Patches XHR + fetch to copy
 * X's own GraphQL media responses to the ISOLATED content script via a document
 * CustomEvent. Issues no requests of its own; always returns the page's response.
 */
export default defineContentScript({
  matches: ['*://x.com/*', '*://twitter.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
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
      if (isGraphqlMediaUrl(String(url))) {
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
        if (isGraphqlMediaUrl(reqUrl)) {
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
