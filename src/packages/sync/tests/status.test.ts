import { describe, it, expect } from 'vitest'
import { ConvexFunctionError, ConvexHttpError, ConvexMalformedError } from '../convex'
import { classifySyncError, describeSyncOk } from '../status'

describe('classifySyncError', () => {
  it('points at deploying the backend when the function is missing (URL valid, never pushed)', () => {
    expect(
      classifySyncError(new Error("Could not find public function for 'sync:recordEvents'.")),
    ).toMatch(/deploy the backend/)
  })

  it('points at the deployment URL on an edge 404 (no such deployment)', () => {
    expect(classifySyncError(new Error('convex: HTTP 404'))).toMatch(/deployment URL/)
  })

  it('points at the shared secret on an unauthorized function error', () => {
    expect(classifySyncError(new Error('unauthorized: bad or missing sync secret'))).toMatch(
      /SYNC_SHARED_SECRET/,
    )
  })

  it('relays other 4xx and 5xx codes distinctly', () => {
    expect(classifySyncError(new Error('convex: HTTP 400'))).toMatch(/rejected/)
    expect(classifySyncError(new Error('convex: HTTP 503'))).toMatch(/try again/)
  })

  it('flags a non-Convex body', () => {
    expect(classifySyncError(new Error('convex: malformed response'))).toMatch(/Convex deployment/)
  })

  it('falls back to a reachability hint for a raw fetch rejection', () => {
    expect(classifySyncError(new TypeError('Failed to fetch'))).toMatch(
      /Could not reach the deployment/,
    )
  })

  it('handles non-Error throws', () => {
    expect(classifySyncError('boom')).toContain('boom')
  })

  // The port throws tagged errors; the classifier switches on the discriminant
  // (status / _tag) and must produce the same lines as the legacy string match.
  it('classifies a tagged HTTP error by status code, not by message text', () => {
    expect(classifySyncError(new ConvexHttpError({ status: 404 }))).toMatch(/deployment URL/)
    expect(classifySyncError(new ConvexHttpError({ status: 400 }))).toBe(
      'Deployment rejected the request (convex: HTTP 400).',
    )
    expect(classifySyncError(new ConvexHttpError({ status: 503 }))).toBe(
      'Deployment error (convex: HTTP 503) — try again shortly.',
    )
  })

  it('falls back to a reachability hint for an HTTP status outside 4xx/5xx', () => {
    expect(classifySyncError(new ConvexHttpError({ status: 302 }))).toMatch(
      /Could not reach the deployment.*convex: HTTP 302/,
    )
  })

  it('classifies a tagged function error by its server errorMessage', () => {
    expect(
      classifySyncError(
        new ConvexFunctionError({ errorMessage: "Could not find public function for 'x'." }),
      ),
    ).toMatch(/deploy the backend/)
    expect(
      classifySyncError(new ConvexFunctionError({ errorMessage: 'unauthorized: bad secret' })),
    ).toMatch(/SYNC_SHARED_SECRET/)
    expect(
      classifySyncError(new ConvexFunctionError({ errorMessage: 'some other failure' })),
    ).toMatch(/Could not reach the deployment.*some other failure/)
  })

  it('classifies a tagged malformed error', () => {
    expect(
      classifySyncError(new ConvexMalformedError({ detail: 'convex: malformed response' })),
    ).toMatch(/Convex deployment/)
  })
})

describe('describeSyncOk', () => {
  it('reports a clean connection with nothing queued', () => {
    expect(describeSyncOk(0)).toMatch(/working/)
  })

  it('singularizes vs pluralizes the pending count', () => {
    expect(describeSyncOk(1)).toContain('1 event still queued')
    expect(describeSyncOk(3)).toContain('3 events still queued')
  })
})
