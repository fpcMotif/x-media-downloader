/** Adapter-local Media Key wire bound. */
export const MAX_MEDIA_ID_LENGTH = 512

/** One DownloadRequest may carry at most this many Media Items. */
export const MAX_DOWNLOAD_ITEMS_PER_REQUEST = 64

/** One SavedStatusRequest may carry at most this many unique X snowflakes. */
export const MAX_SAVED_TWEET_IDS_PER_REQUEST = 100

/** One SweepEnqueueRequest may carry at most this many posts. */
export const MAX_SWEEP_POSTS_PER_REQUEST = 16

/** An X post can contribute at most four Media Items to one Sweep request. */
export const MAX_X_MEDIA_PER_SWEEP_POST = 4

/** One SweepEnqueueRequest may carry at most this many Media Items in total. */
export const MAX_SWEEP_MEDIA_PER_REQUEST = 64

/** Opaque durable identifier for one X list-sweep post. */
export const MAX_SWEEP_RECEIPT_ID_LENGTH = 96

/** Stable idempotency key shared by transfer ownership and terminal sinks. */
export const MAX_TRANSFER_PROJECTION_ID_LENGTH = 256

/** Longest `xmd:v1:<kind>:<platform>:<length>:<media-key>` artifact identity. */
export const MAX_SAVE_REQUEST_ID_LENGTH =
  'xmd:v1:sidecar:instagram:512:'.length + MAX_MEDIA_ID_LENGTH

/** Durable transfer request and lease IDs include the longest encoded artifact tuple. */
export const MAX_TRANSFER_REGISTRY_ID_LENGTH = MAX_SAVE_REQUEST_ID_LENGTH

/** Durable Save Request and Download History filenames share this wire limit. */
export const MAX_TRANSFER_FILENAME_LENGTH = 1_024

/** Largest UTF-8 syndication metadata body recovered through worker messaging. */
export const MAX_SYNDICATION_BODY_BYTES = 64 * 1024
