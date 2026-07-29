import { describe, expect, it } from 'vitest'
import { confirmEraseArchiveCopy, erasedArchiveCopy, eraseArchiveFailedCopy } from './capture-copy'

describe('Capture Archive erase copy', () => {
  it('states the local and remote limits before and after erase', () => {
    expect(confirmEraseArchiveCopy(2)).toBe(
      'Erase all 2 captured tweets and pending mirror work? This cannot be undone. Copies already sent to Convex remain.',
    )
    expect(erasedArchiveCopy(2)).toBe(
      'Erased 2 tweets and pending mirror work. Copies already sent to Convex remain.',
    )
  })
})

describe('eraseArchiveFailedCopy', () => {
  it('does not imply a successful erase', () => {
    expect(eraseArchiveFailedCopy()).toBe('Could not erase the archive. Try again.')
  })
})
