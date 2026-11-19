import { describe, it, expect } from 'vitest'
import type { MediaItem } from '@/packages/schema'
import {
  DEFAULT_MAX_RETAINED_ITEMS,
  makeDetectionStore,
  keysForItem,
  postGrabItems,
  postVideoKey,
  postVideoKeyIndexed,
  postVideoKeyByDomSlot,
} from './detection-store'
import { mediaKeyFromUrl } from './x/dom'
import { videoTweetsNeedingRecovery } from './x/index'
import { mediaKeyFromMetaUrl } from './meta-shared/dom'
import { threadsAdapter } from './threads/adapter'
import { instagramAdapter } from './instagram/adapter'

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

const video = (
  id: string,
  mp4Key: string,
  posterKey: string,
  tweetId = 't1',
  index = 0,
): MediaItem => ({
  id,
  platform: 'x',
  postId: tweetId,
  author: 'alice',
  type: 'video',
  url: `https://video.twimg.com/ext_tw_video/9/pu/vid/720x720/${mp4Key}.mp4?tag=12`,
  previewUrl: `https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/${posterKey}.jpg`,
  ext: 'mp4',
  index,
})

describe('keysForItem', () => {
  it('returns the url + previewUrl twimg media keys', () => {
    expect(keysForItem(video('v', 'MP4', 'POST'), mediaKeyFromUrl)).toEqual(['MP4', 'POST'])
  })
  it('dedups when url and previewUrl share a key', () => {
    expect(keysForItem(photo('p', 'KA'), mediaKeyFromUrl)).toEqual(['KA'])
  })
  it('omits a missing previewUrl', () => {
    const { previewUrl: _dropped, ...withoutPreview } = photo('p', 'KA')
    expect(keysForItem(withoutPreview, mediaKeyFromUrl)).toEqual(['KA'])
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

describe('postGrabItems', () => {
  it('unions the hovered item with the post items, hovered first, de-duped by id', () => {
    const a = photo('a', 'KA', 't1')
    const b = photo('b', 'KB', 't1')
    const c = video('c', 'MP4', 'POST', 't1')
    expect(postGrabItems(a, [a, b, c]).map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(postGrabItems(a, [b, c]).map((i) => i.id)).toEqual(['a', 'b', 'c'])
  })
  it('returns just the hovered item when the post set is empty (tee not seen it yet)', () => {
    const a = photo('a', 'KA', 't1')
    expect(postGrabItems(a, [])).toEqual([a])
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

  it('keysForTweet returns every by-key entry of a post, [] for an unknown post', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.addDetected([photo('a', 'KA', 't1'), photo('b', 'KB', 't2'), video('v', 'MP4', 'POST', 't1')])
    const t1 = s.keysForTweet('t1')
    expect(t1).toContain('KA') // t1 photo
    expect(t1).toContain('MP4') // t1 video mp4 key
    expect(t1).toContain('POST') // t1 video poster key
    expect(t1).not.toContain('KB') // KB belongs to t2
    expect(s.keysForTweet('t2')).toEqual(['KB'])
    expect(s.keysForTweet('nope')).toEqual([])
  })

  it('postIdForCode inverts registerPostCode (DOM shortcode → tee postId)', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('17900000000000001', 'Cabc123')
    expect(s.postIdForCode('Cabc123')).toBe('17900000000000001')
    expect(s.postIdForCode('unknown')).toBeUndefined()
  })

  it('needsRecovery wraps the injected finder with the store keys', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <article data-testid="tweet">
        <a href="/alice/status/55"><time>now</time></a>
        <div data-testid="videoPlayer"><video></video>
          <img src="https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/POST.jpg" />
        </div>
      </article>`
    const s = makeDetectionStore({
      mediaKeyFromUrl,
      findMediaNeedingRecovery: videoTweetsNeedingRecovery,
    })
    expect(s.needsRecovery(root)).toEqual(['55']) // poster key 'POST' unknown
    s.addRecovered([video('v', 'MP4', 'POST')]) // now the poster key is known
    expect(s.needsRecovery(root)).toEqual([]) // skipped
  })

  it('needsRecovery skips already-attempted tweets; unmarkAttempted restores them', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <article data-testid="tweet">
        <a href="/alice/status/55"><time>now</time></a>
        <div data-testid="videoPlayer"><video></video>
          <img src="https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/POST.jpg" />
        </div>
      </article>
      <article data-testid="tweet">
        <a href="/bob/status/77"><time>now</time></a>
        <div data-testid="videoPlayer"><video></video>
          <img src="https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/OTHER.jpg" />
        </div>
      </article>`
    const s = makeDetectionStore({
      mediaKeyFromUrl,
      findMediaNeedingRecovery: videoTweetsNeedingRecovery,
    })
    s.markAttempted('55')
    // Tweet 55 is filtered out early; the untouched candidate 77 remains.
    expect(s.needsRecovery(root)).toEqual(['77'])
    s.unmarkAttempted('55') // transient send failure re-armed it
    expect(s.needsRecovery(root)).toEqual(['55', '77'])
  })

  it('needsRecovery is a constant [] with NO DOM walk when no finder is injected', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    // A root whose DOM would throw if touched — proves the absent-finder path
    // never walks the DOM, it just returns the empty constant.
    const exploding = document.createElement('div')
    Object.defineProperty(exploding, 'querySelectorAll', {
      get() {
        throw new Error('needsRecovery walked the DOM')
      },
    })
    expect(s.needsRecovery(exploding)).toEqual([])
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

describe('post-level video key (post:code:{code})', () => {
  it('also registers the indexed key at index 0 for a single-video post (uniform lookup)', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST', 'postA', 0)
    s.addDetected([v])
    s.registerPostCode('postA', 'CODEA')
    expect(s.keyIndex().get(postVideoKeyIndexed('CODEA', 0))).toEqual(v)
  })

  it('ignores photos (never registers a post-key for a photo-only post)', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postD', 'CODED')
    s.addDetected([photo('p1', 'KA', 'postD')])
    expect(s.keyIndex().has(postVideoKey('CODED'))).toBe(false)
  })

  it('clear() also wipes the indexed and dom-slot key bookkeeping', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postE2', 'CODEE2')
    s.addDetected([video('v1', 'MP4', 'POST', 'postE2', 0)])
    expect(s.keyIndex().has(postVideoKeyIndexed('CODEE2', 0))).toBe(true)
    expect(s.keyIndex().has(postVideoKeyByDomSlot('CODEE2', 0))).toBe(true)
    s.clear()
    expect(s.keyIndex().has(postVideoKeyIndexed('CODEE2', 0))).toBe(false)
    expect(s.keyIndex().has(postVideoKeyByDomSlot('CODEE2', 0))).toBe(false)
  })

  it('a duplicate addDetected call for the same video item does not inflate the per-post count', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postF', 'CODEF')
    const v = video('v1', 'MP4', 'POST', 'postF')
    s.addDetected([v])
    s.addDetected([v])
    expect(s.keyIndex().has(postVideoKey('CODEF'))).toBe(true)
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

  it('a 2-video post keeps post:code:{code} absent', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postJ', 'CODEJ')
    s.addDetected([
      video('v1', 'MP4A', 'POSTA', 'postJ', 0),
      video('v2', 'MP4B', 'POSTB', 'postJ', 1),
    ])
    expect(s.keyIndex().has(postVideoKey('CODEJ'))).toBe(false)
  })

  it('two videos in one post resolve via distinct indexed keys, never swapped', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postM', 'CODEM')
    const v0 = video('v1', 'MP4A', 'POSTA', 'postM', 0)
    const v1 = video('v2', 'MP4B', 'POSTB', 'postM', 1)
    s.addDetected([v0, v1])

    // the no-index key withholds entirely (can't disambiguate by postId alone)
    expect(s.keyIndex().has(postVideoKey('CODEM'))).toBe(false)

    // the indexed keys resolve each to its OWN distinct item
    expect(s.keyIndex().get(postVideoKeyIndexed('CODEM', 0))).toEqual(v0)
    expect(s.keyIndex().get(postVideoKeyIndexed('CODEM', 1))).toEqual(v1)

    // the always-registered dom-slot alias resolves identically
    expect(s.keyIndex().get(postVideoKeyByDomSlot('CODEM', 0))).toEqual(v0)
    expect(s.keyIndex().get(postVideoKeyByDomSlot('CODEM', 1))).toEqual(v1)
  })

  it('mixed carousel: only videos get indexed keys, a photo-occupied index stays absent', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postN', 'CODEN')
    // index 1 is a photo in this carousel — never enters videosByPost at all.
    const v0 = video('v1', 'MP4A', 'POSTA', 'postN', 0)
    const v2 = video('v2', 'MP4B', 'POSTB', 'postN', 2)
    s.addDetected([v0, photo('p1', 'KA', 'postN'), v2])

    expect(s.keyIndex().get(postVideoKeyIndexed('CODEN', 0))).toEqual(v0)
    expect(s.keyIndex().get(postVideoKeyIndexed('CODEN', 2))).toEqual(v2)
    expect(s.keyIndex().has(postVideoKeyIndexed('CODEN', 1))).toBe(false)
  })

  it('a 1→2 video transition re-syncs: no-index keys go away, both indexed keys appear', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postO', 'CODEO')
    const v0 = video('v1', 'MP4A', 'POSTA', 'postO', 0)
    s.addDetected([v0])
    expect(s.keyIndex().has(postVideoKey('CODEO'))).toBe(true)

    const v1 = video('v2', 'MP4B', 'POSTB', 'postO', 1)
    s.addDetected([v1])
    expect(s.keyIndex().has(postVideoKey('CODEO'))).toBe(false)
    expect(s.keyIndex().get(postVideoKeyIndexed('CODEO', 0))).toEqual(v0)
    expect(s.keyIndex().get(postVideoKeyIndexed('CODEO', 1))).toEqual(v1)
  })

  it('a superseded/removed video does not leave a stale indexed entry behind', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postP', 'CODEP')
    const v0 = video('v1', 'MP4A', 'POSTA', 'postP', 0)
    const v1 = video('v2', 'MP4B', 'POSTB', 'postP', 1)
    s.addDetected([v0, v1])
    expect(s.keyIndex().has(postVideoKeyIndexed('CODEP', 1))).toBe(true)

    // simulate the tee re-detecting the post with only index 0 present now —
    // addDetected itself only ever ADDS to videosByPost (never removes an
    // index), so directly exercise the removal path via a fresh store that
    // never saw index 1, proving syncPostVideoKey's cleanup only ever
    // registers indices actually present in videosByPost right now.
    const s2 = makeDetectionStore({ mediaKeyFromUrl })
    s2.registerPostCode('postP2', 'CODEP2')
    s2.addDetected([video('v1', 'MP4A', 'POSTA', 'postP2', 0)])
    expect(s2.keyIndex().has(postVideoKeyIndexed('CODEP2', 1))).toBe(false)
  })

  it('fails closed: a slide index the store never registered resolves to nothing, never a wrong item', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postQ', 'CODEQ')
    // Only index 0 was ever tee-detected for this post.
    s.addDetected([video('v1', 'MP4A', 'POSTA', 'postQ', 0)])
    // A hover resolver that (incorrectly) computed index/domSlot 5 for this
    // post must get nothing back, never accidentally the index-0 item.
    expect(s.resolve(postVideoKeyIndexed('CODEQ', 5))).toBeUndefined()
    expect(s.resolve(postVideoKeyByDomSlot('CODEQ', 5))).toBeUndefined()
  })

  it('Threads integration: a mixed carousel [video, photo, video] resolves the SECOND video via the real adapter + store together', () => {
    // Regression test for the domSlot/absolute-index mismatch: the Threads
    // adapter's DOM-derived slot must name the SAME video the store registered
    // under that slot, for a real mixed carousel (video, photo, video) — the
    // exact shape live-verified at threads.com/@zuck/post/DZ7eGA1G7wU.
    const s = makeDetectionStore({ mediaKeyFromUrl: mediaKeyFromMetaUrl })
    s.registerPostCode('postR', 'CODER')
    const v0: MediaItem = {
      id: 'v0',
      platform: 'threads',
      postId: 'postR',
      author: 'zuck',
      type: 'video',
      url: 'https://cdn.example/v0.mp4',
      ext: 'mp4',
      index: 0,
    }
    const v2: MediaItem = {
      id: 'v2',
      platform: 'threads',
      postId: 'postR',
      author: 'zuck',
      type: 'video',
      url: 'https://cdn.example/v2.mp4',
      ext: 'mp4',
      index: 2,
    }
    // index 1 is a photo slide — never enters videosByPost.
    s.addDetected([v0, v2])

    const root = document.createElement('div')
    root.innerHTML = `
      <div data-pressable-container="true"><a href="/@zuck/post/CODER">link</a>
        <div style="transform: translateX(-716px);">
          <div></div>
          <div><video></video></div>
          <div><img /></div>
          <div><video></video></div>
        </div>
      </div>`
    const videos = root.querySelectorAll('video')
    const firstKey = threadsAdapter.postKeyFromVideoElement!(videos[0]!, '/@zuck/post/CODER')!
    const secondKey = threadsAdapter.postKeyFromVideoElement!(videos[1]!, '/@zuck/post/CODER')!

    expect(s.resolve(firstKey)).toEqual(v0)
    expect(s.resolve(secondKey)).toEqual(v2)
  })

  it('Instagram integration: a 2-video carousel whose FIRST slide is a video resolves via the real adapter + store together', () => {
    // Regression test for the analogous bug on Instagram: postKeyFromVideoElement
    // used to special-case slide-0 to the bare post:{code} shortcut, but the
    // store deletes that bare key the moment a post has 2+ videos (it only
    // stays alive for a genuinely single-video post) — so a multi-video
    // carousel whose first slide is a video could never resolve via hover.
    const s = makeDetectionStore({ mediaKeyFromUrl: mediaKeyFromMetaUrl })
    s.registerPostCode('postS', 'CODES')
    const v0: MediaItem = {
      id: 'ig-v0',
      platform: 'instagram',
      postId: 'postS',
      author: 'alice',
      type: 'video',
      url: 'https://cdn.example/ig-v0.mp4',
      ext: 'mp4',
      index: 0,
    }
    const v1: MediaItem = {
      id: 'ig-v1',
      platform: 'instagram',
      postId: 'postS',
      author: 'alice',
      type: 'video',
      url: 'https://cdn.example/ig-v1.mp4',
      ext: 'mp4',
      index: 1,
    }
    s.addDetected([v0, v1])

    const root = document.createElement('div')
    root.innerHTML = `
      <article><a href="/p/CODES/">link</a>
        <ul>
          <li><video></video></li>
          <li><video></video></li>
          <li></li>
        </ul>
      </article>`
    const videos = root.querySelectorAll('video')
    const firstKey = instagramAdapter.postKeyFromVideoElement!(videos[0]!, '/p/CODES/')!
    const secondKey = instagramAdapter.postKeyFromVideoElement!(videos[1]!, '/p/CODES/')!

    expect(s.resolve(firstKey)).toEqual(v0)
    expect(s.resolve(secondKey)).toEqual(v1)
  })

  it('valuesForTweet/keysForTweet stay correct after registerPostCode re-links a video post-key', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST', 'postT')
    s.addDetected([v])
    s.registerPostCode('postT', 'CODET')
    expect(s.valuesForTweet('postT').map((i) => i.id)).toEqual(['v1'])
    const keys = s.keysForTweet('postT')
    expect(keys).toContain('MP4')
    expect(keys).toContain('POST')
    expect(keys).toContain(postVideoKey('CODET'))
    expect(keys).toContain(postVideoKeyIndexed('CODET', 0))
    expect(keys).toContain(postVideoKeyByDomSlot('CODET', 0))
  })

  it('keysForTweet stays correct after a 1→2 video re-sync (no-index key removed, indexed keys added)', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postU', 'CODEU')
    const v0 = video('v1', 'MP4A', 'POSTA', 'postU', 0)
    s.addDetected([v0])
    expect(s.keysForTweet('postU')).toContain(postVideoKey('CODEU'))

    const v1 = video('v2', 'MP4B', 'POSTB', 'postU', 1)
    s.addDetected([v1])
    const keys = s.keysForTweet('postU')
    expect(keys).not.toContain(postVideoKey('CODEU'))
    expect(keys).toContain(postVideoKeyIndexed('CODEU', 0))
    expect(keys).toContain(postVideoKeyIndexed('CODEU', 1))
    expect(s.valuesForTweet('postU').map((i) => i.id)).toEqual(['v1', 'v2'])
  })

  it('keysForTweet reflects addRecovered items for their post, and clears on clear()', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST', 'postV')
    s.addRecovered([v])
    expect(s.keysForTweet('postV')).toEqual(expect.arrayContaining(['MP4', 'POST']))
    expect(s.valuesForTweet('postV').map((i) => i.id)).toEqual(['v1'])
    s.clear()
    expect(s.keysForTweet('postV')).toEqual([])
    expect(s.valuesForTweet('postV')).toEqual([])
  })

  it('no stale ids/keys remain after an id+key is overwritten with an item of a DIFFERENT postId', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const original = photo('dup', 'KSHARED', 'postW1')
    s.addDetected([original])
    expect(s.valuesForTweet('postW1').map((i) => i.id)).toEqual(['dup'])
    expect(s.keysForTweet('postW1')).toContain('KSHARED')

    // Same id AND same key, re-added under a different postId — the old
    // postId's indices must lose all trace of it, the new postId gains it.
    const replacement = photo('dup', 'KSHARED', 'postW2')
    s.addDetected([replacement])

    expect(s.valuesForTweet('postW1')).toEqual([])
    expect(s.keysForTweet('postW1')).not.toContain('KSHARED')
    expect(s.valuesForTweet('postW2').map((i) => i.id)).toEqual(['dup'])
    expect(s.keysForTweet('postW2')).toContain('KSHARED')
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

describe('route-scope reset (resetPageScope)', () => {
  it('clears Bulk count and values() while keeping post:code and plain media keys resolvable', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4A', 'POSTA', 'post1', 0)
    s.registerPostCode('post1', 'DcV75F4ys05')
    s.addDetected([v])

    const summary = s.resetPageScope()

    expect(summary).toEqual({
      resetItems: 1,
      retainedItems: 1,
      retainedKeys: 5,
      retainedCodes: 1,
    })
    expect(s.count).toBe(0)
    expect(s.values()).toEqual([])
    expect(s.resolve(postVideoKey('DcV75F4ys05'))).toEqual(v)
    expect(s.resolve('MP4A')).toEqual(v)
    expect(s.resolve('POSTA')).toEqual(v)
  })

  it('preserves postIdForCode, valuesForTweet, keysForTweet, and get across resetPageScope', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4A', 'POSTA', 'post1', 0)
    const p = photo('p1', 'KA', 'post1')
    s.registerPostCode('post1', 'CODE1')
    s.addDetected([v, p])

    s.resetPageScope()

    expect(s.postIdForCode('CODE1')).toBe('post1')
    expect(s.get('v1')).toEqual(v)
    expect(s.get('p1')).toEqual(p)
    expect(s.valuesForTweet('post1')).toEqual([v, p])
    expect(s.keysForTweet('post1')).toEqual(
      expect.arrayContaining([
        'MP4A',
        'POSTA',
        'KA',
        postVideoKey('CODE1'),
        postVideoKeyIndexed('CODE1', 0),
        postVideoKeyByDomSlot('CODE1', 0),
      ]),
    )
  })

  it('keeps multi-video carousel indexed and dom-slot keys resolvable after resetPageScope', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v0 = video('v0', 'MP4A', 'POSTA', 'postM', 0)
    const v1 = video('v1', 'MP4B', 'POSTB', 'postM', 1)
    s.registerPostCode('postM', 'CODEM')
    s.addDetected([v0, v1])

    s.resetPageScope()

    expect(s.count).toBe(0)
    expect(s.resolve(postVideoKey('CODEM'))).toBeUndefined()
    expect(s.resolve(postVideoKeyIndexed('CODEM', 0))).toEqual(v0)
    expect(s.resolve(postVideoKeyIndexed('CODEM', 1))).toEqual(v1)
    expect(s.resolve(postVideoKeyByDomSlot('CODEM', 0))).toEqual(v0)
    expect(s.resolve(postVideoKeyByDomSlot('CODEM', 1))).toEqual(v1)
  })

  it('re-seeds page scope idempotently when a retained item is captured again after resetPageScope', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4A', 'POSTA', 'post1', 0)
    s.addDetected([v])
    s.resetPageScope()
    expect(s.count).toBe(0)

    expect(s.addDetected([v])).toEqual([v])
    expect(s.count).toBe(1)
    expect(s.values()).toEqual([v])

    expect(s.addDetected([v])).toEqual([])
    expect(s.count).toBe(1)
    expect(s.valuesForTweet('post1')).toEqual([v])
  })

  it('releases attempted-recovery claims while keeping retained keys visible to needsRecovery', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <article data-testid="tweet">
        <a href="/alice/status/55"><time>now</time></a>
        <div data-testid="videoPlayer"><video></video>
          <img src="https://pbs.twimg.com/ext_tw_video_thumb/9/pu/img/POST.jpg" />
        </div>
      </article>`
    const s = makeDetectionStore({
      mediaKeyFromUrl,
      findMediaNeedingRecovery: videoTweetsNeedingRecovery,
    })
    expect(s.markAttempted('55')).toBe(true)
    expect(s.needsRecovery(root)).toEqual([])

    s.resetPageScope()

    expect(s.markAttempted('55')).toBe(true)
    s.unmarkAttempted('55')
    expect(s.needsRecovery(root)).toEqual(['55'])

    s.addRecovered([video('v55', 'MP4', 'POST', '55')])
    s.resetPageScope()
    expect(s.needsRecovery(root)).toEqual([])
  })

  it('retains recovered-key provenance across resetPageScope and re-admits without double-counting', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const recovered = video('vKey', 'MP4', 'POST', 't1')
    s.addRecovered([recovered])
    s.resetPageScope()
    expect(s.count).toBe(0)

    const teeDuplicate = video('99', 'MP4', 'POST', 't1')
    expect(s.addDetected([teeDuplicate])).toEqual([recovered])
    expect(s.count).toBe(1)
    expect(s.values()).toEqual([recovered])
    expect(s.valuesForTweet('t1')).toEqual([recovered])

    expect(s.addDetected([teeDuplicate])).toEqual([])
    expect(s.count).toBe(1)
  })

  it('clear() still wipes retained items, keys, post codes, recovered provenance, and attempts', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('post1', 'CODE1')
    s.addDetected([video('v1', 'MP4A', 'POSTA', 'post1', 0)])
    s.addRecovered([video('vRec', 'MP4R', 'POSTR', 'post2', 0)])
    s.markAttempted('post3')
    s.resetPageScope()

    s.clear()

    expect(s.count).toBe(0)
    expect(s.values()).toEqual([])
    expect(s.get('v1')).toBeUndefined()
    expect(s.resolve(postVideoKey('CODE1'))).toBeUndefined()
    expect(s.resolve('MP4R')).toBeUndefined()
    expect(s.postIdForCode('CODE1')).toBeUndefined()
    expect(s.valuesForTweet('post1')).toEqual([])
    expect(s.keysForTweet('post1')).toEqual([])
    expect(s.markAttempted('post3')).toBe(true)
    expect(s.addDetected([video('99', 'MP4R', 'POSTR', 'post2', 0)])).toHaveLength(1)
  })
})

describe('bounded oldest-first retention', () => {
  it('exports a positive default retention ceiling', () => {
    expect(DEFAULT_MAX_RETAINED_ITEMS).toBeGreaterThan(0)
  })

  it('evicts oldest captured video and all of its keys and post code when exceeding maxRetainedItems', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl, maxRetainedItems: 2 })
    const v1 = video('v1', 'MP41', 'POST1', 'post1', 0)
    const v2 = video('v2', 'MP42', 'POST2', 'post2', 0)
    const v3 = video('v3', 'MP43', 'POST3', 'post3', 0)

    s.registerPostCode('post1', 'CODE1')
    s.registerPostCode('post2', 'CODE2')
    s.registerPostCode('post3', 'CODE3')
    s.addDetected([v1, v2])
    s.resetPageScope()
    s.addDetected([v3])

    expect(s.get('v1')).toBeUndefined()
    expect(s.resolve('MP41')).toBeUndefined()
    expect(s.resolve('POST1')).toBeUndefined()
    expect(s.resolve(postVideoKey('CODE1'))).toBeUndefined()
    expect(s.resolve(postVideoKeyIndexed('CODE1', 0))).toBeUndefined()
    expect(s.resolve(postVideoKeyByDomSlot('CODE1', 0))).toBeUndefined()
    expect(s.postIdForCode('CODE1')).toBeUndefined()
    expect(s.valuesForTweet('post1')).toEqual([])
    expect(s.keysForTweet('post1')).toEqual([])

    expect(s.resolve(postVideoKey('CODE2'))).toEqual(v2)
    expect(s.postIdForCode('CODE2')).toBe('post2')
    expect(s.resolve(postVideoKey('CODE3'))).toEqual(v3)
    expect(s.postIdForCode('CODE3')).toBe('post3')
    expect(s.count).toBe(1)
    expect(s.values()).toEqual([v3])
  })

  it('evicts oldest items during addRecovered and clears recoveredKeys so evicted media can be re-captured', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl, maxRetainedItems: 2 })
    const r1 = video('r1', 'MP4R1', 'POSTR1', 'post1', 0)
    const r2 = video('r2', 'MP4R2', 'POSTR2', 'post2', 0)
    const r3 = video('r3', 'MP4R3', 'POSTR3', 'post3', 0)

    s.addRecovered([r1, r2])
    s.addRecovered([r3])

    expect(s.get('r1')).toBeUndefined()
    expect(s.resolve('MP4R1')).toBeUndefined()
    expect(s.resolve('POSTR1')).toBeUndefined()
    expect(s.count).toBe(2)
    expect(s.values()).toEqual([r2, r3])

    const recaught = video('tee-r1', 'MP4R1', 'POSTR1', 'post1', 0)
    expect(s.addDetected([recaught])).toEqual([recaught])
    expect(s.resolve('MP4R1')).toEqual(recaught)
  })

  it('evicts a 2-video carousel atomically as a whole post without synthesizing a bare post video key', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl, maxRetainedItems: 2 })
    const v0 = video('v0', 'MP4A', 'POSTA', 'postC', 0)
    const v1 = video('v1', 'MP4B', 'POSTB', 'postC', 1)
    const p2 = photo('p2', 'KP2', 'postOther1')

    s.registerPostCode('postC', 'CODEC')
    s.addDetected([v0, v1])
    s.addDetected([p2])

    expect(s.get('v0')).toBeUndefined()
    expect(s.get('v1')).toBeUndefined()
    expect(s.resolve('MP4A')).toBeUndefined()
    expect(s.resolve('POSTA')).toBeUndefined()
    expect(s.resolve('MP4B')).toBeUndefined()
    expect(s.resolve('POSTB')).toBeUndefined()
    expect(s.resolve(postVideoKey('CODEC'))).toBeUndefined()
    expect(s.resolve(postVideoKeyIndexed('CODEC', 0))).toBeUndefined()
    expect(s.resolve(postVideoKeyIndexed('CODEC', 1))).toBeUndefined()
    expect(s.resolve(postVideoKeyByDomSlot('CODEC', 0))).toBeUndefined()
    expect(s.resolve(postVideoKeyByDomSlot('CODEC', 1))).toBeUndefined()
    expect(s.postIdForCode('CODEC')).toBeUndefined()
    expect(s.valuesForTweet('postC')).toEqual([])
    expect(s.keysForTweet('postC')).toEqual([])
    expect(s.get('p2')).toEqual(p2)
    expect(s.resolve('KP2')).toEqual(p2)
    expect(s.count).toBe(1)
    expect(s.values()).toEqual([p2])
  })

  it('returns only surviving items when a single addDetected or addRecovered batch exceeds maxRetainedItems', () => {
    const detectedStore = makeDetectionStore({ mediaKeyFromUrl, maxRetainedItems: 2 })
    const p1 = photo('p1', 'KP1', 'post1')
    const p2 = photo('p2', 'KP2', 'post2')
    const p3 = photo('p3', 'KP3', 'post3')

    expect(detectedStore.addDetected([p1, p2, p3])).toEqual([p2, p3])
    expect(detectedStore.get('p1')).toBeUndefined()
    expect(detectedStore.values()).toEqual([p2, p3])

    const recoveredStore = makeDetectionStore({ mediaKeyFromUrl, maxRetainedItems: 2 })
    const r1 = video('r1', 'MP4R1', 'POSTR1', 'post1', 0)
    const r2 = video('r2', 'MP4R2', 'POSTR2', 'post2', 0)
    const r3 = video('r3', 'MP4R3', 'POSTR3', 'post3', 0)

    expect(recoveredStore.addRecovered([r1, r2, r3])).toEqual([r2, r3])
    expect(recoveredStore.get('r1')).toBeUndefined()
    expect(recoveredStore.values()).toEqual([r2, r3])
  })

  it('does not clobber a newer post when evicting an older post that shared its URL key', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl, maxRetainedItems: 2 })
    const older = video('v-old', 'SHARED_MP4', 'SHARED_POST', 'postOld', 0)
    const newer = video('v-new', 'SHARED_MP4', 'SHARED_POST', 'postNew', 0)
    const third = photo('p3', 'K3', 'post3')

    s.registerPostCode('postOld', 'CODE_OLD')
    s.registerPostCode('postNew', 'CODE_NEW')
    s.addDetected([older])
    s.addDetected([newer])
    s.addDetected([third])

    expect(s.get('v-old')).toBeUndefined()
    expect(s.postIdForCode('CODE_OLD')).toBeUndefined()
    expect(s.get('v-new')).toEqual(newer)
    expect(s.resolve('SHARED_MP4')).toEqual(newer)
    expect(s.resolve('SHARED_POST')).toEqual(newer)
    expect(s.resolve(postVideoKey('CODE_NEW'))).toEqual(newer)
    expect(s.resolve(postVideoKeyIndexed('CODE_NEW', 0))).toEqual(newer)
  })

  it('caps codeToPostId oldest-first for both text-only and video posts', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl, maxRetainedItems: 2 })
    const v1 = video('v1', 'MP41', 'POST1', 'postV', 0)
    s.registerPostCode('postV', 'CODEV')
    s.addDetected([v1])
    s.registerPostCode('postText1', 'CODET1')
    s.registerPostCode('postText2', 'CODET2')

    expect(s.postIdForCode('CODEV')).toBeUndefined()
    expect(s.resolve(postVideoKey('CODEV'))).toBeUndefined()
    expect(s.resolve(postVideoKeyIndexed('CODEV', 0))).toBeUndefined()
    expect(s.resolve(postVideoKeyByDomSlot('CODEV', 0))).toBeUndefined()
    expect(s.postIdForCode('CODET1')).toBe('postText1')
    expect(s.postIdForCode('CODET2')).toBe('postText2')

    s.registerPostCode('postText3', 'CODET3')
    expect(s.postIdForCode('CODET1')).toBeUndefined()
    expect(s.postIdForCode('CODET2')).toBe('postText2')
    expect(s.postIdForCode('CODET3')).toBe('postText3')
  })

  it('evicts oldest photo item cleanly including its URL key and post code', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl, maxRetainedItems: 1 })
    const p1 = photo('p1', 'KP1', 'postP1')
    const p2 = photo('p2', 'KP2', 'postP2')
    s.registerPostCode('postP1', 'CODEP1')
    s.addDetected([p1])
    s.addDetected([p2])

    expect(s.get('p1')).toBeUndefined()
    expect(s.resolve('KP1')).toBeUndefined()
    expect(s.postIdForCode('CODEP1')).toBeUndefined()
    expect(s.valuesForTweet('postP1')).toEqual([])
    expect(s.keysForTweet('postP1')).toEqual([])
    expect(s.resolve('KP2')).toEqual(p2)
  })
})
