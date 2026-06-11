import { describe, it, expect } from 'vitest'
import {
  mediaKey,
  recordKey,
  hasKey,
  markSaved,
  filterUnsaved,
  decodeLedger,
  emptyLedger,
  LEDGER_CAP,
} from './ledger'

describe('mediaKey', () => {
  it('lowercases the host but preserves path case (twimg keys are case-sensitive)', () => {
    expect(mediaKey('https://PBS.twimg.com/media/AbC.jpg?name=orig')).toBe(
      'pbs.twimg.com/media/AbC',
    )
  })

  it('drops query + fragment and a trailing extension; two URL shapes collapse', () => {
    const a = mediaKey('https://PBS.twimg.com/media/AbC.jpg?name=orig')
    const b = mediaKey('https://pbs.twimg.com/media/AbC?format=jpg&name=orig')
    expect(a).toBe(b)
    expect(a).toBe('pbs.twimg.com/media/AbC')
  })

  it('drops a #fragment as well as the query', () => {
    expect(mediaKey('https://pbs.twimg.com/media/AbC.jpg#frag')).toBe('pbs.twimg.com/media/AbC')
  })

  it('strips the trailing extension only when it is 1-5 alphanumerics', () => {
    // .jpg => stripped
    expect(mediaKey('https://h.test/a/b.jpg')).toBe('h.test/a/b')
    // 6-char "extension" => not an extension, kept
    expect(mediaKey('https://h.test/a/file.abcdef')).toBe('h.test/a/file.abcdef')
    // non-alnum extension => kept
    expect(mediaKey('https://h.test/a/file.tar-gz')).toBe('h.test/a/file.tar-gz')
    // alnum 4 => stripped
    expect(mediaKey('https://h.test/clip.webm'.replace('webm', 'mp4a'))).toBe('h.test/clip')
  })

  it('only strips the extension on the LAST segment, leaving dotted dirs alone', () => {
    expect(mediaKey('https://h.test/v1.2/AbC.jpg')).toBe('h.test/v1.2/AbC')
  })

  it('falls back to the trimmed string for non-URL input', () => {
    expect(mediaKey('  tweet:42:record  ')).toBe('tweet:42:record')
    expect(mediaKey('not a url')).toBe('not a url')
  })
})

describe('recordKey', () => {
  it('formats as tweet:{id}:record', () => {
    expect(recordKey('1790')).toBe('tweet:1790:record')
  })
})

describe('emptyLedger / hasKey', () => {
  it('emptyLedger has no entries', () => {
    expect(emptyLedger().entries).toEqual([])
  })

  it('hasKey reflects membership', () => {
    const l = markSaved(emptyLedger(), ['k1'], 100)
    expect(hasKey(l, 'k1')).toBe(true)
    expect(hasKey(l, 'k2')).toBe(false)
  })
})

describe('markSaved', () => {
  it('appends new entries in given order with the supplied timestamp', () => {
    const l = markSaved(emptyLedger(), ['a', 'b', 'c'], 50)
    expect(l.entries.map((e) => e.key)).toEqual(['a', 'b', 'c'])
    expect(l.entries.every((e) => e.savedAt === 50)).toBe(true)
  })

  it('keeps the original savedAt when a key is re-marked (idempotent)', () => {
    const first = markSaved(emptyLedger(), ['x'], 100)
    const second = markSaved(first, ['x'], 999)
    const entry = second.entries.find((e) => e.key === 'x')!
    expect(second.entries).toHaveLength(1)
    expect(entry.savedAt).toBe(100)
  })

  it('collapses intra-call duplicate keys to a single entry', () => {
    const l = markSaved(emptyLedger(), ['dup', 'dup', 'other', 'dup'], 7)
    expect(l.entries.map((e) => e.key)).toEqual(['dup', 'other'])
  })

  it('never mutates its input ledger or the keys array', () => {
    const original = markSaved(emptyLedger(), ['a'], 1)
    const beforeLen = original.entries.length
    const keys = ['b', 'c']
    markSaved(original, keys, 2)
    expect(original.entries.length).toBe(beforeLen)
    expect(original.entries.map((e) => e.key)).toEqual(['a'])
    expect(keys).toEqual(['b', 'c'])
  })

  it('drops the OLDEST entries when overflowing LEDGER_CAP', () => {
    expect(LEDGER_CAP).toBe(5000)
    const seed = Array.from({ length: LEDGER_CAP }, (_, i) => `seed-${i}`)
    const full = markSaved(emptyLedger(), seed, 1)
    expect(full.entries).toHaveLength(LEDGER_CAP)

    const over = markSaved(full, ['fresh-a', 'fresh-b'], 2)
    expect(over.entries).toHaveLength(LEDGER_CAP)
    // oldest two seeds evicted, newest kept at the tail
    expect(hasKey(over, 'seed-0')).toBe(false)
    expect(hasKey(over, 'seed-1')).toBe(false)
    expect(hasKey(over, 'seed-2')).toBe(true)
    expect(over.entries[LEDGER_CAP - 1]!.key).toBe('fresh-b')
    expect(over.entries[LEDGER_CAP - 2]!.key).toBe('fresh-a')
  })
})

describe('filterUnsaved', () => {
  it('drops items whose key is already in the ledger', () => {
    const ledger = markSaved(emptyLedger(), ['k:1'], 0)
    const items = [{ k: 'k:1' }, { k: 'k:2' }, { k: 'k:3' }]
    const out = filterUnsaved(ledger, items, (i) => i.k)
    expect(out.map((i) => i.k)).toEqual(['k:2', 'k:3'])
  })

  it('drops intra-batch duplicates keeping the first occurrence', () => {
    const items = [
      { k: 'a', tag: 1 },
      { k: 'a', tag: 2 },
      { k: 'b', tag: 3 },
    ]
    const out = filterUnsaved(emptyLedger(), items, (i) => i.k)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ k: 'a', tag: 1 })
    expect(out[1]).toMatchObject({ k: 'b', tag: 3 })
  })

  it('combines ledger membership and intra-batch dedupe', () => {
    const ledger = markSaved(emptyLedger(), ['saved'], 0)
    const items = [{ k: 'saved' }, { k: 'new' }, { k: 'new' }, { k: 'saved' }]
    const out = filterUnsaved(ledger, items, (i) => i.k)
    expect(out.map((i) => i.k)).toEqual(['new'])
  })
})

describe('decodeLedger', () => {
  it('round-trips a well-formed ledger', () => {
    const good = {
      entries: [
        { key: 'a', savedAt: 1 },
        { key: 'b', savedAt: 2 },
      ],
    }
    const out = decodeLedger(good)
    expect(out.entries.map((e) => e.key)).toEqual(['a', 'b'])
    expect(out.entries[0]!.savedAt).toBe(1)
  })

  it('falls back to emptyLedger for garbage (corrupt-recovery)', () => {
    expect(decodeLedger(null).entries).toEqual([])
    expect(decodeLedger(undefined).entries).toEqual([])
    expect(decodeLedger('nope').entries).toEqual([])
    expect(decodeLedger(42).entries).toEqual([])
    expect(decodeLedger({ entries: 'not-array' }).entries).toEqual([])
    expect(decodeLedger({ entries: [{ key: 5, savedAt: 'x' }] }).entries).toEqual([])
    expect(decodeLedger({ entries: [{ key: 'ok' }] }).entries).toEqual([])
  })
})
