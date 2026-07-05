import { Schema } from 'effect'
import { describe, it, expect } from 'vitest'
import {
  backoffMs,
  capLedger,
  claim,
  decodeLedger,
  enqueue,
  idempotencyKeyFor,
  isClaimable,
  MAX_ATTEMPTS,
  pruneTerminal,
  readyJobs,
  recordFailure,
  recordSourceGone,
  recordSuccess,
  retry,
  summarize,
  toWireUploadJob,
  WireUploadJob,
  type JobLedger,
  type UploadJobSpec,
} from './upload-job'

const target = (path: string) => ({
  path,
  folder: 'alice',
  filename: path.split('/').pop()!,
  contentType: 'image/jpeg',
})

const spec = (mediaId: string, provider: 'gdrive' | 'dropbox' = 'gdrive'): UploadJobSpec => ({
  mediaId,
  provider,
  url: `https://pbs.twimg.com/${mediaId}.jpg`,
  target: target(`alice/${mediaId}.jpg`),
})

/** Claim the only ready job and return [ledger, jobId, token]. */
function claimFirst(ledger: JobLedger, now: number): [JobLedger, string, number] {
  const job = readyJobs(ledger, now)[0]!
  const r = claim(ledger, job.jobId, now)
  expect(r.claimed).toBe(true)
  return [r.ledger, job.jobId, r.token!]
}

describe('enqueue / idempotency', () => {
  it('adds one pending job with a deterministic id', () => {
    const l = enqueue([], spec('m1'), 1000)
    expect(l).toHaveLength(1)
    expect(l[0]!.jobId).toBe(idempotencyKeyFor('m1', 'gdrive'))
    expect(l[0]!.status).toBe('pending')
    expect(l[0]!.nextAttemptAt).toBe(1000)
  })

  it('refreshes the source URL of a still-pending job on re-enqueue', () => {
    const l1 = enqueue([], spec('m1'), 1000)
    const fresh: UploadJobSpec = { ...spec('m1'), url: 'https://pbs.twimg.com/m1-FRESH.jpg' }
    const l2 = enqueue(l1, fresh, 2000)
    expect(l2).toHaveLength(1)
    expect(l2[0]!.url).toBe('https://pbs.twimg.com/m1-FRESH.jpg')
    expect(l2[0]!.status).toBe('pending')
    expect(l2[0]!.nextAttemptAt).toBe(2000)
  })

  it('re-arms a FAILED job to pending with the fresh URL (un-pins an expired source)', () => {
    let l = enqueue([], spec('m1'), 0)
    const [c, jobId, token] = claimFirst(l, 0)
    l = recordFailure(c, jobId, token, 0, 'twimg 500').ledger
    expect(l[0]!.status).toBe('failed')
    expect(l[0]!.attempts).toBe(1)
    const fresh: UploadJobSpec = { ...spec('m1'), url: 'https://pbs.twimg.com/m1-FRESH.jpg' }
    l = enqueue(l, fresh, 10_000)
    expect(l[0]!.status).toBe('pending')
    expect(l[0]!.url).toBe('https://pbs.twimg.com/m1-FRESH.jpg')
    expect(l[0]!.attempts).toBe(0)
    expect(l[0]!.nextAttemptAt).toBe(10_000)
    expect(l[0]!.error).toBeNull()
  })

  it('revives a SKIPPED (source-gone) job when a fresh URL arrives', () => {
    let l = enqueue([], spec('m1'), 0)
    const [c, jobId, token] = claimFirst(l, 0)
    l = recordSourceGone(c, jobId, token, 'source HTTP 410').ledger
    expect(l[0]!.status).toBe('skipped')
    l = enqueue(l, { ...spec('m1'), url: 'https://pbs.twimg.com/m1-FRESH.jpg' }, 5000)
    expect(l[0]!.status).toBe('pending')
    expect(l[0]!.url).toBe('https://pbs.twimg.com/m1-FRESH.jpg')
  })

  it('revives a DEAD (attempts-exhausted) job when a fresh URL arrives', () => {
    let l = enqueue([], spec('m1'), 0)
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const [c, jobId, token] = claimFirst(l, i * 1_000_000)
      l = recordFailure(c, jobId, token, i * 1_000_000, `fail ${i}`).ledger
    }
    expect(l[0]!.status).toBe('dead')
    l = enqueue(l, { ...spec('m1'), url: 'https://pbs.twimg.com/m1-FRESH.jpg' }, 9_000_000)
    expect(l[0]!.status).toBe('pending')
    expect(l[0]!.url).toBe('https://pbs.twimg.com/m1-FRESH.jpg')
    expect(l[0]!.attempts).toBe(0)
  })

  it('leaves a SUCCEEDED job untouched on re-enqueue (never re-upload)', () => {
    let l = enqueue([], spec('m1'), 0)
    const [c, jobId, token] = claimFirst(l, 0)
    l = recordSuccess(c, jobId, token, 0, { bytes: 100 }).ledger
    expect(l[0]!.status).toBe('succeeded')
    const l2 = enqueue(l, { ...spec('m1'), url: 'https://other.example/x.jpg' }, 9999)
    expect(l2).toBe(l) // same reference — no-op
  })

  it('leaves an in-flight UPLOADING job untouched on re-enqueue (live lease)', () => {
    const l0 = enqueue([], spec('m1'), 0)
    const r = claim(l0, l0[0]!.jobId, 0, 1000)
    expect(r.ledger[0]!.status).toBe('uploading')
    const l2 = enqueue(r.ledger, { ...spec('m1'), url: 'https://other.example/x.jpg' }, 500)
    expect(l2).toBe(r.ledger) // same reference — don't disturb a live transfer
  })

  it('separates jobs per provider', () => {
    let l = enqueue([], spec('m1', 'gdrive'), 0)
    l = enqueue(l, spec('m1', 'dropbox'), 0)
    expect(l).toHaveLength(2)
  })
})

