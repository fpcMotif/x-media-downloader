import { describe, it, expect, beforeEach } from 'vitest'
import { Option } from 'effect'
import {
  actionTestids,
  alreadyCleared,
  caretControl,
  CLEARED_STUB_ATTR,
  cellOf,
  classifyFlip,
  clearControl,
  clearableScope,
  collapseClearedStubs,
  findArticle,
  findFeedbackButton,
  findNotInterestedItem,
  flipConfirmed,
  isClearableTweetId,
  isClearedStub,
  isForYouHome,
  isMember,
  notInterestedConfirmed,
  pageScope,
  shouldClickScope,
  tweetIdOfArticle,
} from '../clearer'

function article(opts: { tweetId: string; bookmarked?: boolean; liked?: boolean }): HTMLElement {
  const el = document.createElement('article')
  el.setAttribute('data-testid', 'tweet')
  el.innerHTML = `
    <a href="/jack/status/${opts.tweetId}"><time></time></a>
    <button data-testid="${opts.bookmarked ? 'removeBookmark' : 'bookmark'}"></button>
    <button data-testid="${opts.liked ? 'unlike' : 'like'}"></button>
  `
  return el
}

describe('clearer — isClearableTweetId (DOM-locatable id guard)', () => {
  it('accepts X numeric snowflake ids, rejects the media-key fallback', () => {
    expect(isClearableTweetId('2069527192787472572')).toBe(true)
    expect(isClearableTweetId('1')).toBe(true)
    // The adapter's `tweetId ?? key` fallback yields a non-numeric media key that
    // can never match a `/status/{id}` article — clearing it only defer-then-drops.
    expect(isClearableTweetId('jO4OvymczbTx7WL4')).toBe(false)
    expect(isClearableTweetId('HLkY8gTWsAASx-7')).toBe(false)
    expect(isClearableTweetId('')).toBe(false)
    // Anchored: no partial/embedded/whitespace match, and over-wide ids rejected.
    expect(isClearableTweetId('123abc')).toBe(false)
    expect(isClearableTweetId('12 34')).toBe(false)
    expect(isClearableTweetId('123456789012345678901')).toBe(false)
  })
})

