import { describe, it, expect } from 'vitest'
import { bindFetch } from './fetch'

describe('bindFetch', () => {
  it('invokes the underlying fetch with the global receiver, never as a method (Illegal invocation)', async () => {
    // Native `fetch` in the MV3 service worker brand-checks its receiver against
    // the global scope. A non-arrow stub exposes the dynamic `this`; bindFetch
    // must detach it so the call runs with `this === globalThis`, not the owner.
    const brandChecked = function (this: unknown) {
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
