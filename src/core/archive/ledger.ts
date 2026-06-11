import { Schema } from 'effect'

/**
 * Idempotency ledger (ADR-0010). A capped, append-ordered set of canonical
 * "already saved" keys persisted in `storage.local`. The job plans only work
 * whose key is absent, so re-runs across sessions/restarts download nothing
 * twice. Pure: every function returns a new value, never mutating its input.
 */

export interface LedgerEntry {
  readonly key: string
  readonly savedAt: number
}

/** Entries oldest → newest (append order); overflow drops from the front. */
export interface Ledger {
  readonly entries: ReadonlyArray<LedgerEntry>
}

export const LEDGER_CAP = 5000

const LedgerSchema = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ key: Schema.String, savedAt: Schema.Number })),
})

export function emptyLedger(): Ledger {
  return { entries: [] }
}

/**
 * Canonicalize a media URL into a stable key: lowercase host, PATH CASE
 * PRESERVED (twimg media keys are case-sensitive), query+fragment dropped, and
 * a trailing `.{1-5 alphanumeric}` extension stripped from the last path
 * segment. Non-URL input falls back to its trimmed self.
 */
export function mediaKey(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url.trim()
  }
  // Only http(s) media URLs are canonicalized; other schemes (e.g. a
  // `tweet:…:record` ledger key passed through) fall back to the trimmed input.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return url.trim()
  const host = parsed.hostname.toLowerCase()
  const segments = parsed.pathname.split('/')
  const last = segments[segments.length - 1] ?? ''
  segments[segments.length - 1] = last.replace(/\.[A-Za-z0-9]{1,5}$/, '')
  return `${host}${segments.join('/')}`
}

/** Ledger key for a tweet's archive record (distinct from its media keys). */
export function recordKey(tweetId: string): string {
  return `tweet:${tweetId}:record`
}

export function hasKey(ledger: Ledger, key: string): boolean {
  return ledger.entries.some((e) => e.key === key)
}

/**
 * Mark keys saved at `at`. Existing keys keep their original `savedAt`
 * (idempotent); duplicates within one call collapse to one entry; new keys
 * append in order; overflow beyond {@link LEDGER_CAP} drops the oldest.
 */
export function markSaved(ledger: Ledger, keys: ReadonlyArray<string>, at: number): Ledger {
  const known = new Set(ledger.entries.map((e) => e.key))
  const appended: LedgerEntry[] = []
  const addedThisCall = new Set<string>()
  for (const key of keys) {
    if (known.has(key) || addedThisCall.has(key)) continue
    addedThisCall.add(key)
    appended.push({ key, savedAt: at })
  }
  const entries = [...ledger.entries, ...appended]
  const overflow = entries.length - LEDGER_CAP
  return { entries: overflow > 0 ? entries.slice(overflow) : entries }
}

/**
 * Drop items whose key is already in the ledger, and intra-batch duplicates
 * (first occurrence wins). Order is preserved; the input is not mutated.
 */
export function filterUnsaved<T>(
  ledger: Ledger,
  items: ReadonlyArray<T>,
  keyOf: (t: T) => string,
): T[] {
  const known = new Set(ledger.entries.map((e) => e.key))
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = keyOf(item)
    if (known.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

/** Decode a stored ledger; corrupt/garbage data recovers to an empty ledger. */
export function decodeLedger(raw: unknown): Ledger {
  try {
    return Schema.decodeUnknownSync(LedgerSchema)(raw ?? { entries: [] })
  } catch {
    return emptyLedger()
  }
}
