import { describe, expect, it } from 'vitest'
import { sweepEnqueueFailureResponse } from './sweep-enqueue-response'

describe('sweepEnqueueFailureResponse', () => {
  it('does not claim callback-failed work as queued', () => {
    expect(
      sweepEnqueueFailureResponse({
        selectedPosts: 3,
        selectionSkipped: 1,
        durableHandoff: false,
      }),
    ).toEqual({ _tag: 'SweepEnqueueResponse', queued: 0, skipped: 4 })
  })

  it('reports only a pre-seed failure as skipped', () => {
    expect(
      sweepEnqueueFailureResponse({
        selectedPosts: 3,
        selectionSkipped: 1,
        durableHandoff: false,
      }),
    ).toEqual({ _tag: 'SweepEnqueueResponse', queued: 0, skipped: 4 })
  })
})