describe('claim fencing token', () => {
  it('claims a pending job and refuses while the lease is held', () => {
    const l0 = enqueue([], spec('m1'), 0)
    const r1 = claim(l0, l0[0]!.jobId, 0, 1000)
    expect(r1.claimed).toBe(true)
    expect(r1.ledger[0]!.status).toBe('uploading')
    const r2 = claim(r1.ledger, l0[0]!.jobId, 500, 1000)
    expect(r2.claimed).toBe(false)
    expect(r2.reason).toMatch(/lease held/)
  })

  it('drops a stale (zombie) worker outcome; honours the live holder', () => {
    const l0 = enqueue([], spec('m1'), 0)
    const id = l0[0]!.jobId
    const first = claim(l0, id, 0, 1000)
    const staleToken = first.token!
    // lease expires → reclaimed by a fresh worker with a new token
    const second = claim(first.ledger, id, 2000, 1000)
    expect(second.claimed).toBe(true)
    expect(second.token).not.toBe(staleToken)
    // the zombie (old token) cannot record anything
    const zombie = recordSuccess(second.ledger, id, staleToken, 2500, { bytes: 1 })
    expect(zombie.changed).toBe(false)
    // the live holder can
    const live = recordSuccess(second.ledger, id, second.token!, 2600, { bytes: 10 })
    expect(live.changed).toBe(true)
    expect(live.ledger[0]!.status).toBe('succeeded')
  })

  it('a crashed-upload reclaim consumes an attempt and dies at the cap', () => {
    let l = enqueue([], spec('m1'), 0)
    const id = l[0]!.jobId
    let t = 0
    // Repeatedly reclaim a job whose lease expired (SW recycle mid-upload). Each
    // reclaim costs one attempt; the claim that would exceed MAX_ATTEMPTS instead
    // marks the job dead and refuses (claimed:false), still returning that ledger.
    for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) {
      const r = claim(l, id, t, 100)
      l = r.ledger
      if (!r.claimed) break
      t += 1000 // let the lease expire so the next claim is a crash-recovery
    }
    expect(l.find((j) => j.jobId === id)!.status).toBe('dead')
  })
})

describe('outcomes', () => {
  it('records success with bytes + remoteId', () => {
    const [l, id, t] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const r = recordSuccess(l, id, t, 100, { bytes: 2048, remoteId: 'drive-id' })
    expect(r.ledger[0]!.status).toBe('succeeded')
    expect(r.ledger[0]!.bytes).toBe(2048)
    expect(r.ledger[0]!.remoteId).toBe('drive-id')
    expect(r.ledger[0]!.verifiedAt).toBe(100)
  })

  it('failure backs off then dies at MAX_ATTEMPTS', () => {
    let l = enqueue([], spec('m1'), 0)
    const id = l[0]!.jobId
    let now = 0
    const statuses: string[] = []
    const firstBackoff: number[] = []
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const c = claim(l, id, now)
      expect(c.claimed).toBe(true)
      l = recordFailure(c.ledger, id, c.token!, now, `try ${i}`).ledger
      statuses.push(l[0]!.status)
      if (i === 1) firstBackoff.push(l[0]!.nextAttemptAt)
      now = l[0]!.nextAttemptAt || now + 1
    }
    // 4 backoff failures then dead (MAX_ATTEMPTS = 5)
    expect(statuses).toEqual(['failed', 'failed', 'failed', 'failed', 'dead'])
    expect(firstBackoff[0]).toBe(backoffMs(1))
  })

  it('sourceGone → skipped (terminal, not a fault)', () => {
    const [l, id, t] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const r = recordSourceGone(l, id, t, 'HTTP 403')
    expect(r.ledger[0]!.status).toBe('skipped')
    expect(isClaimable(r.ledger[0]!, 1_000_000)).toBe(false)
  })

  it('retry resurrects a dead job', () => {
    let l = enqueue([], spec('m1'), 0)
    const id = l[0]!.jobId
    let now = 0
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const c = claim(l, id, now)
      l = recordFailure(c.ledger, id, c.token!, now, 'x').ledger
      now = l[0]!.nextAttemptAt || now + 1
    }
    expect(l[0]!.status).toBe('dead')
    const r = retry(l, id, 9999)
    expect(r.changed).toBe(true)
    expect(r.ledger[0]!.status).toBe('pending')
    expect(r.ledger[0]!.attempts).toBe(0)
  })
})

