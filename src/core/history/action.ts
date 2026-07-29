import type { MediaItem } from '../schema'

/** A queued admission or terminal transition for durable Download History. */
export type HistoryAction =
  | {
      readonly kind: 'queued'
      readonly recordingEnabled: boolean
      readonly requestId: string
      readonly item: MediaItem
      readonly filename: string
      readonly at: number
    }
  | {
      readonly kind: 'completed' | 'failed'
      readonly requestId: string
      readonly at: number
      readonly bytes?: { readonly received: number; readonly total: number }
    }
