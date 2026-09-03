import { describe, it, expect } from 'vitest'
import { bindFetch } from '../fetch'

describe('bindFetch', () => {
  it('invokes the underlying fetch with the global receiver, never as a method (Illegal invocation)', async () => {
    // Native `fetch` in the MV3 service worker brand-checks its receiver against
    // the global scope. A non-arrow stub exposes the dynamic `this`; bindFetch
    // must detach it so the call runs with `this === globalThis`, not the owner.
    // Typed to the two receivers a correctly-bound call produces: ESM is always
    // strict mode, so an un-bound call's receiver is `undefined` and `bindFetch`'s
    // own `.bind(globalThis)` makes a correctly-bound one `globalThis` — the type
    // doesn't gate the runtime check below, which still fires on ANY other value.
    // SAFETY: only single-string-arg `fetch(url)` is ever called through this stub
    // (`bindFetch`'s own signature is `typeof fetch` in, `typeof fetch` out; nothing
    // here exercises the wider `RequestInfo | URL, init` overload it doesn't implement).
    const brandChecked = function (this: typeof globalThis | undefined) {
      if (this !== globalThis && this !== undefined) {
        throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation")
      }
      return Promise.resolve(new Response('ok'))
    } as typeof fetch

    const owner = { fetchImpl: brandChecked }
    const bound = bindFetch(owner.fetchImpl)
    await expect(bound('https://x.example')).resolves.toBeInstanceOf(Response)
  })
})
