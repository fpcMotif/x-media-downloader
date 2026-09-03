import { describe, it, expect } from 'vitest'
import type { DownloadTraceEntry, JsonValue } from '@/packages/schema'
import {
  RELEASE_DIAGNOSTICS_CAP,
  EMPTY_RELEASE_DIAGNOSTICS,
  type ReleaseDiagnosticsLog,
  isReleaseDiagnosticsEvent,
  appendReleaseDiagnostics,
  appendManyReleaseDiagnostics,
  decodeReleaseDiagnostics,
  composeDiagnosticsExport,
  formatTraceLabel,
} from '../diagnostics'

const ev = (over: Partial<DownloadTraceEntry> & { stage: string }): DownloadTraceEntry => ({
  source: 'background',
  t: 1_700_000_000_000,
  ...over,
})

const logOf = (
  events: ReadonlyArray<DownloadTraceEntry>,
  counters: Partial<Omit<ReleaseDiagnosticsLog, 'events'>> = {},
): ReleaseDiagnosticsLog => ({ ...EMPTY_RELEASE_DIAGNOSTICS, events, ...counters })

/** What the background's storage round-trip does to a log between writes. */
const persist = (log: ReleaseDiagnosticsLog): JsonValue => JSON.parse(JSON.stringify(log))

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
  it('appends in order under the cap, counting appends and evicting nothing', () => {
    let log = EMPTY_RELEASE_DIAGNOSTICS
    log = appendReleaseDiagnostics(log, ev({ stage: 'clear-claim', t: 1 }))
    log = appendReleaseDiagnostics(log, ev({ stage: 'clear-resolve', t: 2 }))
    expect(log.events.map((e) => e.stage)).toEqual(['clear-claim', 'clear-resolve'])
    expect(log.appended).toBe(2)
    expect(log.evicted).toBe(0)
  })

  it('ring-evicts the oldest beyond the cap, preserving order and booking one eviction each', () => {
    let log = EMPTY_RELEASE_DIAGNOSTICS
    for (let i = 0; i < 5; i++) {
      log = appendReleaseDiagnostics(log, ev({ stage: `s${i}`, t: i }), 3)
    }
    expect(log.events.map((e) => e.stage)).toEqual(['s2', 's3', 's4'])
    expect(log.appended).toBe(5)
    expect(log.evicted).toBe(2)
  })

  it('carries the decode-drop count through unchanged — only a decode ever drops entries', () => {
    const log = appendReleaseDiagnostics(logOf([], { decodeDropped: 4 }), ev({ stage: 'clear-x' }))
    expect(log.decodeDropped).toBe(4)
  })

  it('defaults the cap to RELEASE_DIAGNOSTICS_CAP', () => {
    let log = EMPTY_RELEASE_DIAGNOSTICS
    for (let i = 0; i < RELEASE_DIAGNOSTICS_CAP + 10; i++) {
      log = appendReleaseDiagnostics(log, ev({ stage: `s${i}`, t: i }))
    }
    expect(log.events).toHaveLength(RELEASE_DIAGNOSTICS_CAP)
    expect(log.events[0]?.stage).toBe(`s10`)
    expect(log.events[log.events.length - 1]?.stage).toBe(`s${RELEASE_DIAGNOSTICS_CAP + 9}`)
    expect(log.appended).toBe(RELEASE_DIAGNOSTICS_CAP + 10)
    expect(log.evicted).toBe(10)
  })

  it('holds a whole 50-post Bookmarks run at the default cap (the regression that motivated 1000)', () => {
    // ~7 events per released post: 50 posts ≈ 350 events, which the old 200 cap
    // could not hold — the run's opening events were gone before any export.
    let log = EMPTY_RELEASE_DIAGNOSTICS
    for (let i = 0; i < 350; i++) log = appendReleaseDiagnostics(log, ev({ stage: `s${i}`, t: i }))
    expect(log.evicted).toBe(0)
    expect(log.events[0]?.stage).toBe('s0')
  })
})

