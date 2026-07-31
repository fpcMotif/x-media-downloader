import { describe, it, expect } from 'vitest'
import { classifyRecoveryReply } from './recovery-classify'

const photo = {
  type: 'photo',
  media_url_https: 'https://pbs.twimg.com/media/AAA.jpg',
}

const video = {
  type: 'video',
  media_url_https: 'https://pbs.twimg.com/media/BBB.jpg',
  video_info: {
    variants: [
      { content_type: 'video/mp4', url: 'https://video.twimg.com/x/720.mp4', bitrate: 832_000 },
      { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/x/master.m3u8' },
    ],
  },
}

const reply = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id_str: 't1',
    user: { screen_name: 'alice' },
    mediaDetails: [video],
    ...over,
  })

describe('classifyRecoveryReply', () => {
  it('recovers the tweet’s media', () => {
    const out = classifyRecoveryReply('t1', reply())
    expect(out.kind).toBe('recovered')
    if (out.kind !== 'recovered') return
    expect(out.items).toHaveLength(1)
    expect(out.items[0]).toMatchObject({ postId: 't1', author: 'alice', type: 'video' })
  })

  it('recovers photos too — Recovery is not video-only', () => {
    // The branch this was ported from filtered `type !== 'photo'` here. Main's
    // `addRecovered` accepts recovered photos, so filtering them would have been
    // a silent behaviour change smuggled in with the classifier.
    const out = classifyRecoveryReply('t1', reply({ mediaDetails: [photo] }))
    expect(out.kind).toBe('recovered')
    if (out.kind !== 'recovered') return
    expect(out.items.map((i) => i.type)).toEqual(['photo'])
  })

  describe('retryable — the reply said nothing about this tweet, so release the claim', () => {
    it('no body at all', () => {
      expect(classifyRecoveryReply('t1', undefined)).toEqual({
        kind: 'retryable',
        reason: 'no-body',
      })
    })

    it('body is not JSON', () => {
      expect(classifyRecoveryReply('t1', '<html>rate limited</html>')).toEqual({
        kind: 'retryable',
        reason: 'unparseable',
      })
    })

    it('body is JSON but not an object', () => {
      for (const body of ['null', '42', '"a string"', '[]'])
        expect(classifyRecoveryReply('t1', body)).toEqual({
          kind: 'retryable',
          reason: 'unparseable',
        })
    })

    it('the reply is for a DIFFERENT tweet', () => {
      // parseSyndicationTweet trusts the payload's own id_str, so without this
      // check t2's media would be folded in under a request for t1.
      expect(classifyRecoveryReply('t1', reply({ id_str: 't2' }))).toEqual({
        kind: 'retryable',
        reason: 'wrong-tweet',
      })
    })

    it('the reply carries no id_str at all', () => {
      const { id_str: _dropped, ...rest } = JSON.parse(reply()) as Record<string, unknown>
      expect(classifyRecoveryReply('t1', JSON.stringify(rest))).toEqual({
        kind: 'retryable',
        reason: 'wrong-tweet',
      })
    })

    it('mediaDetails is present but not an array (response-shape drift)', () => {
      expect(classifyRecoveryReply('t1', reply({ mediaDetails: { '0': video } }))).toEqual({
        kind: 'retryable',
        reason: 'bad-shape',
      })
    })

    it('a media entry that makes the resolver THROW', () => {
      // `parseSyndicationTweet` is not total — an entry without
      // `media_url_https` reaches `mediaBasenameKey` as undefined and throws.
      // The old call site caught this in the same block as bad JSON and
      // returned without releasing the claim, permanently burning the attempt.
      expect(classifyRecoveryReply('t1', reply({ mediaDetails: [{ type: 'photo' }] }))).toEqual({
        kind: 'retryable',
        reason: 'bad-shape',
      })
    })
  })

  describe('exhausted — the endpoint answered, keep the claim so it cannot loop', () => {
    it('mediaDetails absent', () => {
      const { mediaDetails: _dropped, ...rest } = JSON.parse(reply()) as Record<string, unknown>
      expect(classifyRecoveryReply('t1', JSON.stringify(rest))).toEqual({
        kind: 'exhausted',
        reason: 'no-media',
      })
    })

    it('mediaDetails is an empty array', () => {
      expect(classifyRecoveryReply('t1', reply({ mediaDetails: [] }))).toEqual({
        kind: 'exhausted',
        reason: 'no-media',
      })
    })

    it('media entries are well-formed but resolve to nothing usable', () => {
      // A photo entry the resolver can read but yields no item from.
      expect(
        classifyRecoveryReply(
          't1',
          reply({ mediaDetails: [{ type: 'poll', media_url_https: 'https://x/' }] }),
        ),
      ).toEqual({ kind: 'exhausted', reason: 'no-media' })
    })
  })

  it('an id_str that only loosely matches is still the wrong tweet', () => {
    // Strict equality, not coercion: syndication ids are strings and a numeric
    // id_str is drift, not a match.
    expect(classifyRecoveryReply('1', reply({ id_str: 1 })).kind).toBe('retryable')
  })
})
