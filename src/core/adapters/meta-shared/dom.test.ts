import { describe, it, expect } from 'vitest'
import {
  isCdninstagramHost,
  pathFamily,
  isContentPathFamily,
  isGrabbableMetaPhotoUrl,
  mediaKeyFromMetaUrl,
  extFromMetaImgUrl,
} from './dom'

describe('isCdninstagramHost', () => {
  it('accepts the region-prefixed Instagram form and the bare Threads form', () => {
    expect(isCdninstagramHost('scontent-lga3-2.cdninstagram.com')).toBe(true)
    expect(isCdninstagramHost('scontent.cdninstagram.com')).toBe(true)
    expect(isCdninstagramHost('cdninstagram.com')).toBe(true)
  })

  it('rejects a spoofed suffix host', () => {
    expect(isCdninstagramHost('evil-cdninstagram.com')).toBe(false)
  })

  it('rejects an unrelated host', () => {
    expect(isCdninstagramHost('media4.giphy.com')).toBe(false)
  })
})

describe('pathFamily', () => {
  it('extracts a t{N}.{N}-{N} path family segment', () => {
    expect(pathFamily('/v/t51.82787-15/731448209_x_n.jpg')).toBe('t51.82787-15')
    expect(pathFamily('/v/t51.71878-15/abc_n.jpg')).toBe('t51.71878-15')
    expect(pathFamily('/v/t51.2885-19/avatar_n.jpg')).toBe('t51.2885-19')
  })

  it('returns null when no such segment exists', () => {
    expect(pathFamily('/v/no-family-here/abc.jpg')).toBe(null)
  })
})

describe('isContentPathFamily', () => {
  it('is true for -15 families and false for -19 families', () => {
    expect(isContentPathFamily('t51.82787-15')).toBe(true)
    expect(isContentPathFamily('t51.71878-15')).toBe(true)
    expect(isContentPathFamily('t51.2885-19')).toBe(false)
    expect(isContentPathFamily('t51.82787-19')).toBe(false)
  })
})

describe('isGrabbableMetaPhotoUrl', () => {
  it('accepts a real content photo url, both host forms, both -15 families seen', () => {
    expect(
      isGrabbableMetaPhotoUrl(
        'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/731448209_18446489893184644_2626552789731070694_n.jpg',
      ),
    ).toBe(true)
    expect(
      isGrabbableMetaPhotoUrl(
        'https://scontent.cdninstagram.com/v/t51.82787-15/731580649_17977172196112664_127588051484214294_n.jpg',
      ),
    ).toBe(true)
    expect(
      isGrabbableMetaPhotoUrl('https://scontent.cdninstagram.com/v/t51.71878-15/abc_n.jpg'),
    ).toBe(true)
  })

  it('rejects an avatar (-19 family)', () => {
    expect(
      isGrabbableMetaPhotoUrl('https://scontent.cdninstagram.com/v/t51.2885-19/avatar_n.jpg'),
    ).toBe(false)
    expect(
      isGrabbableMetaPhotoUrl('https://scontent.cdninstagram.com/v/t51.82787-19/avatar_n.jpg'),
    ).toBe(false)
  })

  it('rejects an unrelated host (giphy embed)', () => {
    expect(isGrabbableMetaPhotoUrl('https://media4.giphy.com/media/abc/giphy.gif')).toBe(false)
  })

  it('rejects a chrome-extension url', () => {
    expect(isGrabbableMetaPhotoUrl('chrome-extension://abcdefg/icons/icon128.png')).toBe(false)
  })

  it('rejects a malformed url string', () => {
    expect(isGrabbableMetaPhotoUrl('not a url')).toBe(false)
  })

  it('rejects a cdninstagram host with no path family segment at all', () => {
    expect(isGrabbableMetaPhotoUrl('https://scontent.cdninstagram.com/v/no-family/abc.jpg')).toBe(
      false,
    )
  })
})

describe('mediaKeyFromMetaUrl', () => {
  it('extracts the basename key, stripping extension and query string', () => {
    expect(
      mediaKeyFromMetaUrl(
        'https://scontent-lga3-2.cdninstagram.com/v/t51.82787-15/731448209_18446489893184644_2626552789731070694_n.jpg?stp=dst-jpg',
      ),
    ).toBe('731448209_18446489893184644_2626552789731070694_n')
  })

  it('matches a DOM src against a differently-sized rendition sharing the same basename', () => {
    const small =
      'https://scontent.cdninstagram.com/v/t51.82787-15/734488748_17930531229347993_7984311109180631287_n.jpg?stp=c0.90.720.720a_dst-jpg_e15'
    const orig =
      'https://scontent.cdninstagram.com/v/t51.82787-15/734488748_17930531229347993_7984311109180631287_n.jpg?stp=dst-jpg_e35_p1080x1080'
    expect(mediaKeyFromMetaUrl(small)).toBe(mediaKeyFromMetaUrl(orig))
  })

  it('returns null for a non-grabbable url (avatar, wrong host, malformed)', () => {
    expect(
      mediaKeyFromMetaUrl('https://scontent.cdninstagram.com/v/t51.2885-19/avatar_n.jpg'),
    ).toBe(null)
    expect(mediaKeyFromMetaUrl('https://media4.giphy.com/media/abc/giphy.gif')).toBe(null)
    expect(mediaKeyFromMetaUrl('not a url')).toBe(null)
  })

  it('uses the whole basename as the key when it has no extension', () => {
    expect(mediaKeyFromMetaUrl('https://scontent.cdninstagram.com/v/t51.82787-15/abc_n')).toBe(
      'abc_n',
    )
  })

  it('returns null when the basename minus extension is empty', () => {
    expect(mediaKeyFromMetaUrl('https://scontent.cdninstagram.com/v/t51.82787-15/.jpg')).toBe(null)
  })
})

describe('extFromMetaImgUrl', () => {
  it('reads the path extension', () => {
    expect(
      extFromMetaImgUrl('https://scontent.cdninstagram.com/v/t51.82787-15/abc_n.jpg?stp=dst-jpg'),
    ).toBe('jpg')
  })

  it('falls back to jpg when no extension is present', () => {
    expect(extFromMetaImgUrl('https://scontent.cdninstagram.com/v/t51.82787-15/abc_n')).toBe('jpg')
  })

  it('falls back to jpg for a malformed url', () => {
    expect(extFromMetaImgUrl('not a url')).toBe('jpg')
  })
})
