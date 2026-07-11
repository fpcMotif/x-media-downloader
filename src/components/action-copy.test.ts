import { describe, expect, it } from 'vitest'
import {
  RELEASE_WORD,
  RELEASE_PAGE_CONFIRM_LABEL,
  RELEASE_LIST_CONFIRM_LABEL,
  TURN_ON_RELEASE_LABEL,
  releasePageConfirm,
  releaseListConfirm,
  releasedPageResult,
  releasedListResult,
  turnOnReleaseConfirm,
  drainResult,
  sweepResult,
  contextLabel,
  modifierLabel,
  secondModifierLabel,
  hoverGrabLine,
  wholePostLine,
  firstRunBody,
  PAGE_UNREACHABLE,
  NO_ACTIVE_TAB,
  SWEEP_STALE_CONTEXT,
  isPersistentStatus,
} from './action-copy'

describe('RELEASE_WORD', () => {
  it('is the exact typed-word gate literal', () => {
    expect(RELEASE_WORD).toBe('RELEASE')
  })
})

describe('confirm labels — never the bare word "Confirm" (design contract line 4)', () => {
  it.each([
    ['Release the list', RELEASE_LIST_CONFIRM_LABEL],
    ['Release this page', RELEASE_PAGE_CONFIRM_LABEL],
    ['Turn it on', TURN_ON_RELEASE_LABEL],
  ])('restates the literal action: %s', (expected, actual) => {
    expect(actual).toBe(expected)
    expect(actual).not.toBe('Confirm')
  })
})

describe('release cluster copy', () => {
  it('releasePageConfirm matches §2.3 Row 1 armed sentence verbatim', () => {
    expect(releasePageConfirm).toBe(
      "Release every post on this page — un-like on Likes, un-bookmark on Bookmarks. This can't be undone.",
    )
  })

  it('releaseListConfirm matches §2.3 Row 2 armed sentence verbatim', () => {
    expect(releaseListConfirm).toBe(
      "Release the whole list — scrolls the entire list and releases every post. This can affect hundreds of posts and can't be undone.",
    )
  })

  it('turnOnReleaseConfirm matches the toggle-ON gate sentence verbatim', () => {
    expect(turnOnReleaseConfirm).toBe(
      'Turn on release after download? Each saved post will also be removed from its list (un-like on Likes, un-bookmark on Bookmarks) once its media is verified saved.',
    )
  })

  it.each([
    [0, 'Released 0 posts on this page.'],
    [1, 'Released 1 post on this page.'],
    [3, 'Released 3 posts on this page.'],
  ])('releasedPageResult(%i) → %s', (n, expected) => {
    expect(releasedPageResult(n)).toBe(expected)
  })

  it('releasedListResult: not-list reason', () => {
    expect(releasedListResult({ reason: 'not-list-page' })).toBe(
      'Open a Likes or Bookmarks list to release it.',
    )
  })

  it('releasedListResult: null result treated as zero', () => {
    expect(releasedListResult(null)).toBe('No posts to release on this list.')
  })

  it('releasedListResult: zero', () => {
    expect(releasedListResult({ cleared: 0 })).toBe('No posts to release on this list.')
  })

  it.each([
    [1, 'Released 1 post across the list.'],
    [42, 'Released 42 posts across the list.'],
  ])('releasedListResult: n=%i', (cleared, expected) => {
    expect(releasedListResult({ cleared })).toBe(expected)
  })
})

describe('drainResult', () => {
  it('n=0: teaches instead of reporting nothing', () => {
    expect(drainResult(0, false)).toBe(
      'No media detected yet — scroll to load posts, then try again.',
    )
    expect(drainResult(0, true)).toBe(
      'No media detected yet — scroll to load posts, then try again.',
    )
  })

  it('releasing (willClear true)', () => {
    expect(drainResult(5, true)).toBe('Downloading 5 items — each post releases as it finishes.')
  })

  it('plain (willClear false)', () => {
    expect(drainResult(5, false)).toBe('Downloading 5 items.')
  })

  it('singular item count', () => {
    expect(drainResult(1, false)).toBe('Downloading 1 item.')
  })
})

