import { describe, it, expect } from 'vitest'
import {
  contentLengthExceeds,
  makeTeeBudget,
  readBoundedUtf8Response,
  utf8ByteLengthAtMost,
  MAX_TEE_BODY_BYTES,
  MAX_TEE_BYTES_IN_FLIGHT,
  MAX_TEE_CAPTURES_IN_FLIGHT,
  TEE_DROP_EVENT,
  TEE_DROP_CAPS,
  type TeeLease,
  type ProbedResponse,
} from '../tee-limits'

/** A lease that always grants — isolates the streaming cap from the budget. */
const openLease = (): TeeLease => ({ reserve: () => true, release: () => {} })

const bodyOf = (text: string, headers: Record<string, string> = {}): Response =>
  new Response(new TextEncoder().encode(text), { headers })

describe('tee ceilings', () => {
  it('are ordered so the aggregate bites before the per-body cap times the slots', () => {
    expect(MAX_TEE_BYTES_IN_FLIGHT).toBeLessThan(MAX_TEE_BODY_BYTES * MAX_TEE_CAPTURES_IN_FLIGHT)
  })
})

describe('makeTeeBudget', () => {
  it('hands out exactly maxCaptures slots, and reuses one after release', () => {
    const budget = makeTeeBudget({ maxCaptures: 2 })
    const a = budget.acquire()
    const b = budget.acquire()
    expect([a, b].every(Boolean)).toBe(true)
    expect(budget.inFlight()).toBe(2)
    expect(budget.acquire()).toBeNull()

    a!.release()
    expect(budget.inFlight()).toBe(1)
    expect(budget.acquire()).not.toBeNull()
  })

  it('shares one byte ceiling across concurrent captures', () => {
    const budget = makeTeeBudget({ maxCaptures: 3, maxBytesInFlight: 100 })
    const a = budget.acquire()!
    const b = budget.acquire()!

    expect(a.reserve(60)).toBe(true)
    expect(b.reserve(50)).toBe(false) // 60 + 50 > 100 — the aggregate, not per-lease
    expect(b.reserve(40)).toBe(true)
    expect(b.reserve(1)).toBe(false)

    // Releasing one capture returns exactly the bytes IT owned.
    a.release()
    expect(b.reserve(60)).toBe(true)
  })

  it('a zero-byte reserve is allowed; a negative one never is', () => {
    const lease = makeTeeBudget({ maxBytesInFlight: 10 }).acquire()!
    expect(lease.reserve(0)).toBe(true)
    expect(lease.reserve(-1)).toBe(false)
  })

  it('release is idempotent, and a released lease can never reserve again', () => {
    const budget = makeTeeBudget({ maxCaptures: 1, maxBytesInFlight: 100 })
    const lease = budget.acquire()!
    lease.reserve(10)

    lease.release()
    lease.release() // a `finally` after an early release must not free a second slot
    expect(budget.inFlight()).toBe(0)

    // A late chunk from an abandoned read must not resurrect the slot.
    expect(lease.reserve(1)).toBe(false)
    expect(budget.inFlight()).toBe(0)
  })
})

describe('utf8ByteLengthAtMost', () => {
  it('settles by length alone at both bounds', () => {
    expect(utf8ByteLengthAtMost('abcd', 3)).toBe(false) // length alone exceeds
    expect(utf8ByteLengthAtMost('ab', 6)).toBe(true) // length * 3 fits
  })

  it('measures the band between the bounds, where multi-byte characters decide it', () => {
    // 4 UTF-16 units, 12 UTF-8 bytes: inside the band (4 <= 11 < 12), so it encodes.
    expect(utf8ByteLengthAtMost('日本語だ', 11)).toBe(false)
    expect(utf8ByteLengthAtMost('日本語だ', 12)).toBe(true)
    // Same band, but ASCII — 4 units, 4 bytes.
    expect(utf8ByteLengthAtMost('abcd', 11)).toBe(true)
  })

  it('counts a surrogate pair as 4 bytes across 2 units', () => {
    expect('😀'.length).toBe(2)
    expect(utf8ByteLengthAtMost('😀', 3)).toBe(false)
    expect(utf8ByteLengthAtMost('😀', 4)).toBe(true)
  })
})