describe('appendManyReleaseDiagnostics', () => {
  it('folds N events in one pass with correct append/eviction accounting', () => {
    const batch = Array.from({ length: 5 }, (_, i) => ev({ stage: `s${i}`, t: i }))
    const log = appendManyReleaseDiagnostics(logOf([ev({ stage: 'old', t: -1 })]), batch, 3)
    expect(log.events.map((e) => e.stage)).toEqual(['s2', 's3', 's4'])
    expect(log.appended).toBe(5)
    expect(log.evicted).toBe(3)
  })

  it('books the same totals as the equivalent one-at-a-time appends', () => {
    const batch = Array.from({ length: 7 }, (_, i) => ev({ stage: `s${i}`, t: i }))
    let looped = EMPTY_RELEASE_DIAGNOSTICS
    for (const e of batch) looped = appendReleaseDiagnostics(looped, e, 4)
    const folded = appendManyReleaseDiagnostics(EMPTY_RELEASE_DIAGNOSTICS, batch, 4)
    expect(folded).toEqual(looped)
  })

  it('evicts nothing below the cap', () => {
    const log = appendManyReleaseDiagnostics(
      logOf([ev({ stage: 'a', t: 1 })]),
      [ev({ stage: 'b', t: 2 })],
      10,
    )
    expect(log.events.map((e) => e.stage)).toEqual(['a', 'b'])
    expect(log.evicted).toBe(0)
  })

  it('returns the same object for an empty batch so the caller can skip the write', () => {
    const before = logOf([ev({ stage: 'a', t: 1 })], { appended: 1 })
    expect(appendManyReleaseDiagnostics(before, [])).toBe(before)
  })

  it('defaults the cap to RELEASE_DIAGNOSTICS_CAP', () => {
    const batch = Array.from({ length: RELEASE_DIAGNOSTICS_CAP + 5 }, (_, i) =>
      ev({ stage: `s${i}`, t: i }),
    )
    const log = appendManyReleaseDiagnostics(EMPTY_RELEASE_DIAGNOSTICS, batch)
    expect(log.events).toHaveLength(RELEASE_DIAGNOSTICS_CAP)
    expect(log.evicted).toBe(5)
    expect(log.appended).toBe(RELEASE_DIAGNOSTICS_CAP + 5)
  })
})

describe('decodeReleaseDiagnostics', () => {
  it('lifts a LEGACY bare array (already persisted by pre-wrapper builds) without losing events', () => {
    const events = [ev({ stage: 'clear-claim', t: 1 }), ev({ stage: 'clear-resolve', t: 2 })]
    expect(decodeReleaseDiagnostics(events)).toEqual({
      events,
      evicted: 0,
      appended: events.length,
      decodeDropped: 0,
    })
  })

  it('round-trips a wrapper, preserving its counters', () => {
    const log = logOf([ev({ stage: 'clear-claim', t: 1 })], { evicted: 12, appended: 40 })
    expect(decodeReleaseDiagnostics(JSON.parse(JSON.stringify(log)))).toEqual(log)
  })

  it('falls back a non-integer/absent counter without discarding the events', () => {
    const decoded = decodeReleaseDiagnostics({
      events: [ev({ stage: 'clear-claim', t: 1 })],
      evicted: 'lots',
      appended: Number.NaN,
    })
    expect(decoded.events).toHaveLength(1)
    expect(decoded.evicted).toBe(0)
    expect(decoded.appended).toBe(1)
    expect(decodeReleaseDiagnostics({ events: [] }).appended).toBe(0)
  })

  it('falls back to the zero state for a wholly corrupt value', () => {
    expect(decodeReleaseDiagnostics('garbage')).toEqual(EMPTY_RELEASE_DIAGNOSTICS)
    expect(decodeReleaseDiagnostics(null)).toEqual(EMPTY_RELEASE_DIAGNOSTICS)
    expect(decodeReleaseDiagnostics(undefined)).toEqual(EMPTY_RELEASE_DIAGNOSTICS)
    expect(decodeReleaseDiagnostics({ not: 'an array' })).toEqual(EMPTY_RELEASE_DIAGNOSTICS)
    expect(decodeReleaseDiagnostics({ events: 'not an array' })).toEqual(EMPTY_RELEASE_DIAGNOSTICS)
  })

  it('drops ONLY the corrupt element and reports it (a bad entry must not wipe the log)', () => {
    const good = [ev({ stage: 'clear-claim', t: 1 }), ev({ stage: 'clear-resolve', t: 2 })]
    const decoded = decodeReleaseDiagnostics([good[0]!, { nope: true }, good[1]!])
    expect(decoded.events).toEqual(good)
    expect(decoded.decodeDropped).toBe(1)
    expect(decoded.appended).toBe(2)
  })

  it('reports element-wise drops inside a wrapper too', () => {
    const decoded = decodeReleaseDiagnostics({
      events: [ev({ stage: 'clear-claim', t: 1 }), 42],
      evicted: 3,
      appended: 9,
    })
    expect(decoded.events).toHaveLength(1)
    expect(decoded.decodeDropped).toBe(1)
    expect(decoded.evicted).toBe(3)
    expect(decoded.appended).toBe(9)
  })

  it('ACCUMULATES drops onto the persisted count rather than replacing it', () => {
    const decoded = decodeReleaseDiagnostics({
      events: [ev({ stage: 'clear-claim', t: 1 }), 42],
      decodeDropped: 5,
    })
    expect(decoded.decodeDropped).toBe(6)
  })

  it('is idempotent for a clean re-decode — carrying the count must not inflate it', () => {
    const raw = { events: [ev({ stage: 'clear-claim', t: 1 })], decodeDropped: 5 }
    expect(decodeReleaseDiagnostics(raw).decodeDropped).toBe(5)
    expect(decodeReleaseDiagnostics(raw).decodeDropped).toBe(5)
  })

  it('degrades a corrupt persisted drop count without losing this decode’s own drops', () => {
    const decoded = decodeReleaseDiagnostics({
      events: [ev({ stage: 'clear-claim', t: 1 }), 42],
      decodeDropped: 'lots',
    })
    expect(decoded.decodeDropped).toBe(1)
  })
})

