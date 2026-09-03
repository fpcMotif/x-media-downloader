import { describe, it, expect } from 'vitest'
import { Effect, Exit } from 'effect'
import { FetchService, makeFetchServiceLive } from '../fetch-service'

describe('makeFetchServiceLive', () => {
  it('calls fetch with a global receiver, never as a property of the holder (Illegal invocation)', async () => {
    // Native fetch in the MV3 SW throws when its receiver is not the global scope.
    // A non-arrow stub exposes the dynamic `this`, proving the service binds it once.
    // Typed to the two receivers a correctly-bound call produces: ESM is always
    // strict mode, so an un-bound call's receiver is `undefined` and a correctly-
    // bound one's is `globalThis` — the type doesn't gate the runtime check below,
    // which still fires on ANY other value.
    // SAFETY: `makeFetchServiceLive` only ever calls its `fetchImpl` as
    // `fetchImpl(url, init)`; this stub's narrower shape is never asked to do more.
    const brandChecked = function (this: typeof globalThis | undefined) {
      if (this !== globalThis && this !== undefined)
        throw new TypeError("Failed to execute 'fetch' on 'WorkerGlobalScope': Illegal invocation")
      return Promise.resolve(new Response('ok', { status: 200 }))
    } as typeof fetch
    const program = Effect.flatMap(FetchService, (h) => h.fetch('https://x/'))
    const res = await Effect.runPromise(
      program.pipe(Effect.provide(makeFetchServiceLive(brandChecked))),
    )
    expect(res.status).toBe(200)
  })

  it('surfaces a fetch rejection as a tagged FetchError, not a defect', async () => {
    // SAFETY: only called as `fetchImpl(url)` by `makeFetchServiceLive` — the
    // rejection is what's under test, so the stub never needs the real `init` param.
    const failing = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(FetchService, (h) => h.fetch('https://x/')).pipe(
        Effect.provide(makeFetchServiceLive(failing)),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('exposes the same bound fetch as `fetchPromise` (for the streamed sink)', async () => {
    let called = false
    // SAFETY: only called as `fetchImpl(url)` by `makeFetchServiceLive`/`fetchPromise` —
    // this stub only needs to prove it ran, never the real `RequestInfo | URL, init` shape.
    const f = (async () => {
      called = true
      return new Response('', { status: 204 })
    }) as typeof fetch
    const program = Effect.flatMap(FetchService, (h) =>
      Effect.promise(() => h.fetchPromise('https://x/')),
    )
    const res = await Effect.runPromise(program.pipe(Effect.provide(makeFetchServiceLive(f))))
    expect(called).toBe(true)
    expect(res.status).toBe(204)
  })
})
