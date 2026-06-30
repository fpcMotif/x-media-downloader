import { describe, it, expect } from 'vitest'
import { classifyUploadError, describeUploadSummary } from './status'
import type { UploadSummary } from './upload-job'

const summary = (over: Partial<UploadSummary> = {}): UploadSummary => ({
  pending: 0,
  uploading: 0,
  succeeded: 0,
  failed: 0,
  dead: 0,
  skipped: 0,
  ...over,
})

describe('classifyUploadError', () => {
  it.each([
    ['HTTP 401 from provider', /Authorization expired/],
    ['invalid_grant', /Authorization expired/],
    ['unauthorized request', /Authorization expired/],
    ['no refresh_token — reconnect', /Authorization expired/],
    ['HTTP 403 forbidden', /re-grant access/],
    ['insufficientScopes', /re-grant access/],
    ['access_denied', /re-grant access/],
    ['HTTP 429 slow down', /rate-limited/],
    ['rateLimit exceeded', /rate-limited/],
    ['too_many_requests', /rate-limited/],
    ['HTTP 503 upstream', /retrying shortly/],
    ['sourceGone', /link expired/],
    ['the media link rotted', /link expired/],
    ['quotaExceeded', /storage is full/],
    ['storageQuota reached', /storage is full/],
  ])('maps %j to an actionable line', (reason, expected) => {
    expect(classifyUploadError(reason)).toMatch(expected)
  })

  it('matches earlier rules first: a "5xx" source error reads as a transient provider error', () => {
    // `/HTTP 5\d\d/` precedes the source/link rule, so "source HTTP 500" is transient.
    expect(classifyUploadError('source HTTP 500')).toMatch(/retrying shortly/)
  })

  it('passes through an unrecognized reason verbatim', () => {
    expect(classifyUploadError('something weird happened')).toBe('something weird happened')
  })

  it('prefers the auth class over the storage class when both could match', () => {
    // "HTTP 401" is checked first, so an auth message wins even with other tokens.
    expect(classifyUploadError('HTTP 401 quotaExceeded')).toMatch(/Authorization expired/)
  })

  it.each([
    [401, /Authorization expired/],
    [403, /re-grant access/],
    [429, /rate-limited/],
    [500, /retrying shortly/],
    [503, /retrying shortly/],
  ])('dispatches a tagged provider status %i structurally, ignoring the message', (status, expected) => {
    // With a numeric status (from CloudHttpError) the opaque message is irrelevant.
    expect(classifyUploadError('opaque provider error', status)).toMatch(expected)
  })

  it('falls back to the message rules for a status it does not special-case (404)', () => {
    expect(classifyUploadError('source HTTP 404', 404)).toMatch(/link expired/)
  })
})

describe('describeUploadSummary', () => {
  it('reports nothing yet when the ledger is empty of outcomes', () => {
    expect(describeUploadSummary(summary())).toBe('No uploads yet.')
  })

  it('reports in-flight progress (pending + uploading) without retries', () => {
    expect(describeUploadSummary(summary({ succeeded: 2, pending: 1, uploading: 2 }))).toBe(
      'Uploading — 2 done, 3 in progress.',
    )
  })

  it('appends a retrying count when failures are queued for backoff', () => {
    expect(describeUploadSummary(summary({ uploading: 1, failed: 2 }))).toBe(
      'Uploading — 0 done, 1 in progress, 2 retrying.',
    )
  })

  it('summarizes a settled ledger with successes only', () => {
    expect(describeUploadSummary(summary({ succeeded: 3 }))).toBe('3 uploaded.')
  })

  it('includes dead + skipped breakdown when settled', () => {
    expect(describeUploadSummary(summary({ succeeded: 1, dead: 2, skipped: 4 }))).toBe(
      '1 uploaded · 2 failed · 4 skipped (link expired).',
    )
  })

  it('treats a ledger with only skips/deads as settled (not "no uploads yet")', () => {
    expect(describeUploadSummary(summary({ skipped: 1 }))).toBe(
      '0 uploaded · 1 skipped (link expired).',
    )
    expect(describeUploadSummary(summary({ dead: 1 }))).toBe('0 uploaded · 1 failed.')
  })
})
