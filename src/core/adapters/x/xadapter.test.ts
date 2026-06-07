import { describe, it, expect } from 'vitest'
import { detectFromJson, detectFromDom } from './index'
import tweetDetail from '../../../test/fixtures/tweet-detail.json'

describe('detectFromJson', () => {
  it('extracts all photos from a TweetResult with handle + tweetId', () => {
    const items = detectFromJson(tweetDetail)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ handle: 'alice', tweetId: '1790', type: 'photo' })
    expect(items[0]!.url).toContain('name=orig')
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