// The background never decodes in isolation: `recordTrace` runs decode -> append -> set
// on EVERY clear trace event, and the export handler then does a FRESH decode of what
// that RMW persisted. A drop count that described only the latest decode was erased by
// the next trace event, so every export read decodeDropped=0 and the lost entries were
// silently reattributed to the refused-writes gap.
describe('decode/append/export cycle (the real background flow)', () => {
  it('surfaces a decode drop in the export even after later appends re-persist the log', () => {
    const stored = {
      events: [ev({ stage: 'clear-seeded', t: 1 }), { nope: 'corrupt' }],
      evicted: 0,
      appended: 2,
    }
    // recordTrace fires: decode -> append -> set. The corrupt element is pruned here.
    let raw = persist(
      appendReleaseDiagnostics(
        decodeReleaseDiagnostics(stored),
        ev({ stage: 'clear-claim', t: 2 }),
      ),
    )
    // ...and a few more events land, each one re-persisting the pruned window.
    for (let i = 3; i < 8; i++) {
      raw = persist(
        appendReleaseDiagnostics(decodeReleaseDiagnostics(raw), ev({ stage: `clear-s${i}`, t: i })),
      )
    }
    const meta = JSON.parse(
      composeDiagnosticsExport(
        decodeReleaseDiagnostics(raw),
        Date.parse('2026-07-05T12:34:56.000Z'),
      ).text.split('\n')[0] ?? '',
    )
    expect(meta.detail).toContain('decodeDropped=1')
  })

  it('keeps the counters a partition of every event offered, so each loss is attributable', () => {
    // 10 offered, 1 came back corrupt, and the ring evicted down to a cap of 4.
    const stored = {
      events: [
        ...Array.from({ length: 4 }, (_, i) => ev({ stage: `clear-s${i}`, t: i })),
        { bad: 1 },
      ],
      evicted: 5,
      appended: 10,
    }
    const log = decodeReleaseDiagnostics(stored)
    expect(log.appended - log.events.length - log.evicted - log.decodeDropped).toBe(0)
    // One more event lands; the partition still balances (nothing refused).
    const next = decodeReleaseDiagnostics(
      persist(appendReleaseDiagnostics(log, ev({ stage: 'clear-claim', t: 9 }), 4)),
    )
    expect(next.appended - next.events.length - next.evicted - next.decodeDropped).toBe(0)
  })

  it('attributes a genuinely refused write to the remainder, not to eviction or corruption', () => {
    // appended ran ahead of what stuck: 300 offered, 1 present, nothing evicted or corrupt.
    const log = decodeReleaseDiagnostics({
      events: [ev({ stage: 'clear-claim', t: 1 })],
      evicted: 0,
      appended: 300,
      decodeDropped: 0,
    })
    expect(log.appended - log.events.length - log.evicted - log.decodeDropped).toBe(299)
  })
})

