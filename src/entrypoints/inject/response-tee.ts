import { isGraphqlMediaUrl } from './tee'

declare global {
  interface Window {
    xmdResponseTeeInstalled?: boolean
  }
}

function emitResponse(path: string, body: string): void {
  document.dispatchEvent(new CustomEvent('xmd:media-response', { detail: { path, body } }))
}

export function installResponseTee(): void {
  if (window.xmdResponseTeeInstalled) return
  window.xmdResponseTeeInstalled = true

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
            emitResponse(new URL(this.responseURL).pathname, this.responseText)
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
              .then((body) => {
                emitResponse(new URL(reqUrl, location.origin).pathname, body)
                return undefined
              })
              .catch(() => {})
          }
          return undefined
        })
      }
    } catch {
      /* never break the page */
    }
    return promise
  }
}
