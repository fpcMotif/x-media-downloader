import { describe, it, expect } from 'vitest'
import { META_CDN_HOSTS } from './cdn'

describe('META_CDN_HOSTS', () => {
  it('is the single cdninstagram.com entry, with subdomains included', () => {
    // No fbcdn.net evidence exists anywhere in this repo's fixtures/tests
    // (adapter tests, meta-shared tests) as of this writing — every captured
    // Instagram/Threads media url in the repo is cdninstagram.com. Add an
    // fbcdn.net entry here ONLY once a real captured url demands it, per
    // `docs/adr/0019`.
    expect(META_CDN_HOSTS).toEqual([{ host: 'cdninstagram.com', includeSubdomains: true }])
  })
})
