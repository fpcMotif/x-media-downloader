/**
 * Build a minimal `typeof fetch` stub from a plain async function, for tests that
 * exercise an HTTP call site without a real network (the aria2/convex/cloud port
 * convention — see `kernel/fetch.ts`'s module doc).
 */
export const fetchStub = (
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch => {
  // SAFETY: the real `fetch` accepts `RequestInfo | URL`; every stub built through
  // this helper is exercised only via a bound port that always calls it with a
  // string URL (never a `Request`/`URL` object), so the narrower parameter type
  // above is never asked to do more than it declares.
  return impl as typeof fetch
}
