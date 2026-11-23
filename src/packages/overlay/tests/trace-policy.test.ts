import { describe, expect, it } from 'vitest'
import { isPageOnlyTraceStage } from '../trace-policy'

describe('isPageOnlyTraceStage', () => {
  it('treats hover-only stages as page-only', () => {
    expect(isPageOnlyTraceStage('shown')).toBe(true)
    expect(isPageOnlyTraceStage('nudged')).toBe(true)
    expect(isPageOnlyTraceStage('armed')).toBe(true)
  })

  it('allows failure and outcome stages to reach the worker', () => {
    for (const stage of [
      'media-no-key',
      'no-item-for-hover',
      'grab-target-stale',
      'badge-target-stale',
      'whole-post-fallback',
      'recovery-retryable',
      'tee-drop',
    ]) {
      expect(isPageOnlyTraceStage(stage)).toBe(false)
    }
  })
})
