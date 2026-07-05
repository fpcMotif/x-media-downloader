import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../schema'
import { makeDetectionStore, keysForItem, postVideoKey, postVideoKeyById } from './detection-store'
import { mediaKeyFromUrl } from './x/dom'

/** twimg URLs so mediaKeyFromUrl yields a real key (final path segment, no ext). */
const photo = (id: string, key: string, tweetId = 't1'): MediaItem => ({
  id,
  platform: 'x',
  postId: tweetId,
  author: 'alice',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${key}.jpg?name=orig`,
  previewUrl: `https://pbs.twimg.com/media/${key}.jpg`,
  ext: 'jpg',
  index: 0,
})

const video = (id: string, mp4Key: string, posterKey: string, tweetId = 't1'): MediaItem => ({
  id,
  platform: 'x',
  postId: tweetId,
  author: 'alice',
  type: 'video',
  url: `https://video.twimg.com/ext_tw_video/9/pu/vid/720x720/${mp4Key}.mp4?tag=12`,
  previewUrl: `https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/${posterKey}.jpg`,
  ext: 'mp4',
  index: 0,
})

describe('keysForItem', () => {
  it('returns the url + previewUrl twimg media keys', () => {
    expect(keysForItem(video('v', 'MP4', 'POST'), mediaKeyFromUrl)).toEqual(['MP4', 'POST'])
  })
  it('dedups when url and previewUrl share a key', () => {
    expect(keysForItem(photo('p', 'KA'), mediaKeyFromUrl)).toEqual(['KA'])
  })
  it('omits a missing previewUrl', () => {
    expect(keysForItem({ ...photo('p', 'KA'), previewUrl: undefined }, mediaKeyFromUrl)).toEqual([
      'KA',
    ])
  })
  it('falls back to previewUrl when the url is not twimg', () => {
    expect(
      keysForItem(
        { ...video('v', 'MP4', 'POST'), url: 'https://example.com/x.mp4' },
        mediaKeyFromUrl,
      ),
    ).toEqual(['POST'])
  })
  it('returns [] when neither url nor previewUrl is twimg', () => {
    expect(
      keysForItem(
        {
          ...photo('p', 'KA'),
          url: 'https://example.com/a.jpg',
          previewUrl: 'https://example.com/b.jpg',
        },
        mediaKeyFromUrl,
      ),
    ).toEqual([])
  })
})

