import { describe, it, expect, vi } from 'vitest'
import { makeSavedStatusCoordinator } from './saved-status'
import { makeSavedIndex } from '../core/sync/saved-index'

describe('makeSavedStatusCoordinator', () => {
  it('resolves via the SavedIndex — local seed answered without query, unknowns queried', async () => {
    const index = makeSavedIndex()
    index.seed(['T1'])
    const queryConvex = vi.fn<(tweetIds: string[]) => Promise<string[]>>(async () => [] as string[])
    const coord = makeSavedStatusCoordinator({ index, queryConvex })

    const res = await coord.handle({ _tag: 'SavedStatusRequest', tweetIds: ['T1', 'T2'] })

    expect(res).toEqual({ _tag: 'SavedStatusResponse', saved: ['T1'] })
    expect(queryConvex).toHaveBeenCalledWith(['T2'])
  })

  it('onCompleted marks the index — a later resolve returns it without querying', async () => {
    const index = makeSavedIndex()
    const queryConvex = vi.fn<(tweetIds: string[]) => Promise<string[]>>(async () => [] as string[])
    const coord = makeSavedStatusCoordinator({ index, queryConvex })

    coord.onCompleted('T7')
    const res = await coord.handle({ _tag: 'SavedStatusRequest', tweetIds: ['T7'] })

    expect(res.saved).toEqual(['T7'])
    expect(queryConvex).not.toHaveBeenCalled()
  })

  it('runs C-only when queryConvex is the sync-off no-op — answers from local seed only', async () => {
    const index = makeSavedIndex()
    index.seed(['T1'])
    const queryConvex = vi.fn<(tweetIds: string[]) => Promise<string[]>>(async () => [] as string[]) // sync unconfigured → no-op
    const coord = makeSavedStatusCoordinator({ index, queryConvex })

    const res = await coord.handle({ _tag: 'SavedStatusRequest', tweetIds: ['T1', 'T9'] })

    expect(res.saved).toEqual(['T1'])
  })
})
