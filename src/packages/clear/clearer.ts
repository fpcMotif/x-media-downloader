/**
 * DOM-click Clearer (v1) — performs the irreversible Clear by synthetically
 * clicking X's OWN un-bookmark / un-like control in-page, then verifying the
 * control flipped before reporting success (spec §4.4). Pure selectors + DOM
 * helpers here; the content script owns the click + rAF orchestration. No
 * authenticated replay (deferred). Selector rot is the main risk — every path
 * fails safe: no verified flip ⇒ `ok: false`, never a silent "cleared".
 */
import { Option } from 'effect'
import type { ClearScope } from '@/packages/schema'

/** The two membership scopes cleared by a single button-flip (un-bookmark /
 *  un-like). `notInterested` is NOT one of these — it has no membership control
 *  and is cleared via the caret menu (see the `notInterested*` helpers below), so
 *  the flip helpers are typed to exclude it. */
export type MembershipScope = Exclude<ClearScope, 'notInterested'>

/** WHICH call path fired this clear — the diagnostics-log axis, distinct from
 *  `ledger.ts`'s `Origin` (`'hook' | 'sweep'`, which answers a DIFFERENT question:
 *  why a ledger entry was seeded, not who clicked). `'settle'` is the direct
 *  per-tweet dispatch (`ClearTweetRequest` → `handleClearTweet`) fired once a
 *  download settles — the same message path whether the trigger was the live
 *  per-download hook or the durable worklist's sweep re-dispatch, which the
 *  content script cannot yet tell apart (see `handleClearTweet`); `'drain'` is
 *  the auto-scroll Drain's in-page recovery loop (`scroll-drain.ts`) for a Clear
 *  whose tweet wasn't mounted; `'manual'` is the popup-triggered "Release this
 *  page…" / "Release the whole list…" bulk click loop, which has no Ledger/
 *  Worklist involvement at all (spec #59 H5). */
export type ClearOrigin = 'settle' | 'drain' | 'manual'

/** X's `data-testid`s per membership scope: the control shown while the tweet IS
 *  a member (the one we click), and the control it flips to once cleared. */
export const CLEAR_TESTID: Record<
  MembershipScope,
  { readonly active: string; readonly cleared: string }
> = {
  bookmark: { active: 'removeBookmark', cleared: 'bookmark' },
  like: { active: 'unlike', cleared: 'like' },
}

export const TWEET_ARTICLE_SEL = 'article[data-testid="tweet"]'

/** The membership Worklist scope for a LIST page: a Likes page clears only Likes,
 *  a Bookmarks page clears only Bookmarks. Null anywhere else (incl. the timeline).
 *  Clearing is list-scoped so a post is only ever removed from the list you're
 *  viewing — never un-liked AND un-bookmarked in one action. This drives the
 *  manual Drain/Sweep buttons, which are list-only; the download hook uses the
 *  wider `clearableScope` (which also recognizes the For You feed).
 *
 *  X now serves both lists off a single History surface (`/i/history` = Bookmarks,
 *  `/i/history/likes` = Likes); `/i/bookmarks` and `/{handle}/likes` still 302 there
 *  and are kept as legacy alternatives. `pathname` is `location.pathname` — never a
 *  full URL — so there is no query string to match; likes is checked FIRST so
 *  `/i/history/likes` can't fall through to the unqualified `/i/history` bookmark
 *  match. The legacy handle pattern excludes the `i` segment (`/i/likes` ⇒ none) —
 *  `/i/` is X's own route namespace, never a real handle, and every other `/i/...`
 *  path here is matched explicitly. */
export function pageScope(pathname: string): Option.Option<MembershipScope> {
  if (
    /^\/i\/history\/likes(\/|$)/.test(pathname) ||
    /^\/(?!i\/)[A-Za-z0-9_]{1,15}\/likes(\/|$)/.test(pathname)
  ) {
    return Option.some('like')
  }
  if (/^\/i\/history(\/|$)/.test(pathname) || /^\/i\/bookmarks(\/|$)/.test(pathname)) {
    return Option.some('bookmark')
  }
  return Option.none()
}

