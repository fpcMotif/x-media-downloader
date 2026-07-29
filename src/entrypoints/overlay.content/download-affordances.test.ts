import { describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '../../core/schema'
import { makeDownloadAffordances } from './download-affordances'

type DownloadAffordanceDeps = Parameters<typeof makeDownloadAffordances>[0]

const item: MediaItem = {
  id: 'media-1',
  platform: 'x',
  postId: 'post-1',
  author: 'author',
  type: 'photo',
  url: 'https://example.test/media.jpg',
  ext: 'jpg',
  index: 0,
}

const media = { isConnected: true } as unknown as HTMLImageElement

const harness = (resolvedItem: MediaItem = item) => {
  let now = 0
  let nextTimer = 0
  const timers = new Map<number, () => void>()
  const rerender = vi.fn<DownloadAffordanceDeps['rerender']>()
  const sendTracked = vi.fn<DownloadAffordanceDeps['sendTracked']>(async () => ({
    _tag: 'started',
  }))
  const affordances = makeDownloadAffordances({
    clock: {
      now: () => now,
      after: (_ms, task) => {
        const id = ++nextTimer
        timers.set(id, task)
        return () => timers.delete(id)
      },
    },
    rerender,
    resolveItem: () => resolvedItem,
    mediaIsCurrent: () => true,
    allItems: () => [resolvedItem],
    clearExpect: () => undefined,
    sendTracked,
    trace: () => {},
  })
  return {
    affordances,
    rerender,
    sendTracked,
    tick: () => {
      const queued = [...timers.values()]
      timers.clear()
      queued.forEach((task) => task())
      now++
    },
  }
}

describe('download affordances', () => {
  it('keeps a same-key badge entrance while its DOM anchor changes', () => {
    const h = harness()
    h.affordances.apply({ enabled: true, modifierHeld: false, media, key: 'key', resolvable: true })
    const replacement = { isConnected: true } as unknown as HTMLImageElement
    h.affordances.apply({
      enabled: true,
      modifierHeld: false,
      media: replacement,
      key: 'key',
      resolvable: true,
    })
    expect(h.affordances.snapshot()).toMatchObject({
      badge: { phase: 'shown', key: 'key' },
      badgeMedia: replacement,
    })
  })

  it('fences a late badge start after a route change', async () => {
    let resolveStart: ((value: { readonly _tag: 'started' }) => void) | undefined
    const h = harness()
    h.sendTracked.mockImplementation(
      () => new Promise<{ readonly _tag: 'started' }>((resolve) => (resolveStart = resolve)),
    )
    h.affordances.apply({ enabled: true, modifierHeld: false, media, key: 'key', resolvable: true })
    h.affordances.onBadgeClick()
    expect(h.affordances.snapshot().badge.phase).toBe('queued')
    h.affordances.onRouteChange()
    resolveStart?.({ _tag: 'started' })
    await Promise.resolve()
    expect(h.affordances.snapshot()).toMatchObject({
      badge: { phase: 'hidden', key: null },
      launcher: 'idle',
    })
  })

  it('corrects a launcher start acknowledgement with a terminal failure', async () => {
    const h = harness()
    h.affordances.launchAll()
    await Promise.resolve()
    expect(h.affordances.snapshot().launcher).toBe('saved')
    expect(h.affordances.onTransferOutcome(item.id, 'failed')).toBe(true)
    expect(h.affordances.snapshot().launcher).toBe('failed')
  })

  it('correlates non-X terminal outcomes by global Save Request ID', async () => {
    const instagram = { ...item, platform: 'instagram' as const }
    const h = harness(instagram)
    h.affordances.launchAll()
    await Promise.resolve()

    expect(h.affordances.onTransferOutcome(item.id, 'failed')).toBe(false)
    expect(h.affordances.onTransferOutcome('xmd:v1:media:instagram:7:media-1', 'failed')).toBe(true)
  })

  it('stops timers and ignores terminal outcomes after teardown', async () => {
    const h = harness()
    h.affordances.launchAll()
    await Promise.resolve()
    h.affordances.stop()
    h.tick()
    expect(h.affordances.onTransferOutcome(item.id, 'failed')).toBe(false)
    expect(h.affordances.snapshot().launcher).toBe('idle')
  })
})
