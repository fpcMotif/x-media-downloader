import { Option } from 'effect'
import { adapterForUrl, allAdapterHostMatch } from '../core/adapters/registry'
import type { Message } from '@/packages/schema'
import type { ClearTweetResponse } from '@/packages/schema'
import type { TabMessagingPort } from '@/packages/download/media-url-refresh'
import type { Scope } from '@/packages/clear/ledger'
import type { ReleaseScopePin } from '@/packages/clear/seed'
import { pageScope, type MembershipScope } from '@/packages/clear/clearer'
import type { ClearScopeResult } from '@/packages/clear/result'
import { makeSerialQueue } from '@/packages/kernel/serial-queue'

/** The narrow tab-messaging surface every tab fan-out routes through. Owns no
 *  module state — `queryXTabs` is the single tabs.query the messaging paths share,
 *  keyed off the registry's `allAdapterHostMatch()` (every registered platform, not
 *  just X — see the widening note on `defaultTabsPort` below). The name is legacy
 *  (X was the only platform when it was written); which fan-outs actually run
 *  X-specific DOM logic is now decided by the receiving handler's platform gate,
 *  not by which tabs get queried here. */
export interface TabBroadcaster {
  /** The numeric ids of every open tab on a registered platform (not X-only —
   *  see the interface doc above). */
  readonly queryXTabs: () => Promise<number[]>
  /** The RefreshMediaUrl port the media-url refresh + retry-url resolution use. */
  readonly makeTabMessagingPort: () => TabMessagingPort
  /** Fire-and-forget a message to every open X tab; a dead tab is a silent no-op. */
  readonly broadcastToXTabs: (message: Message) => Promise<void>
  /** Announce a transfer's TERMINAL outcome to the overlays (sidecar `.json` skipped). */
  readonly reportTransferOutcome: (
    requestId: string,
    outcome: 'complete' | 'failed',
    at: number,
  ) => void
  /** Ask open X tabs to clear the tweet; stops at the first mounted tab. When no tab
   *  has the post mounted, ONE reused background tab navigates to the tweet's own
   *  permalink and clears it there. `preferTabId` (the tab the download came from)
   *  is tried FIRST, so a background list tab can't win the clear and un-bookmark a
   *  post the user only meant to drop from its feed. `allLists` rides into EVERY leg
   *  — the fan-out AND the permalink release — so the content script clears every list
   *  the post is in only when the "Clear from every list" setting is actually on. With
   *  it off, `release` (the scope PINNED when the ledger entry was seeded) is the only
   *  thing the permalink page may click — a status page owns no list scope of its own;
   *  see `releaseViaStatusTab`. */
  readonly sendClearToTabs: (
    tweetId: string,
    scopes: Scope[],
    preferTabId?: number,
    allLists?: boolean,
    release?: ReleaseScopePin,
  ) => Promise<ReadonlyArray<ClearScopeResult>>
  /** A tab's X list scope RIGHT NOW (`bookmark` on /i/history, `like` on /i/history/likes),
   *  `undefined` anywhere else — including off X, a closed tab, or an unparsable url.
   *  Called at SEED time (clear-session pins the answer onto the tweet's origin record)
   *  and NEVER by the release leg: between a download starting and settling, that tab
   *  can be on the OTHER list, and clicking that list's control on the permalink is
   *  exactly the irreversible cross-list loss the pin exists to prevent. */
  readonly resolveTabListScope: (tabId: number) => Promise<MembershipScope | undefined>
  /** Count of tabs currently proven-dead and skipped from the immediate fan-out (the
   *  orphan policy in `sendClearToTabs`) — a pure, synchronous read of session-scoped
   *  state. Mirrored into `MetricsSnapshot.staleTabs` so the popup can tell the user to
   *  refresh them. */
  readonly staleTabCount: () => number
}

/** The `browser.tabs` seam every X-tab fan-out routes through. Defaults to the live
 *  binding; a test injects a fake to drive the clear-targeting + fan-out logic (the
 *  fake-browser package implements neither tabs.query's url-pattern match nor
 *  tabs.sendMessage, so the seam — not a global stub — is how this is testable). */
