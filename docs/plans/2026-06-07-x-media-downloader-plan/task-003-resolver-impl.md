# Task 003 — MediaResolver (impl)

**type:** impl
**depends-on:** ["003-resolver-test"]

## Contract

```ts
import { Context, Effect, Layer } from 'effect'
class MediaResolver extends Context.Service<MediaResolver, {
  readonly resolveFromJson: (json: unknown) => Effect.Effect<MediaItem[], DetectError>
  readonly upgradePhotoUrl: (url: string) => string
  readonly pickVideoVariant: (variants: Variant[]) => Variant | null
}>()('app/MediaResolver') {}
export const MediaResolverLive = Layer.succeed(MediaResolver, { /* impl */ })
```
(Effect v4: no `Effect.Service` — use `Context.Service` + an explicit `Layer`.)

## Files

- `src/core/resolver/index.ts`
- `src/core/errors/index.ts` (`DetectError extends Data.TaggedError`)

## Steps

1. `upgradePhotoUrl`: replace/append `name=` with fallback chain
   `[orig, 4096x4096, large, medium, small]` (mirror gallery-dl `twitter.py`).
2. `pickVideoVariant`: filter `content_type === "video/mp4"`, `max` by `bitrate`.
3. `resolveFromJson`: walk media array → `MediaItem[]`, dedupe by `id`, validate
   each via the schema.

## Verification

- `bun test src/core/resolver` — all green.
