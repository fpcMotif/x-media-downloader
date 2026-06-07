# Task 002 — Schema models (impl)

**type:** impl
**depends-on:** ["002-schema-test"]

## Contract (signatures only)

```ts
import { Schema, Effect } from 'effect'
export const MediaType = Schema.Literals(['photo', 'video', 'gif'])   // array form
export const MediaItem = Schema.Struct({ /* …; optional via Schema.optional */ })
export const Settings  = Schema.Struct({ /* defaults via withDecodingDefaultKey(Effect.succeed(v)) */ })
export const Message   = Schema.Union([/* TaggedStruct members */])   // array form
export type MediaItem = typeof MediaItem.Type
export type Settings  = typeof Settings.Type
export type Message   = typeof Message.Type
```

## Files

- `src/core/schema/index.ts`

## Steps

1. Define `MediaItem` with `Schema.Struct`; optional fields via `Schema.optional`.
2. Define `Settings` defaults via
   `Schema.<T>.pipe(Schema.withDecodingDefaultKey(Effect.succeed(<value>)))`
   (v4 defaults take an `Effect`, not a value). Defaults: template
   `{handle}/{tweetId}_{index}.{ext}`, concurrency 3, authFallbackEnabled false.
3. Define `Message` as `Schema.Union([...])` of `Schema.TaggedStruct` members
   (`DetectRequest`, `MediaDetected`, `DownloadRequest`, `QueueUpdate`,
   `SettingsGet`, `SettingsSet`).

## Verification

- `bun test src/core/schema` — all green.
