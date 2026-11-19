import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Schema } from 'effect'
import { Settings, type MediaItem } from '@/packages/schema'
import type { DurableStore } from '@/packages/kernel/durable-store'
import { decideQueueStart } from '@/packages/download/queue-start'
import { localDay } from '@/packages/download/daily-budget'
import { applyQueueStartEffects } from './queue-start-applier'
import { makeRemoteUpload } from './remote-upload'
import type { CloudHistoryNotice } from './cloud-upload'

const settings = Schema.decodeUnknownSync(Settings)({
  cloudUploadEnabled: true,
  convexDriveEnabled: true,
  convexDriveConnected: true,
  saveToDisk: false,
  convexUrl: 'https://test.convex.cloud',
  convexSyncSecret: 'test-secret',
  cloudDeviceId: 'device',
})
const media = {
  id: 'm1',
  platform: 'x',
  postId: 'post',
  author: 'alice',
  type: 'photo',
  ext: 'jpg',
  index: 0,
  url: 'https://pbs.twimg.com/media/test.jpg',
} satisfies MediaItem
const item = {
  item: { ...media, handle: 'alice' },
  filename: 'twitter/test.jpg',
  estimatedBytes: 4,
}

function memoryStore(): DurableStore {
  let value: unknown = null
  return {
    get: async () => value,
    set: async (next) => {
      value = next
    },
  }
}

const StatusCall = Schema.Struct({
  args: Schema.Struct({ mediaIds: Schema.Array(Schema.String) }),
})

function makeBatchReconcileFixture(
  onStatus: (mediaIds: ReadonlyArray<string>) => JsonValue,
  store: DurableStore = memoryStore(),
) {
  const candidates = Array.from({ length: 150 }, (_, index) => ({
    item: {
      ...item.item,
      id: `m${index}`,
      url: `https://pbs.twimg.com/media/m${index}.jpg`,
    },
    filename: `twitter/m${index}.jpg`,
    estimatedBytes: 4,
  }))
  const remote = makeRemoteUpload({
    getSettings: async () => settings,
    store,
    onHistoryNotice: () => {},
    fetchImpl: async (_url, init) => {
      const body = String(init?.body)
      if (body.includes('relay:status')) {
        const parsed = Schema.decodeUnknownSync(StatusCall)(JSON.parse(body))
        return Response.json({ status: 'success', value: onStatus(parsed.args.mediaIds) })
      }
      return Response.json({
        status: 'success',
        value: candidates.map((candidate) => ({
          mediaId: candidate.item.id,
          id: `job-${candidate.item.id}`,
          created: true,
        })),
      })
    },
  })
  return { candidates, remote }
}

beforeEach(() => vi.restoreAllMocks())

