/**
 * Release-bench fixtures — deterministic offline replicas of the X surfaces the
 * Release flow touches, wired to the REAL clear modules (`packages/clear/*`,
 * `background/tab-broadcaster`). Selectors verified against the live x.com
 * `/i/history` DOM over CDP (2026-08-23); permalink error shell carries X's own
 * `[data-testid="error-detail"]` marker so the leg's page-evidence path is real.
 *
 * Ground truth lives OUTSIDE the DOM (`FakeXWorld.truth`): only a fired optimistic
 * control flip marks a scope truly cleared — a recycled/detached node never does.
 * That separation is what makes the detach-as-proof confirm rule measurable.
 *
 * No network, no wall clock: all timing runs on `VirtualClock`; scenarios replay
 * byte-identically. happy-dom objects are duck-typed into the lib-DOM signatures
 * the src modules declare (`asDom`) — the same seam vitest's happy-dom environment
 * provides implicitly.
 */
import { Option } from 'effect'
import { Window } from 'happy-dom'
import {
  clearableScope,
  findArticle,
  isMember,
  shouldClickScope,
  type MembershipScope,
} from '@/packages/clear/clearer'
import { makeTweetClearer } from '@/packages/clear/tweet-clear'
import { makeTabBroadcaster, type TabsPort } from '@/background/tab-broadcaster'
import type { ClearScope, ClearTweetRequest, ClearTweetResponse } from '@/packages/schema'

/** happy-dom → lib-DOM boundary (runtime-compatible, compile-time distinct). */
const asDom = <T>(value: unknown): T => value as T

// ── Virtual time ─────────────────────────────────────────────────────────────

/** Deterministic clock matching the broadcaster's `{ sleep, now }` seam, plus an
 * `at()` scheduler fixtures use to fire DOM events between polls. */
export class VirtualClock {
  nowMs = 0
  private q: { at: number; seq: number; fn: () => void }[] = []
  private seq = 0

  now(): number {
    return this.nowMs
  }

  get pending(): boolean {
    return this.q.length > 0
  }

  sleep(ms: number): Promise<void> {
    return new Promise<void>((res) => this.push(this.nowMs + ms, res))
  }

  at(delayMs: number, fn: () => void): void {
    this.push(this.nowMs + delayMs, fn)
  }

  private push(at: number, fn: () => void): void {
    this.q.push({ at, seq: this.seq++, fn })
  }

  pop(): { at: number; fn: () => void } | undefined {
    if (this.q.length === 0) return undefined
    this.q.sort((a, b) => a.at - b.at || a.seq - b.seq)
    const job = this.q.shift()
    if (!job) return undefined
    this.nowMs = Math.max(this.nowMs, job.at)
    return job
  }
}

const tick = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

/** Drive `run` against the clock. Between jobs, macrotask boundaries let resolved
 * non-clock promises (the fake ports) run their continuations before the next pop;
 * only a pending scenario with an idle queue after a full flush is a deadlock. */
export async function drive<T>(clock: VirtualClock, run: () => Promise<T>): Promise<T> {
  let settled = false
  let failure: { error: unknown } | undefined
  let value: T | undefined
  const p = run().then(
    (v) => {
      value = v
      settled = true
    },
    (error: unknown) => {
      settled = true
      failure = { error }
    },
  )
  while (!settled) {
    await tick()
    if (settled) break
    if (!clock.pending) {
      await tick()
      if (!settled && !clock.pending)
        throw new Error('virtual-clock deadlock: scenario pending with no timers')
      continue
    }
    clock.pop()?.fn()
  }
  await p
  if (failure) throw failure.error
  return value as T
}

// ── Tweet/list/permalink DOM builders ────────────────────────────────────────

export type Membership = 'member' | 'cleared' | 'none'

