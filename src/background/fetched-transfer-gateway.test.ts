/* oxlint-disable vitest/require-mock-type-parameters */
import { describe, expect, it, vi } from 'vitest'
import {
  FETCHED_STAGE_IDLE_TIMEOUT_MS,
  FETCHED_STAGE_MAX_TIMEOUT_MS,
  FETCHED_TERMINAL_CLEANUP_RETRY_MS,
  makeFetchedTransferGateway,
  type BrowserDownloadPort,
} from './fetched-transfer-gateway'
import {
  decodeFetchedBlobLeaseStore,
  emptyFetchedBlobLeaseStore,
  type FetchedBlobLeaseStorage,
} from './fetched-blob-lease-store'
import { type OffscreenBlobPort } from './offscreen-blob-port'
import type { ByteSource, FetchedTransferOwner } from '../core/download/fetched-transfer-contract'
import {
  MAX_TRANSFER_ATTEMPTS,
  MAX_TRANSFER_REGISTRY_FILENAME_LENGTH,
} from '../core/download/transfer-registry-model'
import { MAX_TRANSFER_REGISTRY_ID_LENGTH } from '../core/wire/limits'
import { MAX_DOWNLOAD_ITEMS_PER_REQUEST } from '../core/wire/limits'
import { OFFSCREEN_BLOB_MAX_LEASES } from '../core/offscreen-blob-protocol'

const owner: FetchedTransferOwner = {
  tag: 'transfer',
  requestId: 'media-1',
  projectionId: 'projection-1',
  attempt: 0,
  since: 1,
}
const ownerFor = (index: number): FetchedTransferOwner => ({
  tag: 'transfer',
  requestId: `media-${index}`,
  projectionId: `projection-${index}`,
  attempt: 0,
  since: 1,
})
const body = (): ByteSource => ({
  read: async () => ({ done: true }),
  cancel: async () => {},
})
const opened =
  (source: ByteSource = body(), mimeType = 'image/jpeg') =>
  async () => ({ mimeType, body: source })

function setup() {
  let value: unknown = emptyFetchedBlobLeaseStore()
  let nextLease = 1
  const storage: FetchedBlobLeaseStorage = {
    get: async () => value,
    set: async (next) => {
      value = next
    },
  }
  const discarded: string[] = []
  const closeDocument = vi.fn(async () => {})
  const append = vi.fn<OffscreenBlobPort['append']>(async () => {})
  const offscreen: OffscreenBlobPort = {
    ensureDocument: async () => {},
    isDocumentPresent: async () => true,
    begin: async () => {},
    append,
    finalize: async (id) => `blob:${id}`,
    discard: async (id) => {
      discarded.push(id)
    },
    closeDocument,
  }
  const downloads: BrowserDownloadPort = {
    download: vi.fn(async () => 42),
    search: vi.fn(async () => [{ state: 'in_progress' }]),
    searchByUrl: vi.fn(async () => [{ id: 42, state: 'in_progress' }]),
  }
  const scheduleAutonomousTerminalCleanup = vi.fn(async () => {})
  const gateway = makeFetchedTransferGateway({
    leases: storage,
    offscreen,
    downloads,
    leaseId: () => `lease-${nextLease++}`,
    now: () => 1,
    scheduleAutonomousTerminalCleanup,
  })
  const restart = () =>
    makeFetchedTransferGateway({
      leases: storage,
      offscreen,
      downloads,
      leaseId: () => `lease-${nextLease++}`,
      now: () => 1,
      scheduleAutonomousTerminalCleanup,
    })
  return {
    storage,
    downloads,
    discarded,
    closeDocument,
    append,
    offscreen,
    gateway,
    restart,
    scheduleAutonomousTerminalCleanup,
    store: () => value,
  }
}

