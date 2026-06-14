import { describe, it, expect } from 'vitest'
import {
  type JobLedger,
  type UploadJobSpec,
  LEASE_MS,
  MAX_ATTEMPTS,
  backoffMs,
  claim,
  enqueue,
  idempotencyKeyFor,
  isClaimable,
  isTerminal,
  readyJobs,
  recordFailure,
  recordSourceGone,
  recordSuccess,
  renewLease,
  retry,
  rollup,
} from './upload-job'

const spec = (mediaId: string, provider: UploadJobSpec['provider'] = 's3'): UploadJobSpec => ({
  mediaId,
  provider,
  objectKey: `alice/1/${mediaId}.jpg`,
})

const seed = (): JobLedger => enqueue([], spec('m1'), 'job-1', 0)

/** Claim and return the issued fencing token (throws if refused — keeps tests honest). */
const start = (ledger: JobLedger, jobId: string, now: number, leaseMs?: number) => {
  const c = claim(ledger, jobId, now, leaseMs)
  if (!c.claimed || c.token === undefined) throw new Error(`claim refused: ${c.reason}`)
  return { ledger: c.ledger, token: c.token }
}

describe('idempotencyKeyFor / backoffMs', () => {
  it('keys a job by media + provider', () => {
    expect(idempotencyKeyFor('m1', 'r2')).toBe('m1:r2')
  })

  it('backs off exponentially, capped, with a 5s floor', () => {
    expect([0, -3, 1, 2, 3, 4, 5, 6, 12].map(backoffMs)).toEqual([
      5_000, 5_000, 5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000,
    ])
  })
})

describe('enqueue', () => {
  it('creates a pending job at now', () => {
    const led = enqueue([], spec('m1'), 'job-1', 1000)
    expect(led).toHaveLength(1)
    expect(led[0]).toMatchObject({
      jobId: 'job-1',
      mediaId: 'm1',
      provider: 's3',
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 1000,
      leaseUntil: null,
      leaseSeq: 0,
    })
  })

  it('is idempotent by (mediaId, provider)', () => {
    let led = enqueue([], spec('m1'), 'job-1', 0)
    led = enqueue(led, spec('m1'), 'job-DUP', 0)
    expect(led).toHaveLength(1)
    expect(led[0]?.jobId).toBe('job-1')
  })

  it('refuses a duplicate jobId across different keys (would alias replaceJob)', () => {
    let led = enqueue([], spec('m1', 's3'), 'same', 0)
    led = enqueue(led, spec('m2', 'r2'), 'same', 0) // different key, same jobId → rejected
    expect(led).toHaveLength(1)
  })

  it('fans out one job per provider', () => {
    let led = enqueue([], spec('m1', 's3'), 'job-1', 0)
    led = enqueue(led, spec('m1', 'r2'), 'job-2', 0)
    expect(led).toHaveLength(2)
  })
})

describe('claim / lease', () => {
  it('claims a pending job → uploading, with a fencing token + lease', () => {
    const c = claim(seed(), 'job-1', 100)
    expect(c.claimed).toBe(true)
    expect(c.token).toBe(1)
    expect(c.ledger[0]).toMatchObject({
      status: 'uploading',
      leaseUntil: 100 + LEASE_MS,
      leaseSeq: 1,
    })
  })

  it('refuses a second claim while the lease is live (no double-fire)', () => {
    const once = start(seed(), 'job-1', 0).ledger
    const twice = claim(once, 'job-1', 1000)
    expect(twice.claimed).toBe(false)
    expect(twice.reason).toMatch(/lease/)
  })

  it('reclaims at exactly the lease-expiry instant (now === leaseUntil), issuing a new token', () => {
    const once = start(seed(), 'job-1', 0).ledger
    const r = claim(once, 'job-1', LEASE_MS)
    expect(r.claimed).toBe(true)
    expect(r.token).toBe(2)
  })

  it('clamps leaseMs to ≥1 so a zero lease cannot be re-claimed in the same tick', () => {
    const c = claim(seed(), 'job-1', 100, 0).ledger
    expect(claim(c, 'job-1', 100).claimed).toBe(false) // leaseUntil = 101 > 100, still held
  })

  it('does not claim a job still in backoff', () => {
    const s = start(seed(), 'job-1', 0)
    const failed = recordFailure(s.ledger, 'job-1', s.token, 0, 'neterr').ledger
    expect(isClaimable(failed[0]!, 1000)).toBe(false) // nextAttemptAt = 5000
    expect(isClaimable(failed[0]!, 5000)).toBe(true)
  })

  it('never claims a terminal job', () => {
    const s = start(seed(), 'job-1', 0)
    const done = recordSuccess(s.ledger, 'job-1', s.token, 10).ledger
    expect(isClaimable(done[0]!, 1_000_000)).toBe(false)
    expect(claim(done, 'job-1', 1_000_000).claimed).toBe(false)
  })

  it('readyJobs hides a live lease but resurfaces a crashed (expired-lease) job', () => {
    const led = enqueue(seed(), spec('m2'), 'job-2', 0)
    const c = start(led, 'job-1', 0).ledger // job-1 uploading, live lease
    expect(readyJobs(c, 0).map((j) => j.jobId)).toEqual(['job-2'])
    expect(
      readyJobs(c, LEASE_MS)
        .map((j) => j.jobId)
        .toSorted(),
    ).toEqual(['job-1', 'job-2'])
  })
})