export interface TweetSpec {
  readonly id: string
  readonly bookmark?: Membership | undefined
  readonly like?: Membership | undefined
  /** An active control whose click does NOTHING (X ignored the synthetic click /
   * reverted before re-render) — the node can then only leave by recycling. */
  readonly inert?: boolean | undefined
}

const ACTIVE_TESTID: Record<MembershipScope, string> = {
  bookmark: 'removeBookmark',
  like: 'unlike',
}
const CLEARED_TESTID: Record<MembershipScope, string> = {
  bookmark: 'bookmark',
  like: 'like',
}
const SCOPES = ['bookmark', 'like'] as const

function newWindow(pathname: string): Window {
  return new Window({
    url: `https://x.com${pathname}`,
    settings: { disableJavaScriptEvaluation: true },
  })
}

function primaryColumn(win: Window): HTMLElement {
  const doc = asDom<Document>(win.document)
  const col = doc.createElement('div')
  col.setAttribute('data-testid', 'primaryColumn')
  doc.body.appendChild(col)
  return col
}

/** One timeline cell whose action bar reflects the declared memberships. Active
 * controls flip to their cleared testid when clicked — X's optimistic update,
 * scheduled through the clock so delayed renders replay identically — and report
 * the mutation to `onMemberFlip`, the ONLY channel that moves server-side truth. */
function tweetCell(
  win: Window,
  spec: TweetSpec,
  clock: VirtualClock,
  onMemberFlip: ((tweetId: string, scope: MembershipScope) => void) | undefined,
): HTMLElement {
  const doc = asDom<Document>(win.document)
  const cell = doc.createElement('div')
  cell.setAttribute('data-testid', 'cellInnerDiv')
  const article = doc.createElement('article')
  article.setAttribute('data-testid', 'tweet')

  const link = doc.createElement('a')
  link.setAttribute('href', `/author/status/${spec.id}`)
  link.textContent = 'link'
  article.appendChild(link)

  const bar = doc.createElement('div')
  bar.setAttribute('role', 'group')
  for (const scope of SCOPES) {
    const membership = spec[scope] ?? 'none'
    if (membership === 'none') continue
    const button = doc.createElement('button')
    button.setAttribute(
      'data-testid',
      membership === 'member' ? ACTIVE_TESTID[scope] : CLEARED_TESTID[scope],
    )
    if (membership === 'member' && !spec.inert) {
      button.addEventListener('click', () => {
        clock.at(0, () => {
          button.setAttribute('data-testid', CLEARED_TESTID[scope])
          onMemberFlip?.(spec.id, scope)
        })
      })
    }
    bar.appendChild(button)
  }
  article.appendChild(bar)
  cell.appendChild(article)
  return cell
}

function makeListWindow(
  pathname: string,
  specs: readonly TweetSpec[],
  clock: VirtualClock,
  onMemberFlip: ((tweetId: string, scope: MembershipScope) => void) | undefined,
): Window {
  const win = newWindow(pathname)
  const col = primaryColumn(win)
  for (const spec of specs) col.appendChild(tweetCell(win, spec, clock, onMemberFlip))
  return win
}

export interface PermalinkSpec {
  readonly state: 'member' | 'cleared' | 'notfound'
  /** React mounting the article LATE (the observed slow-permalink case): the page
   * starts empty and the cell appears after this much virtual ms. */
  readonly mountAfterMs?: number
  readonly bookmark?: Membership
  readonly like?: Membership
}

function makePermalinkWindow(
  tweetId: string,
  spec: PermalinkSpec,
  clock: VirtualClock,
  onMemberFlip: ((tweetId: string, scope: MembershipScope) => void) | undefined,
): Window {
  const win = newWindow(`/i/web/status/${tweetId}`)
  const insert = (): void => {
    if (spec.state === 'notfound') {
      // X's own error block — the marker the content script's page evidence reads.
      const msg = asDom<Document>(win.document).createElement('div')
      msg.setAttribute('data-testid', 'error-detail')
      msg.textContent = 'Hmm...this page doesn’t exist. Try searching for something else.'
      primaryColumn(win).appendChild(msg)
      return
    }
    primaryColumn(win).appendChild(
      tweetCell(
        win,
        { id: tweetId, bookmark: spec.bookmark, like: spec.like },
        clock,
        onMemberFlip,
      ),
    )
  }
  if (spec.mountAfterMs === undefined) insert()
  else clock.at(spec.mountAfterMs, insert)
  return win
}

