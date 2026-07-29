import { describe, it, expect } from 'vitest'
import type { MediaItem } from '../schema'
import {
  MAX_MEDIA_AUTHOR_LENGTH,
  MAX_MEDIA_POST_ID_LENGTH,
  MAX_MEDIA_URL_LENGTH,
} from '../schema/media'
import {
  MAX_DETECTED_ITEMS_PER_POST,
  MAX_DETECTED_POSTS,
  MAX_POST_CODE_ALIASES,
  MAX_POST_CODE_LENGTH,
  MAX_RECOVERY_ATTEMPTS_PER_PAGE,
  makeDetectionStore,
  keysForItem,
  postGrabItems,
  postVideoKey,
  postVideoKeyById,
  postVideoKeyIndexed,
  postVideoKeyByIdIndexed,
  postVideoKeyByDomSlot,
} from './detection-store'
import { mediaKeyFromUrl } from './x/dom'
import { mediaKeyFromMetaUrl } from './meta-shared/dom'
import { threadsAdapter } from './threads/adapter'
import { instagramAdapter } from './instagram/adapter'

/** twimg URLs so mediaKeyFromUrl yields a real key (final path segment, no ext). */
const photo = (id: string, key: string, tweetId = 't1', index = 0): MediaItem => ({
  id,
  platform: 'x',
  postId: tweetId,
  author: 'alice',
  type: 'photo',
  url: `https://pbs.twimg.com/media/${key}.jpg?name=orig`,
  previewUrl: `https://pbs.twimg.com/media/${key}.jpg`,
  ext: 'jpg',
  index,
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

describe('makeDetectionStore — reconciliation', () => {
  it('reconcileDetected reports added then unchanged, and indexes by id and key', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const a = photo('a', 'KA')
    expect(s.reconcileDetected([a])).toEqual({
      added: 1,
      updated: 0,
      changed: true,
    })
    expect(s.reconcileDetected([a])).toEqual({
      added: 0,
      updated: 0,
      changed: false,
    })
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
    s.reconcileDetected([photo('KA', 'KA')])
    s.reconcileDetected([photo('KA', 'KA')])
    expect(s.count).toBe(1)
  })

  it('rejects hostile Meta and X adapter output before it can evict capacity', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const retained = Array.from({ length: MAX_DETECTED_POSTS }, (_, index) =>
      photo(`id-${index}`, `KEY${index}`, `post-${index}`),
    )
    s.reconcileDetected(retained)

    const hostileMetaPk = {
      ...photo('meta-pk', 'META_PK'),
      platform: 'instagram',
      postId: 'p'.repeat(MAX_MEDIA_POST_ID_LENGTH + 1),
    }
    const hostileMetaUsername = {
      ...photo('meta-username', 'META_USERNAME'),
      platform: 'instagram',
      author: 'u'.repeat(MAX_MEDIA_AUTHOR_LENGTH + 1),
    }
    const hostileMetaUrl = {
      ...photo('meta-url', 'META_URL'),
      platform: 'instagram',
      url: `https://cdninstagram.com/${'u'.repeat(MAX_MEDIA_URL_LENGTH)}`,
    }
    const mediaPrefix = 'https://pbs.twimg.com/media/'
    const boundedUrl = `${mediaPrefix}${'b'.repeat(MAX_MEDIA_URL_LENGTH - mediaPrefix.length)}`
    const oversizedItem = {
      ...photo('oversized', 'OVERSIZED'),
      url: boundedUrl,
      previewUrl: boundedUrl,
    }
    const hostileXDomOutput = {
      ...photo('x-dom', 'X_DOM'),
      url: 'http://pbs.twimg.com/media/X_DOM.jpg',
    }

    expect(
      s.reconcileDetected([
        hostileMetaPk,
        hostileMetaUsername,
        hostileMetaUrl,
        oversizedItem,
        hostileXDomOutput,
      ] as MediaItem[]),
    ).toEqual({ added: 0, updated: 0, changed: false })
    expect(s.count).toBe(MAX_DETECTED_POSTS)
    expect(s.get(retained[0]!.id)).toEqual(retained[0])
  })

  it('rejects hostile recovered adapter output before indexing it', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const hostileXDomOutput = {
      ...video('x-dom', 'X_DOM', 'POSTER'),
      previewUrl: `https://pbs.twimg.com/${'p'.repeat(MAX_MEDIA_URL_LENGTH)}`,
    }

    expect(s.reconcileRecovered([hostileXDomOutput] as MediaItem[])).toEqual({
      added: 0,
      updated: 0,
      changed: false,
    })
    expect(s.count).toBe(0)
  })

  it('reconcileRecovered skips photos and already-known keys', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST')
    expect(s.reconcileRecovered([v])).toEqual({
      added: 1,
      updated: 0,
      changed: true,
    })
    expect(s.resolve('MP4')).toEqual(v)
    expect(s.resolve('POST')).toEqual(v)
    // photo is never recovered (DOM-detectable)
    expect(s.reconcileRecovered([photo('p', 'KZ')])).toEqual({
      added: 0,
      updated: 0,
      changed: false,
    })
    // key already known → skipped
    expect(s.reconcileRecovered([video('v1b', 'MP4', 'POST')])).toEqual({
      added: 0,
      updated: 0,
      changed: false,
    })
  })

  it('reconcileRecovered skips a video passive detection already knows', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.reconcileDetected([video('v1', 'MP4', 'POST')])
    expect(s.reconcileRecovered([video('v1', 'MP4', 'POST')])).toEqual({
      added: 0,
      updated: 0,
      changed: false,
    })
  })

  it('recovery cannot evict a detected occupant, while later detection can replace recovery', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const detectedPhoto = photo('detected-photo', 'PHOTO', 'post-slot', 0)
    const recoveredVideo = video('recovered-video', 'MP4', 'POSTER', 'post-slot', 0)
    s.reconcileDetected([detectedPhoto])

    expect(s.reconcileRecovered([recoveredVideo])).toEqual({
      added: 0,
      updated: 0,
      changed: false,
    })
    expect(s.get(detectedPhoto.id)).toEqual(detectedPhoto)
    expect(s.get(recoveredVideo.id)).toBeUndefined()

    const emptySlotRecovery = video('recovered-empty', 'MP4EMPTY', 'POSTEMPTY', 'post-empty', 0)
    const detectedReplacement = photo('detected-replacement', 'PHOTOEMPTY', 'post-empty', 0)
    s.reconcileRecovered([emptySlotRecovery])
    s.reconcileDetected([detectedReplacement])
    expect(s.get(emptySlotRecovery.id)).toBeUndefined()
    expect(s.get(detectedReplacement.id)).toEqual(detectedReplacement)
  })

  it('passive reconciliation replaces recovered metadata for the same media id', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const recovered = video('media', 'MP4', 'OLDPOST', 'old-post')
    const passive = video('media', 'MP4', 'NEWPOST', 'new-post')
    expect(s.reconcileRecovered([recovered])).toEqual({
      added: 1,
      updated: 0,
      changed: true,
    })
    expect(s.reconcileDetected([passive])).toEqual({
      added: 0,
      updated: 1,
      changed: true,
    })
    expect(s.count).toBe(1)
    expect(s.get('media')).toEqual(passive)
    expect(s.valuesForTweet('old-post')).toEqual([])
    expect(s.valuesForTweet('new-post')).toEqual([passive])
  })

  it('replacing one id across posts removes every old direct and post alias', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('old-post', 'OLD')
    s.registerPostCode('new-post', 'NEW')
    const old = video('media', 'OLDMP4', 'OLDPOST', 'old-post')
    const next = video('media', 'NEWMP4', 'NEWPOST', 'new-post')
    s.reconcileDetected([old])
    expect(s.resolve('OLDMP4')).toEqual(old)
    expect(s.resolve(postVideoKey('OLD'))).toEqual(old)

    expect(s.reconcileDetected([next])).toEqual({
      added: 0,
      updated: 1,
      changed: true,
    })
    expect(s.resolve('OLDMP4')).toBeUndefined()
    expect(s.resolve('OLDPOST')).toBeUndefined()
    expect(s.resolve(postVideoKey('OLD'))).toBeUndefined()
    expect(s.resolve(postVideoKeyIndexed('OLD', 0))).toBeUndefined()
    expect(s.resolve(postVideoKeyByDomSlot('OLD', 0))).toBeUndefined()
    expect(s.resolve('NEWMP4')).toEqual(next)
    expect(s.resolve('NEWPOST')).toEqual(next)
    expect(s.resolve(postVideoKey('NEW'))).toEqual(next)
    expect(s.count).toBe(1)
  })

  it('replacing an item removes its old poster alias', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.reconcileDetected([video('media', 'MP4', 'OLDPOST')])
    const next = video('media', 'MP4', 'NEWPOST')
    s.reconcileDetected([next])
    expect(s.resolve('OLDPOST')).toBeUndefined()
    expect(s.resolve('NEWPOST')).toEqual(next)
  })

  it("replaces a video id at the same post slot without deleting another item's shared alias", () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('post', 'POST')
    const old = video('old', 'OLDMP4', 'SHARED', 'post', 0)
    const sibling = video('sibling', 'SIDEMP4', 'SHARED', 'other-post', 0)
    const next = video('next', 'NEXTMP4', 'NEXTPOST', 'post', 0)
    s.reconcileDetected([old, sibling])

    expect(s.reconcileDetected([next])).toEqual({
      added: 1,
      updated: 0,
      changed: true,
    })
    expect(s.get('old')).toBeUndefined()
    expect(s.resolve('OLDMP4')).toBeUndefined()
    expect(s.resolve('SHARED')).toEqual(sibling)
    expect(s.count).toBe(2)
    expect(s.valuesForTweet('post')).toEqual([next])
    expect(s.resolve(postVideoKey('POST'))).toEqual(next)
  })

  it('markAttempted is once-per-tweet; unmarkAttempted re-arms it', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    expect(s.markAttempted('t9')).toBe(true)
    expect(s.markAttempted('t9')).toBe(false)
    s.unmarkAttempted('t9')
    expect(s.markAttempted('t9')).toBe(true)
  })

  it('rejects unbounded Recovery and Meta code identifiers', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const overlongPostId = 'p'.repeat(MAX_MEDIA_POST_ID_LENGTH + 1)
    const overlongCode = 'c'.repeat(MAX_POST_CODE_LENGTH + 1)

    expect(s.markAttempted(overlongPostId)).toBe(false)
    s.registerPostCode(overlongPostId, 'VALID')
    s.registerPostCode('valid-post', overlongCode)
    expect(s.postIdForCode('VALID')).toBeUndefined()
    expect(s.postIdForCode(overlongCode)).toBeUndefined()
    expect(s.markAttempted('valid-post')).toBe(true)
  })

  it('valuesForTweet filters by tweetId', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.reconcileDetected([photo('a', 'KA', 't1'), photo('b', 'KB', 't2'), photo('c', 'KC', 't1', 1)])
    expect(s.valuesForTweet('t1').map((i) => i.id)).toEqual(['a', 'c'])
    expect(s.valuesForTweet('t2').map((i) => i.id)).toEqual(['b'])
  })

  it('keysForTweet returns every by-key entry of a post, [] for an unknown post', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.reconcileDetected([
      photo('a', 'KA', 't1'),
      photo('b', 'KB', 't2'),
      video('v', 'MP4', 'POST', 't1', 1),
    ])
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

  it('clear empties items, aliases, codes, and attempts', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.reconcileRecovered([video('v', 'MP4', 'POST')])
    s.markAttempted('t1')
    s.clear()
    expect(s.count).toBe(0)
    expect(s.resolve('MP4')).toBeUndefined()
    expect(s.reconcileDetected([video('v', 'MP4', 'POST')])).toEqual({
      added: 1,
      updated: 0,
      changed: true,
    })
    // attempts reset → tweet can be re-attempted
    expect(s.markAttempted('t1')).toBe(true)
  })

  it('evicts the least-recent whole post at the page cap', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const oldestPhoto = photo('old-photo', 'OLDPHOTO', 'oldest', 0)
    const oldestVideo = video('old-video', 'OLDVIDEO', 'OLDPOSTER', 'oldest', 1)
    s.registerPostCode('oldest', 'OLDCODE')
    s.reconcileDetected([oldestPhoto, oldestVideo])

    for (let index = 1; index < MAX_DETECTED_POSTS; index += 1)
      s.reconcileDetected([photo(`id-${index}`, `KEY${index}`, `post-${index}`)])

    const newest = photo('newest', 'NEWEST', 'newest')
    s.reconcileDetected([newest])

    expect(s.count).toBe(MAX_DETECTED_POSTS)
    expect(s.get(oldestPhoto.id)).toBeUndefined()
    expect(s.get(oldestVideo.id)).toBeUndefined()
    expect(s.resolve('OLDPHOTO')).toBeUndefined()
    expect(s.resolve('OLDVIDEO')).toBeUndefined()
    expect(s.resolve('OLDPOSTER')).toBeUndefined()
    expect(s.resolve(postVideoKey('OLDCODE'))).toBeUndefined()
    expect(s.postIdForCode('OLDCODE')).toBeUndefined()
    expect(s.valuesForTweet('oldest')).toEqual([])
    expect(s.keysForTweet('oldest')).toEqual([])
    expect(s.markAttempted('oldest')).toBe(true)
    expect(s.get(newest.id)).toEqual(newest)
  })

  it('refreshes post recency before evicting', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const posts = Array.from({ length: MAX_DETECTED_POSTS }, (_, index) =>
      photo(`id-${index}`, `KEY${index}`, `post-${index}`),
    )
    s.reconcileDetected(posts)

    s.reconcileDetected([posts[0]!])
    s.reconcileDetected([photo('newest', 'NEWEST', 'newest')])

    expect(s.get(posts[0]!.id)).toEqual(posts[0])
    expect(s.get(posts[1]!.id)).toBeUndefined()
    expect(s.count).toBe(MAX_DETECTED_POSTS)
  })

  it('prunes a moved item’s empty Post before the next capped admission', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const posts = Array.from({ length: MAX_DETECTED_POSTS }, (_, index) =>
      photo(`id-${index}`, `KEY${index}`, `post-${index}`),
    )
    s.reconcileDetected(posts)

    const moved = { ...posts.at(-1)!, postId: 'post-0', index: 1 }
    s.reconcileDetected([moved])
    const newest = photo('newest', 'NEWEST', 'newest')
    s.reconcileDetected([newest])

    expect(s.get(posts[1]!.id)).toEqual(posts[1])
    expect(s.valuesForTweet(`post-${MAX_DETECTED_POSTS - 1}`)).toEqual([])
    expect(s.get(moved.id)).toEqual(moved)
    expect(s.get(newest.id)).toEqual(newest)

    s.registerPostCode(`post-${MAX_DETECTED_POSTS - 1}`, 'ghost-code')
    expect(s.postIdForCode('ghost-code')).toBeUndefined()
  })

  it('reuses a departing empty Post slot when moving into a new Post at cap', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const posts = Array.from({ length: MAX_DETECTED_POSTS }, (_, index) =>
      photo(`id-${index}`, `KEY${index}`, `post-${index}`),
    )
    s.reconcileDetected(posts)

    const moved = { ...posts.at(-1)!, postId: 'new-post' }
    expect(s.reconcileDetected([moved])).toEqual({
      added: 0,
      updated: 1,
      changed: true,
    })

    expect(s.count).toBe(MAX_DETECTED_POSTS)
    expect(s.get(posts[0]!.id)).toEqual(posts[0])
    expect(s.valuesForTweet(`post-${MAX_DETECTED_POSTS - 1}`)).toEqual([])
    expect(s.get(moved.id)).toEqual(moved)

    const next = photo('next', 'NEXT', 'next-post')
    s.reconcileDetected([next])
    expect(s.get(posts[0]!.id)).toBeUndefined()
    expect(s.get(posts[1]!.id)).toEqual(posts[1])
    expect(s.get(next.id)).toEqual(next)
    expect(s.count).toBe(MAX_DETECTED_POSTS)
  })

  it('retains old Post metadata when a capped move needs a real eviction', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const posts = Array.from({ length: MAX_DETECTED_POSTS }, (_, index) =>
      photo(`id-${index}`, `KEY${index}`, `post-${index}`),
    )
    s.reconcileDetected(posts)
    const oldPostId = `post-${MAX_DETECTED_POSTS - 1}`
    s.registerPostCode(oldPostId, 'old-code')

    const moved = { ...posts.at(-1)!, postId: 'new-post' }
    s.reconcileDetected([moved])

    expect(s.get(posts[0]!.id)).toBeUndefined()
    expect(s.valuesForTweet(oldPostId)).toEqual([])
    expect(s.postIdForCode('old-code')).toBe(oldPostId)
    expect(s.get(moved.id)).toEqual(moved)
    expect(s.count).toBe(MAX_DETECTED_POSTS - 1)
  })

  it("evicting one post preserves another post's shared direct alias", () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const oldest = video('oldest', 'OLD', 'SHARED', 'oldest')
    const sibling = video('sibling', 'SIBLING', 'SHARED', 'post-1')
    s.reconcileDetected([oldest, sibling])
    for (let index = 2; index < MAX_DETECTED_POSTS; index += 1)
      s.reconcileDetected([photo(`id-${index}`, `KEY${index}`, `post-${index}`)])
    expect(s.resolve('SHARED')).toEqual(sibling)

    s.reconcileDetected([photo('newest', 'NEWEST', 'newest')])

    expect(s.get(oldest.id)).toBeUndefined()
    expect(s.get(sibling.id)).toEqual(sibling)
    expect(s.resolve('SHARED')).toEqual(sibling)
  })

  it('bounds code-only posts', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    for (let index = 0; index < MAX_DETECTED_POSTS; index += 1)
      s.registerPostCode(`post-${index}`, `code-${index}`)

    s.registerPostCode('newest', 'newest-code')

    expect(s.postIdForCode('code-0')).toBeUndefined()
    expect(s.postIdForCode('code-1')).toBe('post-1')
    expect(s.postIdForCode('newest-code')).toBe('newest')
  })

  it('bounds Recovery tombstones independently of transient Post state', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    for (let index = 0; index < MAX_RECOVERY_ATTEMPTS_PER_PAGE; index += 1) {
      s.registerPostCode(`post-${index}`, `code-${index}`)
      expect(s.markAttempted(`post-${index}`)).toBe(true)
    }

    expect(s.markAttempted('newest')).toBe(false)
    expect(s.postIdForCode('code-0')).toBe('post-0')
    expect(s.postIdForCode('code-1')).toBe('post-1')

    s.unmarkAttempted('post-0')
    expect(s.markAttempted('newest')).toBe(true)
    expect(s.postIdForCode('code-0')).toBe('post-0')
    expect(s.markAttempted('post-0')).toBe(false)
    s.unmarkAttempted('post-1')
    expect(s.markAttempted('post-0')).toBe(true)
    expect(s.postIdForCode('code-1')).toBe('post-1')
  })

  it('retains once-only Recovery tombstones after transient state eviction', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    for (let index = 0; index < MAX_RECOVERY_ATTEMPTS_PER_PAGE; index += 1)
      expect(s.markAttempted(`post-${index}`)).toBe(true)

    const item = photo('new', 'NEW', 'new-post')
    expect(s.reconcileDetected([item])).toEqual({
      added: 1,
      updated: 0,
      changed: true,
    })
    expect(s.get(item.id)).toEqual(item)
    expect(s.markAttempted('new-post')).toBe(false)
    expect(s.markAttempted('post-0')).toBe(false)
  })

  it('caps one Post at the Source Adapter media limit', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const items = Array.from({ length: MAX_DETECTED_ITEMS_PER_POST + 1 }, (_, index) =>
      photo(`id-${index}`, `KEY${index}`, 'one-post', index),
    )

    expect(s.reconcileDetected(items)).toEqual({
      added: MAX_DETECTED_ITEMS_PER_POST,
      updated: 0,
      changed: true,
    })
    expect(s.count).toBe(MAX_DETECTED_ITEMS_PER_POST)
    expect(s.get(items.at(-1)!.id)).toBeUndefined()
  })

  it('bounds shortcode aliases for one Post and retains the newest', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const item = video('video', 'VIDEO', 'POSTER', 'post')
    s.reconcileDetected([item])
    for (let index = 0; index <= MAX_POST_CODE_ALIASES; index += 1)
      s.registerPostCode('post', `code-${index}`)

    expect(s.postIdForCode('code-0')).toBeUndefined()
    expect(s.resolve(postVideoKey('code-0'))).toBeUndefined()
    for (let index = 1; index <= MAX_POST_CODE_ALIASES; index += 1) {
      expect(s.postIdForCode(`code-${index}`)).toBe('post')
      expect(s.resolve(postVideoKey(`code-${index}`))).toEqual(item)
    }
  })

  it('does not let a code-only pass evict retained media posts', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const posts = Array.from({ length: MAX_DETECTED_POSTS + 1 }, (_, index) =>
      photo(`id-${index}`, `KEY${index}`, `post-${index}`),
    )
    s.reconcileDetected(posts)

    for (let index = 0; index < posts.length; index += 1)
      s.registerPostCode(`post-${index}`, `code-${index}`)

    expect(s.get(posts[0]!.id)).toBeUndefined()
    for (const retained of posts.slice(1)) {
      expect(s.get(retained.id)).toEqual(retained)
      expect(s.postIdForCode(`code-${retained.postId.slice('post-'.length)}`)).toBe(retained.postId)
    }
    expect(s.count).toBe(MAX_DETECTED_POSTS)
  })

  it("eviction does not delete another Post's colliding current alias", () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const oldest = video('oldest', 'OLDVIDEO', 'OLDPOSTER', 'oldest')
    s.reconcileDetected([oldest])
    s.registerPostCode('oldest', 'COLLIDE')

    const current = photo('current', 'post:code:COLLIDE', 'post-1')
    s.reconcileDetected([current])
    for (let index = 2; index < MAX_DETECTED_POSTS; index += 1)
      s.reconcileDetected([photo(`id-${index}`, `KEY${index}`, `post-${index}`)])
    expect(s.resolve(postVideoKey('COLLIDE'))).toEqual(current)

    s.reconcileDetected([photo('newest', 'NEWEST', 'newest')])

    expect(s.get(oldest.id)).toBeUndefined()
    expect(s.resolve(postVideoKey('COLLIDE'))).toEqual(current)
  })
})

