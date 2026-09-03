/** `typeof fetch`'s first param is `RequestInfo | URL`; every stub built through
 *  `fetchStub` is exercised only via a bound port that always calls it with a
 *  string URL, so narrow via `instanceof` (never stringify a `Request`, whose
 *  default `toString` is meaningless) rather than asserting the narrower type. */
const urlString = (input: RequestInfo | URL): string =>
  input instanceof URL ? input.href : input instanceof Request ? input.url : input

/**
 * Build a minimal `typeof fetch` stub from a plain async function, for tests that
 * exercise an HTTP call site without a real network (the aria2/convex/cloud port
 * convention — see `kernel/fetch.ts`'s module doc).
 */
export const fetchStub = (
  impl: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch => {
  return (input, init) => impl(urlString(input), init)
}