describe('metadata-only queue acceptance', () => {
  it('submits only metadata and reads usage charged by durable server acceptance', async () => {
    const calls: { url: string; body: string }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) })
      const value = String(init?.body).includes('relay:budget')
        ? { bytes: 4, count: 1 }
        : { id: 'server-job', created: true }
      return Response.json({ status: 'success', value })
    }
    const remote = makeRemoteUpload({
      getSettings: async () => settings,
      fetchImpl,
      store: memoryStore(),
      onHistoryNotice: () => {},
    })
    const effects = decideQueueStart({
      metrics: null,
      requests: [{ id: media.id, url: media.url, filename: item.filename }],
      mediaById: new Map([[media.id, media]]),
      settings,
      startedAt: 1,
    })
    let accepted: ReadonlyArray<string> = []
    await applyQueueStartEffects(effects, 1, {
      resetCorrelation: () => {},
      setMetrics: () => {},
      persistSnapshot: async () => {},
      recordSync: () => {},
      recordHistory: () => {},
      seedClear: async () => {},
      recordUploads: async () => {
        accepted = await remote.record(settings, [item])
      },
    })
    expect(accepted).toEqual(['m1'])
    expect(await remote.budget('2026-09-20')).toEqual({ bytes: 4, count: 1 })
    expect(await remote.record(settings, [item])).toEqual([])
    expect(effects.diskRequests).toEqual([])
    expect(effects.clearSeed).toMatchObject({ decision: 'skip', reason: 'cloud-only' })
    expect(calls.every((call) => call.url.startsWith(settings.convexUrl))).toBe(true)
    expect(calls.find((call) => call.body.includes('relay:submit'))?.body).not.toMatch(
      /accessToken|refreshToken|clientSecret|bytes|blob/,
    )
  })

  it.each([200, 560])(
    'charges neither rejection nor duplicate acceptance (HTTP %s)',
    async (status) => {
      const duplicate = makeRemoteUpload({
        getSettings: async () => settings,
        store: memoryStore(),
        onHistoryNotice: () => {},
        fetchImpl: async () =>
          Response.json({ status: 'success', value: { id: 'existing', created: false } }),
      })
      expect(await duplicate.record(settings, [item])).toEqual([])
      const rejected = makeRemoteUpload({
        getSettings: async () => settings,
        store: memoryStore(),
        onHistoryNotice: () => {},
        fetchImpl: async () =>
          Response.json({ status: 'error', errorMessage: 'rejected' }, { status }),
      })
      await expect(rejected.record(settings, [item])).rejects.toThrow('rejected')
      expect(await rejected.owns('m1')).toBe(false)
    },
  )

  it('keeps ambiguous acceptance fenced until the original deployment confirms it', async () => {
    const store = memoryStore()
    const remote = makeRemoteUpload({
      getSettings: async () => settings,
      store,
      onHistoryNotice: () => {},
      fetchImpl: async () => {
        throw new Error('lost acceptance response')
      },
    })
    await expect(remote.record(settings, [item])).rejects.toThrow(/lost acceptance response/)
    expect(await remote.owns('m1')).toBe(true)
  })

  it('does not release ambiguous ownership when a later retry is unauthorized', async () => {
    let lost = true
    const remote = makeRemoteUpload({
      getSettings: async () => settings,
      store: memoryStore(),
      onHistoryNotice: () => {},
      fetchImpl: async () => {
        if (lost) throw new Error('lost acceptance response')
        return Response.json({ status: 'error', errorMessage: 'unauthorized' }, { status: 560 })
      },
    })
    await expect(remote.record(settings, [item])).rejects.toThrow(/lost acceptance response/)
    lost = false
    await expect(remote.retry()).rejects.toThrow(/unauthorized/)
    expect(await remote.owns('m1')).toBe(true)
  })

  it('does not reserve ownership when size admission is missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const remote = makeRemoteUpload({
      getSettings: async () => settings,
      fetchImpl,
      store: memoryStore(),
      onHistoryNotice: () => {},
    })
    await expect(remote.record(settings, [{ ...item, estimatedBytes: 0 }])).rejects.toThrow(/size/)
    expect(await remote.owns('m1')).toBe(false)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('uses original deployment credentials for status and budget after settings change', async () => {
    let current = settings
    const calls: { url: string; body: string }[] = []
    const store = memoryStore()
    const deps = {
      getSettings: async () => current,
      store,
      onHistoryNotice: () => {},
      fetchImpl: (async (url, init) => {
        const body = String(init?.body)
        calls.push({ url: String(url), body })
        const value = body.includes('relay:status')
          ? [{ mediaId: 'm1', status: 'completed', at: 100 }]
          : body.includes('relay:budget')
            ? { bytes: 4, count: 1 }
            : { id: 'server-job', created: true }
        return Response.json({ status: 'success', value })
      }) satisfies typeof fetch,
    }
    await makeRemoteUpload(deps).record(settings, [item])
    current = {
      ...settings,
      convexUrl: 'https://other.convex.cloud',
      convexSyncSecret: 'other-secret',
      convexDriveConnected: false,
    }
    const restarted = makeRemoteUpload(deps)
    await restarted.reconcile()
    expect(await restarted.budget('2026-09-20')).toEqual({ bytes: 4, count: 1 })
    expect(calls.every((call) => call.url.startsWith(settings.convexUrl))).toBe(true)
    expect(calls.every((call) => call.body.includes('test-secret'))).toBe(true)
  })

  it('uses retained local acceptance accounting for ordinary downloads without contacting Convex', async () => {
    let current = settings
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ status: 'success', value: { id: 'server-job', created: true } }),
    )
    const remote = makeRemoteUpload({
      getSettings: async () => current,
      fetchImpl,
      store: memoryStore(),
      onHistoryNotice: () => {},
    })
    await remote.record(settings, [item])
    current = { ...settings, convexDriveEnabled: false, saveToDisk: true, convexUrl: '' }
    fetchImpl.mockClear()
    expect(await remote.budget(localDay(Date.now()))).toEqual({ bytes: 4, count: 1 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reconciles offline completion after restart with the experiment disabled, once', async () => {
    const store = memoryStore()
    const notices: CloudHistoryNotice[] = []
    let completed = false
    let current = settings
    const deps = {
      getSettings: async () => current,
      store,
      onHistoryNotice: (notice: CloudHistoryNotice) => {
        notices.push(notice)
      },
      fetchImpl: (async (_url, init) =>
        Response.json({
          status: 'success',
          value: String(init?.body).includes('relay:status')
            ? [{ mediaId: 'm1', status: completed ? 'completed' : 'failed', at: 100 }]
            : { id: 'server-job', created: true },
        })) satisfies typeof fetch,
    }
    await makeRemoteUpload(deps).record(settings, [item])
    await makeRemoteUpload(deps).reconcile()
    completed = true
    current = { ...settings, convexDriveEnabled: false, saveToDisk: true }
    const reopened = makeRemoteUpload(deps)
    await reopened.reconcile()
    await reopened.reconcile()
    expect(notices.map((notice) => notice.kind)).toEqual(['failed', 'completed'])
    expect(await reopened.owns('m1')).toBe(true)
  })

  it('submits multiple candidates in a single batch request to relay:submitBatch', async () => {
    const calls: { url: string; body: string }[] = []
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: String(init?.body) })
      return Response.json({
        status: 'success',
        value: [
          { mediaId: 'm1', id: 'job-1', created: true },
          { mediaId: 'm2', id: 'job-2', created: true },
        ],
      })
    }
    const remote = makeRemoteUpload({
      getSettings: async () => settings,
      fetchImpl,
      store: memoryStore(),
      onHistoryNotice: () => {},
    })
    const item2 = {
      ...item,
      item: { ...item.item, id: 'm2', url: 'https://pbs.twimg.com/media/m2.jpg' },
      filename: 'twitter/m2.jpg',
    }
    const accepted = await remote.record(settings, [item, item2])
    expect(accepted).toEqual(['m1', 'm2'])
    expect(calls.filter((c) => c.body.includes('relay:submitBatch'))).toHaveLength(1)
  })

  it('reconcile continues past a failing deployment', async () => {
    const store = memoryStore()
    const notices: CloudHistoryNotice[] = []
    const firstSettings = { ...settings, convexUrl: 'https://first.convex.cloud' }
    const secondSettings = { ...settings, convexUrl: 'https://second.convex.cloud' }
    const secondItem = {
      ...item,
      item: { ...item.item, id: 'm2', url: 'https://pbs.twimg.com/media/m2.jpg' },
      filename: 'twitter/m2.jpg',
    }
    const remote = makeRemoteUpload({
      getSettings: async () => secondSettings,
      store,
      onHistoryNotice: (notice) => {
        notices.push(notice)
      },
      fetchImpl: async (url, init) => {
        const body = String(init?.body)
        if (!body.includes('relay:status')) {
          return Response.json({ status: 'success', value: { id: 'server-job', created: true } })
        }
        if (String(url).startsWith(firstSettings.convexUrl)) {
          throw new Error('first deployment offline')
        }
        return Response.json({
          status: 'success',
          value: [{ mediaId: 'm2', status: 'completed', at: 200 }],
        })
      },
    })
    await remote.record(firstSettings, [item])
    await remote.record(secondSettings, [secondItem])
    await expect(remote.reconcile()).rejects.toThrow(/first deployment offline/)
    expect(notices).toEqual([{ mediaId: 'm2', kind: 'completed', at: 200 }])
    expect(await store.get()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mediaId: 'm2', historyOutcome: 'completed' }),
      ]),
    )
  })

  it('reconcile batches status queries', async () => {
    const batches: Array<ReadonlyArray<string>> = []
    const { candidates, remote } = makeBatchReconcileFixture((mediaIds) => {
      batches.push(mediaIds)
      return []
    })
    await remote.record(settings, candidates)
    await remote.reconcile()
    expect(batches).toHaveLength(2)
    expect(batches[0]).toHaveLength(100)
    expect(batches[1]).toHaveLength(50)
  })

  it('reconcile writes the store once per batch', async () => {
    const baseStore = memoryStore()
    let sets = 0
    const store: DurableStore = {
      get: () => baseStore.get(),
      set: async (next) => {
        sets += 1
        await baseStore.set(next)
      },
    }
    const { candidates, remote } = makeBatchReconcileFixture(
      (mediaIds) => mediaIds.map((mediaId) => ({ mediaId, status: 'completed', at: 300 })),
      store,
    )
    await remote.record(settings, candidates)
    sets = 0
    await remote.reconcile()
    expect(sets).toBe(2)
    expect((await remote.summary()).succeeded).toBe(150)
  })
})