describe('clearer DOM helpers', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('resolves tweetId from the permalink', () => {
    expect(Option.getOrNull(tweetIdOfArticle(article({ tweetId: '1900000000000000001' })))).toBe(
      '1900000000000000001',
    )
  })

  it('returns none when no status link is present', () => {
    expect(Option.getOrNull(tweetIdOfArticle(document.createElement('article')))).toBe(null)
  })

  it('detects membership from the active un-control', () => {
    const a = article({ tweetId: '1', bookmarked: true, liked: false })
    expect(isMember(a, 'bookmark')).toBe(true)
    expect(isMember(a, 'like')).toBe(false)
    expect(clearControl(a, 'bookmark')).not.toBe(null)
    expect(clearControl(a, 'like')).toBe(null)
  })

  it('findArticle id-match guard: only returns the matching tweetId', () => {
    document.body.append(article({ tweetId: '11' }), article({ tweetId: '22', bookmarked: true }))
    const found = findArticle(document, '22')
    expect(Option.getOrNull(found)).not.toBe(null)
    expect(Option.getOrNull(tweetIdOfArticle(Option.getOrNull(found)!))).toBe('22')
    expect(Option.getOrNull(findArticle(document, '999'))).toBe(null)
  })

  it('ignores a quoted tweet: resolves the OUTER id and the OUTER action bar', () => {
    // Outer authored tweet (id 100, time-wrapped permalink) embeds a quoted tweet
    // card (div[role="link"]) with its own /status/200 link + a removeBookmark.
    const el = document.createElement('article')
    el.setAttribute('data-testid', 'tweet')
    el.innerHTML = `
      <div role="link">
        <a href="/bob/status/200"></a>
        <button data-testid="removeBookmark"></button>
      </div>
      <a href="/alice/status/100"><time></time></a>
      <button data-testid="bookmark"></button>
    `
    // Must resolve the OUTER tweet (100), never the quoted 200.
    expect(Option.getOrNull(tweetIdOfArticle(el))).toBe('100')
    // Outer tweet is NOT bookmarked (its own control is 'bookmark'); the quoted
    // card's 'removeBookmark' must be ignored, so isMember(bookmark) is false.
    expect(isMember(el, 'bookmark')).toBe(false)
    expect(clearControl(el, 'bookmark')).toBe(null)
  })

  it('pageScope is list-specific (Likes→like, Bookmarks→bookmark, else none)', () => {
    expect(Option.getOrNull(pageScope('/lambda_functor/likes'))).toBe('like')
    expect(Option.getOrNull(pageScope('/i/bookmarks'))).toBe('bookmark')
    expect(Option.getOrNull(pageScope('/i/bookmarks/all'))).toBe('bookmark')
    expect(Option.getOrNull(pageScope('/home'))).toBe(null)
    expect(Option.getOrNull(pageScope('/jack/status/123'))).toBe(null)
  })

  it('prefers the timestamp permalink over a bare status anchor', () => {
    const el = document.createElement('article')
    el.setAttribute('data-testid', 'tweet')
    el.innerHTML = `
      <a href="/i/status/999/analytics"></a>
      <a href="/alice/status/100"><time></time></a>
    `
    expect(Option.getOrNull(tweetIdOfArticle(el))).toBe('100')
  })

  it('flipConfirmed only when the active control is gone (or detached)', () => {
    const a = article({ tweetId: '1', bookmarked: true })
    document.body.append(a)
    expect(flipConfirmed(a, 'bookmark')).toBe(false) // still has removeBookmark
    a.querySelector('[data-testid="removeBookmark"]')!.setAttribute('data-testid', 'bookmark')
    expect(flipConfirmed(a, 'bookmark')).toBe(true) // flipped to bookmark
  })

  it('alreadyCleared is true when the non-member control is present, false otherwise', () => {
    // Not a member: its cleared control (`bookmark`/`like`) is mounted → satisfied.
    const cleared = article({ tweetId: '1', bookmarked: false, liked: false })
    expect(alreadyCleared(cleared, 'bookmark')).toBe(true)
    expect(alreadyCleared(cleared, 'like')).toBe(true)
    // Still a member: only the active un-control is present, not the cleared one.
    const member = article({ tweetId: '1', bookmarked: true, liked: true })
    expect(alreadyCleared(member, 'bookmark')).toBe(false)
    expect(alreadyCleared(member, 'like')).toBe(false)
  })

  it('alreadyCleared ignores a quoted-tweet card’s cleared control (false when ambiguous)', () => {
    // Outer tweet has NEITHER bookmark control of its own; only the quoted card
    // carries a `bookmark` (cleared) control, which must be ignored → not satisfied.
    const el = document.createElement('article')
    el.setAttribute('data-testid', 'tweet')
    el.innerHTML = `
      <div role="link">
        <button data-testid="bookmark"></button>
      </div>
      <a href="/alice/status/100"><time></time></a>
    `
    expect(alreadyCleared(el, 'bookmark')).toBe(false)
  })

  it('returns null when no status link has a numeric id (regex never matches)', () => {
    const el = document.createElement('article')
    el.setAttribute('data-testid', 'tweet')
    // Anchor matches a[href*="/status/"] but the id is non-numeric → no regex match.
    el.innerHTML = `<a href="/i/status/foo"><time></time></a>`
    expect(Option.getOrNull(tweetIdOfArticle(el))).toBe(null)
  })

  it('actionTestids lists only bookmark/like-ish testids, in document order, never other controls', () => {
    const el = document.createElement('article')
    el.innerHTML = `
      <button data-testid="removeBookmark"></button>
      <button data-testid="reply"></button>
      <button data-testid="unlike"></button>
      <button data-testid="retweet"></button>
    `
    expect(actionTestids(el)).toEqual(['removeBookmark', 'unlike'])
  })

  it('actionTestids is empty when the action bar has no data-testid at all', () => {
    expect(actionTestids(document.createElement('article'))).toEqual([])
  })

  describe('classifyFlip', () => {
    it('arm=testid when the captured node is still connected', () => {
      const a = article({ tweetId: '1', bookmarked: false })
      document.body.append(a)
      expect(classifyFlip(document, a, '1', 'bookmark').arm).toBe('testid')
    })

    it('arm=detached when the captured node left the document, even if a fresh node for the same id is mounted', () => {
      const captured = article({ tweetId: '1', bookmarked: false })
      const fresh = article({ tweetId: '1', bookmarked: false })
      document.body.append(fresh) // a live re-resolve would find THIS node
      expect(captured.isConnected).toBe(false)
      expect(classifyFlip(document, captured, '1', 'bookmark').arm).toBe('detached')
    })

    it('reresolved=gone when no article with this id is mounted any more', () => {
      const captured = article({ tweetId: '1', bookmarked: true })
      expect(classifyFlip(document, captured, '1', 'bookmark').reresolved).toBe('gone')
    })

    it('reresolved=member when a fresh resolve still shows the active control (fabricated flip)', () => {
      const captured = article({ tweetId: '1', bookmarked: true })
      const fresh = article({ tweetId: '1', bookmarked: true })
      document.body.append(fresh)
      expect(classifyFlip(document, captured, '1', 'bookmark').reresolved).toBe('member')
    })

    it('reresolved=cleared when a fresh resolve shows the cleared twin', () => {
      const captured = article({ tweetId: '1', bookmarked: true })
      const fresh = article({ tweetId: '1', bookmarked: false })
      document.body.append(fresh)
      expect(classifyFlip(document, captured, '1', 'bookmark').reresolved).toBe('cleared')
    })

    it('reresolved=ambiguous when a fresh resolve has NEITHER control (mid re-render / selector rot)', () => {
      const captured = article({ tweetId: '1', bookmarked: true })
      const fresh = document.createElement('article')
      fresh.setAttribute('data-testid', 'tweet')
      fresh.innerHTML = `<a href="/jack/status/1"><time></time></a>`
      document.body.append(fresh)
      expect(classifyFlip(document, captured, '1', 'bookmark').reresolved).toBe('ambiguous')
    })
  })
})

