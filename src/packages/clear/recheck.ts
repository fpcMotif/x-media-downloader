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
 * re-probe REPEATEDLY across a bounded watch window, well after X's mutation response has
 * had time to land, and put the verdict in the durable Release log (`clear-` prefix — see
 * diagnostics.ts). A single fixed-delay probe (the original v1 of this module) missed a
 * remount past its one check; polling — same ATTEMPTS × INTERVAL shape as `tweet-clear.ts`'s
 * flip poll — catches one that surfaces anywhere across the window, not just at one instant.
 *
 * Membership scopes ONLY (bookmark/like). `notInterested` is out of scope here for the
 * same reason `clearer.ts` types the flip helpers to exclude it — it has no membership
 * control, so "is it back?" is not a question this probe can answer.
 *
 * Pure: the timer, the DOM re-resolve, the fresh-timeline lookup, and the trace sink all
 * arrive as injected ports (matching scroll-drain / tweet-clear), so the dedupe + cancel +
 * re-arm behaviour is testable with a fake clock and no DOM at all. The dependency runs ONE
 * way — `tweet-clear` calls into this module through its flip/report seam; nothing here
 * imports `tweet-clear` (depcruise enforces no-circular globally).
 */
import { Option } from 'effect'
import { pageScope, type ClearOrigin, type MembershipScope } from './clearer'

/**
 * The poll shape — same ATTEMPTS × INTERVAL vocabulary as `tweet-clear.ts`'s
 * `FLIP_POLL_ATTEMPTS`/`FLIP_POLL_INTERVAL_MS`: `elapsedMs` on every line below is
 * `attempt * intervalMs`, a DERIVED count, not a measured wall-clock delta (this
 * codebase's established convention — see that module's own docstring on the same
 * choice). The first probe fires at ONE interval, comfortably past the flip poll's
 * whole window (6 × 200ms = 1.2s) AND past a slow `DeleteBookmark` round-trip; a
 * probe that fired immediately would read the optimistic state we already know
 * about and prove nothing. Six probes at 5s apart (30s total) mirrors the flip
 * poll's own six-attempt budget.
 */
export const RELEASE_RECHECK_INTERVAL_MS = 5000
export const RELEASE_RECHECK_ATTEMPTS = 6

/** The stage every ordinary watchdog line carries. The overlay's `reportClear`
 *  stamps `source:'clear'`, which alone admits the event to the durable Release log
 *  (diagnostics.ts's `isReleaseDiagnosticsEvent`); the `clear-` prefix keeps the line
 *  admissible even if it is ever re-emitted from the background, whose `source` is
 *  shared with unrelated trace lines. */
const RECHECK_STAGE = 'clear-recheck'

/** The DISTINCT, loud stage for the one state that matters most: the release did
 *  NOT stick. Separated from the ordinary per-attempt `clear-recheck` line (which
 *  fires on every probe, including the ones that see nothing wrong) the same way
 *  `tweet-clear.ts`'s `clear-flip-fabricated` is separated from `clear-flip` — a
 *  diagnostician can grep this one stage instead of parsing `state=` out of every
 *  attempt. */
const REAPPEARED_STAGE = 'clear-reappeared'

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

/** Is the tweetId present in the freshest captured Bookmarks/Likes timeline
 *  response for this scope? 'unknown' when no fresh capture exists yet (the tee
 *  never saw one, or none since the last SPA navigation) — the ghost-vs-real
 *  discriminator MUST distinguish "we checked and it's not there" from "we never
 *  got to check", so `unknown` is a real third answer, never folded into `absent`. */
export type FreshTimelineMembership = 'present' | 'absent' | 'unknown'

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
  /** Ghost-vs-real discriminator, consulted ONLY on a `state=member` verdict (the
   *  re-appearance line): does the tweet appear in the freshest captured
   *  Bookmarks/Likes response for this scope? `present` ⇒ the server really still
   *  has it (H1 territory — a genuine revert or double-add); `absent` while the row
   *  renders ⇒ a client-cache ghost (H4); `unknown` ⇒ no fresh capture to check
   *  against. Pure lookup — never issues a request. */
  readonly freshTimelineHasMember: (
    tweetId: string,
    scope: MembershipScope,
  ) => FreshTimelineMembership
  readonly report: (stage: string, detail: string, tweetId?: string) => void
  /** Defaults to RELEASE_RECHECK_INTERVAL_MS when omitted. */
  readonly intervalMs?: number | undefined
  /** Defaults to RELEASE_RECHECK_ATTEMPTS when omitted. */
  readonly attempts?: number | undefined
}

