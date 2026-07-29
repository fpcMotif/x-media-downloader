import { describe, expect, it, vi } from 'vitest'
import type { CaptureReadSnapshot } from './capture-db'
import { makeCaptureExporter } from './capture-export'
import {
  CAPTURE_EXPORT_STAGE_CHUNK_BYTES,
  makeCaptureExportStaging,
  type CaptureExportStageStore,
} from './capture-export-staging'
import type { TweetRecord } from '../core/capture/record'
import {
  MAX_FETCHED_BYTES,
  type FetchedTransferGateway,
} from '../core/download/fetched-transfer-contract'
import { toJsonl } from '../core/capture/export'

const record = (tweetId: string, opts: Partial<TweetRecord> = {}): TweetRecord => ({
  tweetId,
  conversationId: tweetId,
  author: { handle: 'alice' },
  text: tweetId,
  rawText: tweetId,
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'tweetDetail',
  sourceRank: 2,
  capturedAt: 1_700_000_000_000,
  ...opts,
})

const reader = (rows: ReadonlyArray<TweetRecord>, pageSize = 2): CaptureReadSnapshot => ({
  page: vi.fn<CaptureReadSnapshot['page']>(async (afterTweetId?: string) =>
    rows
      .toSorted((a, b) => a.tweetId.localeCompare(b.tweetId))
      .filter((row) => afterTweetId === undefined || row.tweetId > afterTweetId)
      .slice(0, pageSize),
  ),
  conversationPage: vi.fn<CaptureReadSnapshot['conversationPage']>(
    async (conversationId: string, afterTweetId?: string) =>
      rows
        .filter((row) => row.conversationId === conversationId)
        .toSorted((a, b) => a.tweetId.localeCompare(b.tweetId))
        .filter((row) => afterTweetId === undefined || row.tweetId > afterTweetId)
        .slice(0, pageSize),
  ),
  get: vi.fn<CaptureReadSnapshot['get']>(async (tweetId: string) =>
    rows.find((row) => row.tweetId === tweetId),
  ),
})

const stagingStore = () => {
  let id: string | undefined
  let ready = false
  const parts: Uint8Array[][] = []
  const store: CaptureExportStageStore = {
    begin: async (next) => {
      if (id !== undefined) throw new Error('occupied')
      id = next
      ready = false
    },
    append: async (owner, part, bytes) => {
      if (id !== owner || ready || part > parts.length || part + 1 < parts.length)
        throw new Error('unavailable')
      if (part === parts.length) parts.push([])
      parts[part]!.push(new Uint8Array(bytes))
    },
    ready: async (owner, partCount) => {
      if (id !== owner || partCount !== parts.length) throw new Error('unavailable')
      ready = true
    },
    read: async (owner, part, index) => {
      if (id !== owner || !ready || part >= parts.length) throw new Error('unavailable')
      return parts[part]![index]
    },
    discard: async (owner) => {
      if (owner !== undefined && owner !== id) return
      id = undefined
      ready = false
      parts.length = 0
    },
  }
  return { store, activeId: () => id }
}

const countTreeNodes = (value: unknown): number => {
  const stack = [...((value as { tweets: unknown[] }).tweets ?? [])]
  let count = 0
  while (stack.length > 0) {
    const node = stack.pop() as { children: unknown[] }
    count += 1
    stack.push(...node.children)
  }
  return count
}

