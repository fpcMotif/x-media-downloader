import { Schema } from 'effect'
import { describe, it, expect } from 'vitest'
import {
  backoffMs,
  bindRemoteAttempt,
  capLedger,
  claim,
  decodeLedgerResult,
  decodeLedgerStateResult,
  enqueue,
  enqueueBounded,
  idempotencyKeyFor,
  isClaimable,
  legacyConflict,
  quarantineConflict,
  MAX_ATTEMPTS,
  MAX_UPLOAD_CONTENT_TYPE_LENGTH,
  MAX_UPLOAD_ERROR_LENGTH,
  MAX_UPLOAD_LEDGER_BYTES,
  MAX_UPLOAD_JOBS,
  MAX_UPLOAD_REMOTE_ID_LENGTH,
  MAX_STORED_UPLOAD_ERROR_LENGTH,
  pruneTerminal,
  readyJobs,
  rebaseUploadDeadlines,
  recordFailure,
  recordRemoteProgress,
  recordSourceGone,
  recordSuccess,
  removeProviderJobs,
  retry,
  summarize,
  toWireUploadJob,
  WireUploadJob,
  type JobLedger,
  type UploadJobSpec,
} from './upload-job'
import { MAX_SAVE_REQUEST_ID_LENGTH } from '../download/request-identity'
import { MAX_MEDIA_URL_LENGTH } from '../schema/media'
import { MAX_TRANSFER_FILENAME_LENGTH } from '../wire/limits'

const OWNER_KEY = 'a'.repeat(64)

const target = (path: string) => ({
  path,
  folder: 'alice',
  filename: path.split('/').pop()!,
  contentType: 'image/jpeg',
})