describe('FetchedTransferGateway v2 recovery', () => {
  it('reserves durable capacity before any source can open', async () => {
    const h = setup()

    await expect(h.gateway.reserve(owner)).resolves.toEqual({
      kind: 'reserved',
      leaseId: 'lease-1',
    })

    expect(h.store()).toMatchObject({
      leases: {
        'lease-1': {
          owner,
          state: 'building',
          phase: 'reserved',
        },
      },
    })
    expect(h.downloads.download).not.toHaveBeenCalled()
  })

  it('claims one exact reservation before open and never starts it twice', async () => {
    const h = setup()
    const reserved = await h.gateway.reserve(owner)
    if (reserved.kind !== 'reserved') throw new Error('expected reservation')
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const open = vi.fn(async () => {
      await blocked
      return { mimeType: 'image/jpeg', body: body() }
    })

    const first = h.gateway.startReserved({
      leaseId: reserved.leaseId,
      owner,
      filename: 'a.jpg',
      open,
    })
    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce())
    await expect(
      h.gateway.startReserved({
        leaseId: reserved.leaseId,
        owner,
        filename: 'a.jpg',
        open,
      }),
    ).resolves.toEqual({ kind: 'unavailable' })
    release()
    await expect(first).resolves.toEqual({ kind: 'started', downloadId: 42 })
    expect(open).toHaveBeenCalledOnce()
    expect(h.downloads.download).toHaveBeenCalledOnce()
  })

  it('serializes global staging and recovers the next durable claim after a failed stage', async () => {
    const h = setup()
    const calls: string[] = []
    let activeStages = 0
    let maxStages = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = h.gateway.start({
      owner: ownerFor(1),
      filename: 'first.jpg',
      open: async () => {
        calls.push('first-open')
        activeStages += 1
        maxStages = Math.max(maxStages, activeStages)
        await firstGate
        activeStages -= 1
        calls.push('first-failed')
        throw new Error('stage failed')
      },
    })
    await vi.waitFor(() => expect(calls).toEqual(['first-open']))

    const second = h.gateway.start({
      owner: ownerFor(2),
      filename: 'second.jpg',
      open: async () => {
        calls.push('second-open')
        activeStages += 1
        maxStages = Math.max(maxStages, activeStages)
        activeStages -= 1
        return { mimeType: 'image/jpeg', body: body() }
      },
    })
    await vi.waitFor(() =>
      expect(h.store()).toMatchObject({
        leases: { 'lease-2': { state: 'building', phase: 'staging' } },
      }),
    )
    expect(calls).toEqual(['first-open'])
    await expect(h.gateway.reserve(ownerFor(3))).resolves.toEqual({
      kind: 'reserved',
      leaseId: 'lease-3',
    })

    releaseFirst()
    await expect(first).rejects.toThrow('stage failed')
    await expect(second).resolves.toEqual({ kind: 'started', downloadId: 42 })

    expect(maxStages).toBe(1)
    expect(calls).toEqual(['first-open', 'first-failed', 'second-open'])
  })

  it('does not close the shared offscreen document over a concurrent reservation', async () => {
    const h = setup()
    let releaseClose!: () => void
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    const closeDocument = vi.fn(async () => closeGate)
    let nextLease = 1
    const gateway = makeFetchedTransferGateway({
      leases: h.storage,
      offscreen: { ...h.offscreen, closeDocument },
      downloads: h.downloads,
      leaseId: () => `race-${nextLease++}`,
      now: () => 1,
      scheduleAutonomousTerminalCleanup: async () => {},
    })
    await expect(gateway.start({ owner, filename: 'a.jpg', open: opened() })).resolves.toEqual({
      kind: 'started',
      downloadId: 42,
    })

    const release = gateway.releaseTerminal(42)
    await vi.waitFor(() => expect(closeDocument).toHaveBeenCalledOnce())
    let reserveSettled = false
    const reserve = gateway.reserve(ownerFor(2)).then((result) => {
      reserveSettled = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reserveSettled).toBe(false)

    releaseClose()
    await expect(release).resolves.toBeUndefined()
    await expect(reserve).resolves.toEqual({
      kind: 'reserved',
      leaseId: 'race-2',
    })
    expect(h.store()).toMatchObject({
      leases: {
        'race-2': { state: 'building', phase: 'reserved' },
      },
    })
  })

  it.each([
    {
      name: 'attempt above the registry bound',
      lease: {
        leaseId: 'lease-1',
        owner: { ...owner, attempt: MAX_TRANSFER_ATTEMPTS + 1 },
        state: 'building',
        phase: 'staging',
        createdAt: 1,
      },
    },
    {
      name: 'owner newer than its lease',
      lease: {
        leaseId: 'lease-1',
        owner: { ...owner, since: 2 },
        state: 'building',
        phase: 'staging',
        createdAt: 1,
      },
    },
    {
      name: 'owner request id beyond the registry limit',
      lease: {
        leaseId: 'lease-1',
        owner: {
          ...owner,
          requestId: 'x'.repeat(MAX_TRANSFER_REGISTRY_ID_LENGTH + 1),
        },
        state: 'building',
        phase: 'staging',
        createdAt: 1,
      },
    },
    {
      name: 'finalization before creation',
      lease: {
        leaseId: 'lease-1',
        owner,
        state: 'ready',
        objectUrl: 'blob:lease-1',
        createdAt: 1,
        finalizedAt: 0,
      },
    },
    ...['https://example.com/not-a-blob', 'data:text/plain,not-a-blob'].map((objectUrl) => ({
      name: `non-Blob ready URL ${objectUrl.split(':')[0]}`,
      lease: {
        leaseId: 'lease-1',
        owner,
        state: 'ready',
        objectUrl,
        createdAt: 1,
        finalizedAt: 1,
      },
    })),
    {
      name: 'activation before creation',
      lease: {
        leaseId: 'lease-1',
        owner,
        state: 'active',
        downloadId: 42,
        createdAt: 1,
        activatedAt: 0,
      },
    },
  ])('rejects $name', ({ lease }) => {
    expect(decodeFetchedBlobLeaseStore({ version: 2, leases: { 'lease-1': lease } })).toBeNull()
  })

  it.each([0, 4, 2.5, '2', null])('rejects unsupported envelope version %s', (version) => {
    expect(decodeFetchedBlobLeaseStore({ version, leases: {} })).toBeNull()
  })

  it.each([
    {
      state: 'building',
      phase: 'reserved',
    },
    {
      state: 'ready',
      objectUrl: 'blob:lease-1',
      finalizedAt: 1,
    },
    {
      state: 'active',
      downloadId: 42,
      activatedAt: 1,
    },
  ])('rejects a v2 legacy owner in $state', (phase) => {
    expect(
      decodeFetchedBlobLeaseStore({
        version: 2,
        leases: {
          'lease-1': {
            leaseId: 'lease-1',
            owner: { tag: 'legacy-unknown' },
            createdAt: 1,
            ...phase,
          },
        },
      }),
    ).toBeNull()
  })

  it('accepts a v2 legacy owner only as ambiguous', () => {
    expect(
      decodeFetchedBlobLeaseStore({
        version: 2,
        leases: {
          'lease-1': {
            leaseId: 'lease-1',
            owner: { tag: 'legacy-unknown' },
            state: 'ambiguous',
            createdAt: 1,
          },
        },
      }),
    ).toEqual({
      version: 3,
      leases: {
        'lease-1': {
          leaseId: 'lease-1',
          owner: { tag: 'legacy-unknown' },
          state: 'ambiguous',
          createdAt: 1,
        },
      },
    })
  })

  it('rejects a v2 known owner as ambiguous', () => {
    expect(
      decodeFetchedBlobLeaseStore({
        version: 2,
        leases: {
          'lease-1': {
            leaseId: 'lease-1',
            owner,
            state: 'ambiguous',
            createdAt: 1,
          },
        },
      }),
    ).toBeNull()
  })

  it('keeps writer timestamps monotonic when the clock moves backward', async () => {
    const h = setup()
    const gateway = makeFetchedTransferGateway({
      leases: h.storage,
      offscreen: h.offscreen,
      downloads: h.downloads,
      leaseId: () => 'lease-1',
      now: () => 0,
      scheduleAutonomousTerminalCleanup: async () => {},
    })

    await expect(
      gateway.start({
        owner,
        filename: 'a.jpg',
        open: opened(),
      }),
    ).resolves.toEqual({ kind: 'started', downloadId: 42 })
    expect(h.store()).toMatchObject({
      leases: { 'lease-1': { createdAt: 1, activatedAt: 1 } },
    })
  })

  it('does not open when the lease store cannot be read', async () => {
    const h = setup()
    const open = vi.fn(opened())
    const gateway = makeFetchedTransferGateway({
      leases: {
        get: async () => {
          throw new Error('storage unavailable')
        },
        set: h.storage.set,
      },
      offscreen: h.offscreen,
      downloads: h.downloads,
      scheduleAutonomousTerminalCleanup: async () => {},
    })

    await expect(
      gateway.start({
        owner,
        filename: 'a.jpg',
        open,
      }),
    ).resolves.toEqual({ kind: 'unavailable' })
    expect(open).not.toHaveBeenCalled()
    expect(h.downloads.download).not.toHaveBeenCalled()
  })

  it('does not open when durable reservation cannot be written', async () => {
    const h = setup()
    const open = vi.fn(opened())
    const gateway = makeFetchedTransferGateway({
      leases: {
        get: h.storage.get,
        set: async () => {
          throw new Error('storage unavailable')
        },
      },
      offscreen: h.offscreen,
      downloads: h.downloads,
      scheduleAutonomousTerminalCleanup: async () => {},
    })

    await expect(
      gateway.start({
        owner,
        filename: 'a.jpg',
        open,
      }),
    ).rejects.toThrow('storage unavailable')

    expect(open).not.toHaveBeenCalled()
    expect(h.downloads.download).not.toHaveBeenCalled()
  })

  it('aborts a header-stalled open and releases its pre-handoff lease', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      let signal: AbortSignal | undefined
      const start = h.gateway.start({
        owner,
        filename: 'a.jpg',
        open: async (current) => {
          signal = current
          return await new Promise<never>(() => {})
        },
      })
      // oxlint-disable-next-line vitest/valid-expect -- fake time must advance before await.
      const rejected = expect(start).rejects.toThrow('Fetched staging timed out')
      await vi.advanceTimersByTimeAsync(0)
      expect(signal?.aborted).toBe(false)

      await vi.advanceTimersByTimeAsync(FETCHED_STAGE_IDLE_TIMEOUT_MS)
      await rejected
      expect(signal?.aborted).toBe(true)
      expect(h.store()).toEqual(emptyFetchedBlobLeaseStore())
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts a progressing body at the absolute staging deadline', async () => {
    vi.useFakeTimers()
    try {
      const h = setup()
      const cancel = vi.fn(async () => {})
      const start = h.gateway.start({
        owner,
        filename: 'a.jpg',
        open: opened({
          read: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ done: false, value: new Uint8Array([1]) }), 20_000),
            ),
          cancel,
        }),
      })
      // oxlint-disable-next-line vitest/valid-expect -- fake time must advance before await.
      const rejected = expect(start).rejects.toThrow('Fetched staging timed out')

      await vi.advanceTimersByTimeAsync(FETCHED_STAGE_MAX_TIMEOUT_MS)
      await rejected
      expect(cancel).toHaveBeenCalled()
      expect(h.store()).toEqual(emptyFetchedBlobLeaseStore())
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['https://example.com/not-a-blob', 'data:text/plain,not-a-blob'])(
    'quarantines a persisted non-Blob ready URL on boot: %s',
    async (objectUrl) => {
      const h = setup()
      await h.storage.set({
        version: 2,
        leases: {
          'lease-1': {
            leaseId: 'lease-1',
            owner,
            state: 'ready',
            objectUrl,
            createdAt: 1,
            finalizedAt: 1,
          },
        },
      })

      await expect(h.gateway.inspectOnBoot()).resolves.toMatchObject({ tag: 'unavailable' })
      expect(h.downloads.searchByUrl).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      name: 'unsupported empty envelope',
      store: { version: 4, leases: {} },
    },
    {
      name: 'legacy-owned building row',
      store: {
        version: 2,
        leases: {
          'lease-1': {
            leaseId: 'lease-1',
            owner: { tag: 'legacy-unknown' },
            state: 'building',
            phase: 'reserved',
            createdAt: 1,
          },
        },
      },
    },
    {
      name: 'legacy-owned ready row',
      store: {
        version: 2,
        leases: {
          'lease-1': {
            leaseId: 'lease-1',
            owner: { tag: 'legacy-unknown' },
            state: 'ready',
            objectUrl: 'blob:lease-1',
            createdAt: 1,
            finalizedAt: 1,
          },
        },
      },
    },
    {
      name: 'legacy-owned active row',
      store: {
        version: 2,
        leases: {
          'lease-1': {
            leaseId: 'lease-1',
            owner: { tag: 'legacy-unknown' },
            state: 'active',
            downloadId: 42,
            createdAt: 1,
            activatedAt: 1,
          },
        },
      },
    },
  ])('quarantines $name and reports reserves unavailable', async ({ store }) => {
    const h = setup()
    await h.storage.set(store as never)

    await expect(h.gateway.inspectOnBoot()).resolves.toMatchObject({
      tag: 'unavailable',
      reason: 'fetched Blob lease store is malformed',
    })
    await expect(h.gateway.reserve(owner)).resolves.toEqual({ kind: 'unavailable' })
    expect(h.store()).toEqual(store)
    expect(h.downloads.search).not.toHaveBeenCalled()
    expect(h.downloads.searchByUrl).not.toHaveBeenCalled()
  })

  it('rejects an oversized transfer owner before opening', async () => {
    const h = setup()
    const open = vi.fn(opened())

    await expect(
      h.gateway.start({
        owner: {
          ...owner,
          requestId: 'x'.repeat(MAX_TRANSFER_REGISTRY_ID_LENGTH + 1),
        },
        filename: 'a.jpg',
        open,
      }),
    ).resolves.toEqual({ kind: 'unavailable' })

    expect(open).not.toHaveBeenCalled()
    expect(h.store()).toEqual(emptyFetchedBlobLeaseStore())
  })

  it('rejects an oversized filename before opening', async () => {
    const h = setup()
    const open = vi.fn(opened())

    await expect(
      h.gateway.start({
        owner,
        filename: 'f'.repeat(MAX_TRANSFER_REGISTRY_FILENAME_LENGTH + 1),
        open,
      }),
    ).resolves.toEqual({ kind: 'unavailable' })

    expect(open).not.toHaveBeenCalled()
    expect(h.store()).toEqual(emptyFetchedBlobLeaseStore())
  })

  it('cancels an invalid opened MIME source and frees its reservation', async () => {
    const h = setup()
    const cancel = vi.fn(async () => {})

    await expect(
      h.gateway.start({
        owner,
        filename: 'a.jpg',
        open: opened({ read: async () => ({ done: true }), cancel }, 'image/jpeg; charset=utf-8'),
      }),
    ).rejects.toThrow('invalid fetched Blob MIME type')

    expect(cancel).toHaveBeenCalledOnce()
    expect(h.store()).toEqual(emptyFetchedBlobLeaseStore())
  })

  it('cancels capture input with an unbounded owner id before persistence', async () => {
    const h = setup()
    const open = vi.fn(opened())

    await expect(
      h.gateway.start({
        owner: {
          tag: 'capture',
          exportId: 'x'.repeat(MAX_TRANSFER_REGISTRY_ID_LENGTH + 1),
        },
        filename: 'archive.jsonl',
        open,
      }),
    ).resolves.toEqual({ kind: 'unavailable' })

    expect(open).not.toHaveBeenCalled()
    expect(h.store()).toEqual(emptyFetchedBlobLeaseStore())
  })

  it('returns busy promptly for a fifth lease without opening its source', async () => {
    const h = setup()
    let downloadId = 0
    vi.mocked(h.downloads.download).mockImplementation(async () => ++downloadId)
    await Promise.all(
      Array.from({ length: OFFSCREEN_BLOB_MAX_LEASES }, (_, index) =>
        h.gateway.start({
          owner: ownerFor(index),
          filename: `${index}.jpg`,
          open: opened(),
        }),
      ),
    )
    const read = vi.fn<ByteSource['read']>(async () => ({ done: true }))
    const open = vi.fn(opened({ read, cancel: async () => {} }))
    await expect(
      h.gateway.start({
        owner: ownerFor(OFFSCREEN_BLOB_MAX_LEASES),
        filename: 'fifth.jpg',
        open,
      }),
    ).resolves.toEqual({ kind: 'busy' })

    expect(read).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(Object.keys((h.store() as { leases: Record<string, unknown> }).leases)).toHaveLength(
      OFFSCREEN_BLOB_MAX_LEASES,
    )
  })

  it('waits to reserve a later Capture part until terminal cleanup frees capacity', async () => {
    const h = setup()
    await h.storage.set({
      version: 3,
      leases: Object.fromEntries(
        Array.from({ length: OFFSCREEN_BLOB_MAX_LEASES }, (_, index) => [
          `occupied-${index}`,
          {
            leaseId: `occupied-${index}`,
            owner: ownerFor(index),
            state: 'active' as const,
            downloadId: index + 1,
            createdAt: 1,
            activatedAt: 1,
          },
        ]),
      ),
    })
    const waiting = h.gateway.awaitCaptureReservation({
      tag: 'capture',
      exportId: 'capture-part-5',
    })
    let settled = false
    void waiting.finally(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await h.gateway.releaseTerminal(1)

    await expect(waiting).resolves.toEqual({
      kind: 'reserved',
      leaseId: 'lease-1',
    })
    expect(Object.keys((h.store() as { leases: Record<string, unknown> }).leases)).toHaveLength(
      OFFSCREEN_BLOB_MAX_LEASES,
    )
  })

  it('returns busy for every excess request; paused leases cannot wedge a message', async () => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: Object.fromEntries(
        Array.from({ length: OFFSCREEN_BLOB_MAX_LEASES }, (_, index) => [
          `occupied-${index}`,
          {
            leaseId: `occupied-${index}`,
            owner: ownerFor(index),
            state: 'active' as const,
            downloadId: index + 1,
            createdAt: 1,
            activatedAt: 1,
          },
        ]),
      ),
    })
    const opens = Array.from({ length: MAX_DOWNLOAD_ITEMS_PER_REQUEST }, () => vi.fn(opened()))
    await expect(
      Promise.all(
        opens.map((open, index) =>
          h.gateway.start({
            owner: ownerFor(index + 10),
            filename: `${index}.jpg`,
            open,
          }),
        ),
      ),
    ).resolves.toEqual(opens.map(() => ({ kind: 'busy' })))
    expect(opens.every((open) => !open.mock.calls.length)).toBe(true)
  })

  it('does not open a duplicate owner', async () => {
    const h = setup()
    await h.gateway.start({
      owner,
      filename: 'a.jpg',
      open: opened(),
    })
    const read = vi.fn<ByteSource['read']>(async () => ({ done: true }))
    const cancel = vi.fn(async () => {})
    const open = vi.fn(opened({ read, cancel }))

    await expect(
      h.gateway.start({
        owner,
        filename: 'a.jpg',
        open,
      }),
    ).resolves.toEqual({ kind: 'owner-duplicate' })

    expect(read).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('admits a fresh source after safe staging cleanup frees capacity', async () => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: Object.fromEntries(
        Array.from({ length: OFFSCREEN_BLOB_MAX_LEASES }, (_, index) => [
          `occupied-${index}`,
          {
            leaseId: `occupied-${index}`,
            owner: ownerFor(index),
            state: 'building' as const,
            phase: 'staging' as const,
            createdAt: 1,
          },
        ]),
      ),
    })
    const read = vi.fn<ByteSource['read']>(async () => ({ done: true }))
    const open = vi.fn(opened({ read, cancel: async () => {} }))
    await expect(
      h.gateway.start({
        owner: ownerFor(OFFSCREEN_BLOB_MAX_LEASES),
        filename: 'waiting.jpg',
        open,
      }),
    ).resolves.toEqual({ kind: 'busy' })
    expect(read).not.toHaveBeenCalled()

    await h.gateway.discardRecoveredStaging(['occupied-0'])

    await expect(
      h.gateway.start({
        owner: ownerFor(OFFSCREEN_BLOB_MAX_LEASES),
        filename: 'waiting.jpg',
        open,
      }),
    ).resolves.toEqual({ kind: 'started', downloadId: 42 })
    expect(read).toHaveBeenCalledOnce()
    expect(Object.keys((h.store() as { leases: Record<string, unknown> }).leases)).toHaveLength(
      OFFSCREEN_BLOB_MAX_LEASES,
    )
  })

  it('accepts a transfer owner at the shared registry ID limit', async () => {
    const h = setup()
    const cancel = vi.fn(async () => {})

    await expect(
      h.gateway.start({
        owner: {
          ...owner,
          requestId: 'x'.repeat(MAX_TRANSFER_REGISTRY_ID_LENGTH),
        },
        filename: 'a.jpg',
        open: opened({ read: async () => ({ done: true }), cancel }),
      }),
    ).resolves.toEqual({ kind: 'started', downloadId: 42 })

    expect(cancel).not.toHaveBeenCalled()
  })

  it('retains ready ownership when Chrome returns an invalid handle', async () => {
    const h = setup()
    vi.mocked(h.downloads.download).mockResolvedValue(Number.NaN)

    await expect(
      h.gateway.start({
        owner,
        filename: 'a.jpg',
        open: opened(),
      }),
    ).resolves.toEqual({ kind: 'handoff-ambiguous' })
    expect(h.store()).toMatchObject({
      leases: { 'lease-1': { state: 'ready', owner } },
    })
  })

  it('persists typed ready before Chrome then reports its exact recovered handle', async () => {
    const h = setup()
    await expect(
      h.gateway.start({
        owner,
        filename: 'a.jpg',
        open: opened(),
      }),
    ).resolves.toEqual({ kind: 'started', downloadId: 42 })
    expect(h.store()).toMatchObject({
      version: 3,
      leases: { 'lease-1': { owner, state: 'active', downloadId: 42 } },
    })
    await h.storage.set({
      version: 2,
      leases: {
        'lease-1': {
          leaseId: 'lease-1',
          owner,
          state: 'ready',
          objectUrl: 'blob:lease-1',
          createdAt: 1,
          finalizedAt: 1,
        },
      },
    })
    await expect(h.gateway.inspectOnBoot()).resolves.toEqual({
      tag: 'available',
      observations: [
        {
          tag: 'matched',
          leaseId: 'lease-1',
          owner,
          downloadId: 42,
          terminal: false,
        },
      ],
    })
    expect(h.discarded).toEqual([])
  })

  it('retains ready rows with zero or many URL matches', async () => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: {
        'lease-1': {
          leaseId: 'lease-1',
          owner,
          state: 'ready',
          objectUrl: 'blob:lease-1',
          createdAt: 1,
          finalizedAt: 1,
        },
      },
    })
    vi.mocked(h.downloads.searchByUrl)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
    await expect(h.gateway.inspectOnBoot()).resolves.toMatchObject({
      observations: [{ tag: 'unknown', reason: 'no-url-match' }],
    })
    await expect(h.gateway.inspectOnBoot()).resolves.toMatchObject({
      observations: [{ tag: 'unknown', reason: 'many-url-matches' }],
    })
    expect(h.discarded).toEqual([])
  })

  it('retains an ambiguous post-ready rejection and never retries Chrome', async () => {
    const h = setup()
    vi.mocked(h.downloads.download).mockRejectedValue(new Error('lost reply'))
    await expect(
      h.gateway.start({
        owner,
        filename: 'a.jpg',
        open: opened(),
      }),
    ).resolves.toEqual({ kind: 'handoff-ambiguous' })
    expect(h.store()).toMatchObject({
      leases: { 'lease-1': { state: 'ready', owner } },
    })
  })

  it('cleans only capture terminal rows during inspection', async () => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: {
        transfer: {
          leaseId: 'transfer',
          owner,
          state: 'active',
          downloadId: 42,
          createdAt: 1,
          activatedAt: 1,
        },
        capture: {
          leaseId: 'capture',
          owner: { tag: 'capture', exportId: 'export-1' },
          state: 'active',
          downloadId: 43,
          createdAt: 1,
          activatedAt: 1,
        },
      },
    })
    vi.mocked(h.downloads.search).mockImplementation(async (id) => [
      { state: id === 42 ? 'complete' : 'interrupted' },
    ])
    await h.gateway.inspectOnBoot()
    expect(h.discarded).toEqual(['capture'])
    expect(h.store()).toMatchObject({
      leases: { transfer: expect.anything() },
    })
  })

  it.each([
    { name: 'zero URL matches', search: async () => [] },
    { name: 'many URL matches', search: async () => [{ id: 41 }, { id: 42 }] },
    {
      name: 'a URL search error',
      search: async () => {
        throw new Error('Chrome search unavailable')
      },
    },
  ])('retains Capture ready after worker death with $name', async ({ search }) => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: {
        capture: {
          leaseId: 'capture',
          owner: { tag: 'capture', exportId: 'capture-export' },
          state: 'ready',
          objectUrl: 'blob:capture',
          createdAt: 1,
          finalizedAt: 1,
        },
      },
    })
    vi.mocked(h.downloads.searchByUrl).mockImplementation(search)

    await expect(h.restart().inspectOnBoot()).resolves.toEqual({
      tag: 'available',
      observations: [],
    })

    expect(h.discarded).toEqual([])
    expect(h.store()).toMatchObject({ leases: { capture: { state: 'ready' } } })
  })

  it.each([
    { name: 'a missing download', search: async () => [] },
    {
      name: 'a download search error',
      search: async () => {
        throw new Error('Chrome search unavailable')
      },
    },
  ])('retains Capture active after worker death with $name', async ({ search }) => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: {
        capture: {
          leaseId: 'capture',
          owner: { tag: 'capture', exportId: 'capture-export' },
          state: 'active',
          downloadId: 43,
          createdAt: 1,
          activatedAt: 1,
        },
      },
    })
    vi.mocked(h.downloads.search).mockImplementation(search)

    await expect(h.restart().inspectOnBoot()).resolves.toEqual({
      tag: 'available',
      observations: [],
    })

    expect(h.discarded).toEqual([])
    expect(h.store()).toMatchObject({ leases: { capture: { state: 'active' } } })
  })

  it('releases Capture only after exact terminal evidence on restart', async () => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: {
        capture: {
          leaseId: 'capture',
          owner: { tag: 'capture', exportId: 'capture-export' },
          state: 'active',
          downloadId: 43,
          createdAt: 1,
          activatedAt: 1,
        },
      },
    })
    vi.mocked(h.downloads.search).mockResolvedValue([{ state: 'complete' }])

    await expect(h.restart().inspectOnBoot()).resolves.toEqual({
      tag: 'available',
      observations: [],
    })

    expect(h.discarded).toEqual(['capture'])
    expect(h.store()).toEqual(emptyFetchedBlobLeaseStore())
  })

  it('discards transfer staging only after registry acknowledgement', async () => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: {
        'lease-1': {
          leaseId: 'lease-1',
          owner,
          state: 'building',
          phase: 'staging',
          createdAt: 1,
        },
      },
    })
    await expect(h.gateway.inspectOnBoot()).resolves.toMatchObject({
      observations: [{ tag: 'staging', owner }],
    })
    expect(h.discarded).toEqual([])
    await h.gateway.discardRecoveredStaging(['lease-1'])
    expect(h.discarded).toEqual(['lease-1'])
  })

  it('chunks and rejects an oversized body before Chrome handoff', async () => {
    const h = setup()
    const cancel = vi.fn(async () => {})
    let sent = false
    const oversized: ByteSource = {
      read: async () => {
        if (sent) return { done: true }
        sent = true
        return { done: false, value: new Uint8Array(15 * 1024 * 1024 + 1) }
      },
      cancel,
    }
    await expect(
      h.gateway.start({
        owner,
        filename: 'a.jpg',
        open: opened(oversized),
      }),
    ).resolves.toEqual({ kind: 'too-large' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(h.downloads.download).not.toHaveBeenCalled()
    expect(h.discarded).toEqual(['lease-1'])
  })

  it('chunks bounded input before one Chrome handoff', async () => {
    const h = setup()
    let sent = false
    await h.gateway.start({
      owner,
      filename: 'a.jpg',
      open: opened({
        read: async () => {
          if (sent) return { done: true }
          sent = true
          return { done: false, value: new Uint8Array(300_000) }
        },
        cancel: async () => {},
      }),
    })
    expect(h.append.mock.calls.map(([, bytes]) => bytes.byteLength)).toEqual([262_144, 37_856])
    expect(h.downloads.download).toHaveBeenCalledOnce()
  })

  it('retains a lease when discard fails and isolates a corrupt store', async () => {
    const h = setup()
    Object.defineProperty(h.offscreen, 'discard', {
      value: vi.fn(async () => {
        throw new Error('down')
      }),
    })
    const cancel = vi.fn(async () => {})
    await expect(
      h.gateway.start({
        owner,
        filename: 'a.jpg',
        open: opened({
          read: async () => ({
            done: false,
            value: new Uint8Array(15 * 1024 * 1024 + 1),
          }),
          cancel,
        }),
      }),
    ).rejects.toThrow('down')
    expect(h.store()).toMatchObject({
      leases: { 'lease-1': { state: 'building' } },
    })
    await h.storage.set({ bad: true } as never)
    await expect(h.gateway.inspectOnBoot()).resolves.toMatchObject({
      tag: 'unavailable',
    })
  })

  it('releases only the exact transfer lease and closes when empty', async () => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: {
        transfer: {
          leaseId: 'transfer',
          owner,
          state: 'active',
          downloadId: 42,
          createdAt: 1,
          activatedAt: 1,
        },
        capture: {
          leaseId: 'capture',
          owner: { tag: 'capture', exportId: 'e' },
          state: 'active',
          downloadId: 43,
          createdAt: 1,
          activatedAt: 1,
        },
      },
    })
    await h.gateway.releaseTerminal(42)
    expect(h.discarded).toEqual(['transfer'])
    expect(h.store()).toMatchObject({ leases: { capture: expect.anything() } })
    await h.gateway.releaseCaptureTerminal(43)
    expect(h.discarded).toEqual(['transfer', 'capture'])
    expect(h.closeDocument).toHaveBeenCalledOnce()
  })

  it('persists autonomous terminal cleanup across a worker death and alarm retry', async () => {
    const h = setup()
    const schedule = vi.fn(async () => {})
    await h.storage.set({
      version: 2,
      leases: {
        capture: {
          leaseId: 'capture',
          owner: { tag: 'capture', exportId: 'export-1' },
          state: 'active',
          downloadId: 43,
          createdAt: 1,
          activatedAt: 1,
        },
      },
    })
    Object.defineProperty(h.offscreen, 'discard', {
      value: vi.fn(async () => {
        throw new Error('offscreen down')
      }),
    })
    const first = makeFetchedTransferGateway({
      leases: h.storage,
      offscreen: h.offscreen,
      downloads: h.downloads,
      now: () => 1,
      scheduleAutonomousTerminalCleanup: schedule,
    })

    await expect(first.releaseCaptureTerminal(43)).rejects.toThrow('offscreen down')
    expect(h.store()).toMatchObject({
      version: 3,
      leases: { capture: { state: 'terminal', cleanup: 'capture', downloadId: 43 } },
    })
    expect(schedule).toHaveBeenCalledWith(1 + FETCHED_TERMINAL_CLEANUP_RETRY_MS)

    Object.defineProperty(h.offscreen, 'discard', {
      value: vi.fn(async (id: string) => h.discarded.push(id)),
    })
    const restarted = makeFetchedTransferGateway({
      leases: h.storage,
      offscreen: h.offscreen,
      downloads: h.downloads,
      now: () => 2,
      scheduleAutonomousTerminalCleanup: schedule,
    })
    await restarted.retryAutonomousTerminalCleanup()

    expect(h.discarded).toEqual(['capture'])
    expect(h.store()).toEqual(emptyFetchedBlobLeaseStore())
  })

  it('takes over retained projector cleanup before autonomous revoke and never reverses it', async () => {
    const h = setup()
    const schedule = vi.fn(async () => {})
    await h.storage.set({
      version: 3,
      leases: {
        transfer: {
          leaseId: 'transfer',
          owner,
          state: 'terminal',
          cleanup: 'projector',
          downloadId: 42,
          createdAt: 1,
          terminalAt: 1,
        },
      },
    })
    Object.defineProperty(h.offscreen, 'discard', {
      value: vi.fn(async () => {
        throw new Error('offscreen down')
      }),
    })
    const first = makeFetchedTransferGateway({
      leases: h.storage,
      offscreen: h.offscreen,
      downloads: h.downloads,
      now: () => 1,
      scheduleAutonomousTerminalCleanup: schedule,
    })

    await expect(first.releaseAutonomousTerminal(42)).rejects.toThrow('offscreen down')
    expect(schedule).toHaveBeenCalledOnce()
    expect(h.store()).toMatchObject({
      leases: { transfer: { state: 'terminal', cleanup: 'autonomous' } },
    })
    await expect(first.releaseTerminal(42)).rejects.toThrow('offscreen down')
    expect(h.store()).toMatchObject({
      leases: { transfer: { state: 'terminal', cleanup: 'autonomous' } },
    })

    Object.defineProperty(h.offscreen, 'discard', {
      value: vi.fn(async (id: string) => h.discarded.push(id)),
    })
    const restarted = makeFetchedTransferGateway({
      leases: h.storage,
      offscreen: h.offscreen,
      downloads: h.downloads,
      now: () => 2,
      scheduleAutonomousTerminalCleanup: schedule,
    })
    await restarted.retryAutonomousTerminalCleanup()

    expect(h.discarded).toEqual(['transfer'])
    expect(h.store()).toEqual(emptyFetchedBlobLeaseStore())
  })

  it('fails closed before writing autonomous terminal evidence when its alarm cannot arm', async () => {
    const h = setup()
    const schedule = vi.fn(async () => {
      throw new Error('alarm down')
    })
    await h.storage.set({
      version: 2,
      leases: {
        capture: {
          leaseId: 'capture',
          owner: { tag: 'capture', exportId: 'export-1' },
          state: 'active',
          downloadId: 43,
          createdAt: 1,
          activatedAt: 1,
        },
      },
    })
    const gateway = makeFetchedTransferGateway({
      leases: h.storage,
      offscreen: h.offscreen,
      downloads: h.downloads,
      now: () => 1,
      scheduleAutonomousTerminalCleanup: schedule,
    })

    await expect(gateway.releaseCaptureTerminal(43)).rejects.toThrow('alarm down')
    expect(schedule).toHaveBeenCalledOnce()
    expect(h.discarded).toEqual([])
    expect(h.store()).toMatchObject({ leases: { capture: { state: 'active' } } })
  })

  it('arms before each alarm cleanup attempt and fails boot closed if re-arm fails', async () => {
    const h = setup()
    let allowArm!: () => void
    const armGate = new Promise<void>((resolve) => {
      allowArm = resolve
    })
    const schedule = vi.fn(async () => await armGate)
    await h.storage.set({
      version: 3,
      leases: {
        capture: {
          leaseId: 'capture',
          owner: { tag: 'capture', exportId: 'export-1' },
          state: 'terminal',
          cleanup: 'capture',
          downloadId: 43,
          createdAt: 1,
          terminalAt: 1,
        },
      },
    })
    const gateway = makeFetchedTransferGateway({
      leases: h.storage,
      offscreen: h.offscreen,
      downloads: h.downloads,
      now: () => 1,
      scheduleAutonomousTerminalCleanup: schedule,
    })

    const retry = gateway.retryAutonomousTerminalCleanup()
    await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce())
    expect(h.discarded).toEqual([])
    allowArm()
    await retry
    expect(h.discarded).toEqual(['capture'])

    await h.storage.set({
      version: 3,
      leases: {
        capture: {
          leaseId: 'capture',
          owner: { tag: 'capture', exportId: 'export-1' },
          state: 'terminal',
          cleanup: 'capture',
          downloadId: 43,
          createdAt: 1,
          terminalAt: 1,
        },
      },
    })
    const boot = makeFetchedTransferGateway({
      leases: h.storage,
      offscreen: h.offscreen,
      downloads: h.downloads,
      now: () => 1,
      scheduleAutonomousTerminalCleanup: async () => {
        throw new Error('alarm down')
      },
    })
    await expect(boot.inspectOnBoot()).resolves.toMatchObject({
      tag: 'unavailable',
      reason: expect.stringContaining('alarm down'),
    })
    expect(h.discarded).toEqual(['capture'])
  })

  it('reports a terminal transfer lease without revoking it before Registry bind', async () => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: {
        transfer: {
          leaseId: 'transfer',
          owner,
          state: 'active',
          downloadId: 42,
          createdAt: 1,
          activatedAt: 1,
        },
      },
    })

    await expect(h.gateway.observeTerminalTransfer(42)).resolves.toMatchObject({
      leaseId: 'transfer',
      owner,
      downloadId: 42,
      terminal: true,
    })
    expect(h.discarded).toEqual([])
    expect(h.store()).toMatchObject({ leases: { transfer: { state: 'active' } } })
  })

  it('does not stage a new lease while the last lease closes the shared document', async () => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: {
        old: {
          leaseId: 'old',
          owner,
          state: 'active',
          downloadId: 42,
          createdAt: 1,
          activatedAt: 1,
        },
      },
    })
    let unblockClose!: () => void
    const closeBlocked = new Promise<void>((resolve) => {
      unblockClose = resolve
    })
    let notifyCloseStarted!: () => void
    const closeStarted = new Promise<void>((resolve) => {
      notifyCloseStarted = resolve
    })
    Object.defineProperty(h.offscreen, 'closeDocument', {
      value: vi.fn(async () => {
        notifyCloseStarted()
        await closeBlocked
      }),
    })

    const releasing = h.gateway.releaseTerminal(42)
    await closeStarted
    const open = vi.fn(opened())
    const starting = h.gateway.start({
      owner: ownerFor(2),
      filename: 'new.jpg',
      open,
    })
    await Promise.resolve()
    expect(open).not.toHaveBeenCalled()

    unblockClose()
    await expect(releasing).resolves.toBeUndefined()
    await expect(starting).resolves.toEqual({
      kind: 'started',
      downloadId: 42,
    })
    expect(open).toHaveBeenCalledOnce()
  })

  it('isolates one boot cleanup failure and migrates v1 rows to read-only unknown', async () => {
    const h = setup()
    await h.storage.set({
      version: 2,
      leases: {
        bad: {
          leaseId: 'bad',
          owner: { tag: 'capture', exportId: 'bad' },
          state: 'building',
          phase: 'staging',
          createdAt: 1,
        },
        good: {
          leaseId: 'good',
          owner: { tag: 'capture', exportId: 'good' },
          state: 'building',
          phase: 'staging',
          createdAt: 1,
        },
      },
    })
    Object.defineProperty(h.offscreen, 'discard', {
      value: vi.fn(async (leaseId: string) => {
        if (leaseId === 'bad') throw new Error('offscreen down')
        h.discarded.push(leaseId)
      }),
    })
    await h.gateway.inspectOnBoot()
    expect(h.store()).toMatchObject({ leases: { bad: expect.anything() } })
    expect(h.store()).not.toMatchObject({
      leases: { good: expect.anything() },
    })

    await h.storage.set({
      version: 1,
      leases: {
        old: {
          leaseId: 'old',
          requestId: 'old',
          state: 'building',
          createdAt: 1,
        },
      },
    } as never)
    await expect(h.gateway.inspectOnBoot()).resolves.toMatchObject({
      observations: [{ tag: 'unknown', reason: 'legacy-owner' }],
    })
  })
})