export interface TabsPort {
  /** The numeric ids of every open tab on a registered platform (not X-only —
   *  `defaultTabsPort` below queries `allAdapterHostMatch()`). */
  queryXTabs(): Promise<number[]>
  /** Send a message to one tab; resolves to its response (or undefined). */
  sendTabMessage(tabId: number, message: unknown): Promise<unknown>
  /** One tab's current url, or `undefined` when the tab is gone / its url is out of
   *  reach. Read at SEED time to name the ORIGIN page's list scope, which is then
   *  PINNED for the life of that clear: the `/i/web/status/{id}` permalink owns no list
   *  scope, so the pin is the only thing that may authorize a click there. Never a
   *  failure: `undefined` is a legitimate answer that fails the release CLOSED. */
  getTabUrl(tabId: number): Promise<string | undefined>
  /** Navigate the ONE reusable release tab to a tweet permalink and resolve its
   *  tab id. Created INACTIVE on first use; re-created when the user closed it
   *  (a stale id rejects `tabs.update`, which is the re-create signal). Rejects
   *  when no tab can be navigated at all. */
  navigateReleaseTab(url: string): Promise<number>
  /** Reload the release tab in place — the leg's one recovery for a permalink that
   *  answered but never will (X's own error block, or a page that rendered nothing
   *  at all). Rejects when the tab is gone; the leg's next probe simply throws too,
   *  which the budget loop already treats as a dead tab. */
  reloadReleaseTab(tabId: number): Promise<void>
  /** The release tab's CURRENT id, or `undefined` before any leg has navigated one
   *  (or after the user closed it). A read-only mirror of `navigateReleaseTab`'s
   *  reuse state — so the fan-out can exclude it without the leg tracking two
   *  copies of the same id. */
  releaseTabId(): number | undefined
}

/** Optional collaborators the entrypoint wires in. Separate from `TabsPort` because
 *  this is not part of the `browser.tabs` seam — a test drives the fan-out with a fake
 *  TabsPort and no trace at all, and every existing construction site keeps compiling. */
export interface TabBroadcasterDeps {
  /** The Release-diagnostics sink. Stage names must keep the `clear-` prefix or the
   *  durable log drops them (`isReleaseDiagnosticsEvent`, packages/clear/diagnostics.ts).
   *  Omitted ⇒ a no-op: observation must never be load-bearing for a clear. */
  readonly trace?: ((stage: string, detail: string, tweetId?: string) => void) | undefined
  /** Injected sleep + wall clock for the release-tab readiness poll. Defaults to
   *  the real `setTimeout` / `Date.now`; tests hand an instant clock with a
   *  settable `now` so a never-mounting page doesn't cost the whole poll budget
   *  in wall time. */
  readonly clock?:
    | { readonly sleep: (ms: number) => Promise<void>; readonly now: () => number }
    | undefined
}

/** Fold a thrown `tabs.sendMessage` rejection into one grep-safe token. Mirrors the
 *  overlay's `compactReason` (handlers.ts) and scroll-drain's `compactDetailValue`;
 *  inlined rather than shared because both of those are module-private to files this
 *  module must not reach into. Urls collapse to `url` BEFORE the kebab pass, so a
 *  browser-authored message that happens to quote a media/page url can't leak a path
 *  into the durable log; the cap keeps one bad message from eating the event budget. */
const compactReason = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error)
  const compact = raw
    .replace(/https?:\/\/\S+|blob:\S+|www\.\S+/gi, 'url')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '')
  return compact || 'unknown'
}

const compactSequence = (values: ReadonlyArray<string | number>): string => {
  if (values.length === 0) return 'none'
  const visible = values.slice(0, 8).join(',')
  return values.length > 8 ? `${visible},more:${values.length - 8}` : visible
}

/** The neutral tweet permalink the release tab navigates to: resolves to the
 *  author's canonical status URL regardless of handle, and the content script
 *  stays injected through the redirect (same origin). */
const releaseUrl = (tweetId: string): string => `https://x.com/i/web/status/${tweetId}`

/** The X list a tab url belongs to (`bookmark` on /i/history, `like` on /i/history/likes),
 *  or `undefined` anywhere else — including an unparsable url, which `tabs.get` can
 *  hand back for a `chrome://` page or a tab caught mid-navigation. The background
 *  twin of the popup's `tabScope` (entrypoints/popup/context.ts): duplicated rather
 *  than shared because that module is a popup entrypoint the service worker must not
 *  import — the same reason `compactReason` above is inlined.
 *
 *  Platform-gated through the REGISTRY (ADR-0019 forbids ad-hoc X-specific url
 *  matchers), because `pageScope` reads the PATH alone: any host whose path ends
 *  `/likes` or contains `/bookmarks` would otherwise name a membership scope and
 *  authorize a click. The popup's twin gets this for free — `tabScope` is only ever
 *  reached after `tabContext` established the adapter. */
