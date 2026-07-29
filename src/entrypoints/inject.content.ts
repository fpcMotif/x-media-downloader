import { allPlatformHostMatch } from '../core/adapters/catalog'
import { adapterForHostname } from '../core/adapters/registry'
import { installMainWorldResponseTee } from './inject/tee'

/**
 * MAIN-world passive tee (ADR-0001, grounding §c; widened to Instagram/Threads
 * by docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md).
 * Patches XHR + fetch to copy the current platform's own media-bearing network
 * responses to the ISOLATED content script via a document CustomEvent. Issues
 * no requests of its own; always returns the page's response.
 */
export default defineContentScript({
  matches: [...allPlatformHostMatch()],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const adapter = adapterForHostname(location.hostname)
    if (!adapter) return // fail closed: no platform recognized, tee nothing

    installMainWorldResponseTee({
      fetchOwner: window,
      xhrPrototype: XMLHttpRequest.prototype,
      origin: location.origin,
      isTrackedUrl: adapter.isTrackedResponseUrl,
      routeAtObservation: () => `${location.pathname}${location.search}${location.hash}`,
      emit: (path, body, route) =>
        document.dispatchEvent(
          new CustomEvent('xmd:media-response', { detail: { path, body, route } }),
        ),
    })
  },
})
