import { Context, Effect, Layer, Option, Ref } from 'effect'

/**
 * Drive-root/folder key → Drive folder id. Callers include the resolved root id,
 * so one SW-life runtime cannot reuse a folder from another OAuth account.
 * An SW recycle rebuilds the runtime → a fresh cache.
 */
export class FolderCache extends Context.Service<
  FolderCache,
  {
    readonly get: (folder: string) => Effect.Effect<Option.Option<string>>
    readonly set: (folder: string, id: string) => Effect.Effect<void>
  }
>()('cloud/FolderCache') {}

export const FolderCacheLive = Layer.effect(
  FolderCache,
  Effect.gen(function* () {
    const ref = yield* Ref.make<Record<string, string>>({})
    return {
      get: (k) => Ref.get(ref).pipe(Effect.map((r) => Option.fromUndefinedOr(r[k]))),
      set: (k, id) => Ref.update(ref, (r) => ({ ...r, [k]: id })),
    }
  }),
)
