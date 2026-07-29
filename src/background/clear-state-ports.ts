import type { ClearSessionMarker, ClearStorePointer } from './clear-state-codec'

/** Legacy storage exists only as a one-way migration source. */
export interface ClearCoordinatorStorage {
  readonly get: () => Promise<unknown>
  readonly remove: () => Promise<void>
}

/** Pre-coordinator completion data exists only as a one-way migration source. */
export interface LegacyCompletionStorage {
  readonly get: () => Promise<unknown>
  readonly remove: () => Promise<void>
}

export interface ClearStorePointerStorage {
  readonly get: () => Promise<unknown>
  readonly set: (value: ClearStorePointer) => Promise<void>
}

export interface ClearSessionMarkerStorage {
  readonly get: () => Promise<unknown>
  readonly set: (value: ClearSessionMarker) => Promise<void>
}

/** `setTimeout` converts larger delays to a signed 32-bit value in browsers. */
export const MAX_CLEAR_CLOCK_DELAY_MS = 2_147_483_647

export interface ClearClock {
  readonly now: () => number
  readonly schedule: (callback: () => void, delayMs: number) => void
}

export interface ClearCoordinatorTrace {
  readonly tweetId?: string
  readonly requestId?: string
  readonly detail?: string
}
