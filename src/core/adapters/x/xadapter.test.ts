import { describe, it, expect } from 'vitest'
import {
  detectFromJson,
  detectRenderedImageElements,
  resolveImageElement,
  videoTweetsNeedingRecovery,
  isXUrl,
} from './index'
import { renderFilename } from '../../download/filename'
import tweetDetail from '../../../test/fixtures/tweet-detail.json'

/** Build a detached subtree and return the nth `<img>` in document order. */
function imgAt(html: string, n = 0): HTMLImageElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root.querySelectorAll('img')[n]!
}

describe('detectFromJson', () => {
  it('extracts all photos from a TweetResult with author + postId', () => {
    const items = detectFromJson(tweetDetail)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      author: 'alice',
      postId: '1790',
      type: 'photo',
      platform: 'x',
    })
    expect(items[0]!.url).toContain('name=orig')
  })

  it('keeps a video poster URL while resolving the downloadable MP4', () => {
    const items = detectFromJson({
      data: {
        tweetResult: {
          result: {
            rest_id: '77',
            core: { user_results: { result: { legacy: { screen_name: 'alice' } } } },
            legacy: {
              extended_entities: {
                media: [
                  {
                    type: 'video',
                    id_str: 'v1',
                    media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/77/pu/img/V1.jpg',
                    video_info: {
                      variants: [
                        { content_type: 'application/x-mpegURL', url: 'playlist.m3u8' },
                        {
                          content_type: 'video/mp4',
                          bitrate: 832000,
                          url: 'https://video.twimg.com/ext_tw_video/77/pu/vid/640x360/low.mp4',
                        },
                        {
                          content_type: 'video/mp4',
                          bitrate: 2176000,
                          url: 'https://video.twimg.com/ext_tw_video/77/pu/vid/1280x720/high.mp4',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      type: 'video',
      ext: 'mp4',
      url: 'https://video.twimg.com/ext_tw_video/77/pu/vid/1280x720/high.mp4',
      previewUrl: 'https://pbs.twimg.com/ext_tw_video_thumb/77/pu/img/V1.jpg',
      platform: 'x',
    })
  })

  it("attributes a quoting tweet's media to its OWN author, not the quoted author", () => {
    // Outer tweet by REAL_AUTHOR quotes a tweet by QUOTED_AUTHOR. X serializes
    // `quoted_status_result` as a sibling of `core`; here it appears BEFORE `core`
    // in key order, so an unbounded DFS for `screen_name` would return the quoted
    // author and mis-file the outer tweet's media under the wrong handle.
    const items = detectFromJson({
      data: {
        tweetResult: {
          result: {
            rest_id: '5001',
            quoted_status_result: {
              result: {
                rest_id: '4000',
                core: { user_results: { result: { legacy: { screen_name: 'QUOTED_AUTHOR' } } } },
                legacy: {
                  extended_entities: {
                    media: [
                      {
                        type: 'photo',
                        id_str: 'q1',
                        media_url_https: 'https://pbs.twimg.com/media/Quoted.jpg',
                      },
                    ],
                  },
                },
              },
            },
            core: { user_results: { result: { legacy: { screen_name: 'REAL_AUTHOR' } } } },
            legacy: {
              extended_entities: {
                media: [
                  {
                    type: 'photo',
                    id_str: 'o1',
                    media_url_https: 'https://pbs.twimg.com/media/Outer.jpg',
                  },
                ],
              },
            },
          },
        },
      },
    })

    const outer = items.find((i) => i.postId === '5001')
    const quoted = items.find((i) => i.postId === '4000')
    expect(outer).toBeDefined()
    expect(quoted).toBeDefined()
    expect(outer!.author).toBe('REAL_AUTHOR')
    expect(quoted!.author).toBe('QUOTED_AUTHOR')
  })

  it('scans through array values and short-circuits once the author is found', () => {
    // `authors` is an ARRAY whose FIRST element carries `screen_name`; the scan
    // must recurse into the array (Array.isArray arm) and then early-return on the
    // SECOND element because `found` is already set.
    const items = detectFromJson({
      data: {
        result: {
          rest_id: '6001',
          authors: [
            { user_results: { result: { legacy: { screen_name: 'ARR_AUTHOR' } } } },
            { user_results: { result: { legacy: { screen_name: 'SECOND_NEVER_USED' } } } },
          ],
          legacy: {
            extended_entities: {
              media: [
                {
                  type: 'photo',
                  id_str: 'm1',
                  media_url_https: 'https://pbs.twimg.com/media/Arr.jpg',
                },
              ],
            },
          },
        },
      },
    })
    expect(items).toHaveLength(1)
    expect(items[0]!.author).toBe('ARR_AUTHOR')
  })

  it('uses legacy.id_str as the postId when rest_id is absent', () => {
    const items = detectFromJson({
      data: {
        result: {
          core: { user_results: { result: { legacy: { screen_name: 'idstr_author' } } } },
          legacy: {
            id_str: '7100',
            extended_entities: {
              media: [
                {
                  type: 'photo',
                  id_str: 'i1',
                  media_url_https: 'https://pbs.twimg.com/media/IdStr.jpg',
                },
              ],
            },
          },
        },
      },
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ postId: '7100', author: 'idstr_author' })
  })

  it('skips a media node carrying neither rest_id nor legacy.id_str', () => {
    const items = detectFromJson({
      data: {
        result: {
          legacy: {
            extended_entities: {
              media: [
                {
                  type: 'photo',
                  id_str: 'n1',
                  media_url_https: 'https://pbs.twimg.com/media/NoId.jpg',
                },
              ],
            },
          },
        },
      },
    })
    expect(items).toEqual([])
  })

  it('de-dupes a tweet node that appears twice in the JSON tree', () => {
    const node = {
      rest_id: '8200',
      core: { user_results: { result: { legacy: { screen_name: 'dup' } } } },
      legacy: {
        extended_entities: {
          media: [
            { type: 'photo', id_str: 'd1', media_url_https: 'https://pbs.twimg.com/media/Dup.jpg' },
          ],
        },
      },
    }
    // The same node referenced under two keys is walked twice; `seen` keeps one.
    const items = detectFromJson({ data: { a: node, b: node } })
    expect(items).toHaveLength(1)
    expect(items[0]!.postId).toBe('8200')
  })

  it('falls back to an empty author when the tweet node has no screen_name', () => {
    const items = detectFromJson({
      data: {
        result: {
          rest_id: '8300',
          legacy: {
            extended_entities: {
              media: [
                {
                  type: 'photo',
                  id_str: 'h1',
                  media_url_https: 'https://pbs.twimg.com/media/NoName.jpg',
                },
              ],
            },
          },
        },
      },
    })
    expect(items).toHaveLength(1)
    expect(items[0]!.author).toBe('')
  })

  it('attributes both the outer and retweeted media to their OWN authors', () => {
    // The outer node (RETWEETER) carries its own media AND wraps the original
    // under `retweeted_status_result`, serialized BEFORE `core`. This is the case
    // that DISCRIMINATES the prune: an unpruned DFS would find ORIGINAL_AUTHOR
    // first and mis-file the outer media under it. Each tweet must keep its own
    // author — symmetric with the quoted_status_result case.
    const items = detectFromJson({
      data: {
        tweetResult: {
          result: {
            rest_id: '9001',
            retweeted_status_result: {
              result: {
                rest_id: '8000',
                core: { user_results: { result: { legacy: { screen_name: 'ORIGINAL_AUTHOR' } } } },
                legacy: {
                  extended_entities: {
                    media: [
                      {
                        type: 'photo',
                        id_str: 'r1',
                        media_url_https: 'https://pbs.twimg.com/media/RT.jpg',
                      },
                    ],
                  },
                },
              },
            },
            core: { user_results: { result: { legacy: { screen_name: 'RETWEETER' } } } },
            legacy: {
              extended_entities: {
                media: [
                  {
                    type: 'photo',
                    id_str: 'o1',
                    media_url_https: 'https://pbs.twimg.com/media/Own.jpg',
                  },
                ],
              },
            },
          },
        },
      },
    })

    const own = items.find((i) => i.postId === '9001')
    const original = items.find((i) => i.postId === '8000')
    expect(own).toBeDefined()
    expect(original).toBeDefined()
    expect(own!.author).toBe('RETWEETER')
    expect(original!.author).toBe('ORIGINAL_AUTHOR')
  })
})

describe('detectRenderedImageElements', () => {
  it('collects rendered timeline photos using article status links as context', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <article data-testid="tweet">
        <a href="/alice/status/100"><time>now</time></a>
        <img src="https://pbs.twimg.com/media/A1?format=jpg&name=small" />
        <img src="https://pbs.twimg.com/profile_images/nope.jpg" />
      </article>
      <article data-testid="tweet">
        <a href="/bob/status/200"><time>now</time></a>
        <a href="/bob/status/200/photo/1">
          <img src="https://pbs.twimg.com/media/B1?format=png&name=900x900" />
        </a>
      </article>`

    const items = detectRenderedImageElements(root, '/i/trending/2065122521075036169')

    expect(items).toHaveLength(2)
    expect(items.map((item) => item.id)).toEqual(['A1', 'B1']) // id = media key (ADR-0016)
    expect(items.map((item) => item.author)).toEqual(['alice', 'bob'])
    expect(items[0]!.url).toBe('https://pbs.twimg.com/media/A1?format=jpg&name=orig')
    expect(items[1]!.ext).toBe('png')
  })

  it('de-dupes repeated rendered photos by resolved id', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <article data-testid="tweet">
        <a href="/alice/status/100"><time>now</time></a>
        <img src="https://pbs.twimg.com/media/A1?format=jpg&name=small" />
        <img src="https://pbs.twimg.com/media/A1?format=jpg&name=small" />
      </article>`

    expect(detectRenderedImageElements(root, '/i/trending/2065122521075036169')).toHaveLength(1)
  })
})

describe('resolveImageElement', () => {
  const GRID = `
    <article data-testid="tweet">
      <a href="/alice/status/1790"><time>now</time></a>
      <a href="/alice/status/1790/photo/1"><img src="https://pbs.twimg.com/media/P0?format=jpg&name=900x900" /></a>
      <a href="/alice/status/1790/photo/2"><img src="https://pbs.twimg.com/media/P1?format=png&name=360x360" /></a>
      <a href="/alice/status/1790/photo/3"><img src="https://pbs.twimg.com/media/P2?format=jpg&name=small" /></a>
      <img src="https://pbs.twimg.com/profile_images/zzz.jpg" />
    </article>`

  it('resolves the exact hovered photo in a multi-image grid', () => {
    const item = resolveImageElement(imgAt(GRID, 1))
    expect(item).not.toBeNull()
    expect(item!).toMatchObject({ type: 'photo', author: 'alice', postId: '1790', index: 1 })
    expect(item!.url).toContain('name=orig')
    expect(item!.url).toContain('/media/P1')
    expect(item!.ext).toBe('png')
  })

  it('upgrades to original quality and reads ext from ?format=', () => {
    const item = resolveImageElement(imgAt(GRID, 0))
    expect(item!.url).toBe('https://pbs.twimg.com/media/P0?format=jpg&name=orig')
    expect(item!.ext).toBe('jpg')
    expect(item!.index).toBe(0)
  })

  it('returns null for avatars / non-media images', () => {
    expect(resolveImageElement(imgAt(GRID, 3))).toBeNull()
    expect(
      resolveImageElement(imgAt('<img src="https://pbs.twimg.com/card_img/9/a?format=jpg" />')),
    ).toBeNull()
    expect(resolveImageElement(imgAt('<img src="https://example.com/x.jpg" />'))).toBeNull()
  })

  it('falls back to the page path for the lightbox /photo/ route (no article)', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/L7?format=jpg&name=large" />')
    const item = resolveImageElement(img, '/bob/status/55/photo/2')
    expect(item!).toMatchObject({ author: 'bob', postId: '55', index: 1 })
    expect(item!.url).toContain('name=orig')
  })

  it("attributes a quoted-tweet photo to the quoted tweet via the photo's own link", () => {
    const html = `
      <article data-testid="tweet">
        <a href="/alice/status/1790"><time>now</time></a>
        <a href="/alice/status/1790/photo/1"><img src="https://pbs.twimg.com/media/Outer?format=jpg&name=small" /></a>
        <div role="link">
          <a href="/bob/status/2000"><span>@bob</span></a>
          <a href="/bob/status/2000/photo/1"><img src="https://pbs.twimg.com/media/Quoted?format=jpg&name=small" /></a>
        </div>
      </article>`
    const item = resolveImageElement(imgAt(html, 1))
    expect(item!).toMatchObject({ author: 'bob', postId: '2000', index: 0 })
    expect(item!.url).toContain('/media/Quoted')
  })

  it('drops the author for X internal /i/web/status permalinks', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/IW?format=jpg&name=small" />')
    const item = resolveImageElement(img, '/i/web/status/999')
    expect(item!).toMatchObject({ author: '', postId: '999' })
    expect(renderFilename('{handle}/{tweetId}_{index}.{ext}', item!)).toBe('999_0.jpg')
  })

  it('keeps the /photo/{n} ordinal on /i/ internal permalinks', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/IW2?format=jpg&name=small" />')
    const item = resolveImageElement(img, '/i/web/status/999/photo/2')
    expect(item!).toMatchObject({ author: '', postId: '999', index: 1, id: 'IW2' })
  })

  it('ids a DOM photo by the same media key the tee would (ADR-0016)', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/ABC?format=jpg&name=small" />')
    // Matches resolveTweetMedia's id for /media/ABC, so a photo seen by both the
    // tee and the DOM is ONE item, not two.
    expect(resolveImageElement(img, '/alice/status/1790')!.id).toBe('ABC')
  })

  it('normalizes a webp rendition to a jpg original request', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/W1?format=webp&name=small" />')
    const item = resolveImageElement(img, '/alice/status/77')
    expect(item!.url).toBe('https://pbs.twimg.com/media/W1?format=jpg&name=orig')
    expect(item!.ext).toBe('jpg')
  })

  it('falls back to media-key identity for an anchor-less quote card (real X DOM)', () => {
    const html = `
      <article data-testid="tweet">
        <a href="/alice/status/1790"><time>now</time></a>
        <div role="link" tabindex="0">
          <span>@bob</span>
          <img src="https://pbs.twimg.com/media/QuotedNL?format=jpg&name=small" />
        </div>
      </article>`
    const item = resolveImageElement(imgAt(html), '/alice/status/1790')
    expect(item!).toMatchObject({ author: '', postId: 'QuotedNL', id: 'QuotedNL', index: 0 })
  })

  it("scopes the DOM-order index to the photo's own tweet when anchors lack /photo/{n}", () => {
    const html = `
      <article data-testid="tweet">
        <a href="/alice/status/1790"><time>now</time></a>
        <a href="/alice/status/1790"><img src="https://pbs.twimg.com/media/OuterB?format=jpg&name=small" /></a>
        <div role="link">
          <a href="/bob/status/2000"><span>@bob</span></a>
          <a href="/bob/status/2000"><img src="https://pbs.twimg.com/media/QuotedB?format=jpg&name=small" /></a>
        </div>
      </article>`
    expect(resolveImageElement(imgAt(html, 1))!).toMatchObject({
      author: 'bob',
      postId: '2000',
      index: 0,
      id: 'QuotedB',
    })
    expect(resolveImageElement(imgAt(html, 0))!).toMatchObject({
      author: 'alice',
      postId: '1790',
      index: 0,
    })
  })

  it('resolves context from the article permalink when the photo has no enclosing anchor', () => {
    const html = `
      <article data-testid="tweet">
        <a href="/i/web/status/1790"><span>analytics</span></a>
        <a href="/alice/status/1790"><time>now</time></a>
        <img src="https://pbs.twimg.com/media/Bare?format=jpg&name=small" />
      </article>`
    expect(resolveImageElement(imgAt(html))!).toMatchObject({
      author: 'alice',
      postId: '1790',
      index: 0,
    })
  })

  it('uses the author-less /i/ article link as context when no real-author link exists', () => {
    // The article carries ONLY internal `/i/web/status/` permalinks (no handle),
    // and the photo has no enclosing status anchor — so contextFromArticle falls
    // through every real-author check and returns the `/i/` fallback context.
    const html = `
      <article data-testid="tweet">
        <a href="/i/web/status/4242"><span>analytics</span></a>
        <a href="/i/web/status/4242"><time>now</time></a>
        <img src="https://pbs.twimg.com/media/IFB?format=jpg&name=small" />
      </article>`
    const item = resolveImageElement(imgAt(html))
    expect(item!).toMatchObject({ author: '', postId: '4242', index: 0 })
  })

  it('still yields a valid relative filename when no context is known', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/Solo9?format=jpg&name=small" />')
    const item = resolveImageElement(img)
    expect(item!).toMatchObject({ author: '', postId: 'Solo9', index: 0, id: 'Solo9' })
    const path = renderFilename('{handle}/{tweetId}_{index}.{ext}', item!)
    expect(path.startsWith('/')).toBe(false)
    expect(path).toBe('Solo9_0.jpg')
  })

  it('reads img.src when currentSrc is empty (lazy/srcset placeholder)', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/Lazy?format=jpg&name=small" />')
    Object.defineProperty(img, 'currentSrc', { value: '', configurable: true })
    const item = resolveImageElement(img)
    expect(item!).toMatchObject({ postId: 'Lazy', id: 'Lazy' })
  })

  it('returns null for a /media/ url whose basename yields an empty key', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/" />')
    expect(resolveImageElement(img)).toBeNull()
  })

  it('scopes the index scan even when a sibling img has an empty currentSrc', () => {
    const html = `
      <article data-testid="tweet">
        <a href="/alice/status/1790"><time>now</time></a>
        <img src="https://pbs.twimg.com/media/First?format=jpg&name=small" />
        <img src="https://pbs.twimg.com/media/Second?format=jpg&name=small" />
      </article>`
    const root = document.createElement('div')
    root.innerHTML = html
    const imgs = root.querySelectorAll('img')
    // Force the first img to report an empty currentSrc so the filter's
    // `el.currentSrc || el.src` falls through to `.src` during the index scan.
    Object.defineProperty(imgs[0]!, 'currentSrc', { value: '', configurable: true })
    const item = resolveImageElement(imgs[1]!)
    expect(item!).toMatchObject({ postId: '1790', author: 'alice', index: 1 })
  })
})

