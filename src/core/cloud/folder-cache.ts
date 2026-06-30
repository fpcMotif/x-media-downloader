import { Context, Effect, Layer, Option, Ref } from 'effect'

/**
 * handle → Drive subfolder id. The `Ref` is created ONCE when the layer is built,
 * so it lives as long as the runtime that owns it (the SW-life cloud runtime).
 * An SW recycle rebuilds the runtime → a fresh cache, matching the prior `Map`.
 */
export class FolderCache extends Context.Service<
  FolderCache,
  {
    readonly get: (handle: string) => Effect.Effect<Option.Option<string>>
    readonly set: (handle: string, id: string) => Effect.Effect<void>
  }
>()('cloud/FolderCache') {}

export const FolderCacheLive = Layer.effect(
  FolderCache,
  Effect.gen(function* () {
    const ref = yield* Ref.make<Record<string, string>>({})
    return {
      get: (h) => Ref.get(ref).pipe(Effect.map((r) => Option.fromUndefinedOr(r[h]))),
      set: (h, id) => Ref.update(ref, (r) => ({ ...r, [h]: id })),
    }
  }),
)
