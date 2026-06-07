import { Schema, Effect } from 'effect'

export const MediaType = Schema.Literals(['photo', 'video', 'gif'])

export const MediaItem = Schema.Struct({
  id: Schema.String,
  tweetId: Schema.String,
  handle: Schema.String,
  type: MediaType,
  url: Schema.String,
  ext: Schema.String,
  index: Schema.Number,
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  bitrate: Schema.optional(Schema.Number),
})
export type MediaItem = typeof MediaItem.Type

export const DownloadStrategyName = Schema.Literals(['direct', 'fetched'])
export const Theme = Schema.Literals(['light', 'dark', 'system'])

export const Settings = Schema.Struct({
  filenameTemplate: Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('{handle}/{tweetId}_{index}.{ext}')),
  ),
  downloadConcurrency: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(3))),
  authFallbackEnabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  downloadStrategy: DownloadStrategyName.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed('direct' as const)),
  ),
  theme: Theme.pipe(Schema.withDecodingDefaultKey(Effect.succeed('system' as const))),
})
export type Settings = typeof Settings.Type

export const DetectRequest = Schema.TaggedStruct('DetectRequest', { tweetId: Schema.String })
export const MediaDetected = Schema.TaggedStruct('MediaDetected', {
  items: Schema.Array(MediaItem),
})
export const DownloadRequest = Schema.TaggedStruct('DownloadRequest', {
  items: Schema.Array(MediaItem),
})
export const QueueUpdate = Schema.TaggedStruct('QueueUpdate', {
  completed: Schema.Number,
  total: Schema.Number,
})

export const Message = Schema.Union([DetectRequest, MediaDetected, DownloadRequest, QueueUpdate])
export type Message = typeof Message.Type
