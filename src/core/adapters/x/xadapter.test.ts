import { describe, it, expect } from 'vitest'
import {
  archiveSourceFromPage,
  archiveSourceFromPath,
  detectFromJson,
  detectFromDom,
  detectTweetCaptures,
  findRemovalButton,
  findTweetArticle,
  resolveImageElement,
} from './index'
import { renderFilename } from '../../download/filename'
import tweetDetail from '../../../test/fixtures/tweet-detail.json'
import bookmarksTimeline from '../../../test/fixtures/bookmarks-timeline.json'

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
})

describe('archiveSourceFromPath', () => {
  it('recognises Bookmarks and Likes GraphQL captures only', () => {
    expect(archiveSourceFromPath('/i/api/graphql/k3y/Bookmarks')).toBe('bookmarks')
    expect(archiveSourceFromPath('/i/api/graphql/k3y/Likes')).toBe('likes')
    expect(archiveSourceFromPath('/i/api/graphql/k3y/HomeTimeline')).toBeNull()
    expect(archiveSourceFromPath('/some/Bookmarks')).toBeNull()
  })
})

describe('archiveSourceFromPage', () => {
  it('gates the launcher to the bookmarks and likes pages', () => {
    expect(archiveSourceFromPage('/i/bookmarks')).toBe('bookmarks')
    expect(archiveSourceFromPage('/i/bookmarks/all')).toBe('bookmarks')
    expect(archiveSourceFromPage('/alice/likes')).toBe('likes')
    expect(archiveSourceFromPage('/alice/likes/')).toBe('likes')
    expect(archiveSourceFromPage('/home')).toBeNull()
    expect(archiveSourceFromPage('/alice/status/1')).toBeNull()
    expect(archiveSourceFromPage('/i/web/status/1/likes')).toBeNull()
  })
})

describe('detectTweetCaptures', () => {
  const captures = detectTweetCaptures(bookmarksTimeline)
  const byId = new Map(captures.map((c) => [c.tweetId, c]))

  it('captures each saved tweet once, with author, text, and created_at', () => {
    expect(captures.map((c) => c.tweetId)).toEqual(['9001', '9002', '9003', '9004'])
    expect(byId.get('9001')).toMatchObject({
      handle: 'alice',
      text: 'our new paper is out https://t.co/abc and a write-up https://t.co/def',
      createdAt: 'Wed Jun 10 20:19:24 +0000 2026',
    })
  })

  it('expands t.co links from the URL entities', () => {
    expect(byId.get('9001')!.links).toEqual([
      'https://arxiv.org/abs/2406.01234',
      'https://example.com/blog',
    ])
    expect(byId.get('9002')!.links).toEqual([
      'https://link.springer.com/book/10.1007/978-3-031-00000-0',
    ])
  })

  it('resolves media at original quality, and tolerates text-only tweets', () => {
    expect(byId.get('9001')!.media).toHaveLength(1)
    expect(byId.get('9001')!.media[0]!.url).toContain('name=orig')
    expect(byId.get('9002')!.media).toEqual([])
  })

  it('does not surface a quoted tweet as its own capture', () => {
    expect(byId.has('8001')).toBe(false)
    const outer = byId.get('9003')!
    expect(outer.handle).toBe('carol')
    expect(outer.media.map((m) => m.id)).toEqual(['p9003'])
    // The quote survives as the outer tweet's link, so nothing is lost.
    expect(outer.links).toContain('https://x.com/dave/status/8001')
  })

  it('prefers note_tweet long-form text and its entity links', () => {
    const note = byId.get('9004')!
    expect(note.text).toContain('full thoughts here')
    expect(note.text!.endsWith('…')).toBe(false)
    expect(note.links).toEqual(['https://academic.oup.com/book/0000'])
  })
})

describe('findTweetArticle / findRemovalButton', () => {
  const TIMELINE = `
    <main>
      <article data-testid="tweet">
        <a href="/alice/status/100"><time>now</time></a>
        <div role="link">
          <a href="/bob/status/200"><span>@bob</span></a>
        </div>
        <button data-testid="removeBookmark"></button>
        <button data-testid="unlike"></button>
      </article>
      <article data-testid="tweet">
        <a href="/bob/status/200"><time>now</time></a>
        <button data-testid="bookmark"></button>
      </article>
    </main>`

  const root = (): HTMLElement => {
    const el = document.createElement('div')
    el.innerHTML = TIMELINE
    return el
  }

  it("matches an article by its OWN permalink, not a quote card's", () => {
    const r = root()
    const article = findTweetArticle(r, '200')
    expect(article).not.toBeNull()
    expect(article!.querySelector('time')).not.toBeNull()
    expect(article).toBe(r.querySelectorAll('article')[1])
    expect(findTweetArticle(r, '999')).toBeNull()
  })

  it('finds the matching removal control per source', () => {
    const article = findTweetArticle(root(), '100')!
    expect(findRemovalButton(article, 'bookmarks')?.getAttribute('data-testid')).toBe(
      'removeBookmark',
    )
    expect(findRemovalButton(article, 'likes')?.getAttribute('data-testid')).toBe('unlike')
  })

  it('returns null when the tweet is no longer bookmarked (button flipped)', () => {
    const article = findTweetArticle(root(), '200')!
    expect(findRemovalButton(article, 'bookmarks')).toBeNull()
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