/** An element's trimmed text. The `?? ''` only satisfies the DOM lib's
 *  `string | null` type — `textContent` is always a string for elements, so the
 *  fallback is unreachable (mirrors the `?? ''` guard in `tweetIdOfArticle`). */
function elementText(el: Element): string {
  /* v8 ignore next */
  return (el.textContent ?? '').trim()
}

/** The For You home tab — the only timeline where the download hook fires "Not
 *  interested". Gated on BOTH the `/home` path AND the active tab being the FIRST
 *  tab of the home tab bar. For You is ALWAYS the first home tab (Following is
 *  second, pinned Lists follow) — a position signal that holds across every
 *  language, where the label text does NOT ("For you" / "為你推薦" / "Pour vous" /
 *  "おすすめ" …). Following at index 1 ⇒ false, so the negative feed action never
 *  fires on the wrong feed. Fail-safe: no qualifying tablist (not `/home`, not
 *  mounted, no selection) ⇒ false. */
export function isForYouHome(pathname: string, root: ParentNode): boolean {
  if (!/^\/home\/?$/.test(pathname)) return false
  for (const list of root.querySelectorAll('[role="tablist"]')) {
    const tabs = [...list.querySelectorAll('[role="tab"]')]
    if (tabs.length < 2) continue // the For You / Following (+ Lists) switcher
    const selected = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true')
    if (selected === -1) continue
    return selected === 0
  }
  return false
}

/** The scope the download hook may clear on the CURRENT page: the list scope on a
 *  Likes/Bookmarks page, or `notInterested` on the For You timeline. Null
 *  elsewhere. Wider than `pageScope` (which is list-only) because the hook also
 *  self-empties the feed; the manual mass-clear buttons deliberately do NOT use
 *  this, so a button press can never "Not interested" the whole For You feed. */
export function clearableScope(pathname: string, root: ParentNode): ClearScope | null {
  return Option.getOrElse(pageScope(pathname), () =>
    isForYouHome(pathname, root) ? 'notInterested' : null,
  )
}

/**
 * Should the content script CLICK this scope (vs. report it a no-op)? The single
 * pure gate behind both clear modes:
 *
 * - Default (`allLists` off): page-scoped — click ONLY the scope the current page
 *   owns (`onScope` = list scope on Likes/Bookmarks, `notInterested` on For You).
 *   A post stays bookmarked while you clear it from Likes; never two mutations from
 *   one page.
 * - "Clear from every list" (`allLists` on): state-driven — fire a membership scope
 *   (un-bookmark / un-like) wherever the article is ACTUALLY in that list
 *   (`member`), regardless of page, so a liked post un-bookmarks while you browse
 *   Likes and a bookmarked one un-likes while you browse Bookmarks. `notInterested`
 *   has no membership control to read, so it stays gated to the For You feed
 *   (`onScope === 'notInterested'` is true only there).
 *
 * `onScope` is the current page's `clearableScope`; `member` is irrelevant for
 * `notInterested` (passed `false`, never read).
 */
export function shouldClickScope(input: {
  readonly scope: ClearScope
  readonly onScope: ClearScope | null
  readonly member: boolean
  readonly allLists: boolean
}): boolean {
  const { scope, onScope, member, allLists } = input
  if (!allLists) return scope === onScope
  if (scope === 'notInterested') return onScope === 'notInterested'
  // The page's OWN list scope (e.g. `like` on the Likes page) is a guaranteed member
  // — the post is in this very list, that's why it's mounted here — so always fire it,
  // never gating on the `member` snapshot. That snapshot is read AFTER a prior
  // cross-list scope's clear (un-bookmark) re-renders the action bar in place, and can
  // transiently false-negative the un-like control, silently dropping the page clear
  // ("un-bookmarked but not un-liked"). The authoritative membership re-check still
  // happens in `clearScope` at click time; cross-list scopes stay membership-gated.
  return scope === onScope || member
}
/** A quoted tweet renders as an anchor-less `div[role="link"]` card nested in the
 *  article. We must never resolve OR click anything inside it — that belongs to a
 *  different post. */
