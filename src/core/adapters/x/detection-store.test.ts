import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../../schema'
import { makeDetectionStore, keysForItem } from './detection-store'

/** twimg URLs so mediaKeyFromUrl yields a real key (final path segment, no ext). */
const photo = (id: string, key: string, tweetId = 't1'): MediaItem => ({
  id,
  tweetId,
  handle: 'alice',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${key}.jpg?name=orig`,
  previewUrl: `https://pbs.twimg.com/media/${key}.jpg`,
  ext: 'jpg',
  index: 0,
})

const video = (id: string, mp4Key: string, posterKey: string, tweetId = 't1'): MediaItem => ({
  id,
  tweetId,
  handle: 'alice',
  type: 'video',
  url: `https://video.twimg.com/ext_tw_video/9/pu/vid/720x720/${mp4Key}.mp4?tag=12`,
  previewUrl: `https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/${posterKey}.jpg`,
  ext: 'mp4',
  index: 0,
})

describe('keysForItem', () => {
  it('returns the url + previewUrl twimg media keys', () => {
    expect(keysForItem(video('v', 'MP4', 'POST'))).toEqual(['MP4', 'POST'])
  })
  it('dedups when url and previewUrl share a key', () => {
    expect(keysForItem(photo('p', 'KA'))).toEqual(['KA'])
  })
  it('omits a missing previewUrl', () => {
    expect(keysForItem({ ...photo('p', 'KA'), previewUrl: undefined })).toEqual(['KA'])
  })
  it('falls back to previewUrl when the url is not twimg', () => {
    expect(keysForItem({ ...video('v', 'MP4', 'POST'), url: 'https://example.com/x.mp4' })).toEqual(
      ['POST'],
    )
  })
  it('returns [] when neither url nor previewUrl is twimg', () => {
    expect(
      keysForItem({
        ...photo('p', 'KA'),
        url: 'https://example.com/a.jpg',
        previewUrl: 'https://example.com/b.jpg',
      }),
    ).toEqual([])
  })
})

describe('makeDetectionStore — behavior-preserving (M2 characterization)', () => {
  it('addDetected returns newly-added, dedups by id, indexes by id and key', () => {
    const s = makeDetectionStore()
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
    const s = makeDetectionStore()
    // Tee and DOM both key a photo by its media key, so the SAME media yields the
    // SAME id → counted once (the old tee-vs-DOM double-count is gone).
    s.addDetected([photo('KA', 'KA')])
    s.addDetected([photo('KA', 'KA')])
    expect(s.count).toBe(1)
  })

  it('addRecovered skips photos, skips already-known keys, records recovered keys', () => {
    const s = makeDetectionStore()
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
    const s = makeDetectionStore()
    s.addRecovered([video('vKey', 'MP4', 'POST')])
    // tee later adds the SAME media under a different id scheme → recoveredKeys guard
    expect(s.addDetected([video('99', 'MP4', 'POST')])).toEqual([])
    expect(s.count).toBe(1)
  })

  it('addRecovered skips a video the tee already detected', () => {
    const s = makeDetectionStore()
    s.addDetected([video('v1', 'MP4', 'POST')]) // tee already has it
    expect(s.addRecovered([video('v1', 'MP4', 'POST')])).toEqual([])
  })

  it('markAttempted is once-per-tweet; unmarkAttempted re-arms it', () => {
    const s = makeDetectionStore()
    expect(s.markAttempted('t9')).toBe(true)
    expect(s.markAttempted('t9')).toBe(false)
    s.unmarkAttempted('t9')
    expect(s.markAttempted('t9')).toBe(true)
  })

  it('valuesForTweet filters by tweetId', () => {
    const s = makeDetectionStore()
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
    const s = makeDetectionStore()
    expect(s.needsRecovery(root)).toEqual(['55']) // poster key 'POST' unknown
    s.addRecovered([video('v', 'MP4', 'POST')]) // now the poster key is known
    expect(s.needsRecovery(root)).toEqual([]) // skipped
  })

  it('clear empties items, keys, recovered keys, and attempts', () => {
    const s = makeDetectionStore()
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
