import { describe, it, expect } from 'vitest'
import {
  inlineDataPayloads,
  MAX_INLINE_DATA_BYTES,
  MAX_INLINE_DATA_SCRIPTS,
  MAX_INLINE_DOCUMENT_SCRIPTS,
} from './inline-data'
import { detectMediaItems, postCodesInResponse } from './detect'

describe('inlineDataPayloads', () => {
  it('returns textContent of application/json scripts', () => {
    const scripts = [{ type: 'application/json', textContent: '{"a":1}' }]
    expect(inlineDataPayloads(scripts)).toEqual(['{"a":1}'])
  })

  it('skips scripts of other types (e.g. text/javascript)', () => {
    const scripts = [
      { type: 'text/javascript', textContent: '{"a":1}' },
      { type: 'application/ld+json', textContent: '{"b":2}' },
    ]
    expect(inlineDataPayloads(scripts)).toEqual([])
  })

  it('skips empty or null textContent even when type matches', () => {
    const scripts = [
      { type: 'application/json', textContent: '' },
      { type: 'application/json', textContent: null },
    ]
    expect(inlineDataPayloads(scripts)).toEqual([])
  })

  it('accepts an ArrayLike (document.scripts is an HTMLCollection, not an array)', () => {
    const arrayLike = {
      0: { type: 'application/json', textContent: '{"x":1}' },
      1: { type: 'text/javascript', textContent: 'ignored' },
      length: 2,
    }
    expect(inlineDataPayloads(arrayLike)).toEqual(['{"x":1}'])
  })

  it('is total over a mixed, multi-entry input, preserving order', () => {
    const scripts = [
      { type: 'application/json', textContent: '{"first":true}' },
      { type: 'text/javascript', textContent: 'skip me' },
      { type: 'application/json', textContent: '{"second":true}' },
    ]
    expect(inlineDataPayloads(scripts)).toEqual(['{"first":true}', '{"second":true}'])
  })

  it('accepts the exact script-count cap', () => {
    const scripts = Array.from({ length: MAX_INLINE_DATA_SCRIPTS }, (_, index) => ({
      type: 'application/json',
      textContent: String(index),
    }))

    expect(inlineDataPayloads(scripts)).toHaveLength(MAX_INLINE_DATA_SCRIPTS)
  })

  it('drops the whole intake when a later script crosses the count cap', () => {
    const scripts = Array.from({ length: MAX_INLINE_DATA_SCRIPTS + 1 }, (_, index) => ({
      type: 'application/json',
      textContent: String(index),
    }))

    expect(inlineDataPayloads(scripts)).toEqual([])
  })

  it('counts empty application/json scripts against the intake cap', () => {
    const scripts = [
      ...Array.from({ length: MAX_INLINE_DATA_SCRIPTS }, () => ({
        type: 'application/json',
        textContent: '',
      })),
      { type: 'application/json', textContent: '{"late":true}' },
    ]

    expect(inlineDataPayloads(scripts)).toEqual([])
  })

  it('accepts the exact aggregate UTF-8 byte cap', () => {
    const scripts = [
      {
        type: 'application/json',
        textContent: 'a'.repeat(MAX_INLINE_DATA_BYTES - 2),
      },
      { type: 'application/json', textContent: '¢' },
    ]

    expect(inlineDataPayloads(scripts)).toHaveLength(2)
  })

  it('drops the whole intake when a later script crosses the aggregate byte cap', () => {
    const scripts = [
      {
        type: 'application/json',
        textContent: 'a'.repeat(MAX_INLINE_DATA_BYTES - 1),
      },
      { type: 'application/json', textContent: '€' },
    ]

    expect(inlineDataPayloads(scripts)).toEqual([])
  })

  it('snapshots each body once before measuring and returning it', () => {
    let bodyReads = 0
    const scripts = [
      {
        type: 'application/json',
        get textContent() {
          bodyReads += 1
          return bodyReads === 1 ? '{"safe":true}' : 'x'.repeat(MAX_INLINE_DATA_BYTES + 1)
        },
      },
    ]

    expect(inlineDataPayloads(scripts)).toEqual(['{"safe":true}'])
    expect(bodyReads).toBe(1)
  })

  it('snapshots a live collection length once', () => {
    let lengthReads = 0
    const scripts = {
      ...Object.fromEntries(
        Array.from({ length: MAX_INLINE_DATA_SCRIPTS + 1 }, (_, index) => [
          index,
          { type: 'application/json', textContent: String(index) },
        ]),
      ),
      get length() {
        lengthReads += 1
        return lengthReads === 1 ? MAX_INLINE_DATA_SCRIPTS + 1 : MAX_INLINE_DATA_SCRIPTS
      },
    }

    expect(inlineDataPayloads(scripts)).toEqual([])
    expect(lengthReads).toBe(1)
  })

  it('rejects an excessive document script count before reading entries', () => {
    let entryRead = false
    const scripts = {
      get 0() {
        entryRead = true
        return { type: 'text/javascript', textContent: '' }
      },
      length: MAX_INLINE_DOCUMENT_SCRIPTS + 1,
    }

    expect(inlineDataPayloads(scripts)).toEqual([])
    expect(entryRead).toBe(false)
  })

  it('drops atomically when a candidate accessor throws', () => {
    const scripts = [
      { type: 'application/json', textContent: '{"first":true}' },
      {
        type: 'application/json',
        get textContent(): string {
          throw new Error('hostile getter')
        },
      },
    ]

    expect(inlineDataPayloads(scripts)).toEqual([])
  })

  /**
   * Locks the walker-parses-inline-payload assumption: a REALISTIC embedded
   * payload modeled on the live-observed skeleton (captured 2026-07-06 from a
   * real https://www.instagram.com/reels/DaH4la4pRtC/ session — a
   * RelayPrefetchedStreamCache preloader `__bbox` nested inside a
   * ScheduledServerJS `require` envelope). `inlineDataPayloads` doesn't need
   * to understand any of this shape — it only hands back the raw script text;
   * this test proves the SAME `JSON.parse` + `detectMediaItems` seam the tee
   * already uses (overlay.content/index.tsx:1660-1665) also resolves a post
   * buried this deeply, since `forEachPostNode` recurses through arbitrary
   * arrays/objects with no wrapper-key assumptions (post-node.ts:67-82).
   */
  it('a realistic RelayPrefetchedStreamCache inline payload parses into a video MediaItem + code mapping', () => {
    const scripts = [
      {
        type: 'application/json',
        textContent: JSON.stringify({
          require: [
            [
              'ScheduledServerJS',
              'handle',
              null,
              [
                {
                  __bbox: {
                    require: [
                      [
                        'RelayPrefetchedStreamCache',
                        'next',
                        [],
                        [
                          'adp_PolarisClipsTabDesktopContainerQueryRelayPreloader_...',
                          {
                            __bbox: {
                              complete: true,
                              result: {
                                data: {
                                  xdt_api__v1__clips__home__connection_v2: {
                                    edges: [
                                      {
                                        node: {
                                          media: {
                                            __typename: 'XDTMediaDict',
                                            code: 'DaH4la4pRtC',
                                            pk: '3929358061996940098',
                                            user: { id: '123', username: 'iiiitzeric' },
                                            video_versions: [
                                              {
                                                type: 101,
                                                url: 'https://scontent.cdninstagram.com/o1/v/t16/f2/m86/AQEXAMPLE.mp4?efg=x&_nc_ht=scontent',
                                              },
                                            ],
                                            image_versions2: {
                                              candidates: [
                                                {
                                                  height: 1919,
                                                  width: 1080,
                                                  url: 'https://scontent.cdninstagram.com/v/t51.2885-15/PHOTO.jpg?x=1',
                                                },
                                              ],
                                            },
                                          },
                                        },
                                      },
                                    ],
                                  },
                                },
                              },
                            },
                          },
                        ],
                      ],
                    ],
                  },
                },
              ],
            ],
          ],
        }),
      },
    ]

    const payloads = inlineDataPayloads(scripts)
    expect(payloads).toHaveLength(1)
    const json = JSON.parse(payloads[0] as string)

    const items = detectMediaItems(json, 'instagram')
    const video = items.find((m) => m.type === 'video')
    expect(video).toMatchObject({
      postId: '3929358061996940098',
      author: 'iiiitzeric',
      type: 'video',
      url: 'https://scontent.cdninstagram.com/o1/v/t16/f2/m86/AQEXAMPLE.mp4?efg=x&_nc_ht=scontent',
      ext: 'mp4',
    })

    const codes = postCodesInResponse(json)
    expect(codes.get('3929358061996940098')).toBe('DaH4la4pRtC')
  })
})
