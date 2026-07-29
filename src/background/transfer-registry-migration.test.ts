import { describe, expect, it } from 'vitest'
import {
  migrateLegacyTransferTracker,
  type MigrateLegacyTransferTrackerResult,
} from './transfer-registry-migration'
import { MAX_TRANSFER_REGISTRY_FILENAME_LENGTH } from '../core/download/transfer-registry'

const now = 10_000

const metadata = (id: string, extra: Record<string, unknown> = {}) => ({
  [id]: {
    url: `https://cdn.example/${id}.mp4`,
    filename: `${id}.mp4`,
    mode: 'fetched',
    item: {
      id,
      platform: 'x',
      postId: 'post-1',
      author: 'alice',
      type: 'video',
      url: `https://cdn.example/${id}.mp4`,
      ext: 'mp4',
      index: 0,
    },
    ...extra,
  },
})

const metadataWithoutItem = (id: string) => ({
  [id]: {
    url: `https://cdn.example/${id}.mp4`,
    filename: `${id}.mp4`,
    mode: 'fetched',
  },
})

const transfer = (
  id: string,
  downloadId: number,
  startedAt = 4_000,
  extra: Record<string, unknown> = {},
) => ({
  id,
  downloadId,
  startedAt,
  ...extra,
})

const retry = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  url: `https://cdn.example/${id}.mp4`,
  filename: `${id}.mp4`,
  mode: 'fetched',
  attempt: 2,
  nextRetryAt: 12_000,
  item: {
    id,
    platform: 'x',
    postId: 'post-1',
    author: 'alice',
    type: 'video',
    url: `https://cdn.example/${id}.mp4`,
    ext: 'mp4',
    index: 0,
  },
  ...extra,
})

const migrated = (result: MigrateLegacyTransferTrackerResult) => {
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  return result.state
}