export function makeReleaseRecheck(deps: ReleaseRecheckDeps) {
  const interval = deps.intervalMs ?? RELEASE_RECHECK_INTERVAL_MS
  const attempts = deps.attempts ?? RELEASE_RECHECK_ATTEMPTS
  // One pending probe chain per (tweetId, scope) — the same post can be released from
  // bookmarks and likes independently, and each is its own question.
  const pending = new Map<string, () => void>()

  /** Read the post's CURRENT classification, never throwing: the watchdog is pure
   *  observability, so a faulting probe must degrade to a logged token and never take
   *  down the timer (or, worse, surface as an unhandled rejection on the X page). */
  function read(tweetId: string, scope: MembershipScope) {
    try {
      const { state, articles, path } = deps.probe(tweetId, scope)
      return { state, articles, page: pageToken(path) }
    } catch {
      return { state: PROBE_ERROR_STATE, articles: 0, page: UNKNOWN_PAGE }
    }
  }

  function schedule(
    key: string,
    tweetId: string,
    scope: MembershipScope,
    origin: ClearOrigin,
    attempt: number,
  ): void {
    pending.set(
      key,
      deps.clock.after(interval, () => {
        const elapsedMs = attempt * interval
        const { state, articles, page } = read(tweetId, scope)
        const head = `scope=${scope} origin=${origin} attempt=${attempt} elapsedMs=${elapsedMs}`
        // `state=member` is the definitive "the release did NOT stick" evidence — a
        // server revert or a fabricated flip, both indistinguishable from here and both
        // actionable. Report it on the ordinary line (unchanged reading for existing
        // exports) AND on the distinct loud stage below, then stop — the question this
        // watchdog asks is answered.
        //
        // `state=absent` is AMBIGUOUS and must NOT be read as failure: on a worklist page
        // a released row legitimately detaches, the virtualizer unmounts anything the user
        // scrolled away from, and a navigation can empty the timeline entirely. That is
        // exactly why `articles` (how many tweet articles were mounted at all — 0 means we
        // saw nothing, not that this post survived) and `page` (are we even still on the
        // list we released from? compare it against `scope=`) ride on the same line: they
        // are what lets a reader separate "row went away as expected" from "page was gone".
        deps.report(
          RECHECK_STAGE,
          `${head} state=${state} articles=${articles} page=${page}`,
          tweetId,
        )
        if (state === 'member') {
          pending.delete(key)
          const freshTimeline = deps.freshTimelineHasMember(tweetId, scope)
          deps.report(
            REAPPEARED_STAGE,
            `${head} articles=${articles} page=${page} freshTimeline=${freshTimeline}`,
            tweetId,
          )
          return
        }
        // Window exhausted with nothing definitive ⇒ disarm SILENTLY: the per-attempt
        // `clear-recheck` lines already on the log ARE the record of what happened
        // across the window — no extra "gave up" line on top of them.
        if (attempt >= attempts) {
          pending.delete(key)
          return
        }
        schedule(key, tweetId, scope, origin, attempt + 1)
      }),
    )
  }

  function arm(tweetId: string, scope: MembershipScope, origin: ClearOrigin): void {
    const key = `${tweetId}:${scope}`
    // Already watching this exact question — keep the FIRST chain. Re-arming a pending
    // watch would either double-report the same release or (if it reset the chain) let a
    // stream of releases push the last probe out past the evidence window. Re-arming AFTER
    // the chain finished (member found, or window exhausted) is fine and lands below: the
    // key is dropped before either terminal returns.
    if (pending.has(key)) return
    schedule(key, tweetId, scope, origin, 1)
  }

  /** Drop every pending probe. The caller fires this on navigation/teardown: a probe that
   *  wakes up on a DIFFERENT page would report `absent` about a timeline that no longer
   *  exists, manufacturing noise in the one log we intend to trust. */
  function cancelAll(): void {
    for (const cancel of pending.values()) cancel()
    pending.clear()
  }

  /**
   * Watch a confirmed release. `MembershipScope`, not `ClearScope`, on purpose:
   * `notInterested` has no membership control at all (see `clearer.ts`), so re-probing
   * it could only ever yield `absent` — a reappeared "Not interested" post would read
   * exactly like one that stuck. It also never reaches here: `tweet-clear` returns from
   * its `notInterested` branch BEFORE the flip poll that fires `onFlip`.
   */
  return { arm, cancelAll }
}
