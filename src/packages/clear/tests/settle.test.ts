import { describe, it, expect } from 'vitest'
import { decideSettle, didLand, type DownloadProbe } from '../settle'

describe('didLand (the byte-landed predicate)', () => {
  it('complete + exists:true → landed', () => {
    expect(didLand({ state: 'complete', exists: true })).toBe(true)
  })

  it('complete + exists undefined → landed (browser reported no deletion)', () => {
    expect(didLand({ state: 'complete' })).toBe(true)
  })

  it('complete + exists:false → NOT landed (file vanished after completing)', () => {
    expect(didLand({ state: 'complete', exists: false })).toBe(false)
  })

  it('interrupted → NOT landed', () => {
    expect(didLand({ state: 'interrupted', exists: true })).toBe(false)
  })

  it('in_progress → NOT landed', () => {
    expect(didLand({ state: 'in_progress' })).toBe(false)
  })

  it('an empty/unknown row → NOT landed', () => {
    expect(didLand({})).toBe(false)
  })

  it('no probe at all (search found nothing, or threw and the adapter swallowed it) → NOT landed', () => {
    expect(didLand(undefined)).toBe(false)
  })
})

describe('decideSettle (verdict on the irreversible Clear)', () => {
  const landed: DownloadProbe[] = [{ state: 'complete', exists: true }, { state: 'complete' }]
  const notLanded: Array<DownloadProbe | undefined> = [
    { state: 'complete', exists: false },
    { state: 'interrupted', exists: true },
    { state: 'in_progress' },
    {},
    undefined,
  ]

  it.each(landed)('a landed probe settles: %o', (probe) => {
    expect(decideSettle(probe)).toBe('settle')
  })

  it.each(notLanded)('anything unconfirmed is a late interrupt (fail closed): %o', (probe) => {
    expect(decideSettle(probe)).toBe('lateInterrupt')
  })
})
