import { Schema } from 'effect'

// Leaf module: the media description schemas live apart from index.ts so
// `core/resolver` can type against MediaItem without importing the full message
// schema — index.ts imports `capture/record` (which imports the resolver), so
// typing against it would be a cycle. Consumers keep importing `../schema`;
// index.ts re-exports everything here.

export const MediaType = Schema.Literals(['photo', 'video', 'gif'])
export type MediaType = typeof MediaType.Type

/** Which site a MediaItem was detected on. Drives adapter dispatch
 *  (`core/adapters/registry.ts`) and tags every Convex-mirrored row. */
export const Platform = Schema.Literals(['x', 'instagram', 'threads'])
export type Platform = typeof Platform.Type

export const MediaItem = Schema.Struct({
  id: Schema.String,
  platform: Platform,
  postId: Schema.String,
  author: Schema.String,
  type: MediaType,
  url: Schema.String,
  previewUrl: Schema.optionalKey(Schema.String),
  ext: Schema.String,
  index: Schema.Number,
  width: Schema.optionalKey(Schema.Number),
  height: Schema.optionalKey(Schema.Number),
  bitrate: Schema.optionalKey(Schema.Number),
})
export type MediaItem = typeof MediaItem.Type
