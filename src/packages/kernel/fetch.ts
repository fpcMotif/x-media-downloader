/**
 * Bind an injected `fetch` to the global scope. Native `fetch` in the MV3 service
 * worker brand-checks its receiver: calling it as `obj.fetchImpl(...)` runs it
 * with `this === obj`, which the SW rejects with
 * `TypeError: Failed to execute 'fetch' … Illegal invocation`. Every module that
 * takes a `fetchImpl` dependency and calls it as a property must detach it through
 * this helper first (ADR-0009 implementation note).
 *
 * Centralizing the rule here means a new fetch site can't silently forget it — the
 * footgun only surfaces in the real SW; arrow-function test mocks ignore `this`
 * and miss it entirely. The regression guards are the non-arrow brand-check stubs
 * in `fetch.test.ts`, `convex.test.ts`, and `aria2.test.ts`.
 */
export const bindFetch = (fetchImpl: typeof fetch): typeof fetch => fetchImpl.bind(globalThis)
