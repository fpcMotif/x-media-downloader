/**
 * Release re-appearance watchdog — the one line that proves whether a reported
 * Release actually STUCK.
 *
 * Why it exists: `tweet-clear`'s flip poll starts 200ms after the click and confirms on
 * X's OPTIMISTIC in-page flip, so it answers a much weaker question than the one we
 * care about. Two independent ways its "cleared" can be a lie:
 *  - the server REVERTS the mutation (a 4xx/429 on `DeleteBookmark`) after the optimistic
 *    flip has already been observed. That response is invisible to us — the response tee
 *    only observes read ops — so the revert is reported as a success and latches a durable
 *    `cleared` flag that is never re-claimable (see NOTES.md: `cleared` is NOT retryable);
 *  - the virtualizer DETACHES the row mid-poll, which `flipConfirmed` (clearer.ts) reads
 *    as a flip by design (`!article.isConnected`) — a fabricated success on a post nobody
 *    ever un-bookmarked.
 * Both fail the same way LATER: seconds on, the post is a scope member again. So we
 * re-probe once, well after X's mutation response has had time to land, and put the
 * verdict in the durable Release log (`clear-` prefix — see diagnostics.ts).
 *
 * Membership scopes ONLY (bookmark/like). `notInterested` is out of scope here for the
 * same reason `clearer.ts` types the flip helpers to exclude it — it has no membership
 * control, so "is it back?" is not a question this probe can answer.
 *
 * Pure: the timer, the DOM re-resolve and the trace sink all arrive as injected ports
 * (matching scroll-drain / tweet-clear), so the dedupe + cancel behaviour is testable
 * with a fake clock and no DOM at all. The dependency runs ONE way — `tweet-clear` calls
 * into this module through its flip/report seam; nothing here imports `tweet-clear`
 * (depcruise enforces no-circular globally).
 */
import { Option } from 'effect'
import { pageScope, type MembershipScope } from './clearer'

/**
 * How long after the Release click to re-probe. Must sit comfortably past the flip
 * poll's whole window (6 × 200ms = 1.2s) AND past a slow `DeleteBookmark` round-trip
 * plus X's re-render of the reverted row — a probe that fires too early reads the
 * optimistic state we already know about and proves nothing.
 */
export const RELEASE_RECHECK_DELAY_MS = 5000

/** The stage every watchdog line carries. The overlay's `reportClear` stamps
 *  `source:'clear'`, which alone admits the event to the durable Release log
 *  (diagnostics.ts's `isReleaseDiagnosticsEvent`); the `clear-` prefix keeps the line
 *  admissible even if it is ever re-emitted from the background, whose `source` is
 *  shared with unrelated trace lines. */
const RECHECK_STAGE = 'clear-recheck'

/** A probe that threw tells us nothing about membership, so it gets its OWN token rather
 *  than being folded into `absent`: `absent` is already the ambiguous bucket, and quietly
 *  seeding it with selector-rot/teardown faults would destroy the one reading a future
 *  reader can still act on. The thrown message is deliberately NOT on the line — this
 *  seam has no compactor and raw error text may carry post/URL content. */
const PROBE_ERROR_STATE = 'probe-error'

/** The page classification when the probe itself faulted — we never learned where we were. */
const UNKNOWN_PAGE = 'unknown'

/**
 * Which LIST we woke up on, as a bounded token — deliberately NOT the raw pathname.
 * Two reasons, and the second is the binding one:
 *  - the reader's actual question is "are we still on the list we released from?", which
 *    is answered by comparing this token against the line's own `scope=`; the rest of a
 *    pathname is noise that also makes the line un-aggregatable across users;
 *  - `location.pathname` on X carries @handles and post permalinks (`/{handle}/likes`,
 *    `/{handle}/status/{id}`), and this line lands in the DURABLE Release log that the
 *    user later exports as JSONL. Post-identifying text must not reach that log — the
 *    same rule that keeps `tweet-clear`'s `log` port DEV-only (see its docstring) and
 *    keeps the `notInterested` flow out of `trace` entirely.
 * `pageScope` is the same classifier the drain gates on, so this token and the drain's
 * off-list decisions can never disagree.
 */
const pageToken = (pathname: string): string =>
  Option.match(pageScope(pathname), {
    onSome: (scope) => scope,
    onNone: () => (pathname === '/home' ? 'home' : 'other'),
  })

