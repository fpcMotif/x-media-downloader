import { adapterForHostname, ALL_ADAPTERS } from '../core/adapters/registry'
import { matchReleaseMutationOp } from '../core/adapters/x/tracked-mutation'
import {
  makeTeeBudget,
  readBoundedUtf8Response,
  utf8ByteLengthAtMost,
  MAX_TEE_BODY_BYTES,
  TEE_DROP_EVENT,
  type TeeDropCap,
} from '@/packages/kernel/tee-limits'

/**
 * MAIN-world passive tee (ADR-0001, grounding §c; widened to Instagram/Threads
 * by docs/superpowers/specs/2026-07-04-multi-platform-adapter-design.md).
 * Patches XHR + fetch to copy the current platform's own media-bearing network
 * responses to the ISOLATED content script via a document CustomEvent. Issues
 * no requests of its own; always returns the page's response.
 *
 * X-only, and on a SEPARATE predicate + CustomEvent channel from the media tee
 * above: Release diagnostics mutation observation (spec #59 ticket #63) —
 * `CreateBookmark`/`DeleteBookmark`/`FavoriteTweet`/`UnfavoriteTweet`. Always
 * watched (cheap — one more URL-string test per request); the ISOLATED side
 * decides whether to keep/relay anything, gated on the `releaseMutationDiagnosticsEnabled`
 * setting, so a page-forged event with the toggle off still costs nothing. Unlike
 * the media tee (which drops every non-OK response), this one reports the HTTP
 * status AND body on BOTH success and failure — a non-200 or an errors-array-
 * bearing 200 is exactly the H1 evidence this ticket exists to capture. It also
 * captures the REQUEST body (the tweet id lives there, not in the response) —
 * the one place this tee reads more than a response.
 */