const QUOTE_CARD_SEL = 'div[role="link"]'

/**
 * Resolve an `<article>`'s OWN tweetId (spec §4.4 id-match guard). Prefer the
 * canonical permalink — the status link wrapping the timestamp `<time>` — and
 * ignore any anchor inside a quoted-tweet card. A naive "first /status/ link"
 * could return a nested/quoted/analytics id and match the WRONG post for an
 * irreversible clear. Null if no own permalink is mounted yet.
 */
export function tweetIdOfArticle(article: Element): Option.Option<string> {
  const anchors = [...article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')].filter(
    (a) => a.closest(QUOTE_CARD_SEL) === null,
  )
  const ordered = [
    ...anchors.filter((a) => a.querySelector('time') !== null),
    ...anchors.filter((a) => a.querySelector('time') === null),
  ]
  for (const a of ordered) {
    // `?? ''`: unreachable defensive fallback — the `a[href*="/status/"]` selector
    // guarantees every `a` here has an href containing "/status/", so getAttribute
    // is never null. Kept for the `string | null` type; the branch can't be hit.
    /* v8 ignore next */
    const m = /\/status\/(\d+)/.exec(a.getAttribute('href') ?? '')
    if (m?.[1]) return Option.some(m[1])
  }
  return Option.none()
}

/** Twitter's snowflake epoch (2010-11-04T01:42:54.657Z): every genuine status id
 *  decodes to `(id >> 22) + EPOCH`. */
const SNOWFLAKE_EPOCH_MS = 1_288_834_974_657

/** Can the Clear even LOCATE this post? `findArticle` matches a tweet ONLY by its
 *  numeric `/status/{id}` permalink, so a tweetId that isn't a PLAUSIBLE snowflake
 *  can never match a mounted article — it would defer-then-drop on every tab and
 *  silently leave the post in its lists ("not mounted"). That happens for the
 *  media-key fallback the X adapter uses when a photo's tweet context can't be
 *  resolved (`tweetId ?? key`) AND for captured junk ids (live 2026-08-23:
 *  `3969701833668148185`, which decodes to year 2040 — X 404s that permalink
 *  forever while the release leg burns its whole poll budget). Gate clear seeding
 *  on digit shape AND decodable time inside [Twitter epoch, now + 1 day], so such
 *  items are skipped honestly up front, never seeded into a clear that can only fail. */
export function isClearableTweetId(tweetId: string): boolean {
  if (!/^[0-9]{1,20}$/.test(tweetId)) return false
  const createdAtMs = Number(BigInt(tweetId) >> 22n) + SNOWFLAKE_EPOCH_MS
  return createdAtMs >= SNOWFLAKE_EPOCH_MS && createdAtMs <= Date.now() + 86_400_000
}

/** The mounted `<article>` whose resolved tweetId matches — the id-match guard
 *  (spec §4.4) against virtualization momentarily resolving the wrong post. */
export function findArticle(root: ParentNode, tweetId: string): Option.Option<Element> {
  for (const article of root.querySelectorAll(TWEET_ARTICLE_SEL)) {
    const id = tweetIdOfArticle(article)
    if (Option.isSome(id) && id.value === tweetId) return Option.some(article)
  }
  return Option.none()
}

/** A control with this testid in the article's OWN action bar — never one nested
 *  in a quoted-tweet card (which belongs to a different post). */
function ownControl(article: Element, testid: string): HTMLElement | null {
  for (const el of article.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)) {
    if (el.closest(QUOTE_CARD_SEL) === null) return el
  }
  return null
}

/** The control to click to clear this scope, or null if not a member / not found. */
export function clearControl(article: Element, scope: MembershipScope): HTMLElement | null {
  return ownControl(article, CLEAR_TESTID[scope].active)
}

/** Is the tweet currently a member of this scope? (its active un-control present) */
export function isMember(article: Element, scope: MembershipScope): boolean {
  return clearControl(article, scope) !== null
}

/** Flip confirmed when the active control is gone (it became the cleared control,
 *  or the article detached). The sole signal that authorizes marking `cleared`. */