const listScopeOfUrl = (url: string): MembershipScope | undefined => {
  if (adapterForUrl(url)?.platform !== 'x') return undefined
  try {
    return Option.getOrUndefined(pageScope(new URL(url).pathname))
  } catch {
    return undefined
  }
}

/** The scope a pin authorizes, or `undefined` for `none` — the fail-CLOSED answer that
 *  sends no `asPageScope` at all, so the permalink page clicks nothing. */
const pinnedScope = (pin: ReleaseScopePin | undefined): MembershipScope | undefined =>
  pin === undefined || pin.source === 'none' ? undefined : pin.scope

// Readiness poll cadence for the release tab: the content script answers only
// once injected AND React has mounted the article; every earlier attempt either
// throws (no receiver) or returns mounted:false. The FIRST mounted answer
// performs the clear itself, so the poll never double-clicks. Budgeted on WALL
// CLOCK, not attempt count: a permalink that answers `articles=0` on every probe
// (X served an error block, or nothing ever rendered) used to burn the full fixed
// attempt count regardless — a page state the leg couldn't see. The evidence in
// `ClearTweetResponse.page` lets it recognise that state and give up early instead.
export const RELEASE_POLL_INTERVAL_MS = 600
export const RELEASE_POLL_BUDGET_MS = 12_000
// No probe has ever answered (every attempt threw — no receiver) for this long ⇒
// the tab is gone or never got a content script; stop paying for it.
export const RELEASE_UNREACHABLE_MS = 4_000
// Answered, but `articles=0 cells=0 ready=complete` continuously for this long ⇒
// the page rendered and settled on nothing — reload once, X's own recovery.
export const RELEASE_STUCK_MS = 4_000
// After a leg exits on X's own error block (reload already tried once and it's
// STILL there), later legs fail fast without navigating until this passes —
// a burst of queued releases can't hammer a page that's already proven broken.
export const RELEASE_BACKOFF_MS = 60_000

// Orphan policy for the IMMEDIATE fan-out (not the release leg): a tab that answers
// `no-receiver` on 2 consecutive dispatches almost certainly has no injected content
// script (closed page, pre-reload extension context) and is skipped thereafter rather
// than paying a `tabs.sendMessage` round-trip on every settled download. A skipped tab
// is still re-probed periodically — closed over whichever comes first, wall clock or
// dispatch count, so a tab that never gets ANOTHER dispatch (a quiet list tab) still
// gets a fresh chance eventually.
const ORPHAN_MISS_THRESHOLD = 2
export const ORPHAN_REPROBE_MS = 30_000
export const ORPHAN_REPROBE_DISPATCHES = 10

/** One tab's orphan bookkeeping, keyed by tab id in the broadcaster's closure —
 *  session-scoped, not per-dispatch. `skippedSince` set marks the tab as currently
 *  skipped; its absence means the tab is either healthy or mid miss-streak. */
interface OrphanRecord {
  misses: number
  skippedSince?: number
  skippedDispatches: number
}

type ReleasePollReason =
  | 'mounted'
  | 'exhausted'
  | 'unreachable'
  | 'nav-failed'
  | 'page-error'
  | 'backoff'

/** The page-state evidence an unmounted `ClearTweetResponse` carries (Part B). */
type ReleasePageEvidence = NonNullable<ClearTweetResponse['page']>

/** The one folded line every `releaseViaStatusTab` exit emits — replaces the old
 *  per-poll `clear-tweet-request` / `clear-tweet-not-mounted` pairs (silenced on
 *  the content-script side once `probe: true`, Part B) with a single summary of
 *  the WHOLE poll, so a burst of queued legs can't eat the durable log's cap. */
const formatReleasePoll = (
  tabId: number | undefined,
  probes: number,
  threw: number,
  unmounted: number,
  lastPage: ReleasePageEvidence | undefined,
  reloaded: boolean,
  elapsedMs: number,
  reason: ReleasePollReason,
): string =>
  `tab=${tabId ?? 'none'} probes=${probes} threw=${threw} unmounted=${unmounted} ` +
  `lastArticles=${lastPage?.articles ?? 'none'} lastCells=${lastPage?.cells ?? 'none'} ` +
  `lastReady=${lastPage?.ready ?? 'none'} lastError=${lastPage?.error ?? 'none'} ` +
  `reloaded=${reloaded} elapsedMs=${elapsedMs} reason=${reason}`