const POSTER =
  'https://pbs.twimg.com/ext_tw_video_thumb/2068286110858661888/pu/img/wG3s1P2bBrE3U0cL.jpg'

const PLAYER = (poster: string): string => `
  <article data-testid="tweet">
    <a href="/ooaoau/status/2068286123399676218"><time>now</time></a>
    <div data-testid="videoPlayer">
      <video></video>
      <img src="${poster}" />
    </div>
  </article>`

const domRoot = (html: string): HTMLElement => {
  const el = document.createElement('div')
  el.innerHTML = html
  return el
}

describe('videoTweetsNeedingRecovery', () => {
  const root = domRoot

  it('flags a tweet whose video poster key is not yet detected', () => {
    expect(videoTweetsNeedingRecovery(root(PLAYER(POSTER)), new Set())).toEqual([
      '2068286123399676218',
    ])
  })

  it('skips a video the tee already captured (poster key present)', () => {
    const detected = new Set(['wG3s1P2bBrE3U0cL'])
    expect(videoTweetsNeedingRecovery(root(PLAYER(POSTER)), detected)).toEqual([])
  })

  it('reads the poster from the container img when no <video> has mounted yet', () => {
    const html = `
      <article data-testid="tweet">
        <a href="/ooaoau/status/55"><time>now</time></a>
        <div data-testid="videoComponent">
          <img src="${POSTER}" />
        </div>
      </article>`
    expect(videoTweetsNeedingRecovery(root(html), new Set())).toEqual(['55'])
  })

  it('ignores a player with no grabbable poster', () => {
    const html = `
      <article data-testid="tweet">
        <a href="/ooaoau/status/55"><time>now</time></a>
        <div data-testid="videoPlayer"><video></video></div>
      </article>`
    expect(videoTweetsNeedingRecovery(root(html), new Set())).toEqual([])
  })

  it('ignores a player that has neither a <video> nor a poster image', () => {
    const html = `
      <article data-testid="tweet">
        <a href="/ooaoau/status/55"><time>now</time></a>
        <div data-testid="videoComponent"></div>
      </article>`
    expect(videoTweetsNeedingRecovery(root(html), new Set())).toEqual([])
  })

  it('falls back to the poster img src when currentSrc is empty', () => {
    const html = `
      <article data-testid="tweet">
        <a href="/ooaoau/status/77"><time>now</time></a>
        <div data-testid="videoComponent"><img src="${POSTER}" /></div>
      </article>`
    const r = root(html)
    // Force an empty currentSrc so `currentSrc || src` falls through to `.src`.
    Object.defineProperty(r.querySelector('img')!, 'currentSrc', {
      value: '',
      configurable: true,
    })
    expect(videoTweetsNeedingRecovery(r, new Set())).toEqual(['77'])
  })

  it('ignores a player outside any tweet article', () => {
    const html = `<div data-testid="videoPlayer"><img src="${POSTER}" /></div>`
    expect(videoTweetsNeedingRecovery(root(html), new Set())).toEqual([])
  })

  it('de-dupes multiple players of the same tweet', () => {
    expect(videoTweetsNeedingRecovery(root(PLAYER(POSTER) + PLAYER(POSTER)), new Set())).toEqual([
      '2068286123399676218',
    ])
  })

  it('skips attempted tweet ids before any poster work', () => {
    expect(
      videoTweetsNeedingRecovery(
        root(PLAYER(POSTER)),
        new Set(),
        new Set(['2068286123399676218']),
      ),
    ).toEqual([])
  })

  it('a poster-less first player does not block a second valid player of the same tweet', () => {
    const html = `
      <article data-testid="tweet">
        <a href="/alice/status/55"><time>now</time></a>
        <div data-testid="videoPlayer"></div>
        <div data-testid="videoPlayer"><video></video><img src="${POSTER}" /></div>
      </article>`
    expect(videoTweetsNeedingRecovery(root(html), new Set())).toEqual(['55'])
  })
})

describe('isXUrl', () => {
  it('matches x.com and twitter.com pages, rejects other hosts', () => {
    expect(isXUrl('https://x.com/alice/status/1')).toBe(true)
    expect(isXUrl('http://twitter.com/bob')).toBe(true)
    expect(isXUrl('https://example.com/x.com/fake')).toBe(false)
  })
})
