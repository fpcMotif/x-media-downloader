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
 *
 * The membership (button-flip) path is ALSO instrumented for production diagnosis via
 * the `trace`/`onFlip` ports. A Release that reports failure on the Bookmarks page used
 * to collapse four utterly different faults into one `bookmark:fail` token — no article
 * mounted, the control renamed out from under our selector, a click that never took, and
 * a "flip" confirmed only because the captured node detached. The `clear-*` stages below
 * separate them, and carry ONLY stage tokens, scope names, `data-testid` strings,
 * counters and counter-derived ms — never post text, handles, URLs or `textContent`.
 *
 * Precedence (when a `witness` port is supplied): the SERVER's own mutation verdict
 * outranks the DOM. Every poll iteration checks `witness.outcome` first — `'ok'` reports
 * a confirmed flip (`arm=mutation`) regardless of what the DOM shows (the fix for
 * virtualized worklists like `/i/history`, where a stale/ghost row never visibly flips
 * even though X already dropped the post), and `'error'` reports `reason=mutation-error`
 * immediately (the server rejected the mutation; no point waiting out the DOM budget).
 * `'none'` — the tee hasn't seen a matching mutation yet — falls through to the ORIGINAL
 * DOM-flip check unchanged. With no `witness` port at all, behaviour is byte-identical to
 * before: DOM-only is the fallback, never the primary signal, when the tee saw nothing.
 */
import { Option } from 'effect'
import type { ClearScope } from '@/packages/schema'
import {
  actionTestids,
  alreadyCleared,
  caretControl,
  cellOf,
  CLEAR_TESTID,
  CLEARED_STUB_ATTR,
  classifyFlip,
  clearControl,
  type ClearOrigin,
  findArticle,
  findFeedbackButton,
  findNotInterestedItem,
  flipConfirmed,
  isMember,
  type MembershipScope,
  notInterestedConfirmed,
} from './clearer'
import type { MutationWitness } from './mutation-witness'

// Poll for the post-click testid flip. X updates the control optimistically, but
// the row removal / re-render can lag well past a single tick, so we poll a fixed
// number of times rather than waiting once.
const FLIP_POLL_INTERVAL_MS = 200
const FLIP_POLL_ATTEMPTS = 6
const FLIP_CONFIRM_TIMEOUT_MS = FLIP_POLL_ATTEMPTS * FLIP_POLL_INTERVAL_MS

// Once the DOM poll budget above is exhausted with no DOM flip AND no witness
// verdict, give the server mutation a few more beats to land — its response can
// lag the DOM update on a slow connection, and the witness-only checks are cheap
// (no DOM work, just a Map read). Skipped entirely when no `witness` port was
// supplied, so behaviour without one is unchanged.
const EXTRA_WITNESS_POLL_INTERVAL_MS = 250
const EXTRA_WITNESS_POLL_ATTEMPTS = 4

export interface TweetClearerDeps {
  readonly document: Document
  /** The Drain's Clock shape (sleep-only slice) — fake time in tests. */
  readonly clock: { readonly sleep: (ms: number) => Promise<void> }
  /** DEV trace sink; undefined in production so no diag work happens at all. Stays
   *  DEV-only DELIBERATELY: it writes to the page console and its "Not interested"
   *  lines carry element `textContent`, which must never reach a durable log.
   *  Production-visible evidence goes through `trace` instead. */
  readonly log?: ((...args: unknown[]) => void) | undefined
  /** Durable Release-diagnostics sink — every stage here is `clear-`-prefixed, the only
   *  events `clear/diagnostics.ts` admits into the log. Present in production: without
   *  it the DOM-flip verdict (the #1 discriminator between a real un-bookmark, a
   *  fabricated one, selector rot and a plain timeout) is computed nowhere and reaches
   *  nothing. Privacy: pass only tokens, ids and counters — never post content. */
  readonly trace?: ((stage: string, detail: string, tweetId?: string) => void) | undefined
  /** Fired the instant a scope reports a confirmed flip, so the caller can arm a
   *  re-appearance watchdog. A flip confirmed via the `detached` arm may be fabricated
   *  (see `traceFlip`), and only a later re-observation of the post can prove it. */
  readonly onFlip?: ((tweetId: string, scope: ClearScope, origin: ClearOrigin) => void) | undefined
  /** The server's own mutation verdict (see the module doc for precedence). Absent
   *  in tests that don't wire one and (defensively) never on platforms other than
   *  X — DOM-only fallback, byte-identical to the pre-witness behaviour. */
  readonly witness?: Pick<MutationWitness, 'outcome'> | undefined
  /** Clock read at click time so the witness knows which mutations postdate THIS
   *  click (`witness.outcome`'s `sinceT`). Defaults to `Date.now` — fake it in
   *  tests to pin `clickedAt` deterministically alongside the fake `clock`. */
  readonly now?: (() => number) | undefined
}

