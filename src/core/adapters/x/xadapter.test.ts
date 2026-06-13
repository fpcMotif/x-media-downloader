import { describe, it, expect } from 'vitest'
import {
  detectFromJson,
  detectFromDom,
  detectRenderedImageElements,
  resolveImageElement,
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
  it('extracts all photos from a TweetResult with handle + tweetId', () => {
    const items = detectFromJson(tweetDetail)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ handle: 'alice', tweetId: '1790', type: 'photo' })
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
    })
  })
})

describe('detectFromDom', () => {
  it('falls back to pbs.twimg media images in the DOM', () => {
    const root = document.createElement('div')
    root.innerHTML = `
      <article>
        <img src="https://pbs.twimg.com/media/CCC?format=jpg&name=small" />
        <img src="https://pbs.twimg.com/profile_images/zzz.jpg" />
      </article>`
    const items = detectFromDom(root, { tweetId: '42', handle: 'bob' })
    expect(items).toHaveLength(1)
    expect(items[0]!.url).toContain('name=orig')
    expect(items[0]!.handle).toBe('bob')
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
    expect(items.map((item) => item.id)).toEqual(['100-0', '200-0'])
    expect(items.map((item) => item.handle)).toEqual(['alice', 'bob'])
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
    expect(item!).toMatchObject({ type: 'photo', handle: 'alice', tweetId: '1790', index: 1 })
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
    expect(item!).toMatchObject({ handle: 'bob', tweetId: '55', index: 1 })
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
    expect(item!).toMatchObject({ handle: 'bob', tweetId: '2000', index: 0 })
    expect(item!.url).toContain('/media/Quoted')
  })

  it('drops the author for X internal /i/web/status permalinks', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/IW?format=jpg&name=small" />')
    const item = resolveImageElement(img, '/i/web/status/999')
    expect(item!).toMatchObject({ handle: '', tweetId: '999' })
    expect(renderFilename('{handle}/{tweetId}_{index}.{ext}', item!)).toBe('999_0.jpg')
  })

  it('keeps the /photo/{n} ordinal on /i/ internal permalinks', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/IW2?format=jpg&name=small" />')
    const item = resolveImageElement(img, '/i/web/status/999/photo/2')
    expect(item!).toMatchObject({ handle: '', tweetId: '999', index: 1, id: '999-1' })
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
    expect(item!).toMatchObject({ handle: '', tweetId: 'QuotedNL', id: 'QuotedNL', index: 0 })
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
      handle: 'bob',
      tweetId: '2000',
      index: 0,
      id: '2000-0',
    })
    expect(resolveImageElement(imgAt(html, 0))!).toMatchObject({
      handle: 'alice',
      tweetId: '1790',
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
      handle: 'alice',
      tweetId: '1790',
      index: 0,
    })
  })

  it('still yields a valid relative filename when no context is known', () => {
    const img = imgAt('<img src="https://pbs.twimg.com/media/Solo9?format=jpg&name=small" />')
    const item = resolveImageElement(img)
    expect(item!).toMatchObject({ handle: '', tweetId: 'Solo9', index: 0, id: 'Solo9' })
    const path = renderFilename('{handle}/{tweetId}_{index}.{ext}', item!)
    expect(path.startsWith('/')).toBe(false)
    expect(path).toBe('Solo9_0.jpg')
  })
})