describe('clearer — shouldClickScope (page-scoped vs. Clear-from-every-list)', () => {
  describe('default (allLists off): page-scoped — only the current page’s scope clicks', () => {
    it('clicks the scope the page owns, no-ops the others (membership ignored)', () => {
      // On Likes (pageScope=like): like clicks; a bookmarked post does NOT un-bookmark.
      expect(
        shouldClickScope({ scope: 'like', onScope: 'like', member: true, allLists: false }),
      ).toBe(true)
      expect(
        shouldClickScope({ scope: 'bookmark', onScope: 'like', member: true, allLists: false }),
      ).toBe(false)
      // notInterested only on For You (pageScope=notInterested), never on a list page.
      expect(
        shouldClickScope({
          scope: 'notInterested',
          onScope: 'notInterested',
          member: false,
          allLists: false,
        }),
      ).toBe(true)
      expect(
        shouldClickScope({
          scope: 'notInterested',
          onScope: 'bookmark',
          member: false,
          allLists: false,
        }),
      ).toBe(false)
    })

    it('no-ops every scope when the page owns none (pageScope null)', () => {
      expect(
        shouldClickScope({ scope: 'like', onScope: null, member: true, allLists: false }),
      ).toBe(false)
      expect(
        shouldClickScope({ scope: 'bookmark', onScope: null, member: true, allLists: false }),
      ).toBe(false)
    })
  })

  describe('allLists on: state-driven — fire wherever the post is actually a member', () => {
    it('un-bookmark / un-like follow membership, regardless of page', () => {
      // On Likes (pageScope=like): a bookmarked post DOES un-bookmark now.
      expect(
        shouldClickScope({ scope: 'bookmark', onScope: 'like', member: true, allLists: true }),
      ).toBe(true)
      // …but a non-member scope still no-ops (nothing to clear → never pollutes state).
      expect(
        shouldClickScope({ scope: 'bookmark', onScope: 'like', member: false, allLists: true }),
      ).toBe(false)
      // On Bookmarks (pageScope=bookmark): a liked post un-likes.
      expect(
        shouldClickScope({ scope: 'like', onScope: 'bookmark', member: true, allLists: true }),
      ).toBe(true)
      expect(
        shouldClickScope({ scope: 'like', onScope: 'bookmark', member: false, allLists: true }),
      ).toBe(false)
      // Off any list page (profile/search, pageScope=null): still membership-driven.
      expect(shouldClickScope({ scope: 'like', onScope: null, member: true, allLists: true })).toBe(
        true,
      )
    })

    it('ALWAYS fires the page’s own scope even if the member snapshot is transiently false', () => {
      // Regression guard for "un-bookmarked but not un-liked" on the Likes page: the
      // page's own scope (like on Likes) is a guaranteed member — the post is mounted
      // in this very list — so it must fire even when a prior cross-list clear's
      // in-place re-render transiently blanks the un-like control in the snapshot.
      // (clearScope still does the authoritative membership re-check at click time.)
      expect(
        shouldClickScope({ scope: 'like', onScope: 'like', member: true, allLists: true }),
      ).toBe(true)
      expect(
        shouldClickScope({ scope: 'like', onScope: 'like', member: false, allLists: true }),
      ).toBe(true)
      // Symmetric on Bookmarks (pageScope=bookmark): un-bookmark always fires there.
      expect(
        shouldClickScope({ scope: 'bookmark', onScope: 'bookmark', member: false, allLists: true }),
      ).toBe(true)
      // …but a CROSS-list scope still needs real membership (never fire blindly).
      expect(
        shouldClickScope({ scope: 'bookmark', onScope: 'like', member: false, allLists: true }),
      ).toBe(false)
    })

    it('notInterested stays For-You-only even in all-lists mode (no membership to read)', () => {
      expect(
        shouldClickScope({
          scope: 'notInterested',
          onScope: 'notInterested',
          member: false,
          allLists: true,
        }),
      ).toBe(true)
      // On Likes/Bookmarks or anywhere not For You → never fires.
      expect(
        shouldClickScope({
          scope: 'notInterested',
          onScope: 'like',
          member: false,
          allLists: true,
        }),
      ).toBe(false)
      expect(
        shouldClickScope({ scope: 'notInterested', onScope: null, member: false, allLists: true }),
      ).toBe(false)
    })
  })
})

