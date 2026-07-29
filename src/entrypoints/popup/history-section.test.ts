import { describe, it, expect, afterEach } from 'vitest'
import type { MediaItem } from '../../core/schema'
import { recordFromMediaItem, applyOutcome } from '../../core/history/record'
import { DEFAULT_HISTORY_CAP } from '../../core/history/store'
import {
  groupByAuthor,
  formatRecord,
  historyEmptyLabel,
  confirmEraseHistoryCopy,
  requestHistoryErase,
  fetchHistory,
} from './history-section'

const rec = (id: string, handle: string, at: number) =>
  recordFromMediaItem(
    {
      id,
      platform: 'x',
      postId: id.split('-')[0] ?? id,
      author: handle,
      type: 'photo',
      url: `https://pbs.twimg.com/media/${id}?format=jpg&name=orig`,
      ext: 'jpg',
      index: 0,
    } satisfies MediaItem,
    `${handle}/${id}.jpg`,
    at,
  )

describe('groupByAuthor', () => {
  it('groups records by handle, newest-first within and across groups', () => {
    const records = [rec('1-1', 'bob', 300), rec('1-0', 'alice', 250), rec('1-2', 'bob', 100)]
    const groups = groupByAuthor(records)
    expect(groups.map((g) => g.handle)).toEqual(['bob', 'alice'])
    expect(groups[0]!.records.map((r) => r.requestId)).toEqual(['1-1', '1-2'])
    expect(groups[1]!.records.map((r) => r.requestId)).toEqual(['1-0'])
  })
})

describe('formatRecord', () => {
  it('projects the original link, filename, status and finishedAt', () => {
    const done = applyOutcome(rec('1-0', 'alice', 1000), 'completed', 2000)
    const f = formatRecord(done)
    expect(f.link).toBe(done.media.url)
    expect(f.title).toBe(done.filename)
    expect(f.status).toBe('completed')
    expect(f.whenMs).toBe(2000)
  })

  it('falls back to queuedAt when not yet finished', () => {
    expect(formatRecord(rec('2-0', 'bob', 1500)).whenMs).toBe(1500)
  })
})

describe('historyEmptyLabel', () => {
  it('prompts to enable when the toggle is off', () => {
    expect(historyEmptyLabel(false, 0)).toBe('Turn on to keep a local history')
    expect(historyEmptyLabel(false, 5)).toBe('Turn on to keep a local history')
  })

  it('shows an empty hint when on with no records (finding 12: teaches instead of a bare label)', () => {
    expect(historyEmptyLabel(true, 0)).toBe('No downloads yet — files you save will appear here.')
  })

  it('is empty when on with records', () => {
    expect(historyEmptyLabel(true, 3)).toBe('')
  })
})

describe('confirmEraseHistoryCopy', () => {
  it('pluralizes "download record" and states files on disk are untouched', () => {
    expect(confirmEraseHistoryCopy(0)).toBe(
      'Erase all 0 download records? This cannot be undone. Files on disk are not touched.',
    )
    expect(confirmEraseHistoryCopy(1)).toBe(
      'Erase all 1 download record? This cannot be undone. Files on disk are not touched.',
    )
    expect(confirmEraseHistoryCopy(2)).toBe(
      'Erase all 2 download records? This cannot be undone. Files on disk are not touched.',
    )
  })
})

describe('fetchHistory', () => {
  const original = browser.runtime.sendMessage
  afterEach(() => {
    browser.runtime.sendMessage = original
  })

  it('returns available records from an exact valid HistoryRequest reply', async () => {
    const records = [rec('1-0', 'alice', 100)]
    browser.runtime.sendMessage = (async (request) => {
      expect(request).toEqual({ _tag: 'HistoryRequest' })
      return {
        records,
      }
    }) as typeof browser.runtime.sendMessage
    expect(await fetchHistory()).toEqual({ status: 'available', records })
  })

  it('accepts 500 records but rejects an oversized reply array', async () => {
    const records = Array.from({ length: DEFAULT_HISTORY_CAP }, (_, index) =>
      rec(`${index + 1}-0`, 'alice', index),
    ).toReversed()
    browser.runtime.sendMessage = (async () => ({ records })) as typeof browser.runtime.sendMessage
    await expect(fetchHistory()).resolves.toEqual({ status: 'available', records })

    browser.runtime.sendMessage = (async () => ({
      records: [rec('501-0', 'alice', 501), ...records],
    })) as typeof browser.runtime.sendMessage
    await expect(fetchHistory()).resolves.toEqual({ status: 'unavailable' })
  })

  it.each([
    undefined,
    null,
    {},
    { records: [] as unknown[], extra: true },
    { records: [{ ...rec('1-0', 'alice', 100), status: 'unknown' }] },
    { ok: false, reason: 'history failed' },
  ])('returns unavailable for an unclaimed, malformed, or rejected reply: %o', async (reply) => {
    browser.runtime.sendMessage = (async () => reply) as typeof browser.runtime.sendMessage
    expect(await fetchHistory()).toEqual({ status: 'unavailable' })
  })

  it('returns unavailable when sendMessage rejects or throws synchronously', async () => {
    browser.runtime.sendMessage = (async () => {
      throw new Error('no receiver')
    }) as typeof browser.runtime.sendMessage
    expect(await fetchHistory()).toEqual({ status: 'unavailable' })

    browser.runtime.sendMessage = (() => {
      throw new Error('Extension context invalidated')
    }) as typeof browser.runtime.sendMessage
    expect(await fetchHistory()).toEqual({ status: 'unavailable' })
  })
})

describe('requestHistoryErase', () => {
  const original = browser.runtime.sendMessage
  afterEach(() => {
    browser.runtime.sendMessage = original
  })

  it('reports success only after the background confirms erase', async () => {
    browser.runtime.sendMessage = (async () => ({ ok: true })) as typeof browser.runtime.sendMessage
    expect(await requestHistoryErase()).toBe(true)

    browser.runtime.sendMessage = (async () => ({
      ok: true,
      extra: 'unexpected',
    })) as typeof browser.runtime.sendMessage
    expect(await requestHistoryErase()).toBe(false)

    browser.runtime.sendMessage = (async () => undefined) as typeof browser.runtime.sendMessage
    expect(await requestHistoryErase()).toBe(false)

    browser.runtime.sendMessage = (async () => {
      throw new Error('storage failed')
    }) as typeof browser.runtime.sendMessage
    expect(await requestHistoryErase()).toBe(false)
  })
})