export interface ReleaseRecheckDeps {
  /** Timer port: schedule `fn` after `ms`, returning a cancel. Mirrors the Drain clock's `after` slice. */
  readonly clock: { readonly after: (ms: number, fn: () => void) => () => void }
  /**
   * Re-resolve the post NOW and classify it FOR THIS SCOPE. Implemented over
   * findArticle/isMember/alreadyCleared by the caller — the latter two are per-scope
   * (`isMember(article, scope)`), which is why `scope` is passed in: a
   * scope-blind probe would answer about whichever control the page happens to show
   * and the line's `state=` could then describe a different scope than its `scope=`.
   */
  readonly probe: (
    tweetId: string,
    scope: MembershipScope,
  ) => {
    readonly state: 'absent' | 'member' | 'cleared'
    readonly articles: number
    /** Raw `location.pathname`; classified to a bounded token before it is logged. */
    readonly path: string
  }
  readonly report: (stage: string, detail: string, tweetId?: string) => void
  /** Defaults to RELEASE_RECHECK_DELAY_MS when omitted. */
  readonly delayMs?: number | undefined
}

export function makeReleaseRecheck(deps: ReleaseRecheckDeps): {
  /**
   * Watch a confirmed release. `MembershipScope`, not `ClearScope`, on purpose:
   * `notInterested` has no membership control at all (see `clearer.ts`), so re-probing
   * it could only ever yield `absent` — a reappeared "Not interested" post would read
   * exactly like one that stuck. It also never reaches here: `tweet-clear` returns from
   * its `notInterested` branch BEFORE the flip poll that fires `onFlip`.
   */
  readonly arm: (tweetId: string, scope: MembershipScope) => void
  readonly cancelAll: () => void
} {
  const delay = deps.delayMs ?? RELEASE_RECHECK_DELAY_MS
  // One pending probe per (tweetId, scope) — the same post can be released from
  // bookmarks and likes independently, and each is its own question.
  const pending = new Map<string, () => void>()

  /** Read the post's CURRENT classification, never throwing: the watchdog is pure
   *  observability, so a faulting probe must degrade to a logged token and never take
   *  down the timer (or, worse, surface as an unhandled rejection on the X page). */
  function read(
    tweetId: string,
    scope: MembershipScope,
  ): { state: string; articles: number; page: string } {
    try {
      const { state, articles, path } = deps.probe(tweetId, scope)
      return { state, articles, page: pageToken(path) }
    } catch {
      return { state: PROBE_ERROR_STATE, articles: 0, page: UNKNOWN_PAGE }
    }
  }

  function arm(tweetId: string, scope: MembershipScope): void {
    const key = `${tweetId}:${scope}`
    // Already watching this exact question — keep the FIRST timer. Re-arming a pending
    // probe would either double-report the same release or (if it reset the timer) let a
    // stream of releases push the probe out past the evidence window. Re-arming AFTER the
    // probe fired is fine and lands below: the key is dropped before the report.
    if (pending.has(key)) return
    pending.set(
      key,
      deps.clock.after(delay, () => {
        pending.delete(key)
        const { state, articles, page } = read(tweetId, scope)
        // `state=member` is the definitive "the release did NOT stick" evidence — a
        // server revert or a fabricated flip, both indistinguishable from here and both
        // actionable. `state=cleared` is the happy path: X still shows the post with its
        // cleared control, so the mutation survived.
        //
        // `state=absent` is AMBIGUOUS and must NOT be read as failure: on a worklist page
        // a released row legitimately detaches, the virtualizer unmounts anything the user
        // scrolled away from, and a navigation can empty the timeline entirely. That is
        // exactly why `articles` (how many tweet articles were mounted at all — 0 means we
        // saw nothing, not that this post survived) and `page` (are we even still on the
        // list we released from? compare it against `scope=`) ride on the same line: they
        // are what lets a reader separate "row went away as expected" from "page was gone".
        //
        // `delay=` is the CONFIGURED wait, not a measured elapsed — there is no clock here
        // by design, and naming it `at=` would have implied an observation. Residual blind
        // spot a future reader must know about: Chrome throttles `setTimeout` in a
        // backgrounded tab, so a probe can fire far later than `delay` says, and that is a
        // live cause of the ambiguous `state=absent articles=0` reading. Discriminating it
        // needs a time source on the deps, which this seam deliberately does not take.
        deps.report(
          RECHECK_STAGE,
          `scope=${scope} delay=${delay}ms state=${state} articles=${articles} page=${page}`,
          tweetId,
        )
      }),
    )
  }

  /** Drop every pending probe. The caller fires this on navigation/teardown: a probe that
   *  wakes up on a DIFFERENT page would report `absent` about a timeline that no longer
   *  exists, manufacturing noise in the one log we intend to trust. */
  function cancelAll(): void {
    for (const cancel of pending.values()) cancel()
    pending.clear()
  }

  return { arm, cancelAll }
}