// ── Fake tab world ───────────────────────────────────────────────────────────

export interface TraceLine {
  readonly stage: string
  readonly detail: string
  readonly tweetId?: string
}

const RELEASE_TAB_ID = 900_001
const truthKey = (tweetId: string, scope: MembershipScope | ClearScope): string =>
  `${tweetId}:${scope}`

/** The browser seams `makeTabBroadcaster` takes, backed by fixture windows. The
 * receiving side runs the REAL content-script decision stack — `findArticle`,
 * `shouldClickScope`/`clearableScope`, `makeTweetClearer` — mirroring
 * `overlay.content/handlers.ts`; only chrome.runtime plumbing is faked. */
export class FakeXWorld {
  readonly trace: TraceLine[] = []
  /** Server-side membership truth: `true` iff a REAL optimistic flip fired. DOM
   * detachment/recycling NEVER touches it. */
  private readonly truth = new Map<string, boolean>()
  private readonly tabs: { id: number; pathname: string; win: Window; dead: boolean }[] = []
  /** Tweet ids whose ok-verdict armed the recheck watchdog (via the clearer's
   * onFlip port) — the deferred-verification contract for 'gone' detachments. */
  private readonly armed = new Set<string>()
  private releaseUrl: string | null = null
  private releaseWin: Window | null = null
  private nextId = 101

  constructor(
    readonly clock: VirtualClock,
    private readonly permalinkFor: (tweetId: string) => PermalinkSpec,
  ) {}

  private recordFlip = (tweetId: string, scope: MembershipScope): void => {
    this.truth.set(truthKey(tweetId, scope), true)
  }

  addListTab(pathname: string, specs: readonly TweetSpec[]): number {
    const id = this.nextId++
    for (const spec of specs) {
      for (const scope of SCOPES) {
        if ((spec[scope] ?? 'none') === 'member') this.truth.set(truthKey(spec.id, scope), false)
      }
    }
    this.tabs.push({
      id,
      pathname,
      win: makeListWindow(pathname, specs, this.clock, this.recordFlip),
      dead: false,
    })
    return id
  }

  /** A tab whose content script never answers — the orphaned-overlay case that
   * spec Part D's skip list exists for. */
  addOrphanTab(pathname: string): number {
    const id = this.nextId++
    this.tabs.push({
      id,
      pathname,
      win: makeListWindow(pathname, [], this.clock, this.recordFlip),
      dead: true,
    })
    return id
  }

  flipArmed(tweetId: string, scope: MembershipScope): boolean {
    return this.armed.has(truthKey(tweetId, scope))
  }

  truthCleared(tweetId: string, scope: MembershipScope): boolean {
    return this.truth.get(truthKey(tweetId, scope)) === true
  }

  /** The window of a registered list tab (for scheduling fixture events on its nodes). */
  tabWin(tabId: number): Window | undefined {
    return this.tabs.find((t) => t.id === tabId)?.win
  }

  /** Page-state evidence exactly as the real content script computes it. */
  private pageEvidence(win: Window): ClearTweetResponse['page'] {
    const doc = asDom<Document>(win.document)
    return {
      articles: doc.querySelectorAll('article[data-testid="tweet"]').length,
      cells: doc.querySelectorAll('[data-testid="cellInnerDiv"]').length,
      ready: 'complete' as const,
      error: doc.querySelector('[data-testid="error-detail"]') !== null,
    }
  }

