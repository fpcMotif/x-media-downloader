/**
 * Tweet-clearer — the irreversible un-bookmark / un-like / "Not interested" click,
 * under the flip-confirm gate (spec §4.4). The pure selectors + DOM predicates live
 * in `./clearer`; this module owns the effectful click → poll → confirm machinery
 * that was previously trapped in the overlay closure.
 *
 * The document and the timer arrive as injected ports (matching its siblings
 * scroll-drain and list-clear), so the per-click re-resolve, the before-click menu
 * snapshot, the exactly-one-new-menu-else-bail guard and the fail-closed polling are
 * testable with a fake clock and a built DOM. Every path fails safe: no verified flip
 * ⇒ `false`, never a silent "cleared" on selector rot.
 */
import { Option } from 'effect'
import type { ClearScope } from '../schema'
import {
  alreadyCleared,
  caretControl,
  cellOf,
  CLEAR_TESTID,
  CLEARED_STUB_ATTR,
  clearControl,
  findArticle,
  findFeedbackButton,
  findNotInterestedItem,
  flipConfirmed,
  isMember,
  notInterestedConfirmed,
} from './clearer'

/** Every bookmark/like-ish data-testid actually present in an article — the tell
 *  for a selector mismatch (X renamed the control we click). */
const actionTestids = (article: Element): string[] =>
  [...article.querySelectorAll('[data-testid]')]
    /* v8 ignore start -- the [data-testid] selector guarantees getAttribute is non-null, so the `?? ''` fallback is unreachable */
    .map((el) => el.getAttribute('data-testid') ?? '')
    /* v8 ignore stop */
    .filter((t) => /bookmark|like/i.test(t))

// Poll for the post-click testid flip. X updates the control optimistically, but
// the row removal / re-render can lag well past a single tick, so we poll a fixed
// number of times rather than waiting once.
const FLIP_POLL_INTERVAL_MS = 200
const FLIP_POLL_ATTEMPTS = 6
const FLIP_CONFIRM_TIMEOUT_MS = FLIP_POLL_ATTEMPTS * FLIP_POLL_INTERVAL_MS

export interface TweetClearerDeps {
  readonly document: Document
  /** The Drain's Clock shape (sleep-only slice) — fake time in tests. */
  readonly clock: { readonly sleep: (ms: number) => Promise<void> }
  /** DEV trace sink; undefined in production so no diag work happens at all. */
  readonly log?: ((...args: unknown[]) => void) | undefined
}

