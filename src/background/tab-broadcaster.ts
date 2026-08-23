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
  /** A tab's X list scope RIGHT NOW (`bookmark` on /i/bookmarks, `like` on /…/likes),
   *  `undefined` anywhere else — including off X, a closed tab, or an unparsable url.
   *  Called at SEED time (clear-session pins the answer onto the tweet's origin record)
   *  and NEVER by the release leg: between a download starting and settling, that tab
   *  can be on the OTHER list, and clicking that list's control on the permalink is
   *  exactly the irreversible cross-list loss the pin exists to prevent. */
  readonly resolveTabListScope: (tabId: number) => Promise<MembershipScope | undefined>
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
}

/** Optional collaborators the entrypoint wires in. Separate from `TabsPort` because
 *  this is not part of the `browser.tabs` seam — a test drives the fan-out with a fake
 *  TabsPort and no trace at all, and every existing construction site keeps compiling. */
export interface TabBroadcasterDeps {
  /** The Release-diagnostics sink. Stage names must keep the `clear-` prefix or the
   *  durable log drops them (`isReleaseDiagnosticsEvent`, packages/clear/diagnostics.ts).
   *  Omitted ⇒ a no-op: observation must never be load-bearing for a clear. */
  readonly trace?: ((stage: string, detail: string, tweetId?: string) => void) | undefined
  /** Injected sleep for the release-tab readiness poll. Defaults to the real
   *  `setTimeout`; tests hand an instant clock so a never-mounting page doesn't
   *  cost the whole poll budget in wall time. */
  readonly clock?: { readonly sleep: (ms: number) => Promise<void> } | undefined
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

/** The X list a tab url belongs to (`bookmark` on /i/bookmarks, `like` on /…/likes),
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
// performs the clear itself, so the poll never double-clicks. ~10s worst case.
const RELEASE_POLL_INTERVAL_MS = 600
const RELEASE_POLL_ATTEMPTS = 30

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
    let tabId: number
    try {
      tabId = await tabs.navigateReleaseTab(releaseUrl(tweetId))
    } catch (error) {
      trace('clear-tab-error', `phase=release-nav reason=${compactReason(error)}`, tweetId)
      return { ok: false, tabId: undefined }
    }
    // oxlint-disable no-await-in-loop -- bounded readiness poll; the first mounted answer performs the clear
    for (let attempt = 1; attempt <= RELEASE_POLL_ATTEMPTS; attempt++) {
      await clock.sleep(RELEASE_POLL_INTERVAL_MS)
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
        const res = (await tabs.sendTabMessage(tabId, {
          _tag: 'ClearTweetRequest',
          tweetId,
          scopes,
          allLists,
          ...(asPageScope === undefined ? {} : { asPageScope }),
        })) as ClearTweetResponse | undefined
        if (res?.mounted === true) return { ok: true, tabId, results: res.results }
      } catch {
        /* content script not injected yet — keep polling */
      }
    }
    // oxlint-enable no-await-in-loop
    trace(
      'clear-tab-error',
      `tab=${tabId} phase=release-poll reason=exhausted attempts=${RELEASE_POLL_ATTEMPTS}`,
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
    // Try the originating tab FIRST (where the user downloaded): if the post is still
    // mounted there it answers and short-circuits, so a background Bookmarks/Likes tab
    // can't win and un-bookmark a post meant only for its own feed's clear. Falls back
    // to the rest (broadcast) when the origin tab scrolled the post away or is gone.
    // Named (not inlined into `ordered`) so the trace can report whether the preference
    // was actually HONORED: a stale `preferTabId` silently degrades to broadcast order,
    // which is one of the four worlds that arrive downstream as the same failure.
    const honoredPrefer =
      preferTabId !== undefined && ids.includes(preferTabId) ? preferTabId : undefined
    const ordered =
      honoredPrefer !== undefined
        ? [honoredPrefer, ...ids.filter((id) => id !== honoredPrefer)]
        : ids
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
          `release=${releaseTabId ?? 'none'} outcome=${outcome} fabricated=${fabricated}` +
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
        // readiness poll (~9.6s), serialized ahead of every release behind it.
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
  }
}
