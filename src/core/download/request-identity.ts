import type { MediaItem, Platform } from '../schema/media'

export { MAX_SAVE_REQUEST_ID_LENGTH } from '../wire/limits'

export type SaveArtifactKind = 'media' | 'sidecar'

/**
 * Versioned tuple prefix. Ordinary X Media Keys stay unchanged for compatibility.
 * Any X key beginning with this prefix is escaped through the tuple form.
 */
export const SAVE_REQUEST_ID_PREFIX = 'xmd:v1:'

const encodedRequestId = (kind: SaveArtifactKind, platform: Platform, mediaKey: string): string =>
  `${SAVE_REQUEST_ID_PREFIX}${kind}:${platform}:${mediaKey.length}:${mediaKey}`

/** Injective global identity for one media save. */
export const mediaRequestId = (item: Pick<MediaItem, 'id' | 'platform'>): string =>
  item.platform === 'x' && !item.id.startsWith(SAVE_REQUEST_ID_PREFIX)
    ? item.id
    : encodedRequestId('media', item.platform, item.id)

/** Injective global identity for the metadata sibling of one media save. */
export const sidecarRequestId = (item: Pick<MediaItem, 'id' | 'platform'>): string =>
  encodedRequestId('sidecar', item.platform, item.id)

/** Current ID plus accepted pre-v1 persisted forms. New admissions require current IDs. */
export const isCompatibleMediaRequestId = (
  requestId: string,
  item: Pick<MediaItem, 'id' | 'platform'>,
): boolean =>
  requestId === mediaRequestId(item) ||
  requestId === item.id ||
  (item.platform !== 'x' && requestId === `${item.platform}:${item.id}`)