const harness = (
  rows: ReadonlyArray<TweetRecord>,
  opts: {
    readonly maxBytes?: number
    readonly gatewayMaxBytes?: number
    readonly gatewayFailure?: boolean
    readonly gatewayUnavailable?: boolean
    readonly gatewayFailureAt?: number
    readonly gatewayUnavailableAt?: number
    readonly gatewayCapacity?: number
  } = {},
) => {
  const read = reader(rows)
  let maxSourceChunkBytes = 0
  let snapshotActive = false
  const gatewaySnapshotStates: boolean[] = []
  const downloads: Array<{
    readonly filename: string
    readonly text: string
    readonly owner: Parameters<FetchedTransferGateway['start']>[0]['owner']
  }> = []
  const reservations = new Map<string, number>()
  let reservationCount = 0
  let activeReservations = 0
  let directAttempt = 0
  const transfer = async (
    input:
      | Parameters<FetchedTransferGateway['start']>[0]
      | Parameters<FetchedTransferGateway['startReserved']>[0],
    attempt: number,
  ) => {
    const { body } = await input.open()
    gatewaySnapshotStates.push(snapshotActive)
    if (
      opts.gatewayUnavailableAt === attempt ||
      (opts.gatewayUnavailable === true && attempt === 0)
    ) {
      await body.cancel()
      return { kind: 'unavailable' as const }
    }
    const chunks: Uint8Array[] = []
    let size = 0
    const gatewayLimit = opts.gatewayMaxBytes ?? Number.POSITIVE_INFINITY
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- a ByteSource is sequential by contract
      const next = await body.read()
      if (next.done) break
      maxSourceChunkBytes = Math.max(maxSourceChunkBytes, next.value!.byteLength)
      size += next.value!.byteLength
      if (size > gatewayLimit) {
        // oxlint-disable-next-line no-await-in-loop -- ordered ByteSource teardown
        await body.cancel()
        return { kind: 'too-large' as const }
      }
      chunks.push(next.value!)
      if (opts.gatewayFailureAt === attempt || (opts.gatewayFailure === true && attempt === 0)) {
        // oxlint-disable-next-line no-await-in-loop -- simulates ordered gateway teardown
        await body.cancel()
        throw new Error('offscreen append failed')
      }
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    downloads.push({
      filename: input.filename,
      text: new TextDecoder().decode(bytes),
      owner: input.owner,
    })
    activeReservations = Math.max(0, activeReservations - 1)
    return { kind: 'started' as const, downloadId: 7 + attempt }
  }
  const reserve = async () => {
    if (activeReservations >= (opts.gatewayCapacity ?? Number.POSITIVE_INFINITY))
      return { kind: 'busy' as const }
    const attempt = reservationCount
    const leaseId = `capture-reservation-${attempt}`
    reservations.set(leaseId, attempt)
    reservationCount += 1
    activeReservations += 1
    return { kind: 'reserved' as const, leaseId }
  }
  const gateway: FetchedTransferGateway = {
    reserve: vi.fn<FetchedTransferGateway['reserve']>(reserve),
    awaitCaptureReservation: vi.fn<FetchedTransferGateway['awaitCaptureReservation']>(async () => {
      const reservation = await reserve()
      return reservation.kind === 'busy' ? { kind: 'unavailable' as const } : reservation
    }),
    startReserved: vi.fn<FetchedTransferGateway['startReserved']>(async (input) => {
      const attempt = reservations.get(input.leaseId)
      if (attempt === undefined) return { kind: 'unavailable' as const }
      return transfer(input, attempt)
    }),
    start: vi.fn<FetchedTransferGateway['start']>(async (input) => {
      const attempt = directAttempt
      directAttempt += 1
      return transfer(input, attempt)
    }),
    releaseTerminal: vi.fn<FetchedTransferGateway['releaseTerminal']>(async () => {}),
    releaseCaptureTerminal: vi.fn<FetchedTransferGateway['releaseCaptureTerminal']>(async () => {}),
    releaseAutonomousTerminal: vi.fn<FetchedTransferGateway['releaseAutonomousTerminal']>(
      async () => {},
    ),
    observeTerminalTransfer: vi.fn<FetchedTransferGateway['observeTerminalTransfer']>(
      async () => undefined,
    ),
    retryAutonomousTerminalCleanup: vi.fn<FetchedTransferGateway['retryAutonomousTerminalCleanup']>(
      async () => {},
    ),
    discardRecoveredStaging: vi.fn<FetchedTransferGateway['discardRecoveredStaging']>(
      async () => {},
    ),
    inspectOnBoot: vi.fn<FetchedTransferGateway['inspectOnBoot']>(async () => ({
      tag: 'available',
      observations: [],
    })),
  }
  const stage = stagingStore()
  const exporter = makeCaptureExporter({
    captureDb: {
      withReadSnapshot: async (job) => {
        snapshotActive = true
        try {
          return await job(read)
        } finally {
          snapshotActive = false
        }
      },
    },
    gateway,
    staging: makeCaptureExportStaging({ store: stage.store }),
    now: () => Date.parse('2026-07-22T00:00:00Z'),
    requestId: () => 'capture-export-1',
    ...(opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes }),
  })
  return {
    exporter,
    gateway,
    gatewaySnapshotStates,
    stagedId: stage.activeId,
    maxSourceChunkBytes: () => maxSourceChunkBytes,
    read,
    downloads,
    text: () => downloads[0]?.text ?? '',
  }
}