export default defineContentScript({
  matches: [...new Set(ALL_ADAPTERS.flatMap((a) => a.hostMatch))],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const adapter = adapterForHostname(location.hostname)
    if (!adapter) return // fail closed: no platform recognized, tee nothing

    const isTrackedUrl = (url: string): boolean => adapter.isTrackedResponseUrl(url)

    const isStringXhrBody = (
      body: Document | XMLHttpRequestBodyInit | null | undefined,
    ): body is string => typeof body === 'string'
    const isStringFetchInput = (input: RequestInfo | URL): input is string =>
      typeof input === 'string'
    const isStringInitBody = (body: BodyInit | null | undefined): body is string =>
      typeof body === 'string'

    // Shared across both tee legs. Only the fetch paths take a lease: `clone()`
    // pins the whole body in the PAGE's heap until it is drained, so an unbounded
    // number of concurrent clones is the real leak. XHR's `responseText` is a
    // string the page already materialized — nothing extra is pinned by reading
    // it, so those paths take the byte cap alone.
    const teeBudget = makeTeeBudget()

    /** Production-visible drop notice (#92 follow-up): the ISOLATED content
     *  script relays this as a `capture`/`tee-drop` DownloadTraceEvent. */
    const emitDrop = (cap: TeeDropCap): void => {
      document.dispatchEvent(new CustomEvent(TEE_DROP_EVENT, { detail: { cap } }))
    }

    /** Bounded read of a fetch response, or null when it must be dropped. Always
     *  releases its slot, including on the refusal paths. */
    const readTeeBody = async (res: Response): Promise<string | null> => {
      const lease = teeBudget.acquire()
      if (!lease) {
        emitDrop('in-flight-cap')
        if (import.meta.env.DEV)
          console.debug(`[XMD] tee drop · ${adapter.platform} · captures in flight`)
        return null
      }
      try {
        return await readBoundedUtf8Response(res, lease)
      } finally {
        lease.release()
      }
    }

    /** Over-budget is a DROP, never a truncation — a half-body parses into
     *  plausible partial media, and under-reporting is worse than not reporting. */
    const withinTeeBudget = (body: string, what: string): boolean => {
      if (utf8ByteLengthAtMost(body, MAX_TEE_BODY_BYTES)) return true
      emitDrop('byte-cap')
      if (import.meta.env.DEV)
        console.debug(`[XMD] tee drop · ${adapter.platform} · ${what} over ${MAX_TEE_BODY_BYTES}B`)
      return false
    }

    const emit = (path: string, body: string): void => {
      if (import.meta.env.DEV)
        console.debug(
          `[XMD] tee emit · ${adapter.platform} · path=${path} · body=${body.length} chars`,
        )
      document.dispatchEvent(new CustomEvent('xmd:media-response', { detail: { path, body } }))
    }

    // Inert off X: `matchReleaseMutationOp` only ever matches X's GraphQL mutation
    // paths, but the explicit platform gate is the same "never on Instagram/Threads"
    // guarantee the rest of the Release feature makes, made local to this tee too.
    const isMutationUrl = (url: string): boolean =>
      adapter.platform === 'x' && matchReleaseMutationOp(url) !== null

    const emitMutation = (
      path: string,
      status: number,
      body: string,
      requestBody: string | null,
    ): void => {
      if (import.meta.env.DEV) console.debug(`[XMD] tee mutation · path=${path} · status=${status}`)
      document.dispatchEvent(
        new CustomEvent('xmd:mutation-response', { detail: { path, status, body, requestBody } }),
      )
    }

    // Request bodies for an in-flight XHR mutation, keyed by the XHR instance so
    // `send`'s body (captured here) reaches `open`'s 'load' listener (registered
    // first, since `open()` always precedes `send()`). A WeakMap so a request that
    // never completes (`load` never fires) can never leak its body.
    const xhrMutationBody = new WeakMap<XMLHttpRequest, string>()

    // Class method bodies don't inherit the `!adapter` early-return narrowing the
    // way arrow functions do, so the class reads the platform through this capture.
    const teePlatform = adapter.platform

    // A subclass instead of patching `XMLHttpRequest.prototype.open`/`send` in
    // place: `super.open(...)`/`super.send(...)` reach the native methods with
    // `this` bound by construction, so no unbound method reference ever exists
    // (typescript/unbound-method). Coverage is the same — this script runs at
    // document_start in the MAIN world, before any page script, so every XHR
    // the page constructs resolves `XMLHttpRequest` to this class.
    class TeeXMLHttpRequest extends XMLHttpRequest {
      // `rest` is a union of the two native `open()` arities so the super call
      // forwards the caller's exact argument count: appending an explicit
      // `undefined` async arg would flip a 2-arg call to synchronous XHR.
      override open(
        method: string,
        url: string | URL,
        ...rest:
          | []
          | [
              async: boolean,
              username?: string | null | undefined,
              password?: string | null | undefined,
            ]
      ): void {
        if (isTrackedUrl(String(url))) {
          if (import.meta.env.DEV)
            console.debug(`[XMD] tee XHR intercept · ${teePlatform} · ${method} ${url}`)
          this.addEventListener('load', () => {
            if (this.status === 200) {
              try {
                const body = this.responseText
                if (withinTeeBudget(body, 'xhr body'))
                  emit(new URL(this.responseURL).pathname, body)
              } catch {
                /* never break the page */
              }
            } else if (import.meta.env.DEV) {
              console.debug(
                `[XMD] tee XHR non-200 · ${teePlatform} · status=${this.status} · ${url}`,
              )
            }
          })
        }
        if (isMutationUrl(String(url))) {
          this.addEventListener('load', () => {
            try {
              const body = this.responseText
              const requestBody = xhrMutationBody.get(this) ?? null
              // A mutation body is a small GraphQL envelope; anything at this size
              // is not the evidence #63 is looking for.
              if (
                withinTeeBudget(body, 'xhr mutation body') &&
                (requestBody === null || withinTeeBudget(requestBody, 'xhr mutation request'))
              )
                emitMutation(new URL(this.responseURL).pathname, this.status, body, requestBody)
            } catch {
              /* never break the page */
            }
            xhrMutationBody.delete(this)
          })
        }
        if (rest.length === 0) super.open(method, url)
        else super.open(method, url, ...rest)
      }

      override send(body?: Document | XMLHttpRequestBodyInit | null): void {
        if (isStringXhrBody(body)) xhrMutationBody.set(this, body)
        super.send(body)
      }
    }
    window.XMLHttpRequest = TeeXMLHttpRequest

    const origFetch = window.fetch
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const promise = origFetch(input, init)
      try {
        const reqUrl = isStringFetchInput(input)
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        if (isTrackedUrl(reqUrl)) {
          if (import.meta.env.DEV)
            console.debug(`[XMD] tee fetch intercept · ${adapter.platform} · ${reqUrl}`)
          void promise.then((res) => {
            if (res.ok) {
              void readTeeBody(res)
                .then((body) => {
                  if (body !== null) emit(new URL(reqUrl, location.origin).pathname, body)
                })
                .catch(() => {})
            } else if (import.meta.env.DEV) {
              console.debug(
                `[XMD] tee fetch non-ok · ${adapter.platform} · status=${res.status} · ${reqUrl}`,
              )
            }
          })
        }
        if (isMutationUrl(reqUrl)) {
          const requestBody = isStringInitBody(init?.body) ? init.body : null
          void promise
            .then((res) =>
              readTeeBody(res).then((body) => {
                if (body === null) return
                if (requestBody !== null && !withinTeeBudget(requestBody, 'fetch mutation request'))
                  return
                emitMutation(
                  new URL(reqUrl, location.origin).pathname,
                  res.status,
                  body,
                  requestBody,
                )
              }),
            )
            .catch(() => {
              /* a rejected fetch (network failure) never reached a status — nothing to report */
            })
        }
      } catch {
        /* never break the page */
      }
      return promise
    }
  },
})