/** A home tablist; `selectedIndex` marks which tab is active (-1 = none). Labels
 *  are arbitrary on purpose — detection is by POSITION (For You is always first),
 *  not text, so a localized bar must work the same. */
function tabBar(labels: string[], selectedIndex: number): void {
  document.body.innerHTML = `<div role="tablist">${labels
    .map((l, i) => `<a role="tab" aria-selected="${i === selectedIndex}">${l}</a>`)
    .join('')}</div>`
}
/** The English home bar with one of For You / Following selected. */
const homeTablist = (selected: 'For you' | 'Following'): void =>
  tabBar(['For you', 'Following'], selected === 'For you' ? 0 : 1)

describe('clearer — timeline "Not interested" (For You feed clear)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('isForYouHome: true on /home when the FIRST home tab is selected', () => {
    homeTablist('For you') // For You = index 0
    expect(isForYouHome('/home', document)).toBe(true)
    expect(isForYouHome('/home/', document)).toBe(true)
    // Following = index 1 selected → NOT For You (never fire on the wrong feed).
    homeTablist('Following')
    expect(isForYouHome('/home', document)).toBe(false)
  })

  it('isForYouHome: position is locale-independent (the fix for non-English UIs)', () => {
    // zh-TW renders the first tab "為你推薦"; an English text match would miss it.
    // Position (first tab selected, + pinned List tabs after) still identifies it.
    tabBar(['為你推薦', '正在跟隨', '水神様', 'Claude Code'], 0)
    expect(isForYouHome('/home', document)).toBe(true)
    // Following (index 1) in the same localized bar → false.
    tabBar(['為你推薦', '正在跟隨', '水神様'], 1)
    expect(isForYouHome('/home', document)).toBe(false)
  })

  it('isForYouHome: false off /home even with a For-You bar present', () => {
    homeTablist('For you')
    expect(isForYouHome('/explore', document)).toBe(false)
    expect(isForYouHome('/jack/status/1', document)).toBe(false)
  })

  it('isForYouHome: fail-safe false when the bar is ambiguous or unmounted', () => {
    tabBar(['Solo'], 0) // a lone tab (< 2) is not the For You / Following switcher
    expect(isForYouHome('/home', document)).toBe(false)
    tabBar(['For you', 'Following'], -1) // nothing selected yet
    expect(isForYouHome('/home', document)).toBe(false)
    document.body.innerHTML = '' // not mounted
    expect(isForYouHome('/home', document)).toBe(false)
  })

  it('clearableScope: list scope on lists, notInterested on For You, else null', () => {
    homeTablist('For you')
    expect(clearableScope('/home', document)).toBe('notInterested')
    expect(clearableScope('/i/bookmarks', document)).toBe('bookmark')
    expect(clearableScope('/alice/likes', document)).toBe('like')
    homeTablist('Following')
    expect(clearableScope('/home', document)).toBe(null)
    expect(clearableScope('/explore', document)).toBe(null)
  })

  it('caretControl: the article’s OWN caret, ignoring a quoted card’s', () => {
    const el = document.createElement('article')
    el.setAttribute('data-testid', 'tweet')
    el.innerHTML = `
      <div role="link"><button data-testid="caret"></button></div>
      <button data-testid="caret" id="own"></button>
    `
    expect(caretControl(el)?.id).toBe('own')
    // Only a quoted-card caret present → null (never act on another post).
    const noOwn = document.createElement('article')
    noOwn.innerHTML = `<div role="link"><button data-testid="caret"></button></div>`
    expect(caretControl(noOwn)).toBe(null)
  })

  // The not-interested frowning-face icon path (verified on the live caret menu).
  const NI_ICON = 'M12 13.6c1.64-.013 3.278.76 4.284 2.02.114.14.218.282.317.43l-1.202.9c-.088-.102'

  it('findNotInterestedItem: matches the post item by English text', () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.innerHTML = `
      <div role="menuitem">Follow @alice</div>
      <div role="menuitem">Not interested in this post</div>
      <div role="menuitem">Mute @alice</div>
    `
    expect(Option.getOrNull(findNotInterestedItem(menu))?.textContent?.trim()).toBe(
      'Not interested in this post',
    )
  })

  it('findNotInterestedItem: matches a LOCALIZED item by its frowning-face icon', () => {
    // zh-TW: no English text to match, but the not-interested icon is the same.
    const menu = document.createElement('div')
    menu.innerHTML = `
      <div role="menuitem"><svg viewBox="0 0 24 24"><path d="${NI_ICON}"></path></svg><span>對此貼文不感興趣</span></div>
      <div role="menuitem"><svg><path d="M3 3h18"></path></svg><span>封鎖</span></div>
    `
    expect(Option.getOrNull(findNotInterestedItem(menu))?.textContent?.includes('不感興趣')).toBe(
      true,
    )
  })

  it('findNotInterestedItem: null when neither text nor icon matches (fail-safe)', () => {
    // No English text, wrong icon, AND a path with no `d` (the empty-d guard).
    const menu = document.createElement('div')
    menu.innerHTML = `
      <div role="menuitem"><svg><path></path></svg><span>檢舉貼文</span></div>
      <div role="menuitem"><svg><path d="M9 9l6 6"></path></svg><span>靜音</span></div>
    `
    expect(Option.getOrNull(findNotInterestedItem(menu))).toBe(null)
    expect(Option.getOrNull(findNotInterestedItem(document.createElement('div')))).toBe(null)
  })

  it('findNotInterestedItem: requires the POST phrasing — a "topic" item is NOT a match', () => {
    // "Not interested in this topic" is a broader, different feed-training signal;
    // no POST text and no not-interested icon → must be null.
    const menu = document.createElement('div')
    menu.innerHTML = `<div role="menuitem">Not interested in this topic</div>`
    expect(Option.getOrNull(findNotInterestedItem(menu))).toBe(null)
  })

  it('notInterestedConfirmed: true on detach OR caret gone, false while intact', () => {
    const el = document.createElement('article')
    el.setAttribute('data-testid', 'tweet')
    el.innerHTML = `<button data-testid="caret"></button>`
    document.body.append(el)
    expect(notInterestedConfirmed(el)).toBe(false) // intact tweet, caret present
    el.querySelector('[data-testid="caret"]')!.remove()
    expect(notInterestedConfirmed(el)).toBe(true) // collapsed: action bar gone
    const detached = document.createElement('article')
    detached.innerHTML = `<button data-testid="caret"></button>`
    expect(notInterestedConfirmed(detached)).toBe(true) // never mounted → detached
  })
})

