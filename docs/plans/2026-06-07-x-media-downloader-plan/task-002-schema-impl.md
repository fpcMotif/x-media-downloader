# Task 002 — Schema models (impl)

**type:** impl
**depends-on:** ["002-schema-test"]

## Contract (signatures only)

```ts
export const MediaType: Schema.Schema<"photo" | "video" | "gif">
export const MediaItem: Schema.Schema<MediaItem>
export const Settings: Schema.Schema<Settings>   // with defaults
export const Message: Schema.Schema<Message>      // tagged union
export type MediaItem = Schema.Schema.Type<typeof MediaItem>
export type Settings = Schema.Schema.Type<typeof Settings>
export type Message = Schema.Schema.Type<typeof Message>
```

## Files

- `src/core/schema/index.ts`

## Steps

1. Define `MediaItem` (`id, tweetId, handle, type, url, ext, index, width?, height?, bitrate?`).
2. Define `Settings` with `Schema.optionalWith(..., { default })` for each field.
3. Define `Message` as a `Schema.Union` of tagged structs (`DetectRequest`,
   `MediaDetected`, `DownloadRequest`, `QueueUpdate`, `SettingsGet`, `SettingsSet`).

## Verification

- `bun test src/core/schema` — all green.
