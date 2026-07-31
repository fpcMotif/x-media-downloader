import { describe, it, expect } from 'vitest'
import type { MediaItem } from '@/packages/schema'
import {
  freeReason,
  sizeReason,
  budgetReason,
  evaluateAdmission,
  type FilterSettings,
  type AdmissionContext,
} from '../admission'

const item: MediaItem = {
  id: 'm1',
  platform: 'x',
  postId: '123',
  author: 'alice',
  type: 'photo',
  url: 'https://pbs.twimg.com/media/AAA.jpg?name=orig',
  ext: 'jpg',
  index: 0,
  width: 1200,
  height: 800,
}

const allOff: FilterSettings = {
  preventDuplicateDownloads: false,
  skipTypes: [],
  minWidth: 0,
  minHeight: 0,
  maxFileSizeBytes: 0,
  dailyMaxBytes: 0,
  dailyMaxCount: 0,
}

describe('freeReason', () => {
  it("returns 'filtered-type' when the item's type is skipped", () => {
    const video: MediaItem = { ...item, type: 'video' }
    expect(freeReason(video, { ...allOff, skipTypes: ['video'] }, new Set())).toBe('filtered-type')
  })

  it('passes a type that is not in skipTypes', () => {
    expect(freeReason(item, { ...allOff, skipTypes: ['video', 'gif'] }, new Set())).toBeNull()
  })

  it("returns 'too-small' when width is below minWidth", () => {
    expect(freeReason({ ...item, width: 100 }, { ...allOff, minWidth: 500 }, new Set())).toBe(
      'too-small',
    )
  })

  it("returns 'too-small' when height is below minHeight", () => {
    expect(freeReason({ ...item, height: 100 }, { ...allOff, minHeight: 500 }, new Set())).toBe(
      'too-small',
    )
  })

  it('passes (fail-open) when width/height are absent even with a min set', () => {
    const noDims: MediaItem = { ...item, width: undefined, height: undefined }
    expect(freeReason(noDims, { ...allOff, minWidth: 500, minHeight: 500 }, new Set())).toBeNull()
  })

  it('passes an item at or above the resolution threshold', () => {
    expect(freeReason(item, { ...allOff, minWidth: 1200, minHeight: 800 }, new Set())).toBeNull()
  })

  it("returns 'duplicate' when savedMediaIds contains the item's id", () => {
    expect(freeReason(item, { ...allOff, preventDuplicateDownloads: true }, new Set(['m1']))).toBe(
      'duplicate',
    )
  })

  it('does not flag a duplicate when the dedup setting is off', () => {
    expect(
      freeReason(item, { ...allOff, preventDuplicateDownloads: false }, new Set(['m1'])),
    ).toBeNull()
  })

  it('does not flag a duplicate when the item id is not saved', () => {
    expect(
      freeReason(item, { ...allOff, preventDuplicateDownloads: true }, new Set(['999'])),
    ).toBeNull()
  })

  it('flags item A as duplicate but leaves item B (same post, different id) admitted', () => {
    const a: MediaItem = { ...item, id: 'a', postId: 'shared-post' }
    const b: MediaItem = { ...item, id: 'b', postId: 'shared-post' }
    const settings: FilterSettings = { ...allOff, preventDuplicateDownloads: true }
    const saved = new Set(['a'])
    expect(freeReason(a, settings, saved)).toBe('duplicate')
    expect(freeReason(b, settings, saved)).toBeNull()
  })

  it('orders media-type before min-resolution before duplicate', () => {
    const video: MediaItem = { ...item, type: 'video', width: 1 }
    const settings: FilterSettings = {
      ...allOff,
      skipTypes: ['video'],
      minWidth: 9999,
      preventDuplicateDownloads: true,
    }
    expect(freeReason(video, settings, new Set(['m1']))).toBe('filtered-type')

    const small: MediaItem = { ...item, width: 1 }
    expect(freeReason(small, settings, new Set(['m1']))).toBe('too-small')
  })

  it('returns null when all free checks are off', () => {
    expect(freeReason(item, allOff, new Set(['m1']))).toBeNull()
  })
})

