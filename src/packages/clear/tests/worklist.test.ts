import { describe, it, expect } from 'vitest'
import {
  capWorklist,
  decodeWorklist,
  emptyWorklist,
  enqueue,
  isCleared,
  keyFor,
  markState,
  summarize,
  type SweepWorklist,
} from '../worklist'

describe('sweep worklist', () => {
  it('enqueue adds a queued entry and is idempotent in state', () => {
    const a = enqueue(emptyWorklist, '1', 'like', 100)
    expect(a[keyFor('like', '1')]).toEqual({
      tweetId: '1',
      scope: 'like',
      state: 'queued',
      at: 100,
    })
    // Re-enqueue (e.g. a re-run) refreshes the timestamp but stays queued.
    const b = enqueue(a, '1', 'like', 200)
    expect(b[keyFor('like', '1')]?.state).toBe('queued')
    expect(b[keyFor('like', '1')]?.at).toBe(200)
  })

  it('never re-queues a cleared tweet (cleared is terminal)', () => {
    const cleared = markState(
      enqueue(emptyWorklist, '1', 'bookmark', 1),
      '1',
      'bookmark',
      'cleared',
      2,
    )
    expect(isCleared(cleared, '1', 'bookmark')).toBe(true)
    const after = enqueue(cleared, '1', 'bookmark', 3)
    expect(after).toBe(cleared) // same reference — no change
    expect(after[keyFor('bookmark', '1')]?.state).toBe('cleared')
  })

  it('tracks the SAME tweet independently per list scope', () => {
    // A post that is both bookmarked AND liked: clearing it in one scope must NOT
    // make a sweep of the other scope skip it (the per-tweet-key conflation bug).
    let wl = enqueue(emptyWorklist, '1', 'bookmark', 1)
    wl = markState(wl, '1', 'bookmark', 'cleared', 2)
    expect(isCleared(wl, '1', 'bookmark')).toBe(true)
    expect(isCleared(wl, '1', 'like')).toBe(false) // ← was wrongly true
    // The like scope still enqueues + advances independently of the cleared bookmark.
    wl = enqueue(wl, '1', 'like', 3)
    expect(wl[keyFor('like', '1')]?.state).toBe('queued')
    wl = markState(wl, '1', 'like', 'cleared', 4)
    expect(isCleared(wl, '1', 'like')).toBe(true)
    expect(summarize(wl)).toEqual({ queued: 0, downloaded: 0, cleared: 2, failed: 0 })
  })

  it('markState advances an existing entry through the lifecycle', () => {
    let wl = enqueue(emptyWorklist, '1', 'like', 1)
    wl = markState(wl, '1', 'like', 'downloaded', 2)
    expect(wl[keyFor('like', '1')]?.state).toBe('downloaded')
    wl = markState(wl, '1', 'like', 'cleared', 3)
    expect(wl[keyFor('like', '1')]).toEqual({
      tweetId: '1',
      scope: 'like',
      state: 'cleared',
      at: 3,
    })
  })

  it('markState is a no-op for an untracked (tweet, scope) — non-sweep downloads stay out', () => {
    const wl = enqueue(emptyWorklist, '1', 'like', 1)
    // Same tweet, DIFFERENT scope is untracked → no-op (proves scope isolation).
    expect(markState(wl, '1', 'bookmark', 'cleared', 2)).toBe(wl)
    const after = markState(wl, '999', 'like', 'cleared', 2)
    expect(after).toBe(wl)
    expect(after[keyFor('like', '999')]).toBeUndefined()
  })

  it('markState never regresses out of cleared', () => {
    const cleared = markState(enqueue(emptyWorklist, '1', 'like', 1), '1', 'like', 'cleared', 2)
    expect(markState(cleared, '1', 'like', 'failed', 3)).toBe(cleared)
    expect(markState(cleared, '1', 'like', 'downloaded', 3)).toBe(cleared)
  })

  it('markState returns the same reference when the state is unchanged', () => {
    const wl = markState(enqueue(emptyWorklist, '1', 'like', 1), '1', 'like', 'downloaded', 2)
    expect(markState(wl, '1', 'like', 'downloaded', 9)).toBe(wl)
  })

  it('summarize counts each state', () => {
    let wl: SweepWorklist = emptyWorklist
    wl = enqueue(wl, '1', 'like', 1)
    wl = enqueue(wl, '2', 'like', 1)
    wl = markState(wl, '2', 'like', 'downloaded', 2)
    wl = enqueue(wl, '3', 'like', 1)
    wl = markState(wl, '3', 'like', 'cleared', 2)
    wl = enqueue(wl, '4', 'like', 1)
    wl = markState(wl, '4', 'like', 'failed', 2)
    expect(summarize(wl)).toEqual({ queued: 1, downloaded: 1, cleared: 1, failed: 1 })
  })

  it('capWorklist evicts oldest TERMINAL entries first, never in-flight ones', () => {
    let wl: SweepWorklist = emptyWorklist
    wl = enqueue(wl, 'q1', 'like', 100) // queued (in-flight)
    wl = markState(enqueue(wl, 'd1', 'like', 101), 'd1', 'like', 'downloaded', 102) // downloaded (in-flight)
    for (let i = 0; i < 4; i++)
      wl = markState(enqueue(wl, `c${i}`, 'like', i), `c${i}`, 'like', 'cleared', i)
    // max=4: keep both in-flight (q1,d1) + the 2 most-recent terminal (c3,c2).
    const capped = capWorklist(wl, 4)
    expect(
      Object.values(capped)
        .map((e) => e.tweetId)
        .toSorted(),
    ).toEqual(['c2', 'c3', 'd1', 'q1'])
  })

  it('capWorklist never evicts in-flight entries even past max', () => {
    let wl: SweepWorklist = emptyWorklist
    for (let i = 0; i < 5; i++) wl = enqueue(wl, String(i), 'like', i) // all queued
    expect(Object.keys(capWorklist(wl, 3))).toHaveLength(5)
  })

  it('capWorklist returns the same reference within bounds', () => {
    const wl = enqueue(emptyWorklist, '1', 'like', 1)
    expect(capWorklist(wl, 3)).toBe(wl)
  })

  it('capWorklist preserves the scoped key and never collides two scopes of one tweet', () => {
    // Same tweet tracked in BOTH scopes, plus filler to force a cap: capping must
    // keep BOTH scope entries under DISTINCT keys, not overwrite one under a bare id.
    let wl: SweepWorklist = emptyWorklist
    wl = markState(enqueue(wl, '1', 'bookmark', 1), '1', 'bookmark', 'cleared', 2)
    wl = markState(enqueue(wl, '1', 'like', 1), '1', 'like', 'cleared', 2)
    for (let i = 0; i < 3; i++)
      wl = markState(enqueue(wl, `f${i}`, 'like', i), `f${i}`, 'like', 'cleared', i)
    const capped = capWorklist(wl, 4) // 5 terminal → drop the oldest, keep both tweet-1 scopes
    expect(capped[keyFor('bookmark', '1')]?.scope).toBe('bookmark')
    expect(capped[keyFor('like', '1')]?.scope).toBe('like')
    expect(isCleared(capped, '1', 'bookmark')).toBe(true)
    expect(isCleared(capped, '1', 'like')).toBe(true)
  })

  it('decodeWorklist round-trips valid data and resets corruption to empty', () => {
    const wl = markState(
      enqueue(emptyWorklist, '1', 'bookmark', 1),
      '1',
      'bookmark',
      'downloaded',
      2,
    )
    expect(decodeWorklist(JSON.parse(JSON.stringify(wl)))).toEqual(wl)
    expect(decodeWorklist(null)).toEqual(emptyWorklist)
    expect(decodeWorklist({ '1': { tweetId: '1', state: 'bogus' } })).toEqual(emptyWorklist)
  })

  it('decodeWorklist migrates pre-scope bare-tweetId keys to the scoped key', () => {
    // Old persisted data keyed by bare tweetId is re-keyed by (scope, tweetId), so
    // a previously-cleared post still skips correctly after the key change.
    const migrated = decodeWorklist({
      '1': { tweetId: '1', scope: 'like', state: 'cleared', at: 5 },
    })
    expect(Object.keys(migrated)).toEqual([keyFor('like', '1')])
    expect(isCleared(migrated, '1', 'like')).toBe(true)
    expect(isCleared(migrated, '1', 'bookmark')).toBe(false)
  })
})