/** What a tab's `ClearTweetResponse` actually told us, for the folded dispatch line.
 * `mounted-failed` is retryable through another tab or the release tab; `no-receiver`
 * is an orphaned content script, `no-answer` is a live script that answered nothing,
 * `mounted-noop` deliberately clicked nothing, and `mounted-empty` attempted nothing. */
const answerToken = (res: ClearTweetResponse | undefined): string => {
  if (res === undefined) return 'no-answer'
  if (!res.mounted) return 'unmounted'
  if (res.results.some((result) => !result.ok)) return 'mounted-failed'
  return res.results.length === 0 ? 'mounted-empty' : 'mounted-noop'
}

const defaultTabsPort = (): TabsPort => {
  // The release tab's id lives HERE (inside the browser binding, not the
  // broadcaster shell) so reuse/re-create is part of the port policy and a test's
  // fake port never inherits a stale id. The tab is created INACTIVE, so releasing
  // a downloaded post never yanks the user's focus.
  let releaseTabId: number | undefined
  return {
    // Widened to every registered adapter's hostMatch (not X_HOST_MATCH alone): a
    // download that fails on an Instagram/Threads tab must still reach that tab's
    // TransferOutcome listener, or the badge set "saved" at hand-off never gets
    // corrected. The X-only *behavior* for clear-family messages lives in the
    // handlers.ts platform gate, not in which tabs get asked here.
    queryXTabs: async () => {
      const tabs = await browser.tabs.query({ url: [...allAdapterHostMatch()] })
      return tabs.flatMap((t) => (t.id !== undefined ? [t.id] : []))
    },
    sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
    // `tabs.get` REJECTS on a closed/unknown id, and `url` is undefined without a
    // matching host permission. Neither is an error here: a gone origin tab simply
    // means the origin page's list scope can no longer be named, and the caller
    // degrades to "no page scope", which fails closed (nothing gets clicked).
    // `host_permissions` already covers every registered platform origin, so the real
    // X/Instagram/Threads tabs this is ever asked about do expose `url`.
    getTabUrl: async (tabId) => {
      try {
        return (await browser.tabs.get(tabId)).url
      } catch {
        return undefined
      }
    },
    navigateReleaseTab: async (url) => {
      if (releaseTabId !== undefined) {
        try {
          const reused = await browser.tabs.update(releaseTabId, { url })
          if (reused?.id !== undefined) return reused.id
        } catch {
          releaseTabId = undefined // user closed it; fall through to create
        }
      }
      const created = await browser.tabs.create({ url, active: false })
      if (created.id === undefined) throw new Error('tabs.create returned a tab without an id')
      releaseTabId = created.id
      return created.id
    },
    reloadReleaseTab: (tabId) => browser.tabs.reload(tabId),
    releaseTabId: () => releaseTabId,
  }
}