describe('makeDetectionStore — behavior-preserving (M2 characterization)', () => {
  it('addDetected returns newly-added, dedups by id, indexes by id and key', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const a = photo('a', 'KA')
    expect(s.addDetected([a])).toEqual([a])
    expect(s.addDetected([a])).toEqual([]) // same id → not newly added
    expect(s.count).toBe(1)
    expect(s.get('a')).toEqual(a)
    expect(s.resolve('KA')).toEqual(a)
    expect(s.keyIndex().get('KA')).toEqual(a)
    expect(s.keyIndex().has('KA')).toBe(true)
    expect(s.values()).toEqual([a])
  })

  it('dedups the same media across tee and DOM by media-key id (ADR-0016)', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    // Tee and DOM both key a photo by its media key, so the SAME media yields the
    // SAME id → counted once (the old tee-vs-DOM double-count is gone).
    s.addDetected([photo('KA', 'KA')])
    s.addDetected([photo('KA', 'KA')])
    expect(s.count).toBe(1)
  })

  it('addRecovered skips photos, skips already-known keys, records recovered keys', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST')
    expect(s.addRecovered([v])).toEqual([v])
    expect(s.resolve('MP4')).toEqual(v)
    expect(s.resolve('POST')).toEqual(v)
    // photo is never recovered (DOM-detectable)
    expect(s.addRecovered([photo('p', 'KZ')])).toEqual([])
    // key already known → skipped
    expect(s.addRecovered([video('v1b', 'MP4', 'POST')])).toEqual([])
  })

  it('a later tee re-surfacing of a recovered video (different id) is suppressed', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.addRecovered([video('vKey', 'MP4', 'POST')])
    // tee later adds the SAME media under a different id scheme → recoveredKeys guard
    expect(s.addDetected([video('99', 'MP4', 'POST')])).toEqual([])
    expect(s.count).toBe(1)
  })

  it('addRecovered skips a video the tee already detected', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.addDetected([video('v1', 'MP4', 'POST')]) // tee already has it
    expect(s.addRecovered([video('v1', 'MP4', 'POST')])).toEqual([])
  })

  it('markAttempted is once-per-tweet; unmarkAttempted re-arms it', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    expect(s.markAttempted('t9')).toBe(true)
    expect(s.markAttempted('t9')).toBe(false)
    s.unmarkAttempted('t9')
    expect(s.markAttempted('t9')).toBe(true)
  })

  it('valuesForTweet filters by tweetId', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.addDetected([photo('a', 'KA', 't1'), photo('b', 'KB', 't2'), photo('c', 'KC', 't1')])
    expect(s.valuesForTweet('t1').map((i) => i.id)).toEqual(['a', 'c'])
    expect(s.valuesForTweet('t2').map((i) => i.id)).toEqual(['b'])
  })

  it('needsRecovery wraps videoTweetsNeedingRecovery with the store keys', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <article data-testid="tweet">
        <a href="/alice/status/55"><time>now</time></a>
        <div data-testid="videoPlayer"><video></video>
          <img src="https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/POST.jpg" />
        </div>
      </article>`
    const s = makeDetectionStore({ mediaKeyFromUrl })
    expect(s.needsRecovery(root)).toEqual(['55']) // poster key 'POST' unknown
    s.addRecovered([video('v', 'MP4', 'POST')]) // now the poster key is known
    expect(s.needsRecovery(root)).toEqual([]) // skipped
  })

  it('clear empties items, keys, recovered keys, and attempts', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.addRecovered([video('v', 'MP4', 'POST')])
    s.markAttempted('t1')
    s.clear()
    expect(s.count).toBe(0)
    expect(s.resolve('MP4')).toBeUndefined()
    // recoveredKeys reset → the same media can be added again
    expect(s.addDetected([video('v', 'MP4', 'POST')])).toHaveLength(1)
    // attempts reset → tweet can be re-attempted
    expect(s.markAttempted('t1')).toBe(true)
  })
})

describe('post-level video key (post:id:{postId} / post:code:{code})', () => {
  it('registers post:id:{postId} for a single-video post', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST', 'postA')
    s.addDetected([v])
    expect(s.keyIndex().get(postVideoKeyById('postA'))).toEqual(v)
    expect(s.resolve(postVideoKeyById('postA'))).toEqual(v)
  })

  it('does NOT register for a 2-video carousel post', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.addDetected([video('v1', 'MP4A', 'POSTA', 'postB'), video('v2', 'MP4B', 'POSTB', 'postB')])
    expect(s.keyIndex().has(postVideoKeyById('postB'))).toBe(false)
  })

  it('de-registers if a 2nd video for the same post arrives later', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.addDetected([video('v1', 'MP4A', 'POSTA', 'postC')])
    expect(s.keyIndex().has(postVideoKeyById('postC'))).toBe(true)
    s.addDetected([video('v2', 'MP4B', 'POSTB', 'postC')])
    expect(s.keyIndex().has(postVideoKeyById('postC'))).toBe(false)
  })

  it('ignores photos (never registers a post-key for a photo-only post)', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.addDetected([photo('p1', 'KA', 'postD')])
    expect(s.keyIndex().has(postVideoKeyById('postD'))).toBe(false)
  })

  it('clear() wipes videosByPost bookkeeping too', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.addDetected([video('v1', 'MP4', 'POST', 'postE')])
    expect(s.keyIndex().has(postVideoKeyById('postE'))).toBe(true)
    s.clear()
    s.addDetected([video('v1', 'MP4', 'POST', 'postE')])
    expect(s.keyIndex().has(postVideoKeyById('postE'))).toBe(true)
  })

  it('a duplicate addDetected call for the same video item does not inflate the per-post count', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST', 'postF')
    s.addDetected([v])
    s.addDetected([v])
    expect(s.keyIndex().has(postVideoKeyById('postF'))).toBe(true)
  })

  it('registerPostCode called AFTER addDetected still resolves post:{code}', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST', 'postG')
    s.addDetected([v])
    s.registerPostCode('postG', 'CODEG')
    expect(s.keyIndex().get(postVideoKey('CODEG'))).toEqual(v)
  })

  it('registerPostCode called BEFORE addDetected also resolves post:{code}', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postH', 'CODEH')
    const v = video('v1', 'MP4', 'POST', 'postH')
    s.addDetected([v])
    expect(s.keyIndex().get(postVideoKey('CODEH'))).toEqual(v)
  })

  it('registerPostCode for a postId that never gets a video is a harmless no-op', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postI', 'CODEI')
    expect(s.keyIndex().has(postVideoKey('CODEI'))).toBe(false)
  })

  it('a 2-video post keeps BOTH post:id:{postId} and post:code:{code} absent', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postJ', 'CODEJ')
    s.addDetected([video('v1', 'MP4A', 'POSTA', 'postJ'), video('v2', 'MP4B', 'POSTB', 'postJ')])
    expect(s.keyIndex().has(postVideoKeyById('postJ'))).toBe(false)
    expect(s.keyIndex().has(postVideoKey('CODEJ'))).toBe(false)
  })

  it('a postId and an unrelated post code that are the SAME raw string never collide', () => {
    // Regression test for the pre-namespacing risk: post:{x} was one flat
    // string space shared by both raw postIds and DOM-derived codes, so a
    // postId and a totally unrelated post's code that happened to share the
    // same literal string ('SHARED' here) would silently overwrite one
    // another's byKey entry. post:id:/post:code: namespacing below prevents
    // this even when the strings collide.
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const vId = video('vId', 'MP4ID', 'POSTID', 'SHARED')
    s.addDetected([vId])
    s.registerPostCode('unrelatedPost', 'SHARED')
    const vCode = video('vCode', 'MP4CODE', 'POSTCODE', 'unrelatedPost')
    s.addDetected([vCode])
    expect(s.keyIndex().get(postVideoKeyById('SHARED'))).toEqual(vId)
    expect(s.keyIndex().get(postVideoKey('SHARED'))).toEqual(vCode)
  })

  it('syncing one post leaves an unrelated registered code -> post mapping untouched', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    // postK registers first and gets its video — establishes an entry in
    // codeToPostId that a LATER sync (for a different post) must skip over.
    s.registerPostCode('postK', 'CODEK')
    const vK = video('vK', 'MP4K', 'POSTK', 'postK')
    s.addDetected([vK])
    expect(s.keyIndex().get(postVideoKey('CODEK'))).toEqual(vK)

    // postL is a completely separate post/video/code triple.
    s.registerPostCode('postL', 'CODEL')
    const vL = video('vL', 'MP4L', 'POSTL', 'postL')
    s.addDetected([vL])

    // postK's code-keyed entry must still resolve to vK, unaffected by postL's sync.
    expect(s.keyIndex().get(postVideoKey('CODEK'))).toEqual(vK)
    expect(s.keyIndex().get(postVideoKey('CODEL'))).toEqual(vL)
  })
})
