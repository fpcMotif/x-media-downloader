import { describe, it, expect } from 'vitest'
import {
  MAX_SWEEP_WORKLIST_BYTES,
  MAX_SWEEP_WORKLIST_ENTRIES,
  capWorklist,
  decodeStoredWorklist,
  emptyWorklist,
  encodeWorklist,
  enqueue,
  isCleared,
  keyFor,
  markState,
  summarize,
  type SweepWorklist,
} from './worklist'

const tiedTerminalEntries = (tweetIds: readonly string[]) =>
  Object.fromEntries(
    tweetIds.map((tweetId) => [
      keyFor('like', tweetId),
      { tweetId, scope: 'like', state: 'cleared', at: 5 } as const,
    ]),
  )

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
    wl = enqueue(wl, '100', 'like', 100) // queued (in-flight)
    wl = markState(enqueue(wl, '101', 'like', 101), '101', 'like', 'downloaded', 102) // downloaded (in-flight)
    for (let i = 0; i < 4; i++)
      wl = markState(enqueue(wl, String(i + 200), 'like', i), String(i + 200), 'like', 'cleared', i)
    // max=4: keep both in-flight + the 2 most-recent terminal rows.
    const capped = capWorklist(wl, 4)
    expect(
      Object.values(capped)
        .map((e) => e.tweetId)
        .toSorted(),
    ).toEqual(['100', '101', '202', '203'])
  })

  it('capWorklist rejects active overflow instead of evicting it', () => {
    let wl: SweepWorklist = emptyWorklist
    for (let i = 0; i < 5; i++) wl = enqueue(wl, String(i), 'like', i) // all queued
    expect(() => capWorklist(wl, 3)).toThrow(/active/i)
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
      wl = markState(enqueue(wl, String(i + 10), 'like', i), String(i + 10), 'like', 'cleared', i)
    const capped = capWorklist(wl, 4) // 5 terminal → drop the oldest, keep both tweet-1 scopes
    expect(capped[keyFor('bookmark', '1')]?.scope).toBe('bookmark')
    expect(capped[keyFor('like', '1')]?.scope).toBe('like')
    expect(isCleared(capped, '1', 'bookmark')).toBe(true)
    expect(isCleared(capped, '1', 'like')).toBe(true)
  })

  it('rejects invalid identities, states, and times before constructing entries', () => {
    expect(() => enqueue(emptyWorklist, 'bad-id', 'like', 1)).toThrow(/snowflake/i)
    expect(() => enqueue(emptyWorklist, '1', 'like', -1)).toThrow(/time/i)
    const worklist = enqueue(emptyWorklist, '1', 'like', 1)
    expect(() => markState(worklist, 'bad-id', 'like', 'failed', 2)).toThrow(/snowflake/i)
    expect(() => markState(worklist, '1', 'like', 'failed', 1.5)).toThrow(/time/i)
    expect(() => markState(worklist, '1', 'like', 'bogus' as never, 2)).toThrow(/state/i)
  })

  it('decodes only the exact v2 envelope and treats nullish storage as absent', () => {
    const entry = { tweetId: '123', scope: 'like', state: 'queued', at: 5 } as const
    const worklist = { 'like:123': entry }

    expect(decodeStoredWorklist(null)).toEqual({ kind: 'absent', worklist: emptyWorklist })
    expect(decodeStoredWorklist(undefined)).toEqual({ kind: 'absent', worklist: emptyWorklist })
    expect(decodeStoredWorklist(encodeWorklist(worklist))).toEqual({
      kind: 'current',
      worklist,
    })
    expect(decodeStoredWorklist({ version: 2, entries: worklist, extra: true })).toEqual({
      kind: 'corrupt',
    })
    expect(
      decodeStoredWorklist({
        version: 2,
        entries: { 'like:123': { ...entry, at: 1.5 } },
      }),
    ).toEqual({ kind: 'corrupt' })
    expect(
      decodeStoredWorklist({
        version: 2,
        entries: { 'like:123': { ...entry, projectionRevision: 0 } },
      }),
    ).toEqual({ kind: 'corrupt' })
  })

  it('migrates only safe legacy keys and rejects conflicting logical duplicates', () => {
    const entry = { tweetId: '123', scope: 'like', state: 'cleared', at: 5 } as const
    expect(decodeStoredWorklist({ '123': entry })).toEqual({
      kind: 'legacy',
      worklist: { 'like:123': entry },
    })
    expect(decodeStoredWorklist({ '123': entry, 'like:123': { ...entry } })).toEqual({
      kind: 'legacy',
      worklist: { 'like:123': entry },
    })
    expect(
      decodeStoredWorklist({
        '123': entry,
        'like:123': { ...entry, state: 'failed' },
      }),
    ).toEqual({ kind: 'corrupt' })
    expect(decodeStoredWorklist({ arbitrary: entry })).toEqual({ kind: 'corrupt' })
    expect(
      decodeStoredWorklist({
        '123': { ...entry, projectionRevision: 1 },
      }),
    ).toEqual({ kind: 'corrupt' })
  })

  it('rejects unsafe entry shapes and persisted bounds', () => {
    const entry = { tweetId: '123', scope: 'like', state: 'queued', at: 5 } as const
    expect(decodeStoredWorklist({ '123': { ...entry, tweetId: 'not-a-snowflake' } })).toEqual({
      kind: 'corrupt',
    })
    expect(decodeStoredWorklist({ '123': { ...entry, extra: true } })).toEqual({
      kind: 'corrupt',
    })
    let reads = 0
    const accessorEntry = { ...entry }
    Object.defineProperty(accessorEntry, 'projectionRevision', {
      enumerable: true,
      get: () => {
        reads += 1
        throw new Error('must not run')
      },
    })
    expect(decodeStoredWorklist({ '123': accessorEntry })).toEqual({ kind: 'corrupt' })
    expect(reads).toBe(0)

    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_SWEEP_WORKLIST_ENTRIES + 1 }, (_, index) => [
        String(index),
        { ...entry, tweetId: String(index) },
      ]),
    )
    expect(decodeStoredWorklist(tooMany)).toEqual({ kind: 'corrupt' })
    expect(
      decodeStoredWorklist({
        ['x'.repeat(MAX_SWEEP_WORKLIST_BYTES + 1)]: entry,
      }),
    ).toEqual({ kind: 'corrupt' })
  })

  it('uses the canonical key as a deterministic terminal tie-break', () => {
    expect(Object.keys(capWorklist(tiedTerminalEntries(['3', '1', '2']), 2))).toEqual([
      'like:1',
      'like:2',
    ])
    expect(Object.keys(capWorklist(tiedTerminalEntries(['2', '1', '3']), 2))).toEqual([
      'like:1',
      'like:2',
    ])
  })
})