/** A timeline cell (`cellInnerDiv`) with the given inner HTML. */
function cell(inner: string): HTMLElement {
  const c = document.createElement('div')
  c.setAttribute('data-testid', 'cellInnerDiv')
  c.innerHTML = inner
  return c
}
/** A cell holding a real, un-cleared tweet. */
const realCell = (): HTMLElement =>
  cell(
    `<article data-testid="tweet"><a href="/x/status/1"><time></time></a><button data-testid="caret"></button></article>`,
  )
/** The not-interested feedback stub: a NON-tweet article + follow-up buttons. */
const stubCell = (buttons: string[]): HTMLElement =>
  cell(
    `<article><div dir="ltr">Thanks. X will use this to make your timeline better.</div>${buttons
      .map((t) => `<button>${t}</button>`)
      .join('')}</article>`,
  )

describe('clearer — full-hide of a cleared post (feedback stub)', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('cellOf: resolves the wrapping cellInnerDiv, null when not in a cell', () => {
    const c = realCell()
    document.body.append(c)
    expect(cellOf(c.querySelector('article')!)).toBe(c)
    expect(cellOf(document.createElement('article'))).toBe(null)
  })

  it('findFeedbackButton: prefers "isn’t relevant", then "show fewer", never Undo', () => {
    expect(
      Option.getOrNull(
        findFeedbackButton(
          stubCell(['Undo', 'Show fewer posts from @x', 'This post isn’t relevant']),
        ),
      )?.textContent,
    ).toBe('This post isn’t relevant')
    // No relevance text → fall back to "Show fewer".
    expect(
      Option.getOrNull(findFeedbackButton(stubCell(['Undo', 'Show fewer posts from @x'])))
        ?.textContent,
    ).toContain('Show fewer')
  })

  it('findFeedbackButton: positional fallback ([2] of 3, [1] of 2), never the Undo slot', () => {
    // 3 unlabelled-ish buttons → take index 2.
    const b3 = Option.getOrNull(findFeedbackButton(stubCell(['一', '二', '三'])))
    expect(b3?.textContent).toBe('三')
    // 2 buttons → take index 1 (when it isn't Undo).
    expect(Option.getOrNull(findFeedbackButton(stubCell(['一', '二'])))?.textContent).toBe('二')
    // index-1 slot is Undo → refuse (never click Undo).
    expect(Option.getOrNull(findFeedbackButton(stubCell(['something', 'Undo'])))).toBe(null)
    // < 2 buttons → null.
    expect(Option.getOrNull(findFeedbackButton(stubCell(['only one'])))).toBe(null)
  })

  it('findFeedbackButton: ignores buttons inside a REAL tweet (only the stub counts)', () => {
    expect(Option.getOrNull(findFeedbackButton(realCell()))).toBe(null)
  })

  it('isClearedStub: matches by TEXT (rows may be buttons OR divs), never a real post', () => {
    // The "Thanks… will use this" headline alone (no clickable rows yet).
    expect(
      isClearedStub(cell('<div>Thanks. X will use this to make your timeline better.</div>')),
    ).toBe(true)
    // A follow-up rendered as a plain div (not a button) is still caught.
    expect(isClearedStub(cell('<div role="button">This post isn’t relevant</div>'))).toBe(true)
    expect(isClearedStub(cell('<div>Show fewer posts from @x</div>'))).toBe(true)
    // Post-dismissal residual: only an Undo control left.
    expect(isClearedStub(cell('<button>Undo</button>'))).toBe(true)
    expect(isClearedStub(realCell())).toBe(false) // a live tweet is never a stub
    expect(isClearedStub(cell('<div>who to follow</div>'))).toBe(false)
  })

  it('collapseClearedStubs: marks stubs, and UN-marks a recycled cell (recycling-safe)', () => {
    const stub = stubCell(['Undo', 'Show fewer', 'This post isn’t relevant'])
    const real = realCell()
    document.body.append(stub, real)
    expect(collapseClearedStubs(document)).toBe(1)
    expect(stub.hasAttribute(CLEARED_STUB_ATTR)).toBe(true)
    expect(real.hasAttribute(CLEARED_STUB_ATTR)).toBe(false)
    // The stub cell gets recycled to a real post → the mark must drop on re-scan.
    stub.innerHTML = realCell().innerHTML
    expect(collapseClearedStubs(document)).toBe(0)
    expect(stub.hasAttribute(CLEARED_STUB_ATTR)).toBe(false)
  })
})
