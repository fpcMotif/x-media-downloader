/** The Promise-land background Convex transport seam — one `mutation` call, built
 *  per drain from settings, shared by `sync-outbox.ts` (metadata mirror) and
 *  `capture-outbox.ts` (tweet-harvest mirror). Distinct from `core/sync/convex.ts`'s
 *  `ConvexPort` (the Effect-returning HTTP client this wraps at each module's own
 *  airlock) and from `cloud-upload.ts`'s `CloudRuntimePort` (a different transport,
 *  for byte uploads) — do not fold either of those into this one. */
export interface ConvexPort {
  mutation(name: string, args: unknown): Promise<unknown>
}
