import { describe, it, expect } from 'vitest'
import { xAdapter, X_CDN_HOSTS } from './adapter'
import { X_HOST_MATCH } from './index'

describe('xAdapter', () => {
  it('reports the x platform tag and X_HOST_MATCH host patterns', () => {
    expect(xAdapter.platform).toBe('x')
    expect(xAdapter.hostMatch).toBe(X_HOST_MATCH)
  })

  it('reports X_CDN_HOSTS, both exact-only (no subdomains)', () => {
    expect(xAdapter.cdnHosts).toBe(X_CDN_HOSTS)
    expect(xAdapter.cdnHosts).toEqual([
      { host: 'pbs.twimg.com', includeSubdomains: false },
      { host: 'video.twimg.com', includeSubdomains: false },
    ])
  })

  it('matchesUrl delegates to isXUrl', () => {
    expect(xAdapter.matchesUrl('https://x.com/alice/status/1')).toBe(true)
    expect(xAdapter.matchesUrl('https://instagram.com/p/abc/')).toBe(false)
  })

  it('isTrackedResponseUrl delegates to the X GraphQL media-op filter', () => {
    expect(xAdapter.isTrackedResponseUrl('https://x.com/i/api/graphql/abc/TweetDetail')).toBe(true)
    expect(xAdapter.isTrackedResponseUrl('https://x.com/i/api/graphql/abc/CreateBookmark')).toBe(
      false,
    )
  })

  it('detectFromResponse ignores the url param and resolves media from the GraphQL json', () => {
    const json = {
      data: {
        threaded_conversation_with_injections_v2: {
          instructions: [
            {
              entries: [
                {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: {
                          rest_id: '42',
                          core: { user_results: { result: { legacy: { screen_name: 'alice' } } } },
                          legacy: {
                            extended_entities: {
                              media: [
                                {
                                  type: 'photo',
                                  media_url_https: 'https://pbs.twimg.com/media/AAA.jpg',
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    }
    const items = xAdapter.detectFromResponse('https://x.com/i/api/graphql/abc/TweetDetail', json)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ platform: 'x', postId: '42', author: 'alice', type: 'photo' })
  })

  it('detectRenderedMedia/resolveHoverItem/canResolveHoverItem/findMediaNeedingRecovery are wired (no-op on an empty DOM)', () => {
    const root = document.createElement('div')
    expect(xAdapter.detectRenderedMedia(root, '/')).toEqual([])
    expect(xAdapter.canResolveHoverItem(root, 'key', new Map())).toBe(false)
    expect(xAdapter.resolveHoverItem(root, 'key', new Map(), '/')).toBeNull()
    expect(xAdapter.findMediaNeedingRecovery?.(root, new Set(), new Set())).toEqual([])
  })

  it("mediaKeyFromUrl combines isGrabbableMediaPreviewUrl + mediaKeyFromUrl exactly like the overlay's inline gate", () => {
    // A /media/ photo — grabbable, yields its key.
    expect(xAdapter.mediaKeyFromUrl('https://pbs.twimg.com/media/AAA.jpg')).toBe('AAA')
    // A named video-poster section — grabbable, yields its key.
    expect(xAdapter.mediaKeyFromUrl('https://pbs.twimg.com/tweet_video_thumb/BBB.jpg')).toBe('BBB')
    // An avatar (/profile_images/) — NOT grabbable, even though the host is twimg.
    expect(xAdapter.mediaKeyFromUrl('https://pbs.twimg.com/profile_images/CCC.jpg')).toBeNull()
    // A non-twimg host — null.
    expect(xAdapter.mediaKeyFromUrl('https://example.com/media/AAA.jpg')).toBeNull()
    // Malformed input — null (doesn't throw).
    expect(xAdapter.mediaKeyFromUrl('not a url')).toBeNull()
  })
})
