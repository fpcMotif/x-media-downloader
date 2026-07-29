import { MAX_TRANSFER_PROJECTION_ID_LENGTH } from './limits'

/** Sink-independent transfer projection identity. */
export const isTransferProjectionId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_TRANSFER_PROJECTION_ID_LENGTH &&
  value.trim() === value
