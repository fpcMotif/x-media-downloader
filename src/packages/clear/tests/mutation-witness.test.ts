import { describe, expect, it } from 'vitest'
import { makeMutationWitness } from '../mutation-witness'

describe('makeMutationWitness', () => {
  it('no matching mutation ever recorded ⇒ none', () => {
    const w = makeMutationWitness()
    expect(w.outcome('1', 'bookmark', 0)).toBe('none')
  })

  it('DeleteBookmark 200 no-error confirms a bookmark release ⇒ ok', () => {
    const w = makeMutationWitness()
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 200, error: false, t: 100 })
    expect(w.outcome('1', 'bookmark', 0)).toBe('ok')
  })

  it('UnfavoriteTweet 200 no-error confirms a like release ⇒ ok', () => {
    const w = makeMutationWitness()
    w.record({ tweetId: '1', op: 'UnfavoriteTweet', status: 200, error: false, t: 100 })
    expect(w.outcome('1', 'like', 0)).toBe('ok')
  })

  it('non-200 status on the confirming op ⇒ error', () => {
    const w = makeMutationWitness()
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 429, error: false, t: 100 })
    expect(w.outcome('1', 'bookmark', 0)).toBe('error')
  })

  it('200 but body error signal ⇒ error', () => {
    const w = makeMutationWitness()
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 200, error: true, t: 100 })
    expect(w.outcome('1', 'bookmark', 0)).toBe('error')
  })

  it('scope→op mapping: a DeleteBookmark never confirms `like`, an UnfavoriteTweet never confirms `bookmark`', () => {
    const w = makeMutationWitness()
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 200, error: false, t: 100 })
    w.record({ tweetId: '2', op: 'UnfavoriteTweet', status: 200, error: false, t: 100 })
    expect(w.outcome('1', 'like', 0)).toBe('none')
    expect(w.outcome('2', 'bookmark', 0)).toBe('none')
  })

  it('CreateBookmark / FavoriteTweet (re-add ops) never produce an outcome for either scope', () => {
    const w = makeMutationWitness()
    w.record({ tweetId: '1', op: 'CreateBookmark', status: 200, error: false, t: 100 })
    w.record({ tweetId: '1', op: 'FavoriteTweet', status: 200, error: false, t: 100 })
    expect(w.outcome('1', 'bookmark', 0)).toBe('none')
    expect(w.outcome('1', 'like', 0)).toBe('none')
  })

  it('since-gate: an event strictly BEFORE sinceT is ignored (a prior clear, not this one)', () => {
    const w = makeMutationWitness()
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 200, error: false, t: 100 })
    expect(w.outcome('1', 'bookmark', 101)).toBe('none')
  })

  it('since-gate: an event AT sinceT counts (inclusive)', () => {
    const w = makeMutationWitness()
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 200, error: false, t: 100 })
    expect(w.outcome('1', 'bookmark', 100)).toBe('ok')
  })

  it('newest matching event wins: an error overwritten by a later ok reads ok', () => {
    const w = makeMutationWitness()
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 429, error: false, t: 100 })
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 200, error: false, t: 200 })
    expect(w.outcome('1', 'bookmark', 0)).toBe('ok')
  })

  it('newest matching event wins: an ok overwritten by a later error reads error', () => {
    const w = makeMutationWitness()
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 200, error: false, t: 100 })
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 429, error: false, t: 200 })
    expect(w.outcome('1', 'bookmark', 0)).toBe('error')
  })

  it('capacity eviction: recording past capacity drops the oldest entry first', () => {
    const w = makeMutationWitness({ capacity: 2 })
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 200, error: false, t: 1 })
    w.record({ tweetId: '2', op: 'DeleteBookmark', status: 200, error: false, t: 2 })
    // Third distinct (tweetId, op) entry evicts '1' (the oldest surviving key).
    w.record({ tweetId: '3', op: 'DeleteBookmark', status: 200, error: false, t: 3 })
    expect(w.outcome('1', 'bookmark', 0)).toBe('none')
    expect(w.outcome('2', 'bookmark', 0)).toBe('ok')
    expect(w.outcome('3', 'bookmark', 0)).toBe('ok')
  })

  it('capacity eviction does not evict on an UPDATE to an existing key (size unchanged)', () => {
    const w = makeMutationWitness({ capacity: 2 })
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 429, error: false, t: 1 })
    w.record({ tweetId: '2', op: 'DeleteBookmark', status: 200, error: false, t: 2 })
    // Re-recording tweetId '1' updates in place — still 2 keys, nothing evicted.
    w.record({ tweetId: '1', op: 'DeleteBookmark', status: 200, error: false, t: 3 })
    expect(w.outcome('1', 'bookmark', 0)).toBe('ok')
    expect(w.outcome('2', 'bookmark', 0)).toBe('ok')
  })
})
