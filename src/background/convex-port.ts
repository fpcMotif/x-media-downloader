/** The Promise-land background Convex transport seam — one `mutation` call, built
 *  per drain from settings, shared by `sync-outbox.ts` (metadata mirror) and
 *  `capture-outbox.ts` (tweet-harvest mirror). Its canonical live implementation is
 *  `makeConvexPromisePort` (core/sync/convex.ts), the single Effect→Promise airlock
 *  over the Effect-returning `ConvexPort` HTTP client. Distinct from `cloud-upload.ts`'s
 *  `CloudRuntimePort` (a different transport, for byte uploads) — do not fold that into
 *  this one. */
export interface ConvexPort {
  mutation(name: string, args: unknown): Promise<unknown>
}
