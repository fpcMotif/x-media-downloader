/**
 * TEACHING ARTIFACT — Lesson 5: migrating a `cfg.fetchImpl` style dependency from
 * MANUAL dependency injection (a function parameter you thread by hand) to the
 * Effect `R` channel (the Reader monad), provided by a Layer. Safe to delete.
 *
 * The "before" lives in your real code — e.g. makeAria2RpcPort({ rpcUrl, secret,
 * fetchImpl }) and DriveDeps.fetchImpl. This demo showcases the "after" so you can
 * feel the payoff: the dependency is tracked in the type, and you swap the
 * implementation (real ⟷ stub) by swapping a Layer — no network in tests.
 *
 * Run: bunx vitest run src/core/teach/fetch-service.demo.test.ts
 * Mirrors the exact Context.Service/Layer idiom of src/core/settings/index.ts.
 */
import { describe, it, expect } from 'vitest'
import { Context, Effect, Layer } from 'effect'

// 1) THE SERVICE — the one dependency (`fetch`), named and given an interface.
class FetchService extends Context.Service<
  FetchService,
  { readonly fetch: (url: string) => Effect.Effect<Response> }
>()('teach/FetchService') {}

// 2) A LIVE Layer — the real implementation (illustrative; the test uses a stub).
const FetchServiceLive = Layer.succeed(FetchService, {
  fetch: (url) => Effect.promise(() => fetch(url)),
})

// 3) A TEST Layer — a stub. Swapping THIS swaps the implementation everywhere.
const FetchServiceStub = (status: number) =>
  Layer.succeed(FetchService, {
    fetch: () => Effect.succeed(new Response(null, { status })),
  })

// 4) A PROGRAM that declares its need in R = FetchService and never names fetch
//    directly. It cannot run until a FetchService is provided.
const statusOf = (url: string): Effect.Effect<number, never, FetchService> =>
  Effect.gen(function* () {
    const http = yield* FetchService
    const res = yield* http.fetch(url)
    return res.status
  })

describe('Lesson 5 — fetchImpl as a Layer-provided service (the R / Reader channel)', () => {
  it('reads its dependency from R; provide a stub Layer to run it (no network)', async () => {
    const program = statusOf('https://pbs.twimg.com/media/AAA')
    const status = await Effect.runPromise(Effect.provide(program, FetchServiceStub(204)))
    expect(status).toBe(204)
  })

  it('swapping the Layer swaps the implementation — same program, different result', async () => {
    const program = statusOf('https://example.com')
    expect(await Effect.runPromise(Effect.provide(program, FetchServiceStub(500)))).toBe(500)
    expect(await Effect.runPromise(Effect.provide(program, FetchServiceStub(200)))).toBe(200)
  })

  it('the FetchServiceLive layer exists for production wiring (not exercised here)', () => {
    // Provided at the edge: Effect.runPromise(Effect.provide(program, FetchServiceLive))
    expect(typeof FetchServiceLive).toBe('object')
  })
})
