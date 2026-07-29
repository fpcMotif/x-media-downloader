/** One CaptureTweets wire message may carry at most this many records. */
export const MAX_CAPTURE_BATCH = 64

/** One content-script tab retains at most this many unsent capture records. */
export const MAX_CAPTURE_PENDING = 512

/** One captured record's JSON representation may use at most 256 KiB. */
export const MAX_CAPTURE_RECORD_BYTES = 256 * 1024

/** One CaptureTweets wire message may use at most 2 MiB of JSON UTF-8. */
export const MAX_CAPTURE_MESSAGE_BYTES = 2 * 1024 * 1024

/** The largest recent-conversation list the archive panel may request. */
export const MAX_CAPTURE_SUMMARY_LIMIT = 1000

/** Omitted summary limits use the worker's compact recent-thread default. */
export const DEFAULT_CAPTURE_SUMMARY_LIMIT = 20

/** Summary rows expose a preview, never a full captured post. */
export const MAX_CAPTURE_SUMMARY_ROOT_TEXT_LENGTH = 256

/** One summary reply stays well below Chrome runtime-message limits. */
export const MAX_CAPTURE_SUMMARY_RESPONSE_BYTES = 2 * 1024 * 1024
