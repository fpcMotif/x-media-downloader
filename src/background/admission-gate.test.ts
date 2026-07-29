import { describe, it, expect, vi } from 'vitest'
import { Schema } from 'effect'
import { makeAdmissionGate, PROBE_CONCURRENCY } from './admission-gate'
import { Settings, type MediaItem } from '../core/schema'
import type { SavedIndex } from '../core/sync/saved-index'
import type { SizeProbePort } from '../core/download/size-probe'
import { DailyBudgetCapacityError } from './daily-budget-store'

const baseSettings = (over: Partial<typeof Settings.Type>): typeof Settings.Type => ({
  ...Schema.decodeUnknownSync(Settings)({}),
  ...over,
})

const item = (over: Partial<MediaItem> & Pick<MediaItem, 'id' | 'postId'>): MediaItem => ({
  platform: 'x',
  author: 'h',
  type: 'photo',
  url: `https://cdn/${over.id}`,
  ext: 'jpg',
  index: 0,
  ...over,
})

const savedIndexReturning = (subset: string[]): SavedIndex => ({
  seed: () => {},
  replace: () => {},
  markSaved: () => {},
  known: () => subset,
  refresh: async () => [],
  resolve: async () => subset,
})

const queryConvexMedia = async () => []

describe('makeAdmissionGate', () => {
  it('runs cheap filters before any probe — type-filtered item never reaches the probe', async () => {
    const sizeProbe = { probe: vi.fn<SizeProbePort['probe']>(async () => 10) }
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ skipTypes: ['video'], maxFileSizeMB: 1 }),
      savedMediaIndex: savedIndexReturning([]),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 0 }),
    })

    const it1 = item({ id: 'a', postId: 'T1', type: 'video' })
    const res = await gate.admit([it1])

    expect(res.admitted).toEqual([])
    expect(res.skipped).toEqual([{ item: it1, reason: 'filtered-type' }])
    expect(sizeProbe.probe).not.toHaveBeenCalled()
  })

  it('does not probe when neither size cap nor byte budget is active (count budget on)', async () => {
    const sizeProbe = { probe: vi.fn<SizeProbePort['probe']>(async () => 10) }
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ maxFileSizeMB: 0, dailyMaxMB: 0, dailyMaxCount: 5 }),
      savedMediaIndex: savedIndexReturning([]),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 0 }),
    })

    const it1 = item({ id: 'a', postId: 'T1' })
    const it2 = item({ id: 'b', postId: 'T2' })
    const res = await gate.admit([it1, it2])

    expect(res.admitted).toEqual([it1, it2])
    expect(sizeProbe.probe).not.toHaveBeenCalled()
  })

  it('does not read budget state when both daily limits are disabled', async () => {
    const readTodayBudget = vi.fn<() => Promise<{ bytes: number; count: number }>>(async () => {
      throw new Error('corrupt budget')
    })
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ dailyMaxMB: 0, dailyMaxCount: 0 }),
      savedMediaIndex: savedIndexReturning([]),
      queryConvexMedia,
      sizeProbe: { probe: async () => null },
      readTodayBudget,
    })
    const candidate = item({ id: 'a', postId: 'T1' })

    await expect(gate.admit([candidate])).resolves.toEqual({ admitted: [candidate], skipped: [] })
    expect(readTodayBudget).not.toHaveBeenCalled()
  })

  it('fails closed on unavailable budget state when either daily limit is enabled', async () => {
    const readTodayBudget = vi.fn<() => Promise<{ bytes: number; count: number }>>(async () => {
      throw new Error('corrupt budget')
    })
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ dailyMaxCount: 1 }),
      savedMediaIndex: savedIndexReturning([]),
      queryConvexMedia,
      sizeProbe: { probe: async () => null },
      readTodayBudget,
    })

    await expect(gate.admit([item({ id: 'a', postId: 'T1' })])).rejects.toThrow('corrupt budget')
    expect(readTodayBudget).toHaveBeenCalledTimes(1)
  })

  it('fails closed before launch when the receipt ledger is full', async () => {
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ dailyMaxCount: Number.MAX_SAFE_INTEGER }),
      savedMediaIndex: savedIndexReturning([]),
      queryConvexMedia,
      sizeProbe: { probe: async () => null },
      readTodayBudget: async () => {
        throw new DailyBudgetCapacityError()
      },
    })

    await expect(gate.admit([item({ id: 'a', postId: 'T1' })])).rejects.toThrow(
      DailyBudgetCapacityError,
    )
  })

  it('drops a duplicate item via the saved-media set', async () => {
    const sizeProbe = { probe: vi.fn<SizeProbePort['probe']>(async () => 10) }
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ preventDuplicateDownloads: true }),
      savedMediaIndex: savedIndexReturning(['a']),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 0 }),
    })

    const a = item({ id: 'a', postId: 'T1', index: 0 })
    const b = item({ id: 'b', postId: 'T1', index: 1 })
    const c = item({ id: 'c', postId: 'T2' })
    const res = await gate.admit([a, b, c])

    expect(res.admitted).toEqual([b, c])
    expect(res.skipped).toEqual([{ item: a, reason: 'duplicate' }])
  })

  it('grabbing one item from a post does not block a different item from the same post', async () => {
    const sizeProbe = { probe: vi.fn<SizeProbePort['probe']>(async () => 10) }
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ preventDuplicateDownloads: true }),
      savedMediaIndex: savedIndexReturning(['a']),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 0 }),
    })

    const a = item({ id: 'a', postId: 'shared-post', index: 0 })
    const b = item({ id: 'b', postId: 'shared-post', index: 1 })
    const res = await gate.admit([a, b])

    expect(res.admitted).toEqual([b])
    expect(res.skipped).toEqual([{ item: a, reason: 'duplicate' }])
  })

  it('a genuine re-request of the exact same item id is still blocked', async () => {
    const sizeProbe = { probe: vi.fn<SizeProbePort['probe']>(async () => 10) }
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ preventDuplicateDownloads: true }),
      savedMediaIndex: savedIndexReturning(['a']),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 0 }),
    })

    const again = item({ id: 'a', postId: 'shared-post', index: 0 })
    const res = await gate.admit([again])

    expect(res.admitted).toEqual([])
    expect(res.skipped).toEqual([{ item: again, reason: 'duplicate' }])
  })

  it('queries duplicate state by global identity across platforms', async () => {
    const resolve = vi.fn<SavedIndex['resolve']>(async (ids) =>
      ids.filter((id) => id === 'xmd:v1:media:instagram:6:shared'),
    )
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ preventDuplicateDownloads: true }),
      savedMediaIndex: {
        seed: () => {},
        replace: () => {},
        markSaved: () => {},
        known: () => [],
        refresh: async () => [],
        resolve,
      },
      queryConvexMedia,
      sizeProbe: { probe: async () => null },
      readTodayBudget: async () => ({ bytes: 0, count: 0 }),
    })
    const x = item({ id: 'shared', postId: '1' })
    const instagram = item({ id: 'shared', postId: '2', platform: 'instagram' })

    const result = await gate.admit([x, instagram])

    expect(resolve.mock.calls[0]?.[0]).toEqual(['shared', 'xmd:v1:media:instagram:6:shared'])
    expect(result.admitted).toEqual([x])
    expect(result.skipped).toEqual([{ item: instagram, reason: 'duplicate' }])
  })

  it('size cap skips an over-cap file and fails open on an unknown size', async () => {
    const sizeProbe = {
      probe: vi.fn<SizeProbePort['probe']>(async (url: string) =>
        url.endsWith('big') ? 5 * 1024 * 1024 : null,
      ),
    }
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ maxFileSizeMB: 1 }),
      savedMediaIndex: savedIndexReturning([]),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 0 }),
    })

    const over = item({ id: 'big', postId: 'T1' })
    const unknown = item({ id: 'unk', postId: 'T2' })
    const res = await gate.admit([over, unknown])

    expect(res.admitted).toEqual([unknown])
    expect(res.skipped).toEqual([{ item: over, reason: 'too-big' }])
  })

  it('locks the daily budget once the projection would exceed dailyMaxCount', async () => {
    const sizeProbe = { probe: vi.fn<SizeProbePort['probe']>(async () => 0) }
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ dailyMaxCount: 3 }),
      savedMediaIndex: savedIndexReturning([]),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 2 }),
    })

    const a = item({ id: 'a', postId: 'T1' })
    const b = item({ id: 'b', postId: 'T2' })
    const c = item({ id: 'c', postId: 'T3' })
    const res = await gate.admit([a, b, c])

    expect(res.admitted).toEqual([a])
    expect(res.skipped).toEqual([
      { item: b, reason: 'daily-budget' },
      { item: c, reason: 'daily-budget' },
    ])
  })

  it('degrades gracefully when the backstop is unavailable — resolve returns only the local subset, never throws', async () => {
    const sizeProbe = { probe: vi.fn<SizeProbePort['probe']>(async () => 10) }
    // Convex unreachable: resolve yields only the locally-known saved subset.
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ preventDuplicateDownloads: true }),
      savedMediaIndex: savedIndexReturning(['a']),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 0 }),
    })

    const local = item({ id: 'a', postId: 'T_local' })
    const other = item({ id: 'b', postId: 'T_other' })
    const res = await gate.admit([local, other])

    expect(res.admitted).toEqual([other])
    expect(res.skipped).toEqual([{ item: local, reason: 'duplicate' }])
  })

  it('HEAD-probes run in parallel, not one serial await per item (~250ms RTT each)', async () => {
    let active = 0
    const resolvers: Array<() => void> = []
    const sizeProbe: SizeProbePort = {
      probe: () => {
        active += 1
        return new Promise((resolve) => {
          resolvers.push(() => {
            active -= 1
            resolve(10)
          })
        })
      },
    }
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ maxFileSizeMB: 1 }),
      savedMediaIndex: savedIndexReturning([]),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 0 }),
    })

    const items = ['a', 'b', 'c', 'd'].map((id, i) => item({ id, postId: `T${i}` }))
    const admitP = gate.admit(items)
    // Flush microtasks until the probes have had every chance to start. A serial
    // implementation holds at 1 in-flight probe here; the parallel one opens all 4.
    // oxlint-disable-next-line no-await-in-loop -- deliberate sequential microtask flushes
    for (let i = 0; i < 20 && resolvers.length < items.length; i++) await Promise.resolve()
    expect(resolvers.length).toBe(items.length)
    expect(active).toBe(items.length)
    for (const release of resolvers) release()
    const res = await admitP
    expect(res.admitted).toEqual(items)
  })

  it('probe parallelism is bounded — at most PROBE_CONCURRENCY in flight', async () => {
    const resolvers: Array<() => void> = []
    const sizeProbe: SizeProbePort = {
      probe: () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve(10))
        }),
    }
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ maxFileSizeMB: 1 }),
      savedMediaIndex: savedIndexReturning([]),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 0 }),
    })

    const items = Array.from({ length: PROBE_CONCURRENCY + 2 }, (_, i) =>
      item({ id: `i${i}`, postId: `T${i}` }),
    )
    const admitP = gate.admit(items)
    // oxlint-disable no-await-in-loop -- deliberate sequential microtask flushes
    for (let i = 0; i < 20 && resolvers.length < PROBE_CONCURRENCY; i++) await Promise.resolve()
    // The pool opens exactly the cap, never more, while none have resolved.
    expect(resolvers.length).toBe(PROBE_CONCURRENCY)
    resolvers.shift()!()
    for (let i = 0; i < 20 && resolvers.length < PROBE_CONCURRENCY; i++) await Promise.resolve()
    // Releasing one slot admits exactly the next probe.
    expect(resolvers.length).toBe(PROBE_CONCURRENCY)
    while (resolvers.length > 0) {
      resolvers.shift()!()
      for (let i = 0; i < 5; i++) await Promise.resolve()
    }
    // oxlint-enable no-await-in-loop
    const res = await admitP
    expect(res.admitted).toEqual(items)
  })

  it('result shape: admitted is MediaItem[] and skipped preserves input order', async () => {
    const sizeProbe = { probe: vi.fn<SizeProbePort['probe']>(async () => 0) }
    const gate = makeAdmissionGate({
      getSettings: async () => baseSettings({ skipTypes: ['gif'], dailyMaxCount: 2 }),
      savedMediaIndex: savedIndexReturning([]),
      queryConvexMedia,
      sizeProbe,
      readTodayBudget: async () => ({ bytes: 0, count: 1 }),
    })

    const ok = item({ id: 'a', postId: 'T1' })
    const filtered = item({ id: 'b', postId: 'T2', type: 'gif' })
    const overBudget = item({ id: 'c', postId: 'T3' })
    const res = await gate.admit([ok, filtered, overBudget])

    expect(res.admitted).toEqual([ok])
    expect(res.skipped).toEqual([
      { item: filtered, reason: 'filtered-type' },
      { item: overBudget, reason: 'daily-budget' },
    ])
  })
})