describe('CaptureExporter', () => {
  it('streams JSONL by page and resolves a quoted tweet by key', async () => {
    const quoted = record('1', {
      author: { handle: 'quoted' },
      text: 'quoted text',
    })
    const quote = record('2', {
      quotedTweetId: quoted.tweetId,
      text: 'commentary',
    })
    const h = harness([quote, quoted])

    await expect(h.exporter.start('jsonl')).resolves.toEqual({
      _tag: 'CaptureExportStarted',
      filename: 'xharvest-20260722.jsonl',
    })

    const lines = h
      .text()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.map((line) => line.id)).toEqual(['1', '2'])
    expect(lines[1]?.quote).toEqual({
      id: '1',
      url: 'https://x.com/quoted/status/1',
      text: 'quoted text',
    })
    expect(h.read.page).toHaveBeenNthCalledWith(1)
    expect(h.read.page).toHaveBeenCalledWith('2')
    expect(h.read.get).toHaveBeenCalledWith('1')
    expect(h.gatewaySnapshotStates).toEqual([false])
    expect(h.text()).toBe(toJsonl([quoted, quote]))
  })

  it('keeps an unresolved JSONL quote explicit without loading the archive', async () => {
    const h = harness([record('2', { quotedTweetId: 'missing' })])

    await expect(h.exporter.start('jsonl')).resolves.toMatchObject({
      _tag: 'CaptureExportStarted',
    })

    expect(JSON.parse(h.text()).quote).toEqual({
      id: 'missing',
      url: 'https://x.com/i/status/missing',
      text: null,
    })
    expect(h.read.get).toHaveBeenCalledWith('missing')
  })

  it('bounds quote lookup memory and reuses a repeated direct lookup', async () => {
    const quoted = record('1', { conversationId: 'Q' })
    const h = harness([
      quoted,
      record('2', { quotedTweetId: '1' }),
      record('3', { quotedTweetId: '1' }),
      record('4', { quotedTweetId: '1' }),
    ])

    await expect(h.exporter.start('jsonl')).resolves.toMatchObject({
      _tag: 'CaptureExportStarted',
    })

    expect(h.read.get).toHaveBeenCalledTimes(1)
    expect(h.read.get).toHaveBeenCalledWith('1')
  })

  it('returns too-large only when one JSONL record cannot fit a 15 MiB part', async () => {
    const h = harness([record('1', { text: 'x'.repeat(MAX_FETCHED_BYTES) })], {
      gatewayMaxBytes: MAX_FETCHED_BYTES,
    })

    await expect(h.exporter.start('jsonl')).resolves.toEqual({
      _tag: 'CaptureExportTooLarge',
    })
    expect(h.stagedId()).toBeUndefined()
  })

  it(
    'exports an archive above 15 MiB as independently valid bounded JSONL parts',
    { timeout: 15_000 },
    async () => {
      const rows = Array.from({ length: 65 }, (_, index) =>
        record(String(index).padStart(3, '0'), { text: 'x'.repeat(250_000) }),
      )
      const h = harness(rows)

      await expect(h.exporter.start('jsonl')).resolves.toEqual({
        _tag: 'CaptureExportStarted',
        filename: 'xharvest-20260722.jsonl',
      })

      expect(h.downloads.map((download) => download.filename)).toEqual([
        'xharvest-20260722.jsonl',
        'xharvest-20260722.part-0002.jsonl',
      ])
      for (const download of h.downloads) {
        expect(new TextEncoder().encode(download.text).byteLength).toBeLessThanOrEqual(
          MAX_FETCHED_BYTES,
        )
        expect(download.text.split('\n').every((line) => JSON.parse(line) !== null)).toBe(true)
      }
      expect(h.downloads.map((download) => download.text).join('\n')).toBe(toJsonl(rows))
      expect(new Set(h.downloads.map((download) => JSON.stringify(download.owner))).size).toBe(2)
      expect(h.gatewaySnapshotStates).toEqual([false, false])
      expect(h.stagedId()).toBeUndefined()
    },
  )

  it('exports every part through bounded gateway capacity', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => record(String(index)))
    const oneLineBytes = new TextEncoder().encode(toJsonl([rows[0]!])).byteLength
    const h = harness(rows, { maxBytes: oneLineBytes, gatewayCapacity: 4 })

    await expect(h.exporter.start('jsonl')).resolves.toEqual({
      _tag: 'CaptureExportStarted',
      filename: 'xharvest-20260722.jsonl',
    })

    expect(h.downloads).toHaveLength(5)
    expect(h.gateway.reserve).toHaveBeenCalledOnce()
    expect(h.gateway.awaitCaptureReservation).toHaveBeenCalledTimes(4)
    expect(h.gateway.startReserved).toHaveBeenCalledTimes(5)
    expect(h.gatewaySnapshotStates).toEqual([false, false, false, false, false])
    expect(h.stagedId()).toBeUndefined()
  })

  it('maps initial capacity pressure to unavailable without opening staged bytes', async () => {
    const h = harness([record('1')], { gatewayCapacity: 0 })

    await expect(h.exporter.start('jsonl')).resolves.toEqual({
      _tag: 'CaptureExportUnavailable',
    })

    expect(h.gateway.reserve).toHaveBeenCalledOnce()
    expect(h.gateway.startReserved).not.toHaveBeenCalled()
    expect(h.gatewaySnapshotStates).toEqual([])
    expect(h.stagedId()).toBeUndefined()
  })

  it('reports a later part failure as uncertain and removes unread staged parts', async () => {
    const rows = [record('1'), record('2')]
    const oneLineBytes = new TextEncoder().encode(toJsonl([rows[0]!])).byteLength
    const h = harness(rows, { maxBytes: oneLineBytes, gatewayFailureAt: 1 })

    await expect(h.exporter.start('jsonl')).resolves.toEqual({
      _tag: 'CaptureExportUncertain',
    })

    expect(h.downloads).toHaveLength(1)
    expect(h.gateway.startReserved).toHaveBeenCalledTimes(2)
    expect(h.stagedId()).toBeUndefined()
  })

  it.each([
    ['tree', 'thread-C.json'],
    ['markdown', 'thread-C.md'],
  ] as const)('exports only one bounded conversation as %s', async (kind, filename) => {
    const outsideQuote = record('1', {
      conversationId: 'OTHER',
      author: { handle: 'quoted' },
      text: 'quoted text',
    })
    const root = record('2', { conversationId: 'C', text: 'root' })
    const reply = record('3', {
      conversationId: 'C',
      inReplyToTweetId: root.tweetId,
      quotedTweetId: outsideQuote.tweetId,
      text: 'reply',
    })
    const unrelated = record('4', {
      conversationId: 'OTHER',
      text: 'do not export',
    })
    const h = harness([unrelated, reply, outsideQuote, root])

    await expect(h.exporter.start(kind, 'C')).resolves.toEqual({
      _tag: 'CaptureExportStarted',
      filename,
    })

    expect(h.text()).toContain('root')
    expect(h.text()).toContain('reply')
    expect(h.text()).toContain('quoted text')
    expect(h.text()).not.toContain('do not export')
    expect(kind !== 'tree' || JSON.parse(h.text()).conversationId === 'C').toBe(true)
    expect(h.read.conversationPage).toHaveBeenCalledWith('C')
    expect(h.read.page).not.toHaveBeenCalled()
    expect(h.gatewaySnapshotStates).toEqual([false])
  })

  it('feeds the gateway bounded source chunks for one large field', async () => {
    const h = harness([record('1', { text: '😀'.repeat(100_000) })])

    await expect(h.exporter.start('jsonl')).resolves.toMatchObject({
      _tag: 'CaptureExportStarted',
    })

    expect(h.maxSourceChunkBytes()).toBeLessThanOrEqual(CAPTURE_EXPORT_STAGE_CHUNK_BYTES)
  })

  it('accepts the exact conversation input cap and rejects one byte less', async () => {
    const row = record('1', {
      conversationId: 'C',
      rawText: 'stored-only detail',
    })
    const inputBytes = new TextEncoder().encode(JSON.stringify(row)).byteLength
    const exact = harness([row], { maxBytes: inputBytes })
    const short = harness([row], { maxBytes: inputBytes - 1 })

    await expect(exact.exporter.start('markdown', 'C')).resolves.toMatchObject({
      _tag: 'CaptureExportStarted',
    })
    await expect(short.exporter.start('markdown', 'C')).resolves.toEqual({
      _tag: 'CaptureExportTooLarge',
    })
    expect(short.gateway.start).not.toHaveBeenCalled()
  })

  it('renders a cycle and a deep tree finitely, then obeys the output cap', async () => {
    const cycle = [
      record('a', { conversationId: 'C', inReplyToTweetId: 'b' }),
      record('b', { conversationId: 'C', inReplyToTweetId: 'a' }),
    ]
    const deep = Array.from({ length: 5_000 }, (_, index) =>
      record(String(index).padStart(5, '0'), {
        conversationId: 'D',
        ...(index === 0 ? {} : { inReplyToTweetId: String(index - 1).padStart(5, '0') }),
      }),
    )
    const cycleExport = harness(cycle)
    const moderateExport = harness(deep.slice(0, 250))
    const deepExport = harness(deep, { gatewayMaxBytes: MAX_FETCHED_BYTES })
    const capped = harness(deep, { gatewayMaxBytes: 100 })

    await expect(cycleExport.exporter.start('tree', 'C')).resolves.toMatchObject({
      _tag: 'CaptureExportStarted',
    })
    await expect(moderateExport.exporter.start('tree', 'D')).resolves.toMatchObject({
      _tag: 'CaptureExportStarted',
    })
    await expect(deepExport.exporter.start('tree', 'D')).resolves.toEqual({
      _tag: 'CaptureExportTooLarge',
    })
    await expect(capped.exporter.start('tree', 'D')).resolves.toEqual({
      _tag: 'CaptureExportTooLarge',
    })

    expect(countTreeNodes(JSON.parse(cycleExport.text()))).toBe(2)
    expect(countTreeNodes(JSON.parse(moderateExport.text()))).toBe(250)
  })

  it('maps a gateway failure after cleanup to the exact failed result', async () => {
    const h = harness([record('1')], { gatewayFailure: true })

    await expect(h.exporter.start('jsonl')).resolves.toEqual({
      _tag: 'CaptureExportFailed',
    })
    expect(h.gateway.startReserved).toHaveBeenCalledOnce()
    expect(h.stagedId()).toBeUndefined()
  })

  it('keeps definite gateway unavailability distinct from an uncertain handoff', async () => {
    const h = harness([record('1')], { gatewayUnavailable: true })

    await expect(h.exporter.start('jsonl')).resolves.toEqual({
      _tag: 'CaptureExportUnavailable',
    })
    expect(h.gateway.startReserved).toHaveBeenCalledOnce()
  })
})