describe('sweepResult', () => {
  it('not-list-page reason', () => {
    expect(sweepResult({ reason: 'not-list-page' }, false)).toBe(
      'Open a Likes or Bookmarks page — the sweep only runs on a list.',
    )
  })

  it('context (stale) reason', () => {
    expect(sweepResult({ reason: 'context' }, false)).toBe(
      'Reload the X tab (the extension was updated), then try again.',
    )
  })

  it('nothing new: zero queued and zero skipped', () => {
    expect(sweepResult({ queued: 0, skipped: 0 }, false)).toBe(
      'No new media detected — scroll to load posts, then run again.',
    )
    expect(sweepResult(null, false)).toBe(
      'No new media detected — scroll to load posts, then run again.',
    )
  })

  it('releasing, no skipped clause when skipped=0', () => {
    expect(sweepResult({ queued: 4, skipped: 0 }, true)).toBe(
      'Queued 4 posts. Each releases from this list as its download finishes — scroll and run again.',
    )
  })

  it('releasing, skipped clause only when skipped > 0', () => {
    expect(sweepResult({ queued: 4, skipped: 2 }, true)).toBe(
      'Queued 4 posts, skipped 2 already released. Each releases from this list as its download finishes — scroll and run again.',
    )
  })

  it('plain (willClear false)', () => {
    expect(sweepResult({ queued: 4, skipped: 0 }, false)).toBe(
      'Queued 4 posts for download. Turn on "Release after download" below to also remove each from this list.',
    )
  })
})

describe('page-action error copy', () => {
  it('PAGE_UNREACHABLE', () => {
    expect(PAGE_UNREACHABLE).toBe('Could not reach the page — reload the X tab and try again.')
  })

  it('NO_ACTIVE_TAB', () => {
    expect(NO_ACTIVE_TAB).toBe('No active tab.')
  })

  it('SWEEP_STALE_CONTEXT', () => {
    expect(SWEEP_STALE_CONTEXT).toBe(
      'Reload the X tab (the extension was updated), then try again.',
    )
  })

  it('sweepResult surfaces SWEEP_STALE_CONTEXT for the context reason', () => {
    expect(sweepResult({ reason: 'context' }, false)).toBe(SWEEP_STALE_CONTEXT)
  })
})

describe('isPersistentStatus (§2.6 cluster status lifecycle)', () => {
  it('flags every actionable error as persistent', () => {
    expect(isPersistentStatus(PAGE_UNREACHABLE)).toBe(true)
    expect(isPersistentStatus(NO_ACTIVE_TAB)).toBe(true)
    expect(isPersistentStatus(SWEEP_STALE_CONTEXT)).toBe(true)
  })

  it('does not flag null or an ordinary result line', () => {
    expect(isPersistentStatus(null)).toBe(false)
    expect(isPersistentStatus('Downloading 5 items.')).toBe(false)
    expect(isPersistentStatus('Released 3 posts on this page.')).toBe(false)
  })
})

describe('contextLabel', () => {
  it('x-list with bookmark scope', () => {
    expect(contextLabel('x-list', 'bookmark')).toBe('X · Bookmarks list')
  })

  it('x-list with like scope', () => {
    expect(contextLabel('x-list', 'like')).toBe('X · Likes list')
  })

  it('x-list with no scope falls back to a generic list label', () => {
    expect(contextLabel('x-list')).toBe('X · list page')
  })

  it('x (non-list)', () => {
    expect(contextLabel('x')).toBe('X · ready')
  })

  it('instagram', () => {
    expect(contextLabel('instagram')).toBe('Instagram · ready')
  })

  it('threads', () => {
    expect(contextLabel('threads')).toBe('Threads · ready')
  })

  it('none (unsupported tab)', () => {
    expect(contextLabel('none')).toBe('Not on X, Instagram, or Threads')
  })
})

describe('modifier labels', () => {
  it.each([
    ['alt', 'Alt'],
    ['shift', 'Shift'],
    ['ctrl', 'Control'],
    ['meta', 'Cmd'],
  ] as const)('modifierLabel(%s) → %s', (mod, expected) => {
    expect(modifierLabel(mod)).toBe(expected)
  })

  it.each([
    ['alt', 'Cmd'],
    ['shift', 'Cmd'],
    ['ctrl', 'Cmd'],
    ['meta', 'Alt'],
  ] as const)('secondModifierLabel(%s) → %s (mirrors general.tsx line 44)', (mod, expected) => {
    expect(secondModifierLabel(mod)).toBe(expected)
  })
})

describe('teaching copy builders', () => {
  it('hoverGrabLine', () => {
    expect(hoverGrabLine('Alt')).toBe('Hover a photo or video and hold Alt to grab it.')
  })

  it('wholePostLine', () => {
    expect(wholePostLine('Alt', 'Cmd')).toBe(
      'Hold Alt + Cmd to grab a whole post, or use the download dock.',
    )
  })

  it('firstRunBody', () => {
    expect(firstRunBody('Alt')).toBe(
      'Hover a photo or video and hold Alt to grab it. The buttons below handle the whole page.',
    )
  })
})