describe('contentLengthExceeds', () => {
  it('refuses only a well-formed header that declares more than the cap', () => {
    expect(contentLengthExceeds('100', 50)).toBe(true)
    expect(contentLengthExceeds('50', 50)).toBe(false)
  })

  it('treats absent, malformed and negative headers as inconclusive, not permissive', () => {
    // The streaming cap still bounds all of these — this check is an early-out only.
    expect(contentLengthExceeds(null, 50)).toBe(false)
    expect(contentLengthExceeds('not-a-number', 50)).toBe(false)
    expect(contentLengthExceeds('-1', 50)).toBe(false)
  })
})

describe('readBoundedUtf8Response', () => {
  it('returns the body and leaves the original response undisturbed', async () => {
    const res = bodyOf('{"hello":"world"}')
    await expect(readBoundedUtf8Response(res, openLease(), 1024)).resolves.toBe('{"hello":"world"}')
    // The page still owns its response: the tee only ever drained a clone.
    expect(res.bodyUsed).toBe(false)
    await expect(res.text()).resolves.toBe('{"hello":"world"}')
  })

  it('reassembles a multi-byte character split across chunk boundaries', async () => {
    // The streaming decoder must hold the partial sequence, not emit a replacement
    // char — this is why `decode(..., {stream: true})` plus a final flush is used.
    const utf8 = new TextEncoder().encode('日本語')
    const res = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(utf8.slice(0, 4)) // mid-character
          controller.enqueue(utf8.slice(4))
          controller.close()
        },
      }),
    )
    await expect(readBoundedUtf8Response(res, openLease(), 1024)).resolves.toBe('日本語')
  })

  it('drops rather than truncates when the body outgrows the cap mid-stream', async () => {
    // A truncated body would JSON.parse into plausible partial media — worse than
    // reporting nothing for this response.
    await expect(readBoundedUtf8Response(bodyOf('abcdefghij'), openLease(), 4)).resolves.toBeNull()
  })

  it('refuses on content-length before reading a chunk', async () => {
    const res = bodyOf('tiny', { 'content-length': String(99_999) })
    await expect(readBoundedUtf8Response(res, openLease(), 10)).resolves.toBeNull()
  })

  it('drops when the shared budget refuses the chunk', async () => {
    const lease = makeTeeBudget({ maxBytesInFlight: 2 }).acquire()!
    await expect(readBoundedUtf8Response(bodyOf('abcdef'), lease, 1024)).resolves.toBeNull()
  })

  it('drops a body that is not valid UTF-8', async () => {
    const res = new Response(new Uint8Array([0xff, 0xfe, 0xfd]))
    await expect(readBoundedUtf8Response(res, openLease(), 1024)).resolves.toBeNull()
  })

  it('drops when the stream errors part-way', async () => {
    const res = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('ok'))
          controller.error(new Error('connection reset'))
        },
      }),
    )
    await expect(readBoundedUtf8Response(res, openLease(), 1024)).resolves.toBeNull()
  })

  it('drops when the response has no body', async () => {
    await expect(
      readBoundedUtf8Response(new Response(null, { status: 204 }), openLease(), 1024),
    ).resolves.toBeNull()
  })

  it('drops when cloning throws instead of letting it break the page', async () => {
    // No cast needed: `readBoundedUtf8Response` takes `ProbedResponse`
    // (only `headers.get(...)` and `clone()`), exactly this stub's shape.
    const hostile: ProbedResponse = {
      headers: { get: () => null },
      clone: () => {
        throw new TypeError('body already read')
      },
    }
    await expect(readBoundedUtf8Response(hostile, openLease(), 1024)).resolves.toBeNull()
  })
})

// The MAIN↔ISOLATED drop contract (#92): the injected tee dispatches this event
// with one of these caps; the content script relays it as a `capture`/`tee-drop`
// trace. Pinned so a rename on one side can't silently orphan the other.
describe('tee-drop vocabulary', () => {
  it('names the CustomEvent channel and both budget ceilings', () => {
    expect(TEE_DROP_EVENT).toBe('xmd:tee-drop')
    expect(TEE_DROP_CAPS).toEqual(['in-flight-cap', 'byte-cap'])
  })
})
