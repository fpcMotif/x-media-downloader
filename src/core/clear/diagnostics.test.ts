import { describe, it, expect } from 'vitest'
import type { DownloadTraceEntry } from '../schema'
import {
  RELEASE_DIAGNOSTICS_CAP,
  isReleaseDiagnosticsEvent,
  appendReleaseDiagnostics,
  decodeReleaseDiagnostics,
  composeDiagnosticsExport,
} from './diagnostics'

const ev = (over: Partial<DownloadTraceEntry> & { stage: string }): DownloadTraceEntry => ({
  source: 'background',
  t: 1_700_000_000_000,
  ...over,
})

describe('isReleaseDiagnosticsEvent', () => {
  it('is true for an overlay-reported clear event regardless of stage name', () => {
    expect(isReleaseDiagnosticsEvent(ev({ source: 'clear', stage: 'drain-tick' }))).toBe(true)
  })

  it('is true for a background clear-session event (clear- stage prefix)', () => {
    expect(isReleaseDiagnosticsEvent(ev({ source: 'background', stage: 'clear-claim' }))).toBe(true)
  })

  it('is false for an unrelated background trace line (no clear- prefix)', () => {
    expect(isReleaseDiagnosticsEvent(ev({ source: 'background', stage: 'download-start' }))).toBe(
      false,
    )
  })

  it('is false for an unrelated quickgrab/badge event', () => {
    expect(isReleaseDiagnosticsEvent(ev({ source: 'quickgrab', stage: 'grab' }))).toBe(false)
    expect(isReleaseDiagnosticsEvent(ev({ source: 'badge', stage: 'save' }))).toBe(false)
  })

  it('is true whenever the stage carries the clear- prefix, even off the two named producers', () => {
    // The predicate is a stage-prefix test, not a source allowlist — a future
    // producer that reuses a 'clear-*' stage name lands in the log too.
    expect(isReleaseDiagnosticsEvent(ev({ source: 'quickgrab', stage: 'clear-list-start' }))).toBe(
      true,
    )
  })
})

describe('appendReleaseDiagnostics', () => {
  it('appends in order under the cap', () => {
    let log: ReadonlyArray<DownloadTraceEntry> = []
    log = appendReleaseDiagnostics(log, ev({ stage: 'clear-claim', t: 1 }))
    log = appendReleaseDiagnostics(log, ev({ stage: 'clear-resolve', t: 2 }))
    expect(log.map((e) => e.stage)).toEqual(['clear-claim', 'clear-resolve'])
  })

  it('ring-evicts the oldest beyond the cap, preserving order', () => {
    let log: ReadonlyArray<DownloadTraceEntry> = []
    for (let i = 0; i < 5; i++) {
      log = appendReleaseDiagnostics(log, ev({ stage: `s${i}`, t: i }), 3)
    }
    expect(log.map((e) => e.stage)).toEqual(['s2', 's3', 's4'])
  })

  it('defaults the cap to RELEASE_DIAGNOSTICS_CAP', () => {
    let log: ReadonlyArray<DownloadTraceEntry> = []
    for (let i = 0; i < RELEASE_DIAGNOSTICS_CAP + 10; i++) {
      log = appendReleaseDiagnostics(log, ev({ stage: `s${i}`, t: i }))
    }
    expect(log).toHaveLength(RELEASE_DIAGNOSTICS_CAP)
    expect(log[0]?.stage).toBe(`s${10}`)
    expect(log[log.length - 1]?.stage).toBe(`s${RELEASE_DIAGNOSTICS_CAP + 9}`)
  })
})

describe('decodeReleaseDiagnostics', () => {
  it('round-trips a valid log', () => {
    const log = [ev({ stage: 'clear-claim', t: 1 }), ev({ stage: 'clear-resolve', t: 2 })]
    expect(decodeReleaseDiagnostics(log)).toEqual(log)
  })

  it('falls back to [] for a wholly corrupt value', () => {
    expect(decodeReleaseDiagnostics('garbage')).toEqual([])
    expect(decodeReleaseDiagnostics(null)).toEqual([])
    expect(decodeReleaseDiagnostics(undefined)).toEqual([])
    expect(decodeReleaseDiagnostics({ not: 'an array' })).toEqual([])
  })

  it('falls back the WHOLE array to [] when one element is corrupt (mirrors decodeStore)', () => {
    const log = [ev({ stage: 'clear-claim', t: 1 }), { nope: true }]
    expect(decodeReleaseDiagnostics(log)).toEqual([])
  })
})

describe('composeDiagnosticsExport', () => {
  it('returns ok:false for an empty log', () => {
    expect(composeDiagnosticsExport([], Date.parse('2026-07-05T12:34:56.000Z'))).toEqual({
      ok: false,
      filename: '',
      text: '',
    })
  })

  it('composes JSONL (one entry per line, trailing newline) that round-trips via JSON.parse', () => {
    const entries = [ev({ stage: 'clear-claim', t: 1 }), ev({ stage: 'clear-resolve', t: 2 })]
    const result = composeDiagnosticsExport(entries, Date.parse('2026-07-05T12:34:56.000Z'))
    expect(result.ok).toBe(true)
    expect(result.text.endsWith('\n')).toBe(true)
    const lines = result.text.trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => JSON.parse(l))).toEqual(entries)
  })

  it('derives the filename from `now` in UTC as xmd-release-diagnostics-YYYY-MM-DD-HHmm.jsonl', () => {
    const entries = [ev({ stage: 'clear-claim', t: 1 })]
    const result = composeDiagnosticsExport(entries, Date.parse('2026-07-05T12:34:56.000Z'))
    expect(result.filename).toBe('xmd-release-diagnostics-2026-07-05-1234.jsonl')
  })

  it('uses UTC, not local time, for the filename stamp', () => {
    // A timestamp whose UTC date differs from most local timezones' date would
    // expose a local-time bug; pin UTC explicitly instead of relying on the runner's TZ.
    const entries = [ev({ stage: 'clear-claim', t: 1 })]
    const result = composeDiagnosticsExport(entries, Date.parse('2026-01-01T00:05:00.000Z'))
    expect(result.filename).toBe('xmd-release-diagnostics-2026-01-01-0005.jsonl')
  })
})