export function flipConfirmed(article: Element, scope: MembershipScope): boolean {
  return !article.isConnected || ownControl(article, CLEAR_TESTID[scope].active) === null
}

/** The tweet is already in the cleared state for this scope (the non-member
 *  control is present) — e.g. seeded for both scopes but only bookmarked. The
 *  goal ("not in this list") is satisfied, so the scope reports success without a
 *  click. Distinct from "neither control found" (ambiguous → not satisfied). */
export function alreadyCleared(article: Element, scope: MembershipScope): boolean {
  return ownControl(article, CLEAR_TESTID[scope].cleared) !== null
}

/** Every bookmark/like-ish data-testid actually present in an article — the tell
 *  for a selector mismatch (X renamed the control we click). Element NAMES only,
 *  no text, so this is safe for the durable trace and not just the DEV console.
 *  Shared by every clear path (settle/drain's `tweet-clear.ts`, manual's
 *  `clearMountedForScope` in the overlay's handlers) so the `testids=` vocabulary
 *  in the diagnostics log never forks. */
export function actionTestids(article: Element): string[] {
  return (
    [...article.querySelectorAll('[data-testid]')]
      /* v8 ignore start -- the [data-testid] selector guarantees getAttribute is non-null, so the `?? ''` fallback is unreachable */
      .map((el) => el.getAttribute('data-testid') ?? '')
      /* v8 ignore stop */
      .filter((t) => /bookmark|like/i.test(t))
  )
}

/** WHICH disjunct of `flipConfirmed` authorized a "cleared" verdict, plus a FRESH
 *  re-resolve taken right after — the evidence that separates a genuine flip from
 *  a fabricated one. `arm` is read from the CAPTURED node's own `isConnected`
 *  FIRST (mirroring `flipConfirmed`'s own short-circuit), so the attribution can
 *  never credit the testid arm for a detachment: `'detached'` is the suspicious
 *  one — on a list page removing one row re-renders its siblings, so the
 *  virtualizer can detach the CAPTURED node of a DIFFERENT post mid-poll while
 *  `flipConfirmed` still reports success. `reresolved` is what actually splits the
 *  worlds a bare "confirmed" cannot: `'gone'` = the row really left the list;
 *  `'member'` = the post is STILL in it (fabricated flip, or a server-side
 *  revert) — the smoking gun; `'cleared'` = the control genuinely flipped to its
 *  cleared twin; `'ambiguous'` = mounted with NEITHER control (mid re-render, or
 *  selector rot), which must not be laundered into either verdict. Shared by
 *  every clear path so the evidence vocabulary in the diagnostics log never
 *  forks — the single read-only re-resolve the detach-confirm case needs. */
export function classifyFlip(
  document: ParentNode,
  article: Element,
  tweetId: string,
  scope: MembershipScope,
): {
  readonly arm: 'testid' | 'detached'
  readonly reresolved: 'gone' | 'member' | 'cleared' | 'ambiguous'
} {
  const arm = article.isConnected ? 'testid' : 'detached'
  const fresh = findArticle(document, tweetId)
  const reresolved = Option.isNone(fresh)
    ? 'gone'
    : isMember(fresh.value, scope)
      ? 'member'
      : alreadyCleared(fresh.value, scope)
        ? 'cleared'
        : 'ambiguous'
  return { arm, reresolved }
}

// ── "Not interested" (timeline feed clear) ──
//
// Unlike un-bookmark/un-like (a single flip in the action bar), "Not interested"
// is a two-step caret-menu interaction with no membership control: open the
// tweet's "…" menu, click the "Not interested in this post" item, then confirm
// the post collapsed/detached from the feed. Pure selectors here; the content
// script owns the click + menu-wait orchestration. Every path fails safe.

/** The tweet's OWN "…" caret button (never a quoted card's). Clicking it opens the
 *  feedback menu where "Not interested" lives. */
export function caretControl(article: Element): HTMLElement | null {
  return ownControl(article, 'caret')
}

