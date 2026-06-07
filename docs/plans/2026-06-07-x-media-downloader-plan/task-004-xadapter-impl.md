# Task 004 — XAdapter (impl)

**type:** impl
**depends-on:** ["004-xadapter-test"]

## Contract

```ts
import { Context, Effect, Layer } from 'effect'
export interface SourceAdapter {
  readonly detectMedia: (ctx: DetectContext) => Effect.Effect<MediaItem[], DetectError>
}
class XAdapter extends Context.Service<XAdapter, SourceAdapter>()('app/XAdapter') {}
export const XAdapterLive = Layer.effect(
  XAdapter,
  Effect.gen(function* () {
    const resolver = yield* MediaResolver           // inject dep
    return { detectMedia: (ctx) => /* ... */ }
  }),
).pipe(Layer.provide(MediaResolverLive))
```

## Files

- `src/core/adapters/source-adapter.ts` (interface + `DetectContext`)
- `src/core/adapters/x/index.ts`

## Steps

1. `DetectContext = { teedJson?: unknown; root?: ParentNode; tweetId?: string }`.
2. JSON path → delegate to `MediaResolver.resolveFromJson`.
3. DOM fallback → query `img[src*="pbs.twimg.com"]` / `video` under the tweet
   article, build `MediaItem`s via `upgradePhotoUrl`.

## Verification

- `bun test src/core/adapters` — all green.