const spec = (mediaId: string, provider: 'gdrive' | 'dropbox' = 'gdrive'): UploadJobSpec => ({
  requestId: mediaId,
  provider,
  url: `https://pbs.twimg.com/${mediaId}.jpg`,
  target: target(`alice/${mediaId}.jpg`),
})
const acceptedLedger = (raw: unknown): boolean => decodeLedgerResult(raw).ok
const decodeAvailableLedger = (raw: unknown): JobLedger => {
  const decoded = decodeLedgerResult(raw)
  if (!decoded.ok) throw new Error('expected available Cloud Upload ledger')
  return decoded.ledger
}
const baseJob = () => enqueue([], spec('m1'), 0)[0]!

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
    l = recordSuccess(c, jobId, token, 0, { bytes: 100, remotePath: 'alice/m1.jpg' }).ledger
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

  it('rejects only new work at the ledger bound', () => {
    const full = enqueue([], spec('m1'), 0)
    const rejected = enqueueBounded(full, spec('m2'), 1, 1)
    expect(rejected).toMatchObject({ admitted: false, added: false, ledger: full })

    const refreshed = enqueueBounded(
      full,
      { ...spec('m1'), url: 'https://pbs.twimg.com/fresh.jpg' },
      2,
      1,
    )
    expect(refreshed).toMatchObject({ admitted: true, added: false })
    expect(refreshed.ledger[0]?.url).toBe('https://pbs.twimg.com/fresh.jpg')
    expect(MAX_UPLOAD_JOBS).toBe(1_000)
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
    const zombie = recordSuccess(second.ledger, id, staleToken, 2500, {
      bytes: 1,
      remotePath: 'alice/m1.jpg',
    })
    expect(zombie.changed).toBe(false)
    // the live holder can
    const live = recordSuccess(second.ledger, id, second.token!, 2600, {
      bytes: 10,
      remotePath: 'alice/m1.jpg',
    })
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

describe('durable provider attempt fencing', () => {
  it('binds Drive identity once under the live lease', () => {
    const [claimed, id, token] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const attempt = { kind: 'gdrive' as const, ownerKey: OWNER_KEY, fileId: 'drive-id' }
    const bound = bindRemoteAttempt(claimed, id, token, attempt)
    expect(bound.changed).toBe(true)
    expect(bound.ledger[0]!.remoteAttempt).toEqual(attempt)
    expect(
      bindRemoteAttempt(bound.ledger, id, token, { ...attempt, fileId: 'other' }).changed,
    ).toBe(false)
    expect(bindRemoteAttempt(claimed, id, token + 1, attempt).changed).toBe(false)
  })

  it('allows only Dropbox prepared → staged with the same owner and stage path', () => {
    const [claimed, id, token] = claimFirst(enqueue([], spec('m1', 'dropbox'), 0), 0)
    const prepared = {
      kind: 'dropbox' as const,
      phase: 'prepared' as const,
      ownerKey: OWNER_KEY,
      stagePath: '/.xmd-stage/v1/job/blob',
    }
    const bound = bindRemoteAttempt(claimed, id, token, prepared).ledger
    const staged = {
      ...prepared,
      phase: 'staged' as const,
      fileId: 'id:one',
      rev: 'rev-one',
      contentHash: 'b'.repeat(64),
      bytes: 12,
    }
    expect(recordRemoteProgress(bound, id, token, staged).changed).toBe(true)
    expect(
      recordRemoteProgress(bound, id, token, { ...staged, stagePath: '/other/blob' }).changed,
    ).toBe(false)
    expect(recordRemoteProgress(bound, id, token + 1, staged).changed).toBe(false)
  })

  it('rejects cross-provider and malformed durable identity', () => {
    const [claimed, id, token] = claimFirst(enqueue([], spec('m1'), 0), 0)
    expect(
      bindRemoteAttempt(claimed, id, token, {
        kind: 'dropbox',
        phase: 'prepared',
        ownerKey: OWNER_KEY,
        stagePath: '/.xmd-stage/v1/job/blob',
      }).changed,
    ).toBe(false)
    expect(
      bindRemoteAttempt(claimed, id, token, {
        kind: 'gdrive',
        ownerKey: 'short',
        fileId: 'drive-id',
      }).changed,
    ).toBe(false)
  })

  it('freezes placement once provider identity exists', () => {
    const [claimed, id, token] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const bound = bindRemoteAttempt(claimed, id, token, {
      kind: 'gdrive',
      ownerKey: OWNER_KEY,
      fileId: 'drive-id',
    }).ledger
    const failed = recordFailure(bound, id, token, 1, 'retry').ledger
    const refreshed = enqueue(
      failed,
      { ...spec('m1'), url: 'https://pbs.twimg.com/fresh.jpg', target: target('other/name.jpg') },
      2,
    )
    expect(refreshed[0]!.url).toContain('fresh.jpg')
    expect(refreshed[0]!.target.path).toBe('alice/m1.jpg')
  })
})

describe('outcomes', () => {
  it('records success with bytes + remoteId', () => {
    const [l, id, t] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const r = recordSuccess(l, id, t, 100, {
      bytes: 2048,
      remoteId: 'drive-id',
      remotePath: 'alice/m1.jpg',
    })
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

  it('bounds provider-controlled outcome fields before they enter the ledger', () => {
    const [failedLedger, failedId, failedToken] = claimFirst(enqueue([], spec('failure'), 0), 0)
    const failed = recordFailure(
      failedLedger,
      failedId,
      failedToken,
      0,
      'e'.repeat(MAX_UPLOAD_ERROR_LENGTH + 1),
    ).ledger
    expect(failed[0]!.error).toHaveLength(MAX_UPLOAD_ERROR_LENGTH)
    expect(decodeLedgerResult(failed).ok).toBe(true)

    const [doneLedger, doneId, doneToken] = claimFirst(enqueue([], spec('success'), 0), 0)
    const done = recordSuccess(doneLedger, doneId, doneToken, 1, {
      bytes: Number.POSITIVE_INFINITY,
      remoteId: 'r'.repeat(MAX_UPLOAD_REMOTE_ID_LENGTH + 1),
      remotePath: 'alice/m1.jpg',
    }).ledger
    expect(done[0]!.bytes).toBeUndefined()
    expect(done[0]!.remoteId).toBeUndefined()
    expect(decodeLedgerResult(done).ok).toBe(true)
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
  it('removes every status for one disconnected provider', () => {
    let ledger = enqueue([], spec('done', 'gdrive'), 0)
    const done = claim(ledger, ledger[0]!.jobId, 0)
    ledger = recordSuccess(done.ledger, ledger[0]!.jobId, done.token!, 1, {
      bytes: 1,
      remotePath: 'alice/m1.jpg',
    }).ledger
    ledger = enqueue(ledger, spec('pending', 'gdrive'), 0)
    ledger = enqueue(ledger, spec('other', 'dropbox'), 0)

    expect(removeProviderJobs(ledger, 'gdrive')).toMatchObject([{ provider: 'dropbox' }])
  })

  it('readyJobs honours backoff windows', () => {
    const l = enqueue([], { ...spec('m1'), url: 'u' }, 5000)
    expect(readyJobs(l, 4999)).toHaveLength(0)
    expect(readyJobs(l, 5000)).toHaveLength(1)
  })

  it('rebases impossible deadlines from durable job facts in a fresh worker', () => {
    const pending = enqueue([], spec('pending'), 1_000_000)[0]!
    const failedSeed = enqueue([], spec('failed'), 1_000_000)
    const failedClaim = claim(failedSeed, failedSeed[0]!.jobId, 1_000_000)
    const failed = recordFailure(
      failedClaim.ledger,
      failedSeed[0]!.jobId,
      failedClaim.token!,
      1_000_000,
      'offline',
    ).ledger[0]!
    const uploadSeed = enqueue([], spec('uploading'), 1_000_000)
    const uploading = claim(uploadSeed, uploadSeed[0]!.jobId, 1_000_000).ledger[0]!

    const rebased = rebaseUploadDeadlines([pending, failed, uploading], 1)
    expect(rebased.changed).toBe(true)
    expect(rebased.ledger.map((job) => job.nextAttemptAt)).toEqual([1, 5_001, 300_001])
    expect(rebased.ledger[2]).toMatchObject({
      leaseUntil: 300_001,
      attemptStartedAt: 1,
    })
  })

  it('pruneTerminal keeps only live jobs', () => {
    const [l, id, t] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const done = recordSuccess(l, id, t, 1, {
      bytes: 1,
      remotePath: 'alice/m1.jpg',
    }).ledger
    expect(pruneTerminal(done)).toHaveLength(0)
  })

  it('capLedger bounds terminal jobs but keeps live + most-recent terminal', () => {
    // 5 terminal (succeeded) + 1 live pending; cap terminal at 2
    let ledger: JobLedger = []
    for (let i = 0; i < 5; i += 1) {
      const withJob = enqueue(ledger, spec(`done${i}`), 0)
      const job = withJob[withJob.length - 1]!
      const c = claim(withJob, job.jobId, 0)
      ledger = recordSuccess(c.ledger, job.jobId, c.token!, 1, {
        bytes: 1,
        remotePath: 'alice/m1.jpg',
      }).ledger
    }
    ledger = enqueue(ledger, spec('live'), 0)
    const capped = capLedger(ledger, 2)
    expect(capped.filter((j) => j.status === 'succeeded')).toHaveLength(2)
    expect(capped.some((j) => j.requestId === 'live')).toBe(true)
    // keeps the most recent terminal jobs (done3, done4), drops the oldest
    expect(capped.map((j) => j.requestId)).toEqual(['done3', 'done4', 'live'])
  })

  it('capLedger is a no-op under the cap', () => {
    const [l, id, t] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const done = recordSuccess(l, id, t, 1, {
      bytes: 1,
      remotePath: 'alice/m1.jpg',
    }).ledger
    expect(capLedger(done, 50)).toBe(done)
  })

  it('summarize counts by status', () => {
    let l = enqueue([], spec('a'), 0)
    l = enqueue(l, spec('b'), 0)
    const [l2, id, t] = claimFirst(l, 0)
    const l3 = recordSuccess(l2, id, t, 1, {
      bytes: 1,
      remotePath: 'alice/m1.jpg',
    }).ledger
    expect(summarize(l3)).toMatchObject({ succeeded: 1, pending: 1 })
  })

  it('strict decode round-trips and distinguishes absence from corruption', () => {
    const l = enqueue([], spec('m1'), 0)
    expect(decodeAvailableLedger(JSON.parse(JSON.stringify(l)))).toEqual(l)
    expect(decodeLedgerResult(null)).toEqual({ ok: true, ledger: [] })
    expect(decodeLedgerResult('not a ledger')).toEqual({ ok: false })
  })
})

describe('durable ledger codec', () => {
  it('quarantines a pre-v2 non-X row instead of guessing its platform', () => {
    const current = baseJob()
    const legacy = {
      ...current,
      jobId: 'same-id:gdrive',
      idempotencyKey: 'same-id:gdrive',
      mediaId: 'same-id',
      url: 'https://cdninstagram.com/same-id.mp4',
    }
    delete (legacy as Partial<typeof legacy>).version
    delete (legacy as Partial<typeof legacy>).requestId

    const decoded = decodeLedgerStateResult([legacy])
    expect(decoded).toEqual({
      ok: true,
      migrationNeeded: true,
      state: expect.objectContaining({
        jobs: [],
        legacy: [expect.objectContaining({ mediaId: 'same-id' })],
      }),
    })
    if (!decoded.ok) throw new Error('expected legacy decode')
    expect(legacyConflict(decoded.state, ['same-id'], 'gdrive')).toMatchObject({
      provider: 'gdrive',
    })
    expect(legacyConflict(decoded.state, ['same-id'], 'dropbox')).toBeUndefined()
  })

  it('migrates a pre-v2 X row when its exact X URL proves the raw media key', () => {
    const current = baseJob()
    const legacy = {
      ...current,
      jobId: 'x-key:gdrive',
      idempotencyKey: 'x-key:gdrive',
      mediaId: 'x-key',
      url: 'https://video.twimg.com/path/x-key.mp4',
    }
    delete (legacy as Partial<typeof legacy>).version
    delete (legacy as Partial<typeof legacy>).requestId

    expect(decodeLedgerStateResult([legacy])).toEqual({
      ok: true,
      migrationNeeded: true,
      state: expect.objectContaining({
        jobs: [expect.objectContaining({ requestId: 'x-key' })],
        legacy: [],
      }),
    })
  })

  it('migrates the v4 state envelope with no ownership intent', () => {
    const current = baseJob()
    expect(
      decodeLedgerStateResult({
        version: 4,
        jobs: [current],
        legacy: [],
        quarantine: [],
      }),
    ).toEqual({
      ok: true,
      migrationNeeded: true,
      state: {
        version: 5,
        jobs: [current],
        legacy: [],
        quarantine: [],
        ownershipTransitions: [],
      },
    })
  })

  it('migrates v2 rows by stripping admission-only aliases without changing identity', () => {
    const current = baseJob()
    const v2 = { ...current, version: 2 as const, legacyAliases: ['m1'] }
    expect(decodeLedgerStateResult({ version: 2, jobs: [v2], legacy: [] })).toEqual({
      ok: true,
      migrationNeeded: true,
      state: expect.objectContaining({
        version: 5,
        jobs: [expect.objectContaining({ requestId: current.requestId, version: 4 })],
        legacy: [],
        quarantine: [],
        ownershipTransitions: [],
      }),
    })
    const decoded = decodeLedgerStateResult({ version: 2, jobs: [v2], legacy: [] })
    if (!decoded.ok) throw new Error('expected v2 migration')
    expect(decoded.state.jobs[0]).not.toHaveProperty('legacyAliases')
  })

  it('quarantines an in-flight v3 row instead of blindly retrying it', () => {
    const {
      version: _version,
      remoteAttempt: _remoteAttempt,
      remotePath: _remotePath,
      ...current
    } = baseJob()
    const v3 = {
      ...current,
      version: 3 as const,
      status: 'uploading' as const,
      leaseSeq: 2,
      leaseUntil: 100,
    }
    const decoded = decodeLedgerStateResult({ version: 3, jobs: [v3], legacy: [] })
    expect(decoded).toEqual({
      ok: true,
      migrationNeeded: true,
      state: {
        version: 5,
        jobs: [],
        legacy: [],
        quarantine: [v3],
        ownershipTransitions: [],
      },
    })
    if (!decoded.ok) throw new Error('expected v3 quarantine')
    expect(quarantineConflict(decoded.state, current.requestId, current.provider)).toEqual(v3)
    expect(decodeLedgerResult({ version: 3, jobs: [v3], legacy: [] })).toEqual({
      ok: true,
      ledger: [],
    })
  })

  it('rejects forged derived ids and duplicate logical jobs', () => {
    const job = baseJob()
    expect(acceptedLedger([{ ...job, jobId: 'forged' }])).toBe(false)
    expect(acceptedLedger([{ ...job, idempotencyKey: 'forged' }])).toBe(false)
    expect(acceptedLedger([job, { ...job }])).toBe(false)
    expect(
      acceptedLedger([
        {
          ...job,
          remoteAttempt: {
            kind: 'dropbox',
            phase: 'prepared',
            ownerKey: OWNER_KEY,
            stagePath: '/.xmd-stage/v1/job/blob',
          },
        },
      ]),
    ).toBe(false)
  })

  it('rejects excess job and nested target fields', () => {
    const job = baseJob()
    expect(acceptedLedger([{ ...job, accessToken: 'secret' }])).toBe(false)
    expect(acceptedLedger([{ ...job, target: { ...job.target, rootToken: 'secret' } }])).toBe(false)
  })

  it('bounds every durable string family', () => {
    const job = baseJob()
    const longMediaId = 'm'.repeat(MAX_SAVE_REQUEST_ID_LENGTH + 1)
    const longJobId = idempotencyKeyFor(longMediaId, job.provider)

    expect(
      acceptedLedger([
        {
          ...job,
          requestId: longMediaId,
          jobId: longJobId,
          idempotencyKey: longJobId,
        },
      ]),
    ).toBe(false)
    expect(
      acceptedLedger([
        {
          ...job,
          url: `https://${'u'.repeat(MAX_MEDIA_URL_LENGTH)}`,
        },
      ]),
    ).toBe(false)
    expect(
      acceptedLedger([
        {
          ...job,
          target: {
            ...job.target,
            path: 'p'.repeat(MAX_TRANSFER_FILENAME_LENGTH + 1),
          },
        },
      ]),
    ).toBe(false)
    expect(
      acceptedLedger([
        {
          ...job,
          target: {
            ...job.target,
            contentType: 'c'.repeat(MAX_UPLOAD_CONTENT_TYPE_LENGTH + 1),
          },
        },
      ]),
    ).toBe(false)
    expect(
      acceptedLedger([{ ...job, error: 'e'.repeat(MAX_STORED_UPLOAD_ERROR_LENGTH + 1) }]),
    ).toBe(false)
    expect(
      acceptedLedger([{ ...job, remoteId: 'r'.repeat(MAX_UPLOAD_REMOTE_ID_LENGTH + 1) }]),
    ).toBe(false)
    expect(acceptedLedger([{ ...job, remoteId: '' }])).toBe(true)
  })

  it('bounds entries and total serialized bytes before schema traversal', () => {
    const job = baseJob()
    const tooMany = Array.from({ length: MAX_UPLOAD_JOBS + 1 }, (_, index) => {
      const mediaId = `m${index}`
      const identity = idempotencyKeyFor(mediaId, job.provider)
      return { ...job, mediaId, jobId: identity, idempotencyKey: identity }
    })

    expect(acceptedLedger(tooMany)).toBe(false)
    expect(acceptedLedger('x'.repeat(MAX_UPLOAD_LEDGER_BYTES + 1))).toBe(false)
  })

  it('rejects unsafe numeric state instead of reviving corrupt work', () => {
    const job = baseJob()
    expect(acceptedLedger([{ ...job, attempts: 0.5 }])).toBe(false)
    expect(acceptedLedger([{ ...job, attempts: MAX_ATTEMPTS + 1 }])).toBe(false)
    expect(acceptedLedger([{ ...job, leaseSeq: Number.POSITIVE_INFINITY }])).toBe(false)
    expect(acceptedLedger([{ ...job, bytes: -1 }])).toBe(false)
  })
})

describe('claim / transition guards', () => {
  it('refuses to claim an unknown job', () => {
    const r = claim([], 'nope', 0)
    expect(r).toMatchObject({ claimed: false, reason: 'not found' })
  })

  it('refuses to claim a terminal job (reports its status)', () => {
    const [l, id, t] = claimFirst(enqueue([], spec('m1'), 0), 0)
    const done = recordSuccess(l, id, t, 1, {
      bytes: 1,
      remotePath: 'alice/m1.jpg',
    }).ledger
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
    expect(recordSuccess(l, id, 1, 0, { bytes: 1, remotePath: 'alice/m1.jpg' }).changed).toBe(false)
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

  it('does not move a retry deadline backwards when the wall clock rolls back', () => {
    const l0 = enqueue([], spec('m1'), 10_000)
    const claimed = claim(l0, l0[0]!.jobId, 10_000)
    const failed = recordFailure(
      claimed.ledger,
      l0[0]!.jobId,
      claimed.token!,
      1_000,
      'provider offline',
    )
    expect(failed.ledger[0]!.nextAttemptAt).toBeGreaterThanOrEqual(10_000)
  })

  it('saturates a lease deadline at Number.MAX_SAFE_INTEGER', () => {
    const l0 = enqueue([], spec('m1'), Number.MAX_SAFE_INTEGER - 1)
    const claimed = claim(l0, l0[0]!.jobId, Number.MAX_SAFE_INTEGER - 1, 10)
    expect(claimed.claimed).toBe(true)
    expect(claimed.ledger[0]!).toMatchObject({
      leaseUntil: Number.MAX_SAFE_INTEGER,
      nextAttemptAt: Number.MAX_SAFE_INTEGER,
    })
  })

  it('refuses to exhaust the monotonic lease fencing token', () => {
    const l0 = [{ ...baseJob(), leaseSeq: Number.MAX_SAFE_INTEGER }]
    const claimed = claim(l0, l0[0]!.jobId, 0)
    expect(claimed.claimed).toBe(false)
    expect(claimed.ledger[0]!).toMatchObject({
      status: 'dead',
      leaseSeq: Number.MAX_SAFE_INTEGER,
      error: 'lease sequence exhausted',
    })
  })
})

describe('toWireUploadJob / WireUploadJob', () => {
  const decode = Schema.decodeUnknownSync(WireUploadJob)

  it('projects a succeeded job (bytes present, error null) into the Convex mirror shape', () => {
    const [l0, id, tok] = claimFirst(enqueue([], spec('m1', 'dropbox'), 0), 0)
    const job = recordSuccess(l0, id, tok, 1000, {
      bytes: 4096,
      remoteId: 'r1',
      remotePath: '/alice/m1 (1).jpg',
    }).ledger[0]!
    const wire = toWireUploadJob(job, 'dev-7', 5000)
    expect(wire).toEqual({
      jobId: 'xmd:cloud:v2:wire:5:dev-7:2:m1:dropbox',
      deviceId: 'dev-7',
      requestId: 'm1',
      provider: 'dropbox',
      status: 'succeeded',
      attempts: job.attempts,
      revision: job.leaseSeq,
      at: 5000,
      remotePath: '/alice/m1 (1).jpg',
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
    expect(wire.jobId).toBe('xmd:cloud:v2:wire:5:dev-7:2:m2:gdrive')
    expect(wire.status).toBe('failed')
    expect(wire.error).toBe('boom')
    expect('bytes' in wire).toBe(false)
    expect(decode(wire)).toEqual(wire)
  })

  it.each([
    ['fractional attempts', { attempts: 0.5 }],
    ['non-finite time', { at: Number.NaN }],
    ['negative bytes', { bytes: -1 }],
    ['empty device identity', { deviceId: '' }],
    ['oversized remote path', { remotePath: 'x'.repeat(4097) }],
  ])('rejects %s at the client wire boundary', (_case, patch) => {
    const [ledger] = claimFirst(enqueue([], spec('m1', 'dropbox'), 0), 0)
    const wire = { ...toWireUploadJob(ledger[0]!, 'dev-7', 5000), ...patch }
    expect(() => decode(wire)).toThrow('Expected')
  })
})
