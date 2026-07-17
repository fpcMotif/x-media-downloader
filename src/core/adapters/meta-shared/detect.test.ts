import { describe, it, expect } from 'vitest'
import { detectMediaItems, postCodesInResponse } from './detect'
import { partitionAllowedMediaItems } from '../../sync/url-guard'

describe('detectMediaItems', () => {
  it('resolves a single photo post into one MediaItem, tagged with the given platform', () => {
    const json = {
      data: {
        items: [
          {
            pk: '111',
            code: 'CODE1',
            user: { username: 'alice' },
            image_versions2: {
              candidates: [{ url: 'https://cdn.example/media/AAA.jpg', width: 1080, height: 1080 }],
            },
          },
        ],
      },
    }
    expect(detectMediaItems(json, 'instagram')).toEqual([
      {
        id: 'AAA',
        platform: 'instagram',
        postId: '111',
        author: 'alice',
        type: 'photo',
        url: 'https://cdn.example/media/AAA.jpg',
        ext: 'jpg',
        index: 0,
        width: 1080,
        height: 1080,
      },
    ])
  })

  it('resolves a video post, tagged threads when asked', () => {
    const json = {
      pk: 222,
      code: 'CODE2',
      user: { username: 'bob' },
      video_versions: [{ url: 'https://cdn.example/v/BBB.mp4', width: 720, height: 1280 }],
    }
    expect(detectMediaItems(json, 'threads')).toEqual([
      {
        id: 'BBB',
        platform: 'threads',
        postId: '222',
        author: 'bob',
        type: 'video',
        url: 'https://cdn.example/v/BBB.mp4',
        ext: 'mp4',
        index: 0,
        width: 720,
        height: 1280,
      },
    ])
  })

  it('resolves a carousel post into multiple MediaItems, indexed 0..n-1 within the post', () => {
    const json = {
      pk: '333',
      code: 'CODE3',
      user: { username: 'carol' },
      carousel_media: [
        { image_versions2: { candidates: [{ url: 'https://cdn.example/c1.jpg' }] } },
        { video_versions: [{ url: 'https://cdn.example/c2.mp4' }] },
      ],
    }
    const items = detectMediaItems(json, 'instagram')
    expect(
      items.map((i) => ({ id: i.id, type: i.type, index: i.index, postId: i.postId })),
    ).toEqual([
      { id: 'c1', type: 'photo', index: 0, postId: '333' },
      { id: 'c2', type: 'video', index: 1, postId: '333' },
    ])
  })

  it('resolves multiple posts in one response, each restarting its own index at 0', () => {
    const json = {
      items: [
        {
          pk: '1',
          code: 'A',
          user: { username: 'a' },
          image_versions2: { candidates: [{ url: 'https://cdn.example/p1.jpg' }] },
        },
        {
          pk: '2',
          code: 'B',
          user: { username: 'b' },
          image_versions2: { candidates: [{ url: 'https://cdn.example/p2.jpg' }] },
        },
      ],
    }
    const items = detectMediaItems(json, 'instagram')
    expect(items.map((i) => ({ postId: i.postId, index: i.index }))).toEqual([
      { postId: '1', index: 0 },
      { postId: '2', index: 0 },
    ])
  })

  it('de-dupes the same media url seen twice', () => {
    const shared = { image_versions2: { candidates: [{ url: 'https://cdn.example/same.jpg' }] } }
    const json = {
      code: 'A',
      user: { username: 'a' },
      ...shared,
      text_post_app_info: {
        share_info: { reposted_post: { code: 'A', user: { username: 'a' }, ...shared } },
      },
    }
    expect(detectMediaItems(json, 'threads')).toHaveLength(1)
  })

  it('gives two DISTINCT posts sharing the same media url each their own MediaItem (bare repost)', () => {
    // A bare repost shares the underlying asset with the original — same url,
    // different post entirely. Dedup must be scoped per-post, not response-wide,
    // or the repost's own feed entry silently loses its media.
    const shared = { image_versions2: { candidates: [{ url: 'https://cdn.example/shared.jpg' }] } }
    const json = {
      items: [
        { pk: '111', code: 'ORIG', user: { username: 'original_poster' }, ...shared },
        { pk: '222', code: 'REPOST', user: { username: 'friend_who_reposted' }, ...shared },
      ],
    }
    const items = detectMediaItems(json, 'threads')
    expect(items.map((i) => ({ postId: i.postId, author: i.author, url: i.url }))).toEqual([
      { postId: '111', author: 'original_poster', url: 'https://cdn.example/shared.jpg' },
      { postId: '222', author: 'friend_who_reposted', url: 'https://cdn.example/shared.jpg' },
    ])
  })

  it('does not let a post-shaped carousel child steal media into the outer post; visits it as its own post', () => {
    const json = {
      code: 'OUTER_CODE',
      user: { username: 'alice' },
      carousel_media: [
        {
          code: 'INNER_CODE',
          user: { username: 'bob' },
          image_versions2: { candidates: [{ url: 'https://cdn.example/inner-unique.jpg' }] },
        },
      ],
    }
    const items = detectMediaItems(json, 'instagram')
    expect(items.map((i) => ({ id: i.id, postId: i.postId, author: i.author }))).toEqual([
      { id: 'inner-unique', postId: 'INNER_CODE', author: 'bob' },
    ])
  })

  it('returns [] for a response with no post-shaped nodes at all', () => {
    expect(detectMediaItems({ hello: 'world' }, 'instagram')).toEqual([])
  })

  it('falls back to jpg/mp4 defaults and derives an id from a dot-less, query-less url', () => {
    const json = {
      code: 'A',
      user: { username: 'a' },
      image_versions2: { candidates: [{ url: 'https://cdn.example/NODOT' }] },
    }
    expect(detectMediaItems(json, 'instagram')).toEqual([
      {
        id: 'NODOT',
        platform: 'instagram',
        postId: 'A',
        author: 'a',
        type: 'photo',
        url: 'https://cdn.example/NODOT',
        ext: 'jpg',
        index: 0,
      },
    ])
  })
})