export function makeTweetClearer(deps: TweetClearerDeps) {
  /** Clear ONE scope for a tweet by clicking X's own control and confirming the flip.
   *  Invariants: re-resolves the article by id immediately before EVERY click; member ⇒
   *  click + confirm flip on a freshly re-resolved node within ATTEMPTS×INTERVAL;
   *  non-member ⇒ true only if verifiably already cleared; 'notInterested' ⇒ caret menu
   *  flow acting ONLY on the single menu its own click opened (0 or ≥2 new menus ⇒
   *  dismiss + false), then best-effort feedback-stub dismiss; ANY ambiguity/selector
   *  rot ⇒ false — never a blind "cleared". Never throws. Every membership terminal also
   *  emits its verdict through `trace` (`clear-flip` / `clear-attempt-fail` /
   *  `clear-already-cleared`, each carrying `origin=` — WHICH call path fired this
   *  clear, see `ClearOrigin`), and a confirmed flip additionally calls `onFlip`. */
  const { document, clock, log, trace, onFlip, witness, now = Date.now } = deps

  /** The four fail-closed `return false` paths of the flip flow, in ONE vocabulary so
   *  "the post isn't on this page", "X renamed our control", "the click never took" and
   *  "the server itself rejected the mutation" can never be read as each other.
   *  `attempts`/`elapsedMs` derive from the poll counter × the interval — never a wall
   *  clock — so the line is deterministic; `elapsedMsOverride` exists ONLY for
   *  `reason=mutation-error` raised during the extra witness-only polls, whose interval
   *  (`EXTRA_WITNESS_POLL_INTERVAL_MS`) differs from the ordinary DOM poll's.
   *
   *  `reason=no-article` is the one line a `notInterested` clear can also emit: it is
   *  raised before the caret-menu flow branches off, and it is content-free (a scope name
   *  and two zeroes), so it is left reachable rather than special-cased — a "the post
   *  isn't mounted" failure is worth the same line whichever flow would have handled it.
   *  Everything downstream of that branch is `bookmark`/`like` only.
   *
   *  `reason=mutation-error` is the ONE reason with no DOM story at all: the server
   *  answered the confirming mutation with a non-200 or an in-body error signal, which
   *  is stronger evidence than any DOM read could ever be — reported the instant the
   *  witness sees it, without waiting out the rest of the poll budget. */
  const traceAttemptFail = (
    tweetId: string,
    scope: ClearScope,
    reason: 'no-article' | 'no-control' | 'no-flip' | 'mutation-error',
    attempts: number,
    article: Element | null,
    /** What we dispatched at, on the reasons that follow a click (`no-flip`,
     *  `mutation-error`); null on the two that never clicked, so the tokens' presence
     *  itself says a click happened. */
    click: { readonly target: 'button' | 'testid-node'; readonly disabled: boolean } | null,
    origin: ClearOrigin,
    elapsedMsOverride?: number,
  ): void => {
    if (!trace) return
    // No article ⇒ nothing to enumerate. Omit the token entirely: an EMPTY `testids=`
    // means "the action bar has no bookmark/like control at all" (selector rot), a
    // materially different fault from "the post isn't mounted".
    const testids = article === null ? '' : ` testids=${actionTestids(article).join(',')}`
    // The click-quality tokens belong HERE above all: on a `no-flip` they are the two
    // hypotheses that exonerate our selectors (we dispatched at a wrapper X ignores; the
    // control was inert when we clicked it) and they are unreadable from anywhere else.
    const clicked = click === null ? '' : ` target=${click.target} disabled=${click.disabled}`
    const elapsedMs = elapsedMsOverride ?? attempts * FLIP_POLL_INTERVAL_MS
    trace(
      'clear-attempt-fail',
      `scope=${scope} reason=${reason} attempts=${attempts} elapsedMs=${elapsedMs}${clicked}${testids} origin=${origin}`,
      tweetId,
    )
  }

  /** The flip verdict, made production-visible — WHY we believe the post left the
   *  list, not just that we believe it. `classifyFlip` (shared with the manual-release
   *  path in the overlay's handlers, so the `arm=`/`reresolved=` vocabulary never forks)
   *  does the actual re-resolve; this wrapper only formats + emits. A `detached` arm
   *  whose fresh re-resolve reads `member` is the fabricated-flip smoking gun — loud
   *  enough on its own line (`clear-flip-fabricated`) that a diagnostician doesn't have
   *  to parse tokens out of the ordinary `clear-flip` line to find it.
   *
   *  `armOverride`/`elapsedMsOverride` exist for the `witness` 'ok' verdict: `arm=mutation`
   *  says the SERVER confirmed the release (never `testid`/`detached`, which are DOM-only
   *  reads), but `classifyFlip` still runs — a fresh `reresolved=` keeps the line
   *  comparable to every ordinary `clear-flip`, and `arm==='detached'` can never fire the
   *  fabricated-flip line here since the override always wins that check. */
  const traceFlip = (
    article: Element,
    tweetId: string,
    scope: MembershipScope,
    attempt: number,
    target: 'button' | 'testid-node',
    disabled: boolean,
    origin: ClearOrigin,
    armOverride?: 'mutation',
    elapsedMsOverride?: number,
  ): void => {
    if (!trace) return
    const { arm: domArm, reresolved } = classifyFlip(document, article, tweetId, scope)
    const arm = armOverride ?? domArm
    const elapsedMs = elapsedMsOverride ?? attempt * FLIP_POLL_INTERVAL_MS
    const detail = `scope=${scope} arm=${arm} attempt=${attempt} elapsedMs=${elapsedMs} target=${target} disabled=${disabled} reresolved=${reresolved} origin=${origin}`
    trace('clear-flip', detail, tweetId)
    if (arm === 'detached' && reresolved === 'member')
      trace('clear-flip-fabricated', detail, tweetId)
  }

  // Clear ONE scope for a tweet. Re-resolves the article by id IMMEDIATELY before
  // the click (findArticle re-checks tweetId), so a virtualized/recycled node can
  // never make us click the wrong post (spec §4.4 — the guard must run per click,
  // not once per request). Member ⇒ click X's own control and confirm the flip on a
  // FRESHLY re-resolved node (the settle window catches the optimistic re-render, and
  // the row often detaches on a worklist page = cleared). Not a member ⇒ ok only if
  // confirmed already-cleared; ambiguous DOM ⇒ false (stays re-claimable, never a
  // blind "cleared" on selector rot).
  async function clearScope(
    tweetId: string,
    scope: ClearScope,
    origin: ClearOrigin,
  ): Promise<boolean> {
    const article = findArticle(document, tweetId)
    if (Option.isNone(article)) {
      if (log) log(scope, tweetId, '→ no matching article on page')
      traceAttemptFail(tweetId, scope, 'no-article', 0, null, null, origin)
      return false
    }
    // The timeline feed clear is a caret-menu interaction, not a button flip. Its own
    // steps are deliberately UNINSTRUMENTED past this point: `pageScope('/i/bookmarks')`
    // is `bookmark`, so they cannot run on the page under diagnosis, and its `log` lines
    // carry element text that has no business in a durable log. The `no-article` line
    // above is shared, and can carry `scope=notInterested`.
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
      // A no-op outcome, in its OWN stage rather than the `fail` vocabulary: reaching
      // here means we never clicked anything, and folding that into a failure (or into a
      // plain success) is exactly what lets a silent no-op pass for a Release. The bool
      // carries the split — `true` = verifiably out of the list already, `false` = neither
      // control found, so the testids token says whether the selectors rotted.
      if (trace)
        trace(
          'clear-already-cleared',
          `scope=${scope} clicked=false alreadyCleared=${ac} testids=${actionTestids(article.value).join(',')} origin=${origin}`,
          tweetId,
        )
      return ac
    }
    const ctrl = clearControl(article.value, scope)
    /* v8 ignore start -- isMember above already proved this scope's active control is present; clearControl re-reads the same node synchronously, so ctrl is never null here (defensive re-check) */
    if (ctrl === null) {
      if (log)
        log(scope, '→ member but control not found (selector rot?)', actionTestids(article.value))
      traceAttemptFail(tweetId, scope, 'no-control', 0, article.value, null, origin)
      return false
    }
    /* v8 ignore stop */
    // Click the actionable button, not the bare testid node — X may put the testid
    // on a wrapper; clicking `.closest(button/role=button)` is the path proven to
    // un-like in the console. Falls back to the element itself.
    const closestButton = ctrl.closest('button,[role="button"]')
    const button = closestButton instanceof HTMLElement ? closestButton : null
    const target = button ?? ctrl
    // Snapshot WHAT we clicked, before we click it: the node is usually gone by the time
    // the verdict is traced. `target=testid-node` means no button ancestor existed, so we
    // dispatched at a wrapper X may simply ignore; `disabled` catches a control rendered
    // inert mid-flight (X disables the action bar while a mutation is in flight) — either
    // one explains a click that produced no flip without implicating our selectors. BOTH
    // terminals carry them: on `clear-flip` they say the click that worked was ordinary,
    // and on `clear-attempt-fail reason=no-flip` — the terminal they actually explain —
    // they are the difference between "X ignored our dispatch" and "the list never
    // updated". Emitting them only on success would put the evidence where the question
    // never gets asked.
    const targetKind = button === null ? 'testid-node' : 'button'
    const disabled =
      target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true'
    if (log) log(scope, '→ clicking', CLEAR_TESTID[scope].active)
    // Captured IMMEDIATELY before the click — `witness.outcome`'s `sinceT` — so a
    // mutation the tee observed for a PRIOR, unrelated attempt on this tweet (e.g. a
    // re-add the user did by hand) can never be misread as confirming THIS click.
    const clickedAt = now()
    target.click()
    // Poll for the flip: X updates the control optimistically but the row removal /
    // re-render can lag well past a single tick — too short a window reports a real
    // un-like/un-bookmark as a failure. Confirm on the SAME node: its active
    // un-control gone (flipped in place) or the row detached. When a `witness` port
    // is supplied its verdict is consulted FIRST on every iteration (see the module
    // doc's precedence note) — an 'ok' is authoritative regardless of the DOM, and an
    // 'error' short-circuits the whole DOM budget since the server already answered.
    // oxlint-disable no-await-in-loop -- sequential poll with a fixed cap
    for (let i = 1; i <= FLIP_POLL_ATTEMPTS; i++) {
      await clock.sleep(FLIP_POLL_INTERVAL_MS)
      if (witness) {
        const verdict = witness.outcome(tweetId, scope, clickedAt)
        if (verdict === 'error') {
          traceAttemptFail(
            tweetId,
            scope,
            'mutation-error',
            i,
            article.value,
            { target: targetKind, disabled },
            origin,
          )
          return false
        }
        if (verdict === 'ok') {
          traceFlip(article.value, tweetId, scope, i, targetKind, disabled, origin, 'mutation')
          if (onFlip) onFlip(tweetId, scope, origin)
          return true
        }
      }
      if (!flipConfirmed(article.value, scope)) continue
      if (log) log(scope, `→ flip confirmed after ${i * FLIP_POLL_INTERVAL_MS}ms`)
      const { arm, reresolved } = classifyFlip(document, article.value, tweetId, scope)
      traceFlip(article.value, tweetId, scope, i, targetKind, disabled, origin)
      // Discriminated flip-confirm (#62): detachment alone is not proof. The
      // virtualizer detaches the captured node of a post that is STILL a member
      // when a sibling release re-renders the list (diagnosis cause #1) — the
      // fresh re-resolve splits the worlds: `member`/`ambiguous` refuse (fail-
      // closed, latch stays re-claimable); `gone` stays deferred to the recheck
      // watchdog that onFlip arms; `cleared` is a genuine flip on a fresh node.
      if (arm === 'detached' && (reresolved === 'member' || reresolved === 'ambiguous'))
        return false
      if (onFlip) onFlip(tweetId, scope, origin)
      return true
    }
    // oxlint-enable no-await-in-loop
    // The DOM budget is exhausted with no DOM flip. Give the server mutation a few
    // more beats ONLY if a witness was supplied — with none, this is unreachable and
    // behaviour is unchanged from before the witness existed.
    if (witness) {
      // oxlint-disable no-await-in-loop -- sequential poll with a fixed cap
      for (let j = 1; j <= EXTRA_WITNESS_POLL_ATTEMPTS; j++) {
        await clock.sleep(EXTRA_WITNESS_POLL_INTERVAL_MS)
        const verdict = witness.outcome(tweetId, scope, clickedAt)
        const elapsedMs = FLIP_CONFIRM_TIMEOUT_MS + j * EXTRA_WITNESS_POLL_INTERVAL_MS
        if (verdict === 'error') {
          traceAttemptFail(
            tweetId,
            scope,
            'mutation-error',
            FLIP_POLL_ATTEMPTS + j,
            article.value,
            { target: targetKind, disabled },
            origin,
            elapsedMs,
          )
          return false
        }
        if (verdict === 'ok') {
          traceFlip(
            article.value,
            tweetId,
            scope,
            FLIP_POLL_ATTEMPTS + j,
            targetKind,
            disabled,
            origin,
            'mutation',
            elapsedMs,
          )
          if (onFlip) onFlip(tweetId, scope, origin)
          return true
        }
      }
      // oxlint-enable no-await-in-loop
    }
    if (log)
      log(
        scope,
        `→ NO flip after ${FLIP_CONFIRM_TIMEOUT_MS / 1000}s · testids now:`,
        actionTestids(article.value),
      )
    traceAttemptFail(
      tweetId,
      scope,
      'no-flip',
      FLIP_POLL_ATTEMPTS,
      article.value,
      { target: targetKind, disabled },
      origin,
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
    const closestCaretButton = caret.closest('button,[role="button"]')
    const caretTarget = closestCaretButton instanceof HTMLElement ? closestCaretButton : caret
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
        if (log) log('notInterested', '→ dismissing feedback stub:', fb.value.textContent?.trim())
        /* v8 ignore start -- findFeedbackButton only returns button/[role=button] elements, so closest self-matches; the `?? fb.value` fallback is unreachable */
        const clickable = fb.value.closest('button,[role="button"]')
        ;(clickable instanceof HTMLElement ? clickable : fb.value).click()
        /* v8 ignore stop */
        return
      }
      await clock.sleep(FLIP_POLL_INTERVAL_MS)
    }
    // oxlint-enable no-await-in-loop
  }

  return { clearScope } satisfies {
    readonly clearScope: (
      tweetId: string,
      scope: ClearScope,
      origin: ClearOrigin,
    ) => Promise<boolean>
  }
}