  broadcaster() {
    return makeTabBroadcaster(this.port(), {
      clock: this.clock,
      trace: (stage, detail, tweetId) => {
        this.trace.push({ stage, detail, ...(tweetId === undefined ? {} : { tweetId }) })
      },
    })
  }

  private port(): TabsPort {
    return {
      queryXTabs: async () => this.tabs.map((t) => t.id),
      sendTabMessage: async (tabId, message) => {
        const req = message as ClearTweetRequest
        if (tabId === RELEASE_TAB_ID) {
          if (this.releaseWin === null) throw new Error(`no receiver ${tabId}`)
          return this.handleClear(`/i/web/status/${req.tweetId}`, this.releaseWin, req)
        }
        const tab = this.tabs.find((t) => t.id === tabId)
        if (!tab) throw new Error(`no receiver ${tabId}`)
        // Orphaned content script: the port-level rejection the broadcaster's
        // compactReason folds into `no-receiver`.
        if (tab.dead)
          throw new Error('Could not establish connection. Receiving end does not exist.')
        return this.handleClear(tab.pathname, tab.win, req)
      },
      getTabUrl: async (tabId) => {
        const tab = this.tabs.find((t) => t.id === tabId)
        if (tab) return `https://x.com${tab.pathname}`
        if (this.releaseWin !== null && tabId === RELEASE_TAB_ID) return this.releaseUrl ?? ''
        return undefined
      },
      navigateReleaseTab: async (url) => {
        this.openRelease(url)
        return RELEASE_TAB_ID
      },
      reloadReleaseTab: async () => {
        // A reload restarts the SPA: regenerate the page from its spec, including
        // any late-mount timer.
        if (this.releaseUrl !== null) this.openRelease(this.releaseUrl)
      },
      releaseTabId: () => (this.releaseWin !== null ? RELEASE_TAB_ID : undefined),
    }
  }

  private openRelease(url: string): void {
    const tweetId = /status\/(\d+)/.exec(url)?.[1] ?? ''
    this.releaseUrl = url
    this.releaseWin = makePermalinkWindow(
      tweetId,
      this.permalinkFor(tweetId),
      this.clock,
      this.recordFlip,
    )
  }

  private async handleClear(
    pathname: string,
    win: Window,
    req: ClearTweetRequest,
  ): Promise<ClearTweetResponse> {
    const doc = asDom<Document>(win.document)
    const articleOpt = findArticle(doc, req.tweetId)
    if (Option.isNone(articleOpt)) {
      return {
        _tag: 'ClearTweetResponse',
        mounted: false,
        drainEligible: false,
        results: [],
        page: this.pageEvidence(win),
      }
    }
    const article = articleOpt.value
    const clearer = makeTweetClearer({
      document: doc,
      clock: this.clock,
      onFlip: (tweetId, scope) => {
        this.armed.add(truthKey(tweetId, scope))
      },
      trace: (stage, detail, tweetId) => {
        this.trace.push({ stage, detail, ...(tweetId === undefined ? {} : { tweetId }) })
      },
    })
    const allLists = req.allLists ?? false
    // Mirror overlay.content/handlers.ts: the page's own list scope rules; the
    // seed-time pin (`asPageScope`) is only a FALLBACK for pages that own none
    // (the permalink leg), never an override.
    const onScope = clearableScope(pathname, doc) ?? req.asPageScope ?? null
    const results: { scope: ClearTweetResponse['results'][number]['scope']; ok: boolean }[] = []
    for (const scope of req.scopes) {
      if (scope === 'notInterested') continue // caret-menu flow is outside bench v1
      const member = isMember(article, scope)
      if (!shouldClickScope({ scope, onScope, member, allLists })) continue
      results.push({ scope, ok: await clearer.clearScope(req.tweetId, scope, 'settle') })
    }
    return { _tag: 'ClearTweetResponse', mounted: true, drainEligible: false, results }
  }
}