describe('migrateLegacyTransferTracker', () => {
  it('rejects oversized legacy request metadata before creating v3 state', () => {
    expect(
      migrateLegacyTransferTracker(undefined, metadataWithoutItem('a'), undefined, now),
    ).toMatchObject({ ok: true })
    expect(
      migrateLegacyTransferTracker(
        undefined,
        metadata('a', { filename: 'f'.repeat(MAX_TRANSFER_REGISTRY_FILENAME_LENGTH + 1) }),
        undefined,
        now,
      ),
    ).toMatchObject({ ok: false, kind: 'legacy-corruption' })
  })

  it('uses bounded, unique deterministic receipts for long legacy ids', () => {
    const first = 'a'.repeat(256)
    const second = 'b'.repeat(256)
    const state = migrated(
      migrateLegacyTransferTracker(
        { transfers: [transfer(first, 7, 4_000), transfer(second, 8, 4_000)] },
        { ...metadata(first), ...metadata(second) },
        undefined,
        now,
      ),
    )
    expect(state.entries[first]?.request.projectionId).toBe('legacy-1')
    expect(state.entries[second]?.request.projectionId).toBe('legacy-2')
  })

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a non-exact migration clock: %s',
    (badNow) => {
      expect(migrateLegacyTransferTracker(undefined, undefined, undefined, badNow)).toMatchObject({
        ok: false,
        kind: 'legacy-corruption',
      })
    },
  )

  it('quarantines a handleless retry instead of fabricating a browser owner', () => {
    const state = migrated(migrateLegacyTransferTracker(undefined, undefined, [retry('a')], now))

    expect(state.entries.a).toMatchObject({
      request: { id: 'a', mode: 'fetched', item: { id: 'a' } },
      phase: { tag: 'unresolved-launch', attempt: 2, reason: 'worker-restart' },
    })
  })

  it('quarantines an overdue handleless retry without a due alarm', () => {
    const state = migrated(
      migrateLegacyTransferTracker(undefined, undefined, [retry('a', { nextRetryAt: 2_000 })], now),
    )

    expect(state.entries.a).toMatchObject({
      createdAt: now,
      phase: { tag: 'unresolved-launch', attempt: 2, reason: 'worker-restart' },
    })
  })

  it('rejects a legacy retry at unreachable attempt zero', () => {
    const result = migrateLegacyTransferTracker(
      undefined,
      undefined,
      [retry('a', { attempt: 0 })],
      now,
    )

    expect(result).toMatchObject({
      ok: false,
      kind: 'legacy-corruption',
      reason: 'unreachable retry attempt: a',
    })
  })

  it('moves a transfer with matching metadata into active', () => {
    const state = migrated(
      migrateLegacyTransferTracker(
        { transfers: [transfer('a', 7)] },
        metadata('a'),
        undefined,
        now,
      ),
    )

    expect(state.entries.a).toMatchObject({
      request: { id: 'a', mode: 'fetched', item: { id: 'a' } },
      createdAt: 4_000,
      phase: {
        tag: 'active',
        downloadId: 7,
        attempt: 0,
        startedAt: 4_000,
        nextProbeAt: now,
      },
    })
  })

  it('keeps orphan metadata as unresolved instead of starting it', () => {
    const state = migrated(
      migrateLegacyTransferTracker(undefined, metadata('orphan'), undefined, now),
    )

    expect(state.entries.orphan).toMatchObject({
      request: { id: 'orphan', mode: 'fetched' },
      phase: { tag: 'unresolved-launch', attempt: 0, since: now },
    })
  })

  it('quarantines a transfer/retry overlap rather than picking an owner', () => {
    const state = migrated(
      migrateLegacyTransferTracker({ transfers: [transfer('a', 7)] }, undefined, [retry('a')], now),
    )

    expect(state.entries.a?.phase).toMatchObject({
      tag: 'unresolved-launch',
      attempt: 2,
      since: now,
    })
  })

  it('quarantines contradictory retry and metadata rows', () => {
    const state = migrated(
      migrateLegacyTransferTracker(
        undefined,
        metadata('a', { filename: 'other.mp4' }),
        [retry('a')],
        now,
      ),
    )

    expect(state.entries.a?.phase).toMatchObject({
      tag: 'unresolved-launch',
      attempt: 2,
    })
  })

  it('fails all-or-nothing on one corrupt legacy value', () => {
    const result = migrateLegacyTransferTracker(
      {
        transfers: [transfer('a', 7), { id: 'bad', downloadId: -1, startedAt: 1 }],
      },
      metadata('a'),
      undefined,
      now,
    )

    expect(result).toMatchObject({
      ok: false,
      kind: 'legacy-corruption',
      state: { version: 4, entries: {}, profiles: {}, legacy: {} },
      reason: 'transfer tracker: invalid transfer at index 1',
    })
  })

  it('quarantines every metadata-backed owner of a duplicate legacy download handle', () => {
    const state = migrated(
      migrateLegacyTransferTracker(
        { transfers: [transfer('a', 7), transfer('b', 7)] },
        { ...metadata('a'), ...metadata('b') },
        undefined,
        now,
      ),
    )

    expect(state.entries.a?.phase.tag).toBe('unresolved-launch')
    expect(state.entries.b?.phase.tag).toBe('unresolved-launch')
    expect(Object.values(state.entries).some((entry) => entry.phase.tag === 'active')).toBe(false)
  })

  it('quarantines duplicate request ownership as one unresolved identity', () => {
    const state = migrated(
      migrateLegacyTransferTracker(
        { transfers: [transfer('a', 7), transfer('a', 8)] },
        metadata('a'),
        undefined,
        now,
      ),
    )

    expect(Object.keys(state.entries)).toEqual(['a'])
    expect(state.entries.a?.phase.tag).toBe('unresolved-launch')
  })

  it('uses a valid retry identity to quarantine duplicate handle ownership', () => {
    const state = migrated(
      migrateLegacyTransferTracker(
        { transfers: [transfer('a', 7), transfer('b', 7)] },
        metadata('b'),
        [retry('a')],
        now,
      ),
    )

    expect(state.entries.a).toMatchObject({
      request: { id: 'a' },
      phase: { tag: 'unresolved-launch', attempt: 2 },
    })
    expect(state.entries.b?.phase.tag).toBe('unresolved-launch')
  })

  it('fails all-or-nothing when one duplicate handle owner lacks request identity', () => {
    const result = migrateLegacyTransferTracker(
      { transfers: [transfer('a', 7), transfer('b', 7)] },
      metadata('a'),
      undefined,
      now,
    )

    expect(result).toMatchObject({
      ok: false,
      kind: 'unrepresentable-active',
      state: { version: 4, entries: {}, profiles: {}, legacy: {} },
      reason: 'ambiguous transfer lacks metadata: b',
    })
  })

  it('isolates a metadata-free active transfer without inventing request metadata', () => {
    const state = migrated(
      migrateLegacyTransferTracker({ transfers: [transfer('a', 7)] }, undefined, undefined, now),
    )

    expect(state.entries).toEqual({})
    expect(state.legacy.a).toMatchObject({
      downloadId: 7,
      startedAt: 4_000,
      phase: { tag: 'active', nextProbeAt: now },
    })
  })

  it('fails all-or-nothing for ambiguous metadata-free handle owners', () => {
    const result = migrateLegacyTransferTracker(
      { transfers: [transfer('a', 7), transfer('b', 7)] },
      undefined,
      undefined,
      now,
    )

    expect(result).toMatchObject({
      ok: false,
      kind: 'unrepresentable-active',
      state: { version: 4, entries: {}, profiles: {}, legacy: {} },
    })
  })

  it('rejects metadata that points a tracked transfer at another post', () => {
    const result = migrateLegacyTransferTracker(
      { transfers: [transfer('a', 7, 4_000, { tweetId: 'tweet-a' })] },
      metadata('a', { item: { ...metadata('a').a!.item, postId: 'tweet-b' } }),
      undefined,
      now,
    )

    expect(result).toMatchObject({
      ok: false,
      kind: 'legacy-corruption',
      reason: 'tracked transfer post mismatch: a',
    })
  })

  it('rejects tracked tweet provenance without a metadata item', () => {
    const result = migrateLegacyTransferTracker(
      { transfers: [transfer('a', 7, 4_000, { tweetId: 'tweet-a' })] },
      metadataWithoutItem('a'),
      undefined,
      now,
    )

    expect(result).toMatchObject({
      ok: false,
      kind: 'unrepresentable-active',
      reason: 'tracked transfer metadata lacks item: a',
    })
  })
})