describe('sizeReason', () => {
  it("returns 'too-big' when the known size exceeds the cap", () => {
    expect(sizeReason(2_000_000, 1_000_000)).toBe('too-big')
  })

  it('passes when the known size is at or below the cap', () => {
    expect(sizeReason(1_000_000, 1_000_000)).toBeNull()
  })

  it('fails open (null) when the size is unknown', () => {
    expect(sizeReason(null, 1_000_000)).toBeNull()
  })

  it('is off (null) when the cap is 0, even over a huge size', () => {
    expect(sizeReason(9_999_999, 0)).toBeNull()
  })
})

describe('budgetReason', () => {
  it("returns 'daily-budget' when adding would cross the byte limit", () => {
    expect(
      budgetReason(
        { bytes: 900, count: 1 },
        { bytes: 200, count: 1 },
        {
          dailyMaxBytes: 1000,
          dailyMaxCount: 0,
        },
      ),
    ).toBe('daily-budget')
  })

  it("returns 'daily-budget' when adding would cross the count limit", () => {
    expect(
      budgetReason(
        { bytes: 0, count: 5 },
        { bytes: 1, count: 1 },
        {
          dailyMaxBytes: 0,
          dailyMaxCount: 5,
        },
      ),
    ).toBe('daily-budget')
  })

  it('passes when neither active limit is crossed', () => {
    expect(
      budgetReason(
        { bytes: 100, count: 1 },
        { bytes: 100, count: 1 },
        {
          dailyMaxBytes: 1000,
          dailyMaxCount: 10,
        },
      ),
    ).toBeNull()
  })

  it('never triggers when both limits are disabled (0)', () => {
    expect(
      budgetReason(
        { bytes: 9_999_999, count: 9999 },
        { bytes: 9_999_999, count: 9999 },
        {
          dailyMaxBytes: 0,
          dailyMaxCount: 0,
        },
      ),
    ).toBeNull()
  })
})

describe('evaluateAdmission', () => {
  const ctx = (over: Partial<AdmissionContext> = {}): AdmissionContext => ({
    settings: allOff,
    savedMediaIds: new Set(),
    sizeBytes: null,
    running: { bytes: 0, count: 0 },
    ...over,
  })

  it('admits when every filter is off', () => {
    expect(evaluateAdmission(item, ctx())).toEqual({ admit: true })
  })

  it('free checks win over size: duplicate beats too-big', () => {
    const decision = evaluateAdmission(
      item,
      ctx({
        settings: { ...allOff, preventDuplicateDownloads: true, maxFileSizeBytes: 1 },
        savedMediaIds: new Set(['m1']),
        sizeBytes: 5_000_000,
      }),
    )
    expect(decision).toEqual({ admit: false, reason: 'duplicate' })
  })

  it('size wins over budget: too-big beats daily-budget', () => {
    const decision = evaluateAdmission(
      item,
      ctx({
        settings: { ...allOff, maxFileSizeBytes: 1, dailyMaxCount: 1 },
        sizeBytes: 5_000_000,
        running: { bytes: 0, count: 0 },
      }),
    )
    expect(decision).toEqual({ admit: false, reason: 'too-big' })
  })

  it('returns the size reason when only the size cap is crossed', () => {
    const decision = evaluateAdmission(
      item,
      ctx({ settings: { ...allOff, maxFileSizeBytes: 1 }, sizeBytes: 5_000_000 }),
    )
    expect(decision).toEqual({ admit: false, reason: 'too-big' })
  })

  it('returns the budget reason when only the daily budget is crossed', () => {
    const decision = evaluateAdmission(
      item,
      ctx({
        settings: { ...allOff, dailyMaxCount: 1 },
        sizeBytes: 100,
        running: { bytes: 0, count: 1 },
      }),
    )
    expect(decision).toEqual({ admit: false, reason: 'daily-budget' })
  })

  it('counts a null sizeBytes as zero bytes toward the budget', () => {
    const decision = evaluateAdmission(
      item,
      ctx({
        settings: { ...allOff, dailyMaxCount: 1 },
        sizeBytes: null,
        running: { bytes: 0, count: 1 },
      }),
    )
    expect(decision).toEqual({ admit: false, reason: 'daily-budget' })
  })
})
