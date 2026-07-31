import { describe, it, expect, vi } from 'vitest'
import { Schema } from 'effect'
import { makeCaptureOutbox, type LedgerStorage } from './capture-outbox'
import { Settings as SettingsSchema, type Settings } from '@/packages/schema'
import { decodeLedger, readyJobs } from '@/packages/sync/captures'
import type { TweetRecord } from '@/packages/capture/record'

const baseSettings: Settings = Schema.decodeUnknownSync(SettingsSchema)({})

/** A fully configured + mirror-enabled Settings, with overrides for the gate tests. */
const cfg = (over: Partial<Settings> = {}): Settings => ({
  ...baseSettings,
  cloudSyncEnabled: true,
  convexUrl: 'https://x.convex.cloud',
  convexSyncSecret: 'sek',
  cloudDeviceId: 'dev-1',
  captureMirrorEnabled: true,
  ...over,
})

const mk = (tweetId: string): TweetRecord => ({
  tweetId,
  conversationId: tweetId,
  author: { handle: 'alice' },
  text: 'hi',
  rawText: 'hi',
  links: [],
  media: [],
  mentions: [],
  hashtags: [],
  source: 'timeline',
  sourceRank: 1,
  capturedAt: 1000,
})

function fakeLedger(
  initial: unknown = null,
  opts: { delay?: boolean } = {},
): LedgerStorage & { value: unknown } {
  const box = {
    value: initial,
    async get() {
      if (opts.delay) await tick()
      return box.value
    },
    async set(value: unknown) {
      if (opts.delay) await tick()
      box.value = value
    },
  }
  return box
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0))
const records = [mk('1'), mk('2')]

describe('makeCaptureOutbox — ADR-0018 gate (default OFF, separate from media sync)', () => {
  it('sends nothing when the capture mirror is disabled', async () => {
    const ledger = fakeLedger()
    const getSettings = vi.fn<() => Promise<Settings>>(async () =>
      cfg({ captureMirrorEnabled: false }),
    )
    const mutation = vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => ({}))
    const outbox = makeCaptureOutbox({
      getSettings,
      ledger,
      connect: () => ({ mutation }),
      now: () => 1000,
    })

    outbox.mirrorCaptures(records)
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalled())
    await tick()

    expect(mutation).not.toHaveBeenCalled()
    expect(ledger.value).toBeNull()
  })

  it('sends nothing when Cloud Sync is not configured', async () => {
    const ledger = fakeLedger()
    const getSettings = vi.fn<() => Promise<Settings>>(async () => cfg({ cloudSyncEnabled: false }))
    const mutation = vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => ({}))
    const outbox = makeCaptureOutbox({
      getSettings,
      ledger,
      connect: () => ({ mutation }),
      now: () => 1000,
    })

    outbox.mirrorCaptures(records)
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalled())
    await tick()

    expect(mutation).not.toHaveBeenCalled()
    expect(ledger.value).toBeNull()
  })

  it('sends nothing for an empty batch even when fully enabled', async () => {
    const ledger = fakeLedger()
    const getSettings = vi.fn<() => Promise<Settings>>(async () => cfg())
    const mutation = vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => ({}))
    const outbox = makeCaptureOutbox({
      getSettings,
      ledger,
      connect: () => ({ mutation }),
      now: () => 1000,
    })

    outbox.mirrorCaptures([])
    await vi.waitFor(() => expect(getSettings).toHaveBeenCalled())
    await tick()

    expect(mutation).not.toHaveBeenCalled()
    expect(ledger.value).toBeNull()
  })
})

describe('makeCaptureOutbox — drain', () => {
  it('enqueues and sends the batch once to captures:recordCaptures, then stops', async () => {
    const ledger = fakeLedger()
    const mutation = vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => ({}))
    const outbox = makeCaptureOutbox({
      getSettings: async () => cfg(),
      ledger,
      connect: () => ({ mutation }),
      now: () => 1000,
    })

    outbox.mirrorCaptures(records)
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    await tick()

    expect(mutation).toHaveBeenCalledTimes(1)
    const [name, args] = mutation.mock.calls[0] as [string, { captures: unknown[]; secret: string }]
    expect(name).toBe('captures:recordCaptures')
    expect(args.secret).toBe('sek')
    expect(args.captures).toHaveLength(2)
    // Drained events are claimed, so a re-drain at the same instant finds nothing.
    expect(readyJobs(decodeLedger(ledger.value), 1000)).toHaveLength(0)
  })

  it('best-effort: a control-plane error is swallowed and events stay for retry', async () => {
    const ledger = fakeLedger()
    const mutation = vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => {
      throw new Error('503')
    })
    const outbox = makeCaptureOutbox({
      getSettings: async () => cfg(),
      ledger,
      connect: () => ({ mutation }),
      now: () => 1000,
    })

    outbox.mirrorCaptures(records)
    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1))
    await tick()

    // The mirror failed, but the enqueued events remain ready — nothing was lost.
    expect(readyJobs(decodeLedger(ledger.value), 1000)).toHaveLength(2)
  })

  it('serializes interleaved mirror batches so neither capture is lost', async () => {
    const ledger = fakeLedger(null, { delay: true })
    const mutation = vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => ({}))
    const outbox = makeCaptureOutbox({
      getSettings: async () => cfg(),
      ledger,
      connect: () => ({ mutation }),
      now: () => 1000,
    })

    outbox.mirrorCaptures([mk('1')])
    outbox.mirrorCaptures([mk('2')])

    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(2))
    const sent = mutation.mock.calls.flatMap(
      ([, args]) => (args as { captures: ReadonlyArray<{ tweetId: string }> }).captures,
    )
    expect(sent.map((capture) => capture.tweetId)).toEqual(['1', '2'])
  })

  it('caps each Convex wire batch at 64 captures', async () => {
    const mutation = vi.fn<(name: string, args: unknown) => Promise<unknown>>(async () => ({}))
    const outbox = makeCaptureOutbox({
      getSettings: async () => cfg(),
      ledger: fakeLedger(),
      connect: () => ({ mutation }),
      now: () => 1000,
    })

    outbox.mirrorCaptures(Array.from({ length: 65 }, (_, i) => mk(String(i))))

    await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(2))
    expect((mutation.mock.calls[0]![1] as { captures: unknown[] }).captures).toHaveLength(64)
    expect((mutation.mock.calls[1]![1] as { captures: unknown[] }).captures).toHaveLength(1)
  })
})