export function makeTweetClearer(deps: TweetClearerDeps): {
  /** Clear ONE scope for a tweet by clicking X's own control and confirming the flip.
   *  Invariants: re-resolves the article by id immediately before EVERY click; member ⇒
   *  click + confirm flip on a freshly re-resolved node within ATTEMPTS×INTERVAL;
   *  non-member ⇒ true only if verifiably already cleared; 'notInterested' ⇒ caret menu
   *  flow acting ONLY on the single menu its own click opened (0 or ≥2 new menus ⇒
   *  dismiss + false), then best-effort feedback-stub dismiss; ANY ambiguity/selector
   *  rot ⇒ false — never a blind "cleared". Never throws. */
  readonly clearScope: (tweetId: string, scope: ClearScope) => Promise<boolean>
} {
  const { document, clock, log } = deps

  // Clear ONE scope for a tweet. Re-resolves the article by id IMMEDIATELY before
  // the click (findArticle re-checks tweetId), so a virtualized/recycled node can
  // never make us click the wrong post (spec §4.4 — the guard must run per click,
  // not once per request). Member ⇒ click X's own control and confirm the flip on a
  // FRESHLY re-resolved node (the settle window catches the optimistic re-render, and
  // the row often detaches on a worklist page = cleared). Not a member ⇒ ok only if
  // confirmed already-cleared; ambiguous DOM ⇒ false (stays re-claimable, never a
  // blind "cleared" on selector rot).
  async function clearScope(tweetId: string, scope: ClearScope): Promise<boolean> {
    const article = findArticle(document, tweetId)
    if (Option.isNone(article)) {
      if (log) log(scope, tweetId, '→ no matching article on page')
      return false
    }
    // The timeline feed clear is a caret-menu interaction, not a button flip.
    if (scope === 'notInterested') return clearNotInterested(article.value, tweetId)
    if (!isMember(article.value, scope)) {
      const ac = alreadyCleared(article.value, scope)
      if (log)
        log(
          scope,
          '→ not a member; alreadyCleared =',
          ac,
          '· testids present:',
          actionTestids(article.value),
        )
      return ac
    }
    const ctrl = clearControl(article.value, scope)
    /* v8 ignore start -- isMember above already proved this scope's active control is present; clearControl re-reads the same node synchronously, so ctrl is never null here (defensive re-check) */
    if (ctrl === null) {
      if (log)
        log(scope, '→ member but control not found (selector rot?)', actionTestids(article.value))
      return false
    }
    /* v8 ignore stop */
    // Click the actionable button, not the bare testid node — X may put the testid
    // on a wrapper; clicking `.closest(button/role=button)` is the path proven to
    // un-like in the console. Falls back to the element itself.
    const target = (ctrl.closest('button,[role="button"]') as HTMLElement | null) ?? ctrl
    if (log) log(scope, '→ clicking', CLEAR_TESTID[scope].active)
    target.click()
    // Poll for the flip: X updates the control optimistically but the row removal /
    // re-render can lag well past a single tick — too short a window reports a real
    // un-like/un-bookmark as a failure. Confirm on the SAME node: its active
    // un-control gone (flipped in place) or the row detached.
    // oxlint-disable no-await-in-loop -- sequential poll with a fixed cap
    for (let i = 1; i <= FLIP_POLL_ATTEMPTS; i++) {
      await clock.sleep(FLIP_POLL_INTERVAL_MS)
      if (flipConfirmed(article.value, scope)) {
        if (log) log(scope, `→ flip confirmed after ${i * FLIP_POLL_INTERVAL_MS}ms`)
        return true
      }
    }
    // oxlint-enable no-await-in-loop
    if (log)
      log(
        scope,
        `→ NO flip after ${FLIP_CONFIRM_TIMEOUT_MS / 1000}s · testids now:`,
        actionTestids(article.value),
      )
    return false
  }

  /** Close any open X menu (Escape) — cleans up a bailed "Not interested" attempt so
   *  a half-opened caret menu isn't left covering the feed. */
  function dismissMenu(): void {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  }

  // Clear a For You post by firing X's own "Not interested in this post": open the
  // tweet's caret menu, click the item, then confirm the post left the feed. Two
  // staged polls — one for the (portaled, document-level) menu to mount, one for the
  // post to collapse/detach. Fails safe at every step: no caret, no menu/item, or no
  // collapse ⇒ false (stays re-claimable, never a blind "cleared" on selector rot),
  // and a bailed attempt dismisses the dangling menu.
  async function clearNotInterested(article: Element, tweetId: string): Promise<boolean> {
    const caret = caretControl(article)
    if (caret === null) {
      if (log) log('notInterested', tweetId, '→ no caret control (selector rot?)')
      return false
    }
    // Capture the wrapping cell BEFORE the click — X replaces the tweet article with
    // the feedback stub in-place, so we'd lose the handle once it fires.
    const cell = cellOf(article)
    const caretTarget = (caret.closest('button,[role="button"]') as HTMLElement | null) ?? caret
    // Snapshot the menus open BEFORE we click, so we only ever act on the menu THIS
    // caret click opens — never a stale clear-menu, the account switcher, a
    // compose/share menu, or one the user opened by hand. X portals the caret menu to
    // the document with no article tie-back, so a document-wide search could otherwise
    // fire "Not interested" in the WRONG post's menu (the irreversible-action footgun).
    const before = new Set(document.querySelectorAll('[role="menu"]'))
    if (log) log('notInterested', tweetId, '→ opening caret menu')
    caretTarget.click()
    // Poll for the menu our click opened — the one new since the snapshot. Exactly one
    // new menu = ours; two+ is ambiguous (don't guess which is this caret's) → bail.
    let item: HTMLElement | null = null
    // oxlint-disable no-await-in-loop -- staged poll with a fixed cap
    for (let i = 1; i <= FLIP_POLL_ATTEMPTS && item === null; i++) {
      await clock.sleep(FLIP_POLL_INTERVAL_MS)
      const opened = [...document.querySelectorAll('[role="menu"]')].filter((m) => !before.has(m))
      if (opened.length > 1) break
      const [sole] = opened
      if (sole) item = Option.getOrNull(findNotInterestedItem(sole))
    }
    if (item === null) {
      if (log) log('notInterested', '→ own menu/item not found; dismissing')
      dismissMenu()
      return false
    }
    if (log) log('notInterested', '→ clicking "Not interested in this post"')
    item.click()
    // Confirm the post left the feed (article detached, or its caret/action bar gone),
    // then FULLY hide it: click the follow-up "This post isn't relevant" so X drops the
    // post rather than leaving the "Thanks…" stub (the stub-collapse CSS hides any
    // residual). Without this the cleared post lingers as a feedback panel on the feed.
    for (let i = 1; i <= FLIP_POLL_ATTEMPTS; i++) {
      await clock.sleep(FLIP_POLL_INTERVAL_MS)
      if (notInterestedConfirmed(article)) {
        if (log) log('notInterested', `→ confirmed after ${i * FLIP_POLL_INTERVAL_MS}ms`)
        // Collapse the cleared cell immediately (the observer also keeps it marked,
        // recycling-safe) so the "Thanks…" stub never flashes, then click the
        // follow-up so X drops the post natively.
        cell?.setAttribute(CLEARED_STUB_ATTR, '')
        await dismissFeedbackStub(cell)
        return true
      }
    }
    // oxlint-enable no-await-in-loop
    if (log) log('notInterested', '→ NO collapse; dismissing')
    dismissMenu()
    return false
  }

  /** After "Not interested" confirms, X leaves a feedback stub ("Thanks…/Show fewer/
   *  This post isn't relevant"). Click the post-level dismiss so X drops the post
   *  entirely (it renders a beat after the article unmounts — poll briefly). The
   *  stub-collapse CSS hides any residual, so this is best-effort: the CSS is the
   *  guarantee, the click is the native full-dismiss (matching xtimelinefilter). */
  async function dismissFeedbackStub(cell: Element | null): Promise<void> {
    if (cell === null) return
    // oxlint-disable no-await-in-loop -- short bounded poll for the follow-up panel
    for (let i = 1; i <= FLIP_POLL_ATTEMPTS; i++) {
      const fb = findFeedbackButton(cell)
      if (Option.isSome(fb)) {
        if (log)
          log('notInterested', '→ dismissing feedback stub:', fb.value.textContent?.trim())
          /* v8 ignore start -- findFeedbackButton only returns button/[role=button] elements, so closest self-matches; the `?? fb.value` fallback is unreachable */
        ;((fb.value.closest('button,[role="button"]') as HTMLElement | null) ?? fb.value).click()
        /* v8 ignore stop */
        return
      }
      await clock.sleep(FLIP_POLL_INTERVAL_MS)
    }
    // oxlint-enable no-await-in-loop
  }

  return { clearScope }
}
