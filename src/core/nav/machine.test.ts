import { describe, it, expect } from 'vitest'
import {
  focusedPost,
  firstPost,
  idleNav,
  lastPost,
  moveColumn,
  movePost,
  reconcile,
  type NavSnapshot,
  type NavState,
} from './machine'

/** Snapshot builder: each argument is one column of post ids. */
const snapOf = (...columns: string[][]): NavSnapshot => ({
  columns: columns.map((posts) => ({ posts: posts.map((id) => ({ id })) })),
})

const focusOn = (snap: NavSnapshot, column: number, index: number): NavState => ({
  focus: { column, index, postId: snap.columns[column]!.posts[index]!.id },
})

describe('reconcile', () => {
  it('clears focus when the snapshot has no posts', () => {
    const state = focusOn(snapOf(['a']), 0, 0)
    expect(reconcile(state, snapOf([]))).toEqual({ focus: null })
  })

  it('leaves null focus null and returns the same state', () => {
    const snap = snapOf(['a', 'b'])
    expect(reconcile(idleNav, snap)).toBe(idleNav)
  })

  it('returns the same state when the focused post has not moved', () => {
    const snap = snapOf(['a', 'b'])
    const state = focusOn(snap, 0, 1)
    expect(reconcile(state, snap)).toBe(state)
  })

  it('updates coordinates when the focused post moved within its column', () => {
    const snap = snapOf(['x', 'a', 'b'])
    const state = { focus: { column: 0, index: 0, postId: 'b' } }
    expect(reconcile(state, snap)).toEqual({ focus: { column: 0, index: 2, postId: 'b' } })
  })

  it('follows the focused post when a layout change moves it to another column', () => {
    const snap = snapOf(['a'], ['b', 'c'])
    const state = { focus: { column: 0, index: 0, postId: 'c' } }
    expect(reconcile(state, snap)).toEqual({ focus: { column: 1, index: 1, postId: 'c' } })
  })

  it('moves to the nearest survivor in the same column when the post vanished', () => {
    const snap = snapOf(['a', 'b', 'c'])
    const state = { focus: { column: 0, index: 1, postId: 'gone' } }
    expect(reconcile(state, snap)).toEqual({ focus: { column: 0, index: 1, postId: 'b' } })
  })

  it('clamps the survivor index when the column shrank below the focus index', () => {
    const snap = snapOf(['a'])
    const state = { focus: { column: 0, index: 5, postId: 'gone' } }
    expect(reconcile(state, snap)).toEqual({ focus: { column: 0, index: 0, postId: 'a' } })
  })

  it('falls to the nearest non-empty column when the focused column emptied', () => {
    const snap = snapOf([], ['x'], ['y'])
    const state = { focus: { column: 0, index: 0, postId: 'gone' } }
    expect(reconcile(state, snap)).toEqual({ focus: { column: 1, index: 0, postId: 'x' } })
  })

  it('scans backward for a non-empty column when none follows', () => {
    const snap = snapOf(['a'], [], [])
    const state = { focus: { column: 2, index: 0, postId: 'gone' } }
    expect(reconcile(state, snap)).toEqual({ focus: { column: 0, index: 0, postId: 'a' } })
  })

  it('finds the focused post even when its last-known column is out of bounds', () => {
    const snap = snapOf(['a', 'b'])
    const state = { focus: { column: 5, index: 0, postId: 'b' } }
    expect(reconcile(state, snap)).toEqual({ focus: { column: 0, index: 1, postId: 'b' } })
  })

  it('clears focus when every column is empty', () => {
    const state = { focus: { column: 0, index: 0, postId: 'gone' } }
    expect(reconcile(state, snapOf([], []))).toEqual({ focus: null })
  })
})

