import { describe, it, expect } from 'vitest'
import { makeDrainQueue, addPending, readyToClear } from './drain'

describe('clear drain queue', () => {
  it('queues a not-mounted clear and finds it once its post is mounted', () => {
    const q = makeDrainQueue()
    addPending(q, '101', ['bookmark', 'like'], true)
    // Not mounted yet → nothing ready.
    expect(readyToClear(q, ['200', '201'])).toEqual([])
    // Its post scrolls in → ready.
    expect(readyToClear(q, ['201', '101', '202'])).toEqual(['101'])
  })

  it('re-adding UNIONS scopes and ORs allLists (a later settle never shrinks the work)', () => {
    const q = makeDrainQueue()
    addPending(q, '101', ['bookmark'], false)
    addPending(q, '101', ['like'], true)
    expect(q.get('101')).toEqual({ scopes: ['bookmark', 'like'], allLists: true })
    // …and re-adding a subset doesn't drop the wider scope set.
    addPending(q, '101', ['like'], false)
    expect(q.get('101')?.scopes).toEqual(['bookmark', 'like'])
    expect(q.get('101')?.allLists).toBe(true)
  })

  it('readyToClear returns only mounted queued ids, in mounted order', () => {
    const q = makeDrainQueue()
    addPending(q, 'a', ['like'], false)
    addPending(q, 'b', ['like'], false)
    addPending(q, 'c', ['like'], false)
    expect(readyToClear(q, ['c', 'x', 'a'])).toEqual(['c', 'a'])
    expect(readyToClear(q, [])).toEqual([])
  })
})