/** X's "Not interested" feedback icon — a frowning face, used ONLY for the
 *  not-interested action (never for Mute/Block/Report/Embed/etc.). It identifies
 *  the menu item across EVERY language, where the label text does not (verified on
 *  the live caret menu: zh-TW renders "對此貼文不感興趣", which no English regex can
 *  match). Matched as a path-prefix; an X icon redesign makes the clear inert
 *  (fail-safe), never wrong. */
const NOT_INTERESTED_ICON = /^M12 13\.6c1\.64/

/** The "Not interested in this post" menu item within an open caret menu (it
 *  carries no stable `data-testid`). Two locale-independent-ish signals, in order:
 *  (1) the exact English text — immune to icon redesigns for the English UI; the
 *  POST-specific phrasing deliberately excludes "…in this topic"/"…in this ad",
 *  broader actions the user did not consent to; (2) the frowning-face icon — covers
 *  every localized UI. Null when neither matches, so a rename/redesign makes the
 *  clear inert (re-claimable) rather than firing the wrong item. */
export function findNotInterestedItem(menuRoot: ParentNode): Option.Option<HTMLElement> {
  const items = [...menuRoot.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  const byText = items.find((el) => /not interested in this post/i.test(elementText(el)))
  if (byText !== undefined) return Option.some(byText)
  const byIcon = items.find((el) =>
    [...el.querySelectorAll('svg path')].some((p) =>
      NOT_INTERESTED_ICON.test(p.getAttribute('d') ?? ''),
    ),
  )
  return Option.fromUndefinedOr(byIcon)
}

/** The action took effect when the post left the feed: X replaces the tweet with a
 *  "you'll see fewer posts like this" placeholder, so the article either detaches
 *  or loses its caret (its action bar is gone). The sole signal that authorizes
 *  marking `notInterested` cleared — a still-intact tweet (caret present) is NOT
 *  confirmation, keeping selector rot from a blind "cleared". */
export function notInterestedConfirmed(article: Element): boolean {
  return !article.isConnected || caretControl(article) === null
}

// ── Full-hide of a cleared post (the leftover feedback stub) ──
//
// After "Not interested in this post", X does NOT remove the post — it swaps the
// tweet for a feedback stub: a NEW <article> WITHOUT data-testid="tweet" holding
// [Undo, Show fewer from @user, This post isn't relevant] + a "Thanks…" line
// (DOM live-verified by the sibling xtimelinefilter project, multilingual). Two
// jobs make the cleared post truly vanish: click the post-level dismiss so X drops
// it, and CSS-collapse any leftover stub so it never lingers on the feed.

/** The virtualized timeline CELL that wraps a tweet — captured BEFORE the clear,
 *  since X replaces the article with the feedback stub in-place. */
export const CELL_SEL = 'div[data-testid="cellInnerDiv"]'
export function cellOf(article: Element): Element | null {
  return article.closest(CELL_SEL)
}

const SHOW_FEWER_TEXT = /show fewer|see fewer|減少顯示|减少显示|表示を減らす/i
const POST_NOT_RELEVANT_TEXT =
  /(?:post|this).*(?:not relevant|irrelevant|isn['’]t relevant)|not relevant|irrelevant|不相關|不相关|関連性が(?:ありません|ない)/i
const UNDO_TEXT = /^\s*(undo|復原|复原|元に戻す)\s*$/i

/** The follow-up dismiss button in the post-not-interested stub — the click that
 *  makes X drop the post entirely instead of leaving the "Thanks…" panel. Only
 *  buttons OUTSIDE a real tweet article (the stub is a non-tweet article). Prefer
 *  the post-level "isn't relevant", then "Show fewer", then position; NEVER Undo.
 *  Null when no stub button is present. (Mirrors xtimelinefilter's live-verified
 *  findNotInterestedFeedback.) */
export function findFeedbackButton(cell: Element): Option.Option<HTMLElement> {
  const outside = [...cell.querySelectorAll<HTMLElement>('button,[role="button"]')].filter(
    (b) => b.closest(TWEET_ARTICLE_SEL) === null,
  )
  const byPost = outside.find((b) => POST_NOT_RELEVANT_TEXT.test(elementText(b)))
  if (byPost !== undefined) return Option.some(byPost)
  const byFewer = outside.find((b) => SHOW_FEWER_TEXT.test(elementText(b)))
  if (byFewer !== undefined) return Option.some(byFewer)
  const positional = outside.length >= 3 ? outside[2] : outside.length >= 2 ? outside[1] : undefined
  return positional !== undefined && !UNDO_TEXT.test(elementText(positional))
    ? Option.some(positional)
    : Option.none()
}

/** The "Thanks. X will use this to make your timeline better" headline of the
 *  feedback panel (multilingual) — the most reliable marker: present in every state
 *  of the stub, independent of whether X renders the rows as buttons or divs. */
const FEEDBACK_HEADLINE_TEXT = /will use this|使用這項資訊|這項資訊|これを使用|利用します/i

/** Is this cell a leftover not-interested feedback stub (a cleared post X turned
 *  into the "Thanks…/Show fewer/isn't relevant" panel)? Matched by the panel's TEXT
 *  — the headline, the follow-up phrasing, or an Undo control — so it catches the
 *  whole feedback flow regardless of whether X renders the rows as buttons or plain
 *  divs. A real, un-cleared post still has its `article[data-testid="tweet"]`, so it
 *  is never a stub — that gate makes the CSS collapse recycling-safe: a cell
 *  recycled to a real post stops matching and is shown again. */
export function isClearedStub(cell: Element): boolean {
  if (cell.querySelector(TWEET_ARTICLE_SEL) !== null) return false // a live tweet
  const text = elementText(cell)
  return (
    FEEDBACK_HEADLINE_TEXT.test(text) ||
    POST_NOT_RELEVANT_TEXT.test(text) ||
    SHOW_FEWER_TEXT.test(text) ||
    [...cell.querySelectorAll<HTMLElement>('button,[role="button"]')].some((b) =>
      UNDO_TEXT.test(elementText(b)),
    )
  )
}

/** The page-level CSS hook for the collapse. Hides the stub cell's CONTENT (never
 *  the cell node itself) so it reads ~0 height while staying in layout — gentle on
 *  X's virtualization (the xtimelinefilter/ADR-0010 principle). */
export const CLEARED_STUB_ATTR = 'data-xmd-cleared'
export const CLEARED_STUB_CSS = `${CELL_SEL}[${CLEARED_STUB_ATTR}] > *{display:none !important}`

/** What a Release leg polling a permalink actually saw when the target tweet
 *  never mounted — the only window into WHY (still loading vs. X's own
 *  `error-detail` block vs. a genuinely empty page) the release-tab dispatch
 *  otherwise can't see. Read fresh on every poll; never cached. */
export interface PageEvidence {
  readonly articles: number
  readonly cells: number
  readonly ready: DocumentReadyState
  readonly error: boolean
}

export function pageEvidence(
  document: Pick<Document, 'querySelectorAll' | 'querySelector' | 'readyState'>,
): PageEvidence {
  return {
    articles: document.querySelectorAll(TWEET_ARTICLE_SEL).length,
    cells: document.querySelectorAll(CELL_SEL).length,
    ready: document.readyState,
    error: document.querySelector('[data-testid="error-detail"]') !== null,
  }
}

/** Mark/unmark every cell under `root` for collapse based on whether it is a
 *  cleared-post feedback stub right now. Re-runnable + recycling-safe (re-decides
 *  per cell, drops the mark off a recycled cell holding a real post). Returns the
 *  number of stubs currently collapsed. */
export function collapseClearedStubs(root: ParentNode): number {
  let collapsed = 0
  for (const cell of root.querySelectorAll(CELL_SEL)) {
    if (isClearedStub(cell)) {
      cell.setAttribute(CLEARED_STUB_ATTR, '')
      collapsed += 1
    } else if (cell.hasAttribute(CLEARED_STUB_ATTR)) {
      cell.removeAttribute(CLEARED_STUB_ATTR)
    }
  }
  return collapsed
}
