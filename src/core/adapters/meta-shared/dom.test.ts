import { describe, it, expect } from 'vitest'
import {
  isCdninstagramHost,
  pathFamily,
  isContentPathFamily,
  isGrabbableMetaPhotoUrl,
  mediaKeyFromMetaUrl,
  extFromMetaImgUrl,
  videoPathFamily,
  isGrabbableMetaVideoUrl,
  mediaKeyFromMetaVideoUrl,
  mediaKeyFromMetaCombinedUrl,
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

  // LIVE-VERIFIED 2026-07-06: a real Instagram post photo
  // (instagram.com/p/DaM2wDWCH-C/) served the Facebook-style family
  // `t39.30808-6` off scontent-lga3-1.cdninstagram.com — confirms the regex
  // matches this shape too, not just the `t51.*` families seen previously.
  it('matches the t39.30808-6 family observed on a real post photo', () => {
    expect(pathFamily('/v/t39.30808-6/489abc123_n.jpg')).toBe('t39.30808-6')
  })
})

describe('isContentPathFamily', () => {
  // Denylist semantics (fixed 2026-07-06): the gate's real job is excluding
  // avatar families, not allowlisting content families. -15 and the newly
  // observed -6 (t39.30808-6) both count as content; only -19 (the only
  // avatar suffix ever observed live) is excluded.
  it('is true for -15 and -6 families, false for -19 families', () => {
    expect(isContentPathFamily('t51.82787-15')).toBe(true)
    expect(isContentPathFamily('t51.71878-15')).toBe(true)
    expect(isContentPathFamily('t39.30808-6')).toBe(true)
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

  // LIVE-VERIFIED 2026-07-06: a real Instagram post photo
  // (instagram.com/p/DaM2wDWCH-C/) served this Facebook-style content
  // family off scontent-lga3-1.cdninstagram.com; the previous -15-only
  // allowlist returned false for it (the reported bug).
  it('accepts a real content photo url on the t39.30808-6 family', () => {
    expect(
      isGrabbableMetaPhotoUrl(
        'https://scontent-lga3-1.cdninstagram.com/v/t39.30808-6/489abc123_n.jpg?stp=dst-jpg&_nc_ht=x',
      ),
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

  // LIVE-VERIFIED 2026-07-06: same real post photo as above — confirms the
  // fix resolves a hover key for it (previously null, the reported bug).
  it('extracts the basename key for the t39.30808-6 content family', () => {
    expect(
      mediaKeyFromMetaUrl(
        'https://scontent-lga3-1.cdninstagram.com/v/t39.30808-6/489abc123_n.jpg?stp=dst-jpg&_nc_ht=x',
      ),
    ).toBe('489abc123_n')
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

describe('videoPathFamily', () => {
  // LIVE-VERIFIED 2026-07-05: a real Instagram /p/{code}/ inline video post
  // (https://www.instagram.com/p/DaSs_DTmWdw/) served
  // `/o1/v/t16/f2/m84/{opaque-token}.mp4` — no `.NNNN-NN` suffix at all, unlike
  // the photo family. Threads carousel video (@zuck/DZ7eGA1G7wU) confirmed the
  // same `t16` shape live in an earlier pass this session.
  it('extracts a bare tN video path segment (no dot-suffix)', () => {
    expect(videoPathFamily('/o1/v/t16/f2/m84/AQM-abc123.mp4')).toBe('t16')
  })

  it('returns null when no tN segment exists', () => {
    expect(videoPathFamily('/v/no-family-here/abc.mp4')).toBe(null)
  })

  it('does not match the photo-shaped t{N}.{N}-{N} family (that is pathFamily´s job, not this one)', () => {
    // A photo-family path also contains a bare `t51` prefix conceptually, but
    // the actual path segment is `t51.82787-15`, which this predicate's plain
    // `^t\d+$` match correctly rejects as a whole-segment match.
    expect(videoPathFamily('/v/t51.82787-15/abc_n.jpg')).toBe(null)
  })
})

describe('isGrabbableMetaVideoUrl', () => {
  it('accepts a real content video url on the cdninstagram host', () => {
    expect(
      isGrabbableMetaVideoUrl(
        'https://scontent-lga3-1.cdninstagram.com/o1/v/t16/f2/m84/AQM-abc123.mp4?efg=1',
      ),
    ).toBe(true)
  })

  it('rejects an unrelated host', () => {
    expect(isGrabbableMetaVideoUrl('https://media4.giphy.com/media/abc/giphy.mp4')).toBe(false)
  })

  it('rejects a malformed url string', () => {
    expect(isGrabbableMetaVideoUrl('not a url')).toBe(false)
  })

  it('rejects a cdninstagram host with no tN video path segment at all', () => {
    expect(isGrabbableMetaVideoUrl('https://scontent.cdninstagram.com/v/no-family/abc.mp4')).toBe(
      false,
    )
  })

  it('rejects a photo-family url (that is isGrabbableMetaPhotoUrl´s job)', () => {
    expect(
      isGrabbableMetaVideoUrl('https://scontent.cdninstagram.com/v/t51.82787-15/abc_n.jpg'),
    ).toBe(false)
  })
})

describe('mediaKeyFromMetaVideoUrl', () => {
  it('extracts the basename key, stripping extension and query string', () => {
    expect(
      mediaKeyFromMetaVideoUrl(
        'https://scontent-lga3-1.cdninstagram.com/o1/v/t16/f2/m84/AQM-abc123.mp4?efg=1',
      ),
    ).toBe('AQM-abc123')
  })

  it('returns null for a non-grabbable url (wrong host, photo family, malformed)', () => {
    expect(mediaKeyFromMetaVideoUrl('https://media4.giphy.com/media/abc/giphy.mp4')).toBe(null)
    expect(
      mediaKeyFromMetaVideoUrl('https://scontent.cdninstagram.com/v/t51.82787-15/abc_n.jpg'),
    ).toBe(null)
    expect(mediaKeyFromMetaVideoUrl('not a url')).toBe(null)
  })

  it('returns null when the basename minus extension is empty', () => {
    expect(mediaKeyFromMetaVideoUrl('https://scontent.cdninstagram.com/o1/v/t16/f2/m84/.mp4')).toBe(
      null,
    )
  })

  it('uses the whole basename as the key when it has no extension', () => {
    expect(
      mediaKeyFromMetaVideoUrl('https://scontent.cdninstagram.com/o1/v/t16/f2/m84/AQM-abc123'),
    ).toBe('AQM-abc123')
  })
})

describe('mediaKeyFromMetaCombinedUrl', () => {
  it('resolves a photo url via the photo path', () => {
    expect(
      mediaKeyFromMetaCombinedUrl(
        'https://scontent.cdninstagram.com/v/t51.82787-15/abc_n.jpg?stp=dst-jpg',
      ),
    ).toBe('abc_n')
  })

  it('resolves a video url via the video path', () => {
    expect(
      mediaKeyFromMetaCombinedUrl(
        'https://scontent-lga3-1.cdninstagram.com/o1/v/t16/f2/m84/AQM-abc123.mp4?efg=1',
      ),
    ).toBe('AQM-abc123')
  })

  it('returns null for a url matching neither family', () => {
    expect(mediaKeyFromMetaCombinedUrl('https://media4.giphy.com/media/abc/giphy.gif')).toBe(null)
  })

  it('returns null for an avatar photo family (still gated the same as mediaKeyFromMetaUrl)', () => {
    expect(
      mediaKeyFromMetaCombinedUrl('https://scontent.cdninstagram.com/v/t51.2885-19/avatar_n.jpg'),
    ).toBe(null)
  })
})