describe('ledger maintenance', () => {
  it('readyJobs honours backoff windows', () => {
    const l = enqueue([], { ...spec('m1'), url: 'u' }, 5000)
    expect(readyJobs(l, 4999)).toHaveLength(0)
    expect(readyJobs(l, 5000)).toHaveLength(1)
  })

  it('pruneTerminal keeps only live jobs', () => {
    const [l, id, t] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const done = recordSuccess(l, id, t, 1, { bytes: 1 }).ledger
    expect(pruneTerminal(done)).toHaveLength(0)
  })

  it('capLedger bounds terminal jobs but keeps live + most-recent terminal', () => {
    // 5 terminal (succeeded) + 1 live pending; cap terminal at 2
    let ledger: JobLedger = []
    for (let i = 0; i < 5; i += 1) {
      const withJob = enqueue(ledger, spec(`done${i}`), 0)
      const job = withJob[withJob.length - 1]!
      const c = claim(withJob, job.jobId, 0)
      ledger = recordSuccess(c.ledger, job.jobId, c.token!, 1, { bytes: 1 }).ledger
    }
    ledger = enqueue(ledger, spec('live'), 0)
    const capped = capLedger(ledger, 2)
    expect(capped.filter((j) => j.status === 'succeeded')).toHaveLength(2)
    expect(capped.some((j) => j.mediaId === 'live')).toBe(true)
    // keeps the most recent terminal jobs (done3, done4), drops the oldest
    expect(capped.map((j) => j.mediaId)).toEqual(['done3', 'done4', 'live'])
  })

  it('capLedger is a no-op under the cap', () => {
    const [l, id, t] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const done = recordSuccess(l, id, t, 1, { bytes: 1 }).ledger
    expect(capLedger(done, 50)).toBe(done)
  })

  it('summarize counts by status', () => {
    let l = enqueue([], spec('a'), 0)
    l = enqueue(l, spec('b'), 0)
    const [l2, id, t] = claimFirst(l, 0)
    const l3 = recordSuccess(l2, id, t, 1, { bytes: 1 }).ledger
    expect(summarize(l3)).toMatchObject({ succeeded: 1, pending: 1 })
  })

  it('decodeLedger round-trips and falls back to empty on garbage', () => {
    const l = enqueue([], spec('m1'), 0)
    expect(decodeLedger(JSON.parse(JSON.stringify(l)))).toEqual(l)
    expect(decodeLedger('not a ledger')).toEqual([])
    expect(decodeLedger(null)).toEqual([])
  })
})