describe('composeDiagnosticsExport', () => {
  it('returns ok:false for an empty log', () => {
    expect(
      composeDiagnosticsExport(EMPTY_RELEASE_DIAGNOSTICS, Date.parse('2026-07-05T12:34:56.000Z')),
    ).toEqual({ ok: false, filename: '', text: '' })
  })

  it('composes JSONL (one entry per line, trailing newline) that round-trips via JSON.parse', () => {
    const events = [ev({ stage: 'clear-claim', t: 1 }), ev({ stage: 'clear-resolve', t: 2 })]
    const result = composeDiagnosticsExport(logOf(events), Date.parse('2026-07-05T12:34:56.000Z'))
    expect(result.ok).toBe(true)
    expect(result.text.endsWith('\n')).toBe(true)
    const lines = result.text.trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.slice(1).map((l) => JSON.parse(l))).toEqual(events)
  })

  it('prepends a clear-export-meta line that is valid JSON and a Release event itself', () => {
    const now = Date.parse('2026-07-05T12:34:56.000Z')
    const result = composeDiagnosticsExport(
      logOf([ev({ stage: 'clear-claim', t: 1 }), ev({ stage: 'clear-resolve', t: 2 })], {
        evicted: 137,
        appended: 600,
        decodeDropped: 2,
      }),
      now,
    )
    const meta = JSON.parse(result.text.split('\n')[0] ?? '')
    expect(meta).toEqual({
      source: 'clear',
      stage: 'clear-export-meta',
      t: now,
      detail: `entries=2 evicted=137 appended=600 decodeDropped=2 cap=${RELEASE_DIAGNOSTICS_CAP} clears=0 clearsTestid=0 clearsDetached=0 clearsAlreadyCleared=0 mutations=0 serverRejects=0 reAddFingerprints=0 reappearances=0`,
    })
    // Nothing downstream may have to special-case the meta line: it must pass the
    // same predicate that admitted every other line into the log.
    expect(isReleaseDiagnosticsEvent(meta)).toBe(true)
  })

  it('the meta line carries the ticket #65/#66 mismatch counters, derived from the events in THIS export', () => {
    const events = [
      ev({ stage: 'clear-flip', tweetId: '1', detail: 'scope=bookmark arm=testid origin=settle' }),
      ev({
        stage: 'clear-mutation',
        tweetId: '1',
        detail: 'op=DeleteBookmark status=403 error=true',
      }),
      ev({ stage: 'clear-server-reject', tweetId: '1' }),
      ev({ stage: 'clear-re-add-fingerprint', tweetId: '2' }),
      ev({ stage: 'clear-reappeared', tweetId: '1' }),
    ]
    const result = composeDiagnosticsExport(logOf(events), Date.parse('2026-07-05T12:34:56.000Z'))
    expect(result.text.split('\n')[0]).toContain(
      'clears=1 clearsTestid=1 clearsDetached=0 clearsAlreadyCleared=0 mutations=1 serverRejects=1 reAddFingerprints=1 reappearances=1',
    )
  })

  it('exposes refused writes: appended exceeding entries+evicted is the storage-loss tell', () => {
    const result = composeDiagnosticsExport(
      logOf([ev({ stage: 'clear-claim', t: 1 })], { evicted: 0, appended: 300 }),
      Date.parse('2026-07-05T12:34:56.000Z'),
    )
    expect(result.text.split('\n')[0]).toContain('entries=1 evicted=0 appended=300')
  })

  it('derives the filename from `now` in UTC as xmd-release-diagnostics-YYYY-MM-DD-HHmm.jsonl', () => {
    const result = composeDiagnosticsExport(
      logOf([ev({ stage: 'clear-claim', t: 1 })]),
      Date.parse('2026-07-05T12:34:56.000Z'),
    )
    expect(result.filename).toBe('xmd-release-diagnostics-2026-07-05-1234.jsonl')
  })

  it('uses UTC, not local time, for the filename stamp', () => {
    // A timestamp whose UTC date differs from most local timezones' date would
    // expose a local-time bug; pin UTC explicitly instead of relying on the runner's TZ.
    const result = composeDiagnosticsExport(
      logOf([ev({ stage: 'clear-claim', t: 1 })]),
      Date.parse('2026-01-01T00:05:00.000Z'),
    )
    expect(result.filename).toBe('xmd-release-diagnostics-2026-01-01-0005.jsonl')
  })
})

describe('formatTraceLabel', () => {
  it('renders tab= and post= tokens when tabId and tweetId are present', () => {
    const label = formatTraceLabel(ev({ stage: 'clear-release-poll', tabId: 77, tweetId: '12345' }))
    expect(label).toContain('tab=77')
    expect(label).toContain('post=12345')
  })

  it('gains no empty token when tabId and tweetId are absent', () => {
    const label = formatTraceLabel(ev({ stage: 'clear-claim' }))
    expect(label).not.toMatch(/tab=/)
    expect(label).not.toMatch(/post=/)
    expect(label).not.toMatch(/ {2}/)
  })

  it('renders elapsedMs as `<n>ms` only when defined', () => {
    expect(formatTraceLabel(ev({ stage: 'clear-claim', elapsedMs: 42 }))).toContain('42ms')
    expect(formatTraceLabel(ev({ stage: 'clear-claim' }))).not.toMatch(/ms/)
  })

  it('orders fields as [stage, type, itemId, tab=, post=, elapsedMs, detail]', () => {
    const label = formatTraceLabel(
      ev({
        stage: 'clear-release-poll',
        type: 'photo',
        itemId: 'item-1',
        tabId: 5,
        tweetId: '999',
        elapsedMs: 10,
        detail: 'reason=mounted',
      }),
    )
    expect(label).toBe('clear-release-poll photo item-1 tab=5 post=999 10ms reason=mounted')
  })
})
