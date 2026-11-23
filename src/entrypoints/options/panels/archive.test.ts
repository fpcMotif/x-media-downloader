import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Source-grep pin (house idiom — see capture-quick-actions.test.ts).
const source = readFileSync(fileURLToPath(import.meta.resolve('./archive.tsx')), 'utf8')

describe('ArchivePanel status flash owns its timer', () => {
  it('flashes through one owned timer, which cancels on rearm and unmount', () => {
    expect(source).toContain('const statusTimer = useOwnedTimer()')
    expect(source).toContain('statusTimer.arm(() => setStatusMsg(null), 5000)')
  })
})

describe('ArchivePanel search', () => {
  it('searches through the worker', () => {
    expect(source).toContain('fetchCaptureSearch(wanted, ARCHIVE_FETCH_LIMIT)')
    expect(source).toContain('const searchTimer = useOwnedTimer()')
    expect(source).not.toContain('loaded.filter(')
  })

  it('guards searchArchive completion with a monotonic sequence number across Refresh and empty clears', () => {
    expect(source).toContain('const searchSeq = useRef(0)')
    const searchFnStart = source.indexOf('const searchArchive = (text: string): void => {')
    const seqIncIdx = source.indexOf('const seq = ++searchSeq.current', searchFnStart)
    const emptyReturnIdx = source.indexOf("if (wanted === '') {", searchFnStart)
    const guardIdx = source.indexOf(
      'if (searchSeq.current !== seq || latestNeedle.current !== wanted) return',
      searchFnStart,
    )
    expect(searchFnStart).toBeGreaterThan(-1)
    expect(seqIncIdx).toBeGreaterThan(searchFnStart)
    expect(emptyReturnIdx).toBeGreaterThan(seqIncIdx)
    expect(guardIdx).toBeGreaterThan(emptyReturnIdx)
  })
})