describe('claim / transition guards', () => {
  it('refuses to claim an unknown job', () => {
    const r = claim([], 'nope', 0)
    expect(r).toMatchObject({ claimed: false, reason: 'not found' })
  })

  it('refuses to claim a terminal job (reports its status)', () => {
    const [l, id, t] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const done = recordSuccess(l, id, t, 1, { bytes: 1 }).ledger
    const r = claim(done, id, 2)
    expect(r).toMatchObject({ claimed: false, reason: 'succeeded' })
  })

  it('refuses to claim a failed job still inside its backoff window', () => {
    let l = enqueue([], spec('m1'), 0)
    const id = l[0]!.jobId
    const c = claim(l, id, 0)
    l = recordFailure(c.ledger, id, c.token!, 0, 'boom').ledger
    const backoffUntil = l[0]!.nextAttemptAt
    const r = claim(l, id, backoffUntil - 1)
    expect(r.claimed).toBe(false)
    expect(r.reason).toMatch(/backoff/)
  })

  it('clamps a non-positive lease to ≥ 1ms', () => {
    const l = enqueue([], spec('m1'), 0)
    const r = claim(l, l[0]!.jobId, 100, 0)
    expect(r.claimed).toBe(true)
    expect(r.ledger[0]!.leaseUntil).toBe(101)
  })

  it('record* are no-ops on a job that is not uploading', () => {
    const l = enqueue([], spec('m1'), 0) // pending, never claimed
    const id = l[0]!.jobId
    expect(recordSuccess(l, id, 1, 0, { bytes: 1 }).changed).toBe(false)
    expect(recordFailure(l, id, 1, 0, 'x').changed).toBe(false)
    expect(recordSourceGone(l, id, 1, 'x').changed).toBe(false)
  })

  it('retry is a no-op on a job that is neither dead nor failed', () => {
    const l = enqueue([], spec('m1'), 0) // pending
    expect(retry(l, l[0]!.jobId, 0).changed).toBe(false)
    expect(retry(l, 'missing', 0).changed).toBe(false)
  })

  it('retry resurrects a failed (not yet dead) job', () => {
    let l = enqueue([], spec('m1'), 0)
    const id = l[0]!.jobId
    const c = claim(l, id, 0)
    l = recordFailure(c.ledger, id, c.token!, 0, 'boom').ledger
    expect(l[0]!.status).toBe('failed')
    const r = retry(l, id, 50)
    expect(r.changed).toBe(true)
    expect(r.ledger[0]!).toMatchObject({ status: 'pending', attempts: 0, nextAttemptAt: 50 })
  })

  it('backoffMs grows geometrically and is capped', () => {
    expect(backoffMs(0)).toBe(backoffMs(1)) // attempts<=1 share the base
    expect(backoffMs(2)).toBe(backoffMs(1) * 2)
    expect(backoffMs(100)).toBe(300_000) // BACKOFF_CAP_MS
  })

  it('isClaimable: live-lease uploading job is not claimable; expired-lease one is', () => {
    const l0 = enqueue([], spec('m1'), 0)
    const claimed = claim(l0, l0[0]!.jobId, 0, 1000).ledger
    const job = claimed[0]!
    expect(job.status).toBe('uploading')
    expect(isClaimable(job, 500)).toBe(false) // lease still held (until 1000)
    expect(isClaimable(job, 1000)).toBe(true) // lease expired → crash-recovery claimable
  })

  it('isClaimable: a not-yet-due pending job is not claimable', () => {
    const l = enqueue([], spec('m1'), 5000)
    expect(isClaimable(l[0]!, 4999)).toBe(false)
    expect(isClaimable(l[0]!, 5000)).toBe(true)
  })

  it('isClaimable rejects a job at the attempt cap', () => {
    let l = enqueue([], spec('m1'), 0)
    const id = l[0]!.jobId
    let now = 0
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const c = claim(l, id, now)
      l = recordFailure(c.ledger, id, c.token!, now, 'x').ledger
      now = l[0]!.nextAttemptAt || now + 1
    }
    expect(l[0]!.attempts).toBe(MAX_ATTEMPTS)
    expect(isClaimable(l[0]!, now + 1_000_000)).toBe(false)
  })
})

describe('toWireUploadJob / WireUploadJob', () => {
  const decode = Schema.decodeUnknownSync(WireUploadJob)

  it('projects a succeeded job (bytes present, error null) into the Convex mirror shape', () => {
    const [l0, id, tok] = claimFirst(enqueue([], spec('m1', 'dropbox'), 0), 0)
    const job = recordSuccess(l0, id, tok, 1000, { bytes: 4096, remoteId: 'r1' }).ledger[0]!
    const wire = toWireUploadJob(job, 'dev-7', 5000)
    expect(wire).toEqual({
      jobId: 'dev-7/m1/dropbox',
      deviceId: 'dev-7',
      requestId: 'm1',
      provider: 'dropbox',
      status: 'succeeded',
      attempts: job.attempts,
      at: 5000,
      remotePath: 'alice/m1.jpg',
      bytes: 4096,
    })
    expect('error' in wire).toBe(false) // null error is omitted, not sent as null
    expect(decode(wire)).toEqual(wire) // the projection conforms to the wire contract
  })

  it('projects a failed job (error present, no bytes) and omits absent optionals', () => {
    let l = enqueue([], spec('m2', 'gdrive'), 0)
    const c = claim(l, l[0]!.jobId, 0)
    l = recordFailure(c.ledger, l[0]!.jobId, c.token!, 0, 'boom').ledger
    const wire = toWireUploadJob(l[0]!, 'dev-7', 1)
    expect(wire.jobId).toBe('dev-7/m2/gdrive')
    expect(wire.status).toBe('failed')
    expect(wire.error).toBe('boom')
    expect('bytes' in wire).toBe(false)
    expect(decode(wire)).toEqual(wire)
  })
})
