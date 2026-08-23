/**
 * Byte and concurrency ceilings for the MAIN-world passive tee.
 *
 * The tee (`entrypoints/inject.content.ts`) copies the page's own media-bearing
 * responses across a CustomEvent boundary. It read them unbounded: `responseText`
 * for XHR, `res.clone().text()` for fetch, with no limit on how many clones were
 * alive at once. A `clone()` pins the whole body in memory until it is drained,
 * so a media-heavy timeline could hold an unbounded number of unbounded bodies —
 * in the PAGE's heap, on a page we do not own.
 *
 * Two independent ceilings, because they fail differently:
 * - a per-body cap bounds what any single response can cost, and bounds what the
 *   ISOLATED side is asked to `JSON.parse`;
 * - an in-flight cap bounds how many bodies can be pinned at once, which no
 *   per-body cap can do.
 *
 * Over-budget is a DROP, never a truncation: a half-body would parse into
 * plausible-looking partial media, and passive capture reporting fewer items than
 * the page actually loaded is worse than reporting none for that response.
 */

/** Maximum UTF-8 body retained across the tee boundary (8 MiB). Sized well above
 *  a real timeline response — this is a runaway guard, not a working limit. */
export const MAX_TEE_BODY_BYTES = 8 * 1024 * 1024

/** Maximum page responses the tee holds a clone of at once. */
export const MAX_TEE_CAPTURES_IN_FLIGHT = 4

/** Aggregate ceiling across all live captures. Deliberately below
 *  `MAX_TEE_BODY_BYTES * MAX_TEE_CAPTURES_IN_FLIGHT`: four simultaneous 8 MiB
 *  bodies is exactly the case worth refusing. */
export const MAX_TEE_BYTES_IN_FLIGHT = MAX_TEE_BODY_BYTES * 2

/** CustomEvent channel MAIN → ISOLATED for the tee's OWN budget refusals. The
 *  isolated content script relays each as a production-visible
 *  DownloadTraceEvent (`capture` / `tee-drop`, detail `${platform} ${cap}`), so
 *  a whole feed batch missing from the Detected Media Set is diagnosable from
 *  the Monitor snapshot without a dev build (#92 follow-up). */
export const TEE_DROP_EVENT = 'xmd:tee-drop'

/** Which ceiling refused the capture — the `tee-drop` detail vocabulary.
 *  `in-flight-cap`: no free clone slot (`MAX_TEE_CAPTURES_IN_FLIGHT`).
 *  `byte-cap`: body over `MAX_TEE_BODY_BYTES`. */
export const TEE_DROP_CAPS = ['in-flight-cap', 'byte-cap'] as const
export type TeeDropCap = (typeof TEE_DROP_CAPS)[number]

/** One capture's claim on the shared budget. Always `release()` — in a `finally`,
 *  on every path including the refusal paths — or the slot leaks for the life of
 *  the page. */
export interface TeeLease {
  /** Claim `bytes` more for this capture. False = over budget; the caller must
   *  abandon the read (and still release). */
  readonly reserve: (bytes: number) => boolean
  readonly release: () => void
}

export interface TeeBudget {
  /** A slot, or null when `maxCaptures` are already live. */
  readonly acquire: () => TeeLease | null
  /** Live capture count — for assertions and diagnostics. */
  readonly inFlight: () => number
}

export interface TeeLimits {
  readonly maxCaptures?: number
  readonly maxBytesInFlight?: number
}

/**
 * A shared budget across every concurrent tee capture. Not a rate limiter: it
 * bounds what is held at one instant, and refuses rather than queues — a queued
 * capture would hold the page's `Response` clone alive while it waited, which is
 * the exact cost being avoided.
 */
export function makeTeeBudget(limits: TeeLimits = {}): TeeBudget {
  const maxCaptures = limits.maxCaptures ?? MAX_TEE_CAPTURES_IN_FLIGHT
  const maxBytesInFlight = limits.maxBytesInFlight ?? MAX_TEE_BYTES_IN_FLIGHT
  let captures = 0
  let bytes = 0

  return {
    inFlight: () => captures,
    acquire: () => {
      if (captures >= maxCaptures) return null
      captures += 1
      let owned = 0
      let released = false
      return {
        reserve: (amount) => {
          // A released lease never reserves again: a late chunk from an
          // abandoned read must not resurrect a slot that was already given back.
          if (released || amount < 0 || amount > maxBytesInFlight - bytes) return false
          bytes += amount
          owned += amount
          return true
        },
        release: () => {
          if (released) return // idempotent: `finally` may run after an early release
          released = true
          captures -= 1
          bytes -= owned
        },
      }
    },
  }
}

/**
 * Whether `text` is within `maxBytes` when UTF-8 encoded, without encoding it in
 * the common cases. One UTF-16 unit is at least 1 and at most 3 UTF-8 bytes (a
 * surrogate pair is 2 units → 4 bytes, i.e. 2 per unit), so both bounds settle
 * most inputs by length alone; only the band between them is measured.
 */
export function utf8ByteLengthAtMost(text: string, maxBytes: number): boolean {
  if (text.length > maxBytes) return false
  if (text.length * 3 <= maxBytes) return true
  return new TextEncoder().encode(text).byteLength <= maxBytes
}

/** `content-length` big enough to refuse before reading a single chunk. Absent,
 *  malformed, or negative headers are inconclusive, not permissive — the
 *  streaming cap still bounds those. */
export function contentLengthExceeds(header: string | null, maxBytes: number): boolean {
  if (header === null) return false
  const declared = Number(header)
  if (!Number.isFinite(declared) || declared < 0) return false
  return declared > maxBytes
}

/** Release the clone's stream on every abandon path. Best-effort by design:
 *  cancelling an already-errored stream rejects with that same error, which is
 *  precisely the case we are abandoning for. */
async function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel()
  } catch {
    /* the body is going unread either way */
  }
}

/**
 * Drain a CLONE of `response` to a string, refusing anything over budget. The
 * original `Response` is never touched — it stays wholly page-owned, which is the
 * whole contract of a passive tee.
 *
 * Returns null on every refusal (over budget, undecodable, no body, clone failed)
 * so callers have one "nothing to emit" path. `fatal: true` on the decoder is
 * deliberate: a body that isn't valid UTF-8 is not a media response we can trust.
 */
export async function readBoundedUtf8Response(
  response: Response,
  lease: TeeLease,
  maxBytes: number = MAX_TEE_BODY_BYTES,
): Promise<string | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    if (contentLengthExceeds(response.headers.get('content-length'), maxBytes)) return null
    reader = response.clone().body?.getReader()
  } catch {
    return null // a clone can throw on an already-disturbed body
  }
  if (!reader) return null

  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parts: string[] = []
  let bytes = 0

  try {
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- stream pulls are inherently ordered
      const next = await reader.read()
      if (next.done) {
        parts.push(decoder.decode())
        return parts.join('')
      }
      const chunk = next.value.byteLength
      if (chunk > maxBytes - bytes || !lease.reserve(chunk)) {
        // oxlint-disable-next-line no-await-in-loop -- cancel before leaving the loop
        await cancelQuietly(reader)
        return null
      }
      bytes += chunk
      parts.push(decoder.decode(next.value, { stream: true }))
    }
  } catch {
    await cancelQuietly(reader)
    return null
  }
}