export const makeTabBroadcaster = (
  tabs: TabsPort = defaultTabsPort(),
  deps: TabBroadcasterDeps = {},
): TabBroadcaster => {
  const trace = deps.trace ?? ((): void => {})
  const queryXTabs = (): Promise<number[]> => tabs.queryXTabs()

  const makeTabMessagingPort = (): TabMessagingPort => ({
    queryTabs: async () => (await queryXTabs()).map((id) => ({ id })),
    sendTabMessage: (tabId, message) =>
      tabs.sendTabMessage(tabId, message) as Promise<{ readonly url?: string } | undefined>,
  })

  /** Broadcast a fire-and-forget message to every open X tab. A dead tab (no
   *  injected content script / stale context) is a silent no-op — the same
   *  treatment `refreshMediaUrlFromTabs` gives a missing receiver: not a failure. */
  const broadcastToXTabs = async (message: Message): Promise<void> => {
    const ids = await queryXTabs()
    await Promise.all(ids.map((id) => tabs.sendTabMessage(id, message).catch(() => {})))
  }

  /** The single seam every terminal transfer site routes through: announce a
   *  transfer's TERMINAL outcome to the overlays, so a badge marked saved at
   *  hand-off is corrected by the real result (bytes landed / 403 / timeout).
   *  Sidecar `.json` requests are not user media and carry no badge. */
  const reportTransferOutcome = (
    requestId: string,
    outcome: 'complete' | 'failed',
    at: number,
  ): void => {
    if (requestId.endsWith('.json')) return
    // `.catch` so a tabs.query failure during SW teardown is a silent no-op (the
    // same degraded outcome as no tab receiving it), never an unhandled rejection.
    void broadcastToXTabs({ _tag: 'TransferOutcome', requestId, outcome, at }).catch(() => {})
  }

  // ── Release tab (the not-mounted path) ──
  //
  // When no open tab has the settled tweet mounted, ONE reused background tab
  // navigates to the tweet's own permalink and clears it there. A status page
  // always mounts its tweet's article with the bookmark/like controls — no list
  // virtualization — so the scrolled-away posts the Scroll Drain could never reach
  // (a 500-deep backlog ending in `empty-pass-exhausted`) become a direct hit,
  // one settled download at a time.

  const clock = deps.clock ?? {
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  }

  type ReleaseTabOutcome =
    | {
        readonly ok: true
        readonly tabId: number
        readonly results: ReadonlyArray<ClearScopeResult>
      }
    | { readonly ok: false; readonly tabId: number | undefined }

  // One release at a time: several downloads can settle back-to-back, and two
  // concurrent navigations of the shared tab would race — the loser's clear would
  // run against the winner's page and rely on the id-match guard to bail. The
  // serial queue makes the "download one, release one" ordering literal.
  const releaseQueue = makeSerialQueue()

  // The breaker (module-scoped, not per-leg): once a leg proves the current
  // permalink is X's own error block even after a reload, EVERY later leg fails
  // fast — no navigation, no poll — until this passes. Without it a burst of
  // queued releases (one per settled download) hammers a page already proven
  // broken, each paying the full budget for the same answer. A `mounted` exit
  // clears it immediately: the page recovered, so the next leg deserves a real try.
  let backoffUntil = 0

  // The orphan table (module-scoped, not per-dispatch): a tab that keeps proving
  // itself dead is skipped from the immediate fan-out rather than probed on every
  // settled download — see the ORPHAN_* constants above.
  const orphanRecords = new Map<number, OrphanRecord>()

  /** Any non-throw `sendTabMessage` answer proves the tab alive — clears whatever
   *  miss streak or skip state it was carrying. */
  const clearOrphanRecord = (id: number): void => {
    orphanRecords.delete(id)
  }

  /** A thrown `sendTabMessage` — record the miss. A tab already in skip state that
   *  was probed again (it was due for a re-probe) and is STILL dead just restarts its
   *  skip window; a healthy tab's streak escalates into skip state at the threshold. */
  const recordOrphanMiss = (id: number): void => {
    const record = orphanRecords.get(id)
    if (record === undefined) {
      orphanRecords.set(id, { misses: 1, skippedDispatches: 0 })
      return
    }
    if (record.skippedSince !== undefined) {
      record.skippedSince = clock.now()
      record.skippedDispatches = 0
      return
    }
    record.misses++
    if (record.misses >= ORPHAN_MISS_THRESHOLD) {
      record.skippedSince = clock.now()
      record.skippedDispatches = 0
    }
  }

  const staleTabCount = (): number => {
    let count = 0
    for (const record of orphanRecords.values()) {
      if (record.skippedSince !== undefined) count++
    }
    return count
  }

  /** Seed-time only (see the interface doc): the origin tab's list scope, read the
   *  moment a download starts so the clear that eventually settles is judged against
   *  the page the user actually consented on, not against wherever that tab drifted. */
  const resolveTabListScope = async (tabId: number): Promise<MembershipScope | undefined> => {
    const url = await tabs.getTabUrl(tabId)
    return url === undefined ? undefined : listScopeOfUrl(url)
  }

  const releaseViaStatusTab = async (
    tweetId: string,
    scopes: Scope[],
    allLists: boolean | undefined,
    asPageScope: MembershipScope | undefined,
  ): Promise<ReleaseTabOutcome> => {
    // 1. Breaker — fail fast, no navigation, while an earlier leg's error-block
    // verdict is still in force.
    if (clock.now() < backoffUntil) {
      trace(
        'clear-release-poll',
        formatReleasePoll(undefined, 0, 0, 0, undefined, false, 0, 'backoff'),
        tweetId,
      )
      return { ok: false, tabId: undefined }
    }

    // 2. Navigate.
    let tabId: number
    try {
      tabId = await tabs.navigateReleaseTab(releaseUrl(tweetId))
    } catch (error) {
      trace('clear-tab-error', `phase=release-nav reason=${compactReason(error)}`, tweetId)
      trace(
        'clear-release-poll',
        formatReleasePoll(undefined, 0, 0, 0, undefined, false, 0, 'nav-failed'),
        tweetId,
      )
      return { ok: false, tabId: undefined }
    }

    // 3. Poll on a WALL-CLOCK budget, not a fixed attempt count.
    const start = clock.now()
    let probes = 0
    let threw = 0
    let unmounted = 0
    let lastPage: ReleasePageEvidence | undefined
    let reloaded = false
    // The first probe after `tabs.update` can still be answered by the OLD
    // document before the navigation commits, so a lone error answer proves
    // nothing about the NEW page — only two CONSECUTIVE error answers act.
    let errorStreak = 0
    let stuckSince: number | undefined
    let elapsed = 0
    // oxlint-disable no-await-in-loop -- bounded readiness poll; the first mounted answer performs the clear
    while (elapsed < RELEASE_POLL_BUDGET_MS) {
      await clock.sleep(RELEASE_POLL_INTERVAL_MS)
      elapsed = clock.now() - start
      probes++
      let res: ClearTweetResponse | undefined
      try {
        // `allLists` rides through UNCHANGED. It used to be hard-coded `true`, which
        // silently promoted EVERY page-scoped release into a clear-from-every-list one:
        // `clearAllListsOnSave` ships false and the options UI calls it "the most
        // aggressive option", yet a status page's `clearableScope` is null, so
        // membership gating clicked BOTH un-like and un-bookmark on any post in both
        // lists — irreversibly, without consent.
        // With it ON, membership gating is still exactly right here and `asPageScope` is
        // deliberately OMITTED: supplying one would make `shouldClickScope` short-circuit
        // `scope === onScope` and fire a scope the article may not even be a member of.
        // With it OFF, `asPageScope` is the SEED-TIME pin — the list the user consented
        // to empty — so this permalink clears that one list and nothing else.
        // `probe: true` from the 2nd attempt: the first bare attempt still proves the
        // tab reached the tweet at all, so the trace shows that once; every later
        // attempt is expected noise the content script silences on its own side.
        res = (await tabs.sendTabMessage(tabId, {
          _tag: 'ClearTweetRequest',
          tweetId,
          scopes,
          allLists,
          ...(asPageScope === undefined ? {} : { asPageScope }),
          ...(probes >= 2 ? { probe: true } : {}),
        })) as ClearTweetResponse | undefined
      } catch {
        threw++
        if (threw === probes && elapsed >= RELEASE_UNREACHABLE_MS) {
          trace(
            'clear-release-poll',
            formatReleasePoll(
              tabId,
              probes,
              threw,
              unmounted,
              lastPage,
              reloaded,
              elapsed,
              'unreachable',
            ),
            tweetId,
          )
          return { ok: false, tabId }
        }
        continue
      }
      if (res?.mounted === true) {
        backoffUntil = 0 // the page recovered — clear the breaker for the next leg
        trace(
          'clear-release-poll',
          formatReleasePoll(
            tabId,
            probes,
            threw,
            unmounted,
            lastPage,
            reloaded,
            elapsed,
            'mounted',
          ),
          tweetId,
        )
        return { ok: true, tabId, results: res.results }
      }
      unmounted++
      lastPage = res?.page ?? lastPage
      const erroring = res?.page?.error === true
      errorStreak = erroring ? errorStreak + 1 : 0
      if (erroring) {
        if (errorStreak >= 2) {
          if (!reloaded) {
            try {
              await tabs.reloadReleaseTab(tabId)
            } catch {
              /* tab gone — the next probe throws and the loop degrades to unreachable/exhausted */
            }
            reloaded = true
            errorStreak = 0
            stuckSince = undefined
            continue
          }
          backoffUntil = clock.now() + RELEASE_BACKOFF_MS
          trace(
            'clear-release-poll',
            formatReleasePoll(
              tabId,
              probes,
              threw,
              unmounted,
              lastPage,
              reloaded,
              elapsed,
              'page-error',
            ),
            tweetId,
          )
          return { ok: false, tabId }
        }
        continue
      }
      const stuck =
        lastPage !== undefined &&
        lastPage.articles === 0 &&
        lastPage.cells === 0 &&
        lastPage.ready === 'complete'
      if (!stuck) {
        stuckSince = undefined
      } else {
        stuckSince ??= clock.now()
        if (!reloaded && clock.now() - stuckSince >= RELEASE_STUCK_MS) {
          try {
            await tabs.reloadReleaseTab(tabId)
          } catch {
            /* tab gone — the next probe throws and the loop degrades to unreachable/exhausted */
          }
          reloaded = true
          stuckSince = undefined
        }
      }
    }
    // oxlint-enable no-await-in-loop

    // 4. Budget end.
    const reason: ReleasePollReason = unmounted > 0 ? 'exhausted' : 'unreachable'
    trace(
      'clear-release-poll',
      formatReleasePoll(tabId, probes, threw, unmounted, lastPage, reloaded, elapsed, reason),
      tweetId,
    )
    return { ok: false, tabId }
  }

  /** Try immediate Clear in every tab. When no tab has the post mounted, the
   *  release tab navigates to the tweet's permalink and clears it there.
   *
   *  Observability contract: this function NEVER throws, so the caller's
   *  `clear-dispatch-failed` trace (clear-session.ts) is unreachable from here and the
   *  fabricated `ok:false` tail below is indistinguishable downstream from a real
   *  verified failure. Every exit path therefore emits exactly ONE folded
   *  `clear-dispatch` line — one per DISPATCH, not per tab, so the durable Release log's
   *  capped window (`RELEASE_DIAGNOSTICS_CAP`) doesn't scale with the open-tab count — carrying whether
   *  the results were observed or synthesized (`fabricated`). */
  const sendClearToTabs = async (
    tweetId: string,
    scopes: Scope[],
    preferTabId?: number,
    allLists?: boolean,
    release?: ReleaseScopePin,
  ): Promise<ReadonlyArray<ClearScopeResult>> => {
    const ids = await queryXTabs()
    // A tab id the platform no longer reports is a closed tab — forget its orphan
    // record rather than pin it forever.
    const openIds = new Set(ids)
    for (const id of orphanRecords.keys()) {
      if (!openIds.has(id)) orphanRecords.delete(id)
    }
    // The release tab is covered by the leg below, which targets it directly — probing
    // it again here would just be a second message to the same tab this dispatch.
    const excludedReleaseTabId = tabs.releaseTabId()
    const candidates = ids.filter((id) => id !== excludedReleaseTabId)
    // A tab currently in skip state (see ORPHAN_MISS_THRESHOLD) is left unprobed unless
    // it's due for a re-probe; either way it counts once toward `skipped=` below.
    const probeIds: number[] = []
    let skippedCount = 0
    for (const id of candidates) {
      // The origin tab is exempt from the skip filter: `preferTabId` is the whole
      // reason the origin-first short-circuit exists, and a transient orphan miss
      // must not cost it that guarantee — probed every dispatch, skip state or
      // not, and its record still updates from THIS probe like any other tab's.
      if (id === preferTabId) {
        probeIds.push(id)
        continue
      }
      const record = orphanRecords.get(id)
      const due =
        record?.skippedSince !== undefined &&
        (clock.now() - record.skippedSince >= ORPHAN_REPROBE_MS ||
          record.skippedDispatches >= ORPHAN_REPROBE_DISPATCHES)
      if (record?.skippedSince !== undefined && !due) {
        record.skippedDispatches++
        skippedCount++
      } else {
        probeIds.push(id)
      }
    }
    // Try the originating tab FIRST (where the user downloaded): if the post is still
    // mounted there it answers and short-circuits, so a background Bookmarks/Likes tab
    // can't win and un-bookmark a post meant only for its own feed's clear. Falls back
    // to the rest (broadcast) when the origin tab scrolled the post away or is gone.
    // Named (not inlined into `ordered`) so the trace can report whether the preference
    // was actually HONORED: a stale `preferTabId` silently degrades to broadcast order,
    // which is one of the four worlds that arrive downstream as the same failure.
    const honoredPrefer =
      preferTabId !== undefined && probeIds.includes(preferTabId) ? preferTabId : undefined
    const ordered =
      honoredPrefer !== undefined
        ? [honoredPrefer, ...probeIds.filter((id) => id !== honoredPrefer)]
        : probeIds
    // Per-tab verdicts, folded into the single dispatch line. `tried` keeps the ATTEMPT
    // ORDER (so a dishonored preference is visible even when nothing answered).
    const tried: number[] = []
    const answered: string[] = []
    let sawDiscardedMounted = false
    const clearErrors = new Map<string, number>()
    // `releaseTabId` is the tab the release leg actually USED, passed per exit path
    // rather than read off shared state: the leg is serialized behind a queue, so a later
    // dispatch's navigation must never be credited to this dispatch's line.
    const traceDispatch = (outcome: string, fabricated: boolean, releaseTabId?: number): void => {
      const errorSummary = [...clearErrors].map(([reason, count]) => `${reason}:${count}`).join(',')
      trace(
        'clear-dispatch',
        `tabs=${ids.length} prefer=${preferTabId ?? 'none'} preferHonored=${honoredPrefer !== undefined} ` +
          `tried=${compactSequence(tried)} answered=${compactSequence(answered)} ` +
          `release=${releaseTabId ?? 'none'} outcome=${outcome} fabricated=${fabricated} ` +
          `excluded=${excludedReleaseTabId ?? 'none'} skipped=${skippedCount} stale=${staleTabCount()}` +
          (errorSummary ? ` clearErrors=${errorSummary}` : ''),
        tweetId,
      )
    }
    // oxlint-disable no-await-in-loop -- ordered ownership protocol
    for (const id of ordered) {
      tried.push(id)
      try {
        const res = (await tabs.sendTabMessage(id, {
          _tag: 'ClearTweetRequest',
          tweetId,
          scopes,
          allLists,
        })) as ClearTweetResponse | undefined
        clearOrphanRecord(id)
        const attempted = res?.results.some((result) => !result.noop) === true
        const allSucceeded = res?.results.every((result) => result.ok) === true
        if (res?.mounted && attempted && allSucceeded) {
          answered.push(`${id}:mounted`)
          traceDispatch('mounted', false)
          return res.results
        }
        answered.push(`${id}:${answerToken(res)}`)
        if (res?.mounted === true) sawDiscardedMounted = true
      } catch (error) {
        answered.push(`${id}:no-receiver`)
        recordOrphanMiss(id)
        const reason = compactReason(error)
        clearErrors.set(reason, (clearErrors.get(reason) ?? 0) + 1)
      }
    }
    // oxlint-enable no-await-in-loop
    // The not-mounted path: the permalink release tab. Membership scopes only — a
    // notInterested claim can act solely on the For You feed the dispatch just
    // tried, so navigating a status page for it could only fabricate a verdict.
    const membership = scopes.filter((scope) => scope !== 'notInterested')
    if (membership.length > 0) {
      // Page-scoped mode (`allLists` off — the SHIPPED DEFAULT) uses the PIN the ledger
      // entry was seeded with. It is never re-derived from the origin tab here: that tab
      // may have moved to the other list while the download ran, and a permalink clear
      // aimed at a list the user never pressed Release for is irreversible.
      const asPageScope = allLists === true ? undefined : pinnedScope(release)
      if (allLists !== true) {
        // Can this leg click ANYTHING? A permalink page's own `clearableScope` is null, so
        // with all-lists off the pin is the only thing `shouldClickScope` can match — and
        // it must be one of the CLAIMED scopes, or every scope no-ops. Without this check
        // a guaranteed-no-op leg still costs a background navigation plus the full
        // readiness poll (up to RELEASE_POLL_BUDGET_MS), serialized ahead of every
        // release behind it.
        const clickable = asPageScope !== undefined && membership.includes(asPageScope)
        trace(
          'clear-release-scope',
          `origin=${preferTabId ?? 'none'} asPageScope=${asPageScope ?? 'none'} ` +
            `source=${release?.source ?? 'none'} clickable=${clickable}`,
          tweetId,
        )
        if (!clickable) {
          traceDispatch('release-skipped', true)
          return scopes.map((scope) => ({ scope, ok: false }))
        }
      }
      const released = await releaseQueue.run(() =>
        releaseViaStatusTab(tweetId, scopes, allLists, asPageScope),
      )
      if (released.ok) {
        traceDispatch('release-tab', false, released.tabId)
        return released.results
      }
      traceDispatch('release-failed', true, released.tabId)
      return scopes.map((scope) => ({ scope, ok: false }))
    }
    // The fabricated tail, reachable only by a notInterested-only claim. `outcome`
    // says WHICH world produced it: a tab really had the post but every scope was a
    // no-op/nothing was attempted (`noop-only`), or nothing usable answered at all —
    // zero tabs, all orphaned, all unmounted (`exhausted`).
    const outcome = sawDiscardedMounted ? 'noop-only' : 'exhausted'
    traceDispatch(outcome, true)
    return scopes.map((scope) => ({ scope, ok: false }))
  }

  return {
    queryXTabs,
    makeTabMessagingPort,
    broadcastToXTabs,
    reportTransferOutcome,
    sendClearToTabs,
    resolveTabListScope,
    staleTabCount,
  }
}