describe('fencing token — a reclaimed lease invalidates the old holder', () => {
  it('drops a stale (zombie) worker outcome; honours the live holder', () => {
    const a = claim(seed(), 'job-1', 0) // worker A → token 1
    const b = claim(a.ledger, 'job-1', LEASE_MS) // A stalled; B reclaims → token 2
    expect(b.token).toBe(2)
    const stale = recordFailure(b.ledger, 'job-1', a.token!, LEASE_MS + 5, 'neterr')
    expect(stale.changed).toBe(false)
    expect(stale.ledger[0]?.status).toBe('uploading')
    const live = recordSuccess(b.ledger, 'job-1', b.token!, LEASE_MS + 9)
    expect(live.changed).toBe(true)
    expect(live.ledger[0]?.status).toBe('succeeded')
  })
})

describe('outcome transitions (token-gated)', () => {
  it('recordSuccess: uploading → succeeded with verifiedAt', () => {
    const s = start(seed(), 'job-1', 0)
    const r = recordSuccess(s.ledger, 'job-1', s.token, 42)
    expect(r.ledger[0]).toMatchObject({
      status: 'succeeded',
      verifiedAt: 42,
      leaseUntil: null,
      error: null,
    })
    expect(isTerminal(r.ledger[0]!)).toBe(true)
  })

  it('recordFailure: uploading → failed with incremented attempts + backoff', () => {
    const s = start(seed(), 'job-1', 0)
    const r = recordFailure(s.ledger, 'job-1', s.token, 1000, 'neterr')
    expect(r.ledger[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      nextAttemptAt: 1000 + 5_000,
      leaseUntil: null,
      error: 'neterr',
    })
  })

  it('recordFailure: the attempts-4 → attempts-5 crossover flips failed → dead', () => {
    let led = seed()
    let now = 0
    for (let i = 0; i < MAX_ATTEMPTS - 1; i += 1) {
      const s = start(led, 'job-1', now)
      led = recordFailure(s.ledger, 'job-1', s.token, now, 'down').ledger
      now += backoffMs(i + 1)
    }
    expect(led[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS - 1 })
    expect(isClaimable(led[0]!, now)).toBe(true)
    const last = start(led, 'job-1', now)
    led = recordFailure(last.ledger, 'job-1', last.token, now, 'down').ledger
    expect(led[0]).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS, leaseUntil: null })
  })

  it('recordSourceGone: uploading → skipped (honest, never a fake save)', () => {
    const s = start(seed(), 'job-1', 0)
    const r = recordSourceGone(s.ledger, 'job-1', s.token, 'sourceGone (403)')
    expect(r.ledger[0]).toMatchObject({
      status: 'skipped',
      error: 'sourceGone (403)',
      leaseUntil: null,
    })
    expect(r.ledger[0]?.verifiedAt).toBeNull()
  })
})

describe('crash recovery', () => {
  it('a crash loop (lease lapses, no outcome recorded) still reaches dead', () => {
    let led = seed()
    let now = 0
    let guard = 0
    while (!isTerminal(led[0]!) && guard < 20) {
      led = claim(led, 'job-1', now).ledger // worker dies mid-upload; lease lapses
      now += LEASE_MS
      guard += 1
    }
    expect(led[0]).toMatchObject({ status: 'dead', attempts: MAX_ATTEMPTS })
  })
})

