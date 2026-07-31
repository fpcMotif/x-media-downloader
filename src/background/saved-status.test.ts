import { describe, it, expect, vi } from 'vitest'
import { makeSavedStatusCoordinator } from './saved-status'
import { makeSavedIndex } from '@/packages/sync/saved-index'

describe('makeSavedStatusCoordinator', () => {
  it('answers instantly from the local index and still queries the backstop for unknowns', async () => {
    const index = makeSavedIndex()
    index.seed(['T1'])
    const queryConvex = vi.fn<(tweetIds: string[]) => Promise<string[]>>(async () => [] as string[])
    const coord = makeSavedStatusCoordinator({ index, queryConvex })

    const res = await coord.handle({ _tag: 'SavedStatusRequest', tweetIds: ['T1', 'T2'] })

    expect(res).toEqual({ _tag: 'SavedStatusResponse', saved: ['T1'] })
    expect(queryConvex).toHaveBeenCalledWith(['T2'])
  })

  it('the reply never waits on the Convex round-trip — a hanging backstop cannot delay it', async () => {
    const index = makeSavedIndex()
    index.seed(['T1'])
    // A backstop that NEVER resolves: with the old blocking design this hangs the reply.
    const queryConvex = vi.fn<(tweetIds: string[]) => Promise<string[]>>(
      () => new Promise<string[]>(() => {}),
    )
    const coord = makeSavedStatusCoordinator({ index, queryConvex })

    const res = await coord.handle({ _tag: 'SavedStatusRequest', tweetIds: ['T1', 'T2'] })

    expect(res.saved).toEqual(['T1'])
    expect(queryConvex).toHaveBeenCalledWith(['T2'])
  })

  it('pushes LATE cross-device hits through notifyFresh once the backstop answers', async () => {
    const index = makeSavedIndex()
    let release: ((hits: string[]) => void) | undefined
    const queryConvex = vi.fn<(tweetIds: string[]) => Promise<string[]>>(
      () =>
        new Promise<string[]>((r) => {
          release = r
        }),
    )
    const notifyFresh = vi.fn<(saved: ReadonlyArray<string>) => void>()
    const coord = makeSavedStatusCoordinator({ index, queryConvex, notifyFresh })

    const res = await coord.handle({ _tag: 'SavedStatusRequest', tweetIds: ['T1', 'T2'] })
    expect(res.saved).toEqual([]) // nothing known locally yet
    expect(notifyFresh).not.toHaveBeenCalled()

    release!(['T2'])
    await vi.waitFor(() => expect(notifyFresh).toHaveBeenCalledWith(['T2']))
    // And the hit is cached: the next sweep answers it in the instant reply.
    const again = await coord.handle({ _tag: 'SavedStatusRequest', tweetIds: ['T2'] })
    expect(again.saved).toEqual(['T2'])
  })

  it('does not push when the backstop returns nothing fresh', async () => {
    const index = makeSavedIndex()
    index.seed(['T1'])
    const queryConvex = vi.fn<(tweetIds: string[]) => Promise<string[]>>(async () => [] as string[])
    const notifyFresh = vi.fn<(saved: ReadonlyArray<string>) => void>()
    const coord = makeSavedStatusCoordinator({ index, queryConvex, notifyFresh })

    await coord.handle({ _tag: 'SavedStatusRequest', tweetIds: ['T1', 'T9'] })
    await Promise.resolve() // let the fire-and-forget refresh settle
    await Promise.resolve()

    expect(notifyFresh).not.toHaveBeenCalled()
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
