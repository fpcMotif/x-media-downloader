import { Schema } from 'effect'

export const MAX_CAPTURE_EPOCH_LENGTH = 64

/** Opaque durable generation shared by Capture Archive producers and its outbox. */
export const CaptureEpoch = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CAPTURE_EPOCH_LENGTH),
  Schema.isPattern(/^[A-Za-z0-9:_-]+$/u),
)
export type CaptureEpoch = typeof CaptureEpoch.Type