describe('movePost', () => {
  it('focuses the first post of the first non-empty column from null focus', () => {
    const snap = snapOf([], ['a', 'b'], ['c'])
    expect(movePost(idleNav, snap, 1)).toEqual({ focus: { column: 1, index: 0, postId: 'a' } })
  })

  it('focuses the last post of the last non-empty column from null focus on -1', () => {
    const snap = snapOf(['a'], ['b', 'c'], [])
    expect(movePost(idleNav, snap, -1)).toEqual({ focus: { column: 1, index: 1, postId: 'c' } })
  })

  it('is a no-op on an empty snapshot', () => {
    expect(movePost(idleNav, snapOf([]), 1)).toBe(idleNav)
    expect(movePost(idleNav, snapOf([], []), -1)).toBe(idleNav)
  })

  it('moves within the column and clamps at both ends without wrapping', () => {
    const snap = snapOf(['a', 'b', 'c'], ['x'])
    const mid = focusOn(snap, 0, 1)
    expect(movePost(mid, snap, 1)).toEqual({ focus: { column: 0, index: 2, postId: 'c' } })
    expect(movePost(mid, snap, -1)).toEqual({ focus: { column: 0, index: 0, postId: 'a' } })
    const top = focusOn(snap, 0, 0)
    expect(movePost(top, snap, -1)).toBe(top)
    const bottom = focusOn(snap, 0, 2)
    expect(movePost(bottom, snap, 1)).toBe(bottom)
  })

  it('never hops columns at a column boundary', () => {
    const snap = snapOf(['a'], ['x'])
    const bottom = focusOn(snap, 0, 0)
    expect(movePost(bottom, snap, 1)).toBe(bottom)
  })

  it('reconciles stale coordinates before moving', () => {
    const snap = snapOf(['x', 'a', 'b'])
    const stale = { focus: { column: 0, index: 0, postId: 'a' } }
    expect(movePost(stale, snap, 1)).toEqual({ focus: { column: 0, index: 2, postId: 'b' } })
  })
})

describe('moveColumn', () => {
  it('behaves like movePost from null focus', () => {
    const snap = snapOf(['a'], ['b'])
    expect(moveColumn(idleNav, snap, 1)).toEqual({ focus: { column: 0, index: 0, postId: 'a' } })
    expect(moveColumn(idleNav, snap, -1)).toEqual({ focus: { column: 1, index: 0, postId: 'b' } })
  })

  it('is a no-op from null focus on an empty snapshot', () => {
    expect(moveColumn(idleNav, snapOf([]), 1)).toBe(idleNav)
  })

  it('moves to the nearest non-empty column, preserving index when possible', () => {
    const snap = snapOf(['a', 'b', 'c'], [], ['x', 'y', 'z'])
    const state = focusOn(snap, 0, 2)
    expect(moveColumn(state, snap, 1)).toEqual({ focus: { column: 2, index: 2, postId: 'z' } })
  })

  it('clamps the anchor index into the target column', () => {
    const snap = snapOf(['a', 'b', 'c'], ['x'])
    const state = focusOn(snap, 0, 2)
    expect(moveColumn(state, snap, 1, 5)).toEqual({ focus: { column: 1, index: 0, postId: 'x' } })
  })

  it('is a no-op when no non-empty column exists in that direction', () => {
    const snap = snapOf(['a'], [], [])
    const state = focusOn(snap, 0, 0)
    expect(moveColumn(state, snap, 1)).toBe(state)
  })
})

describe('firstPost / lastPost', () => {
  it('jumps to the first/last post of the first/last non-empty column', () => {
    const snap = snapOf([], ['a', 'b'], ['c'])
    expect(firstPost(idleNav, snap)).toEqual({ focus: { column: 1, index: 0, postId: 'a' } })
    expect(lastPost(idleNav, snap)).toEqual({ focus: { column: 2, index: 0, postId: 'c' } })
  })

  it('returns the same state when already there, and is inert when empty', () => {
    const snap = snapOf(['a'])
    const state = focusOn(snap, 0, 0)
    expect(firstPost(state, snap)).toBe(state)
    expect(firstPost(idleNav, snapOf([]))).toBe(idleNav)
    expect(lastPost(idleNav, snapOf([]))).toBe(idleNav)
  })

  it('returns the same state when already at the last post', () => {
    const snap = snapOf(['a'], ['b'])
    const state = focusOn(snap, 1, 0)
    expect(lastPost(state, snap)).toBe(state)
  })
})

describe('focusedPost', () => {
  it('returns the post at the focus coordinates', () => {
    const snap = snapOf(['a', 'b'])
    expect(focusedPost(focusOn(snap, 0, 1), snap)).toEqual({ id: 'b' })
  })

  it('is null with null focus or stale coordinates', () => {
    const snap = snapOf(['a'])
    expect(focusedPost(idleNav, snap)).toBeNull()
    expect(focusedPost({ focus: { column: 0, index: 0, postId: 'gone' } }, snap)).toBeNull()
  })
})
