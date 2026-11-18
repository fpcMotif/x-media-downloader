import { describe, expect, it } from 'vitest'
import { makeReleaseThrottle, noteReleaseReply } from '../throttle'

describe('makeReleaseThrottle', () => {
  it('starts unblocked with blockedForMs equal to 0', () => {
    const throttle = makeReleaseThrottle({ now: () => 1_000 })
    expect(throttle.blockedForMs()).toBe(0)
  })

  it('blocks for the base period after one strike and expires after 60_000 ms', () => {
    let t = 1_000
    const throttle = makeReleaseThrottle({ now: () => t })
    throttle.noteRateLimited()
    expect(throttle.blockedForMs()).toBe(60_000)
    t += 60_000
    expect(throttle.blockedForMs()).toBe(0)
  })

  it('doubles the period on repeated strikes up to the 900_000 ms cap', () => {
    const throttle = makeReleaseThrottle({ now: () => 1_000 })
    throttle.noteRateLimited()
    expect(throttle.blockedForMs()).toBe(60_000)
    throttle.noteRateLimited()
    expect(throttle.blockedForMs()).toBe(120_000)
    throttle.noteRateLimited()
    expect(throttle.blockedForMs()).toBe(240_000)
    for (let i = 4; i <= 10; i++) throttle.noteRateLimited()
    expect(throttle.blockedForMs()).toBe(900_000)
  })

  it('resets the strike count on noteAnswered without ending a running block', () => {
    let t = 1_000
    const throttle = makeReleaseThrottle({ now: () => t })
    throttle.noteRateLimited()
    t += 10_000
    throttle.noteAnswered()
    expect(throttle.blockedForMs()).toBe(50_000)
    t += 50_000
    expect(throttle.blockedForMs()).toBe(0)
    throttle.noteRateLimited()
    expect(throttle.blockedForMs()).toBe(60_000)
  })

  it('blocks on HTTP 429 and does not block on 200 or 500 in noteReleaseReply', () => {
    const throttle = makeReleaseThrottle({ now: () => 1_000 })
    noteReleaseReply(throttle, 200)
    expect(throttle.blockedForMs()).toBe(0)
    noteReleaseReply(throttle, 500)
    expect(throttle.blockedForMs()).toBe(0)
    noteReleaseReply(throttle, 429)
    expect(throttle.blockedForMs()).toBe(60_000)
  })
})
