import type { SweepEnqueueResponse } from '../core/schema/download'

/** A reply can claim queued work only after Registry has the durable handoff. */
export const sweepEnqueueFailureResponse = (input: {
  readonly selectedPosts: number
  readonly selectionSkipped: number
  readonly durableHandoff: boolean
}): SweepEnqueueResponse =>
  input.durableHandoff
    ? {
        _tag: 'SweepEnqueueResponse',
        queued: input.selectedPosts,
        skipped: input.selectionSkipped,
      }
    : {
        _tag: 'SweepEnqueueResponse',
        queued: 0,
        skipped: input.selectionSkipped + input.selectedPosts,
      }