describe('postCodesInResponse', () => {
  it('returns one {postId: code} pair for a single post', () => {
    const json = { pk: '111', code: 'CODE1', user: { username: 'alice' } }
    expect([...postCodesInResponse(json)]).toEqual([['111', 'CODE1']])
  })

  it('returns multiple pairs for multiple posts', () => {
    const json = {
      items: [
        { pk: '1', code: 'A', user: { username: 'a' } },
        { pk: '2', code: 'B', user: { username: 'b' } },
      ],
    }
    expect([...postCodesInResponse(json)].toSorted()).toEqual([
      ['1', 'A'],
      ['2', 'B'],
    ])
  })

  it('keys by pk (matching MediaItem.postId) when pk is present', () => {
    const json = { pk: 42, code: 'CODE42', user: { username: 'a' } }
    const map = postCodesInResponse(json)
    expect(map.get('42')).toBe('CODE42')
  })

  it('keys by code itself when pk is absent (degenerate but consistent)', () => {
    const json = { code: 'ONLYCODE', user: { username: 'a' } }
    const map = postCodesInResponse(json)
    expect(map.get('ONLYCODE')).toBe('ONLYCODE')
  })

  it('includes a nested reposted/quoted post as its own separate pair', () => {
    const json = {
      code: 'OUTER',
      user: { username: 'alice' },
      text_post_app_info: {
        share_info: { reposted_post: { code: 'INNER', user: { username: 'bob' } } },
      },
    }
    const map = postCodesInResponse(json)
    expect(map.get('OUTER')).toBe('OUTER')
    expect(map.get('INNER')).toBe('INNER')
  })

  it('returns an empty map for a response with no post-shaped nodes', () => {
    expect(postCodesInResponse({ hello: 'world' }).size).toBe(0)
  })
})

describe('detectMediaItems × url-guard composition', () => {
  // The fixtures above intentionally use `https://cdn.example/...`, which is NOT
  // on the CDN allow-list. For guard-composition only, clone the parsed item
  // with an allow-listed URL; the guard itself is never widened.
  it('passes a parsed item through the guard once its URL is a real Meta CDN URL', () => {
    const json = {
      data: {
        items: [
          {
            pk: '111',
            code: 'CODE1',
            user: { username: 'alice' },
            image_versions2: {
              candidates: [{ url: 'https://cdn.example/media/AAA.jpg', width: 1080, height: 1080 }],
            },
          },
        ],
      },
    }
    const [parsed] = detectMediaItems(json, 'instagram')
    const { allowed, rejected } = partitionAllowedMediaItems([
      { ...parsed!, url: 'https://scontent.cdninstagram.com/v/example.jpg' },
    ])
    expect(allowed).toHaveLength(1)
    expect(rejected).toEqual([])
  })

  it('rejects a parsed item whose hostile URL is left unchanged', () => {
    const json = {
      pk: '222',
      code: 'CODE2',
      user: { username: 'bob' },
      video_versions: [{ url: 'https://attacker.example/v/BBB.mp4', width: 720, height: 1280 }],
    }
    const [parsed] = detectMediaItems(json, 'threads')
    const { allowed, rejected } = partitionAllowedMediaItems([parsed!])
    expect(allowed).toEqual([])
    expect(rejected.map((r) => r.itemId)).toEqual(['BBB'])
  })
})
