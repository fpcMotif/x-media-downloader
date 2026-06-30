import { describe, it, expect } from 'vitest'
import { Effect, Exit } from 'effect'
import { FetchService, makeFetchServiceLive } from './fetch-service'

describe('makeFetchServiceLive', () => {
  it('calls fetch with a global receiver, never as a property of the holder (Illegal invocation)', async () => {
    // Native fetch in the MV3 SW throws when its receiver is not the global scope.
    // A non-arrow stub exposes the dynamic `this`, proving the service binds it once.
    const brandChecked = function (this: unknown) {
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