describe('renewLease', () => {
  it('extends a live lease for the holder; wrong token is a no-op', () => {
    const s = start(seed(), 'job-1', 0)
    const r = renewLease(s.ledger, 'job-1', s.token, 20_000)
    expect(r.changed).toBe(true)
    expect(r.ledger[0]?.leaseUntil).toBe(20_000 + LEASE_MS)
    expect(isClaimable(r.ledger[0]!, 20_000 + LEASE_MS - 1)).toBe(false)
    expect(renewLease(s.ledger, 'job-1', 999, 0).changed).toBe(false)
  })
})

describe('retry — the only sanctioned terminal regression', () => {
  const toDead = (): JobLedger => {
    let led = seed()
    let now = 0
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const s = start(led, 'job-1', now)
      led = recordFailure(s.ledger, 'job-1', s.token, now, 'down').ledger
      now += backoffMs(i + 1)
    }
    return led
  }

  it('moves dead → pending with attempts reset', () => {
    const dead = toDead()
    expect(dead[0]?.status).toBe('dead')
    const r = retry(dead, 'job-1', 1000)
    expect(r.changed).toBe(true)
    expect(r.ledger[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 1000,
      leaseUntil: null,
      error: null,
    })
  })

  it('no-ops on a non-terminal-recoverable job (uploading)', () => {
    const running = start(seed(), 'job-1', 0).ledger
    expect(retry(running, 'job-1', 0).changed).toBe(false)
  })
})

describe('monotonicity — terminal never regresses except via retry()', () => {
  it('recordFailure on a succeeded job is a no-op', () => {
    const s = start(seed(), 'job-1', 0)
    const done = recordSuccess(s.ledger, 'job-1', s.token, 10).ledger
    expect(recordFailure(done, 'job-1', s.token, 999, 'late').ledger[0]?.status).toBe('succeeded')
  })

  it('recordSuccess on a pending (not uploading) job is a no-op', () => {
    expect(recordSuccess(seed(), 'job-1', 1, 10).ledger[0]?.status).toBe('pending')
  })

  it('unknown jobId is a no-op for every transition', () => {
    const led = seed()
    expect(claim(led, 'nope', 0).claimed).toBe(false)
    expect(recordSuccess(led, 'nope', 1, 0).ledger).toEqual(led)
    expect(recordFailure(led, 'nope', 1, 0, 'x').ledger).toEqual(led)
    expect(recordSourceGone(led, 'nope', 1, 'x').ledger).toEqual(led)
    expect(retry(led, 'nope', 0).changed).toBe(false)
  })
})

describe('rollup (per media)', () => {
  const succeed = (led: JobLedger, jobId: string): JobLedger => {
    const s = start(led, jobId, 0)
    return recordSuccess(s.ledger, jobId, s.token, 1).ledger
  }
  const skip = (led: JobLedger, jobId: string): JobLedger => {
    const s = start(led, jobId, 0)
    return recordSourceGone(s.ledger, jobId, s.token, 'gone').ledger
  }
  const kill = (led: JobLedger, jobId: string): JobLedger => {
    let l = led
    let now = 0
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      const s = start(l, jobId, now)
      l = recordFailure(s.ledger, jobId, s.token, now, 'down').ledger
      now += backoffMs(i + 1)
    }
    return l
  }
  const two = (): JobLedger =>
    enqueue(enqueue([], spec('m1', 's3'), 'j1', 0), spec('m1', 'r2'), 'j2', 0)
  const three = (): JobLedger => enqueue(two(), spec('m1', 'dropbox'), 'j3', 0)

  it('none when no jobs', () => {
    expect(rollup([], 'm1')).toMatchObject({ label: 'none', safe: 0, total: 0 })
  })

  it('syncing while any job is in flight', () => {
    expect(rollup(two(), 'm1')).toMatchObject({ label: 'syncing', safe: 0, total: 2 })
  })

  it('safe only when all jobs succeeded', () => {
    expect(rollup(succeed(succeed(two(), 'j1'), 'j2'), 'm1')).toMatchObject({
      label: 'safe',
      safe: 2,
      total: 2,
    })
  })

  it('sourceGone when a job skipped and the rest succeeded', () => {
    expect(rollup(skip(succeed(two(), 'j1'), 'j2'), 'm1').label).toBe('sourceGone')
  })

  it('dead wins over sourceGone (precedence) with mixed terminal states', () => {
    let led = three()
    led = succeed(led, 'j1')
    led = skip(led, 'j2')
    led = kill(led, 'j3')
    expect(rollup(led, 'm1').label).toBe('failed')
  })
})