describe('post-level video key (post:id:{postId} / post:code:{code})', () => {
  it('registers post:id:{postId} for a single-video post', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST', 'postA')
    s.reconcileDetected([v])
    expect(s.keyIndex().get(postVideoKeyById('postA'))).toEqual(v)
    expect(s.resolve(postVideoKeyById('postA'))).toEqual(v)
  })

  it('also registers the indexed key at index 0 for a single-video post (uniform lookup)', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST', 'postA', 0)
    s.reconcileDetected([v])
    s.registerPostCode('postA', 'CODEA')
    expect(s.keyIndex().get(postVideoKeyByIdIndexed('postA', 0))).toEqual(v)
    expect(s.keyIndex().get(postVideoKeyIndexed('CODEA', 0))).toEqual(v)
  })

  it('does NOT register for a 2-video carousel post', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.reconcileDetected([
      video('v1', 'MP4A', 'POSTA', 'postB', 0),
      video('v2', 'MP4B', 'POSTB', 'postB', 1),
    ])
    expect(s.keyIndex().has(postVideoKeyById('postB'))).toBe(false)
  })

  it('de-registers if a 2nd video for the same post arrives later', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.reconcileDetected([video('v1', 'MP4A', 'POSTA', 'postC', 0)])
    expect(s.keyIndex().has(postVideoKeyById('postC'))).toBe(true)
    s.reconcileDetected([video('v2', 'MP4B', 'POSTB', 'postC', 1)])
    expect(s.keyIndex().has(postVideoKeyById('postC'))).toBe(false)
  })

  it('ignores photos (never registers a post-key for a photo-only post)', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.reconcileDetected([photo('p1', 'KA', 'postD')])
    expect(s.keyIndex().has(postVideoKeyById('postD'))).toBe(false)
  })

  it('clear() wipes slot-occupancy bookkeeping too', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.reconcileDetected([video('v1', 'MP4', 'POST', 'postE')])
    expect(s.keyIndex().has(postVideoKeyById('postE'))).toBe(true)
    s.clear()
    s.reconcileDetected([video('v1', 'MP4', 'POST', 'postE')])
    expect(s.keyIndex().has(postVideoKeyById('postE'))).toBe(true)
  })

  it('clear() also wipes the indexed and dom-slot key bookkeeping', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postE2', 'CODEE2')
    s.reconcileDetected([video('v1', 'MP4', 'POST', 'postE2', 0)])
    expect(s.keyIndex().has(postVideoKeyIndexed('CODEE2', 0))).toBe(true)
    expect(s.keyIndex().has(postVideoKeyByDomSlot('CODEE2', 0))).toBe(true)
    s.clear()
    expect(s.keyIndex().has(postVideoKeyIndexed('CODEE2', 0))).toBe(false)
    expect(s.keyIndex().has(postVideoKeyByDomSlot('CODEE2', 0))).toBe(false)
  })

  it('an unchanged reconciliation does not inflate the per-post count', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST', 'postF')
    s.reconcileDetected([v])
    s.reconcileDetected([v])
    expect(s.keyIndex().has(postVideoKeyById('postF'))).toBe(true)
  })

  it('registerPostCode called after reconciliation still resolves post:{code}', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const v = video('v1', 'MP4', 'POST', 'postG')
    s.reconcileDetected([v])
    s.registerPostCode('postG', 'CODEG')
    expect(s.keyIndex().get(postVideoKey('CODEG'))).toEqual(v)
  })

  it('registerPostCode called before reconciliation also resolves post:{code}', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postH', 'CODEH')
    const v = video('v1', 'MP4', 'POST', 'postH')
    s.reconcileDetected([v])
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
    s.reconcileDetected([
      video('v1', 'MP4A', 'POSTA', 'postJ', 0),
      video('v2', 'MP4B', 'POSTB', 'postJ', 1),
    ])
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
    s.reconcileDetected([vId])
    s.registerPostCode('unrelatedPost', 'SHARED')
    const vCode = video('vCode', 'MP4CODE', 'POSTCODE', 'unrelatedPost')
    s.reconcileDetected([vCode])
    expect(s.keyIndex().get(postVideoKeyById('SHARED'))).toEqual(vId)
    expect(s.keyIndex().get(postVideoKey('SHARED'))).toEqual(vCode)
  })

  it('two videos in one post resolve via distinct indexed keys, never swapped', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postM', 'CODEM')
    const v0 = video('v1', 'MP4A', 'POSTA', 'postM', 0)
    const v1 = video('v2', 'MP4B', 'POSTB', 'postM', 1)
    s.reconcileDetected([v0, v1])

    // the no-index keys withhold entirely (can't disambiguate by postId alone)
    expect(s.keyIndex().has(postVideoKey('CODEM'))).toBe(false)
    expect(s.keyIndex().has(postVideoKeyById('postM'))).toBe(false)

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
    // index 1 is a photo in this carousel — never contributes video aliases.
    const v0 = video('v1', 'MP4A', 'POSTA', 'postN', 0)
    const v2 = video('v2', 'MP4B', 'POSTB', 'postN', 2)
    s.reconcileDetected([v0, photo('p1', 'KA', 'postN', 1), v2])

    expect(s.keyIndex().get(postVideoKeyIndexed('CODEN', 0))).toEqual(v0)
    expect(s.keyIndex().get(postVideoKeyIndexed('CODEN', 2))).toEqual(v2)
    expect(s.keyIndex().has(postVideoKeyIndexed('CODEN', 1))).toBe(false)
  })

  it('replaces a video slot with a photo and removes every stale video alias', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('post-slot', 'CODESLOT')
    const oldVideo = video('video-slot', 'MP4OLD', 'POSTOLD', 'post-slot', 0)
    const nextPhoto = photo('photo-slot', 'PHOTO', 'post-slot')
    s.reconcileDetected([oldVideo])
    expect(s.resolve(postVideoKey('CODESLOT'))).toEqual(oldVideo)

    s.reconcileDetected([nextPhoto])

    expect(s.count).toBe(1)
    expect(s.get(oldVideo.id)).toBeUndefined()
    expect(s.resolve('MP4OLD')).toBeUndefined()
    expect(s.resolve('POSTOLD')).toBeUndefined()
    expect(s.resolve(postVideoKey('CODESLOT'))).toBeUndefined()
    expect(s.resolve(postVideoKeyIndexed('CODESLOT', 0))).toBeUndefined()
    expect(s.resolve(postVideoKeyByDomSlot('CODESLOT', 0))).toBeUndefined()
    expect(s.get(nextPhoto.id)).toEqual(nextPhoto)
    expect(s.resolve('PHOTO')).toEqual(nextPhoto)
  })

  it('replaces a photo slot with a video and exposes only the new video aliases', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('post-slot', 'CODESLOT')
    const oldPhoto = photo('photo-slot', 'PHOTOOLD', 'post-slot')
    const nextVideo = video('video-slot', 'MP4NEW', 'POSTNEW', 'post-slot', 0)
    s.reconcileDetected([oldPhoto])
    expect(s.resolve('PHOTOOLD')).toEqual(oldPhoto)

    s.reconcileDetected([nextVideo])

    expect(s.count).toBe(1)
    expect(s.get(oldPhoto.id)).toBeUndefined()
    expect(s.resolve('PHOTOOLD')).toBeUndefined()
    expect(s.get(nextVideo.id)).toEqual(nextVideo)
    expect(s.resolve('MP4NEW')).toEqual(nextVideo)
    expect(s.resolve('POSTNEW')).toEqual(nextVideo)
    expect(s.resolve(postVideoKey('CODESLOT'))).toEqual(nextVideo)
    expect(s.resolve(postVideoKeyIndexed('CODESLOT', 0))).toEqual(nextVideo)
    expect(s.resolve(postVideoKeyByDomSlot('CODESLOT', 0))).toEqual(nextVideo)
  })

  it('a 1→2 video transition re-syncs: no-index keys go away, both indexed keys appear', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postO', 'CODEO')
    const v0 = video('v1', 'MP4A', 'POSTA', 'postO', 0)
    s.reconcileDetected([v0])
    expect(s.keyIndex().has(postVideoKey('CODEO'))).toBe(true)
    expect(s.keyIndex().has(postVideoKeyById('postO'))).toBe(true)

    const v1 = video('v2', 'MP4B', 'POSTB', 'postO', 1)
    s.reconcileDetected([v1])
    expect(s.keyIndex().has(postVideoKey('CODEO'))).toBe(false)
    expect(s.keyIndex().has(postVideoKeyById('postO'))).toBe(false)
    expect(s.keyIndex().get(postVideoKeyIndexed('CODEO', 0))).toEqual(v0)
    expect(s.keyIndex().get(postVideoKeyIndexed('CODEO', 1))).toEqual(v1)
  })

  it('moving one video out of a two-video post removes stale indexed aliases', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postP', 'CODEP')
    const v0 = video('v1', 'MP4A', 'POSTA', 'postP', 0)
    const v1 = video('v2', 'MP4B', 'POSTB', 'postP', 1)
    s.reconcileDetected([v0, v1])
    expect(s.keyIndex().has(postVideoKeyIndexed('CODEP', 1))).toBe(true)

    const moved = video('v2', 'MP4B', 'POSTB', 'postP2', 0)
    s.reconcileDetected([moved])
    expect(s.resolve(postVideoKeyIndexed('CODEP', 1))).toBeUndefined()
    expect(s.resolve(postVideoKeyByDomSlot('CODEP', 1))).toBeUndefined()
    expect(s.resolve(postVideoKey('CODEP'))).toEqual(v0)
    expect(s.resolve(postVideoKeyById('postP'))).toEqual(v0)
    expect(s.resolve(postVideoKeyById('postP2'))).toEqual(moved)
  })

  it('rebinding a shortcode clears its former bare, indexed, and slot aliases', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    const old = video('old', 'OLDMP4', 'OLDPOST', 'old-post', 0)
    const next = video('next', 'NEXTMP4', 'NEXTPOST', 'new-post', 0)
    s.reconcileDetected([old, next])
    s.registerPostCode('old-post', 'CODE')
    expect(s.resolve(postVideoKey('CODE'))).toEqual(old)
    expect(s.resolve(postVideoKeyIndexed('CODE', 0))).toEqual(old)
    expect(s.resolve(postVideoKeyByDomSlot('CODE', 0))).toEqual(old)

    s.registerPostCode('new-post', 'CODE')
    expect(s.postIdForCode('CODE')).toBe('new-post')
    expect(s.resolve(postVideoKey('CODE'))).toEqual(next)
    expect(s.resolve(postVideoKeyIndexed('CODE', 0))).toEqual(next)
    expect(s.resolve(postVideoKeyByDomSlot('CODE', 0))).toEqual(next)
  })

  it('fails closed: a slide index the store never registered resolves to nothing, never a wrong item', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    s.registerPostCode('postQ', 'CODEQ')
    // Only index 0 was ever tee-detected for this post.
    s.reconcileDetected([video('v1', 'MP4A', 'POSTA', 'postQ', 0)])
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
    // index 1 is a photo slide — it owns the slot but has no video alias.
    s.reconcileDetected([v0, v2])

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
    s.reconcileDetected([v0, v1])

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

  it('syncing one post leaves an unrelated registered code -> post mapping untouched', () => {
    const s = makeDetectionStore({ mediaKeyFromUrl })
    // postK registers first and gets its video — establishes an entry in
    // codeToPostId that a LATER sync (for a different post) must skip over.
    s.registerPostCode('postK', 'CODEK')
    const vK = video('vK', 'MP4K', 'POSTK', 'postK')
    s.reconcileDetected([vK])
    expect(s.keyIndex().get(postVideoKey('CODEK'))).toEqual(vK)

    // postL is a completely separate post/video/code triple.
    s.registerPostCode('postL', 'CODEL')
    const vL = video('vL', 'MP4L', 'POSTL', 'postL')
    s.reconcileDetected([vL])

    // postK's code-keyed entry must still resolve to vK, unaffected by postL's sync.
    expect(s.keyIndex().get(postVideoKey('CODEK'))).toEqual(vK)
    expect(s.keyIndex().get(postVideoKey('CODEL'))).toEqual(vL)
  })
})
