import { storage } from 'wxt/utils/storage'
import type { DownloadTraceEntry, Settings } from '../core/schema'
import {
  createEntry,
  hookScopes,
  reduce as reduceLedger,
  isFullyCleared,
  isTrulyComplete,
  seedScopes,
  tryClaim,
  type LedgerEntry,
  type Scope,
} from '../core/clear/ledger'
import {
  capWorklist,
  decodeWorklist,
  enqueue as enqueueSweepWorklist,
  isCleared as isSweepCleared,
  markState as markSweepState,
  type SweepState,
} from '../core/clear/worklist'
import { decideSettle, type DownloadProbe } from '../core/clear/settle'
import type { ClearSeedVerdict } from '../core/clear/seed'
import { makeSerialQueue } from '../core/serial-queue'

// The irreversible Clear is gated on a SETTLE confirmed through the Settle Port
// (chrome.downloads.search in the SW) — never the bare onChanged 'complete' delta
// (spec §4.2). Settle is deferred this long so a late post-complete 'interrupted'
// can Fail the item first and block the Clear; the probe then double-checks the
// byte truly landed (the pure `decideSettle` verdict) before draining inProgress.
// This keeps the late-interrupt-after-complete blind spot closed.
const SETTLE_CONFIRM_MS = 1500

const SWEEP_WORKLIST_MAX = 5000
const NOOP_CANCEL = (): void => {}
type ClearResult = {
  readonly scope: Scope
  readonly ok: boolean
  readonly noop?: boolean | undefined
}
type ClearAttempt = {
  readonly tweetId: string
  readonly claimed: Scope[]
  readonly allLists: boolean
  readonly preferTabId?: number
  readonly enabled: ReadonlySet<Scope>
  readonly generation: number
}

/** Local clock port for the settle-confirm window. Kept local to
 *  this module, not shared: Clock Ports are per-module shapes (see retry-plan.ts's
 *  RetryClock for the sibling instance in this same SW context). */
export interface SettleClock {
  readonly schedule: (fn: () => void, ms: number) => () => void
}

/** The real clock: wraps `setTimeout`. Used when no `clock` dep is supplied —
 *  tests inject a hand-rolled fake instead (see clear-session.test.ts). */
const realSettleClock: SettleClock = {
  schedule: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
}

/** CAS-claim each still-enabled scope, returning the CAS-updated entry (the
 *  caller MUST persist `entry` — the rebind carries the won claims) and the list
 *  of scopes actually claimed. */
const claimEnabledScopes = (
  entry: LedgerEntry,
  enabled: Set<Scope>,
): { entry: LedgerEntry; claimed: Scope[] } => {
  let e = entry
  const claimed: Scope[] = []
  for (const scope of e.scopes) {
    if (!enabled.has(scope)) continue
    const r = tryClaim(e, scope)
    if (r.won) {
      e = r.entry
      claimed.push(scope)
    }
  }
  return { entry: e, claimed }
}

/** Which scopes may clear NOW: a sweep entry uses its OWN list scope only; the
 *  auto-hook re-derives from its (mid-flight-toggleable) per-scope kill switches. */
const enabledScopesFor = (entry: LedgerEntry, settings: Settings): Set<Scope> =>
  entry.origin === 'sweep' ? new Set<Scope>(entry.scopes) : new Set(hookScopes(settings))

const isPrunable = (entry: LedgerEntry, enabled: ReadonlySet<Scope>): boolean =>
  [...entry.scopes].every((scope) => entry.clear[scope] === 'cleared' || !enabled.has(scope))

export interface ClearSession {
  /** Write B's planned Clear verdict. No planning occurs here. */
  readonly seedLedger: (verdict: ClearSeedVerdict) => Promise<void>
  /** Record Complete now, then after a window verify the byte landed before Settle. */
  readonly recordComplete: (
    tweetId: string | undefined,
    requestId: string,
    downloadId: number,
  ) => void
  /** A media item permanently failed (or failed to start): record Fail. */
  readonly recordFailure: (tweetId: string | undefined, requestId: string) => void
  /** Advance a swept tweet's durable state per scope (no-op when not part of a sweep). */
  readonly setSweepState: (tweetId: string, scopes: Iterable<Scope>, state: SweepState) => void
  /** Filter a sweep's posts against the durable worklist + enqueue the rest.
   *  Generic over the item shape so the caller's full MediaItem flows through. */
  readonly enqueueSweep: <I>(
    scope: Scope,
    posts: ReadonlyArray<{ readonly tweetId: string; readonly items: ReadonlyArray<I> }>,
  ) => Promise<{
    queuedPosts: { readonly items: ReadonlyArray<I> }[]
    skipped: number
  }>
  /** The manual monitor reset bounds the in-memory clear ledger too. */
  readonly reset: () => Promise<void>
}

export interface ClearSessionDeps {
  /** Build the queue's error observer (traces through the background's chain). */
  readonly queueError: (label: string) => (err: unknown) => void
  /** Read the current settings blob. */
  readonly getSettings: () => Promise<Settings>
  /** Trace through the background's accumulator. */
  readonly trace: (stage: string, opts?: Omit<DownloadTraceEntry, 'source' | 'stage' | 't'>) => void
  /** Ask open X tabs to clear the tweet (the tab broadcaster's seam). `allLists`
   *  (the "Clear from every list" setting) tells the content script to fire every
   *  scope the article is a member of, not just the current page's list. */
  readonly dispatchClear: (
    tweetId: string,
    scopes: Scope[],
    allLists: boolean,
    preferTabId?: number,
  ) => Promise<ReadonlyArray<{ scope: Scope; ok: boolean; noop?: boolean | undefined }>>
  /** The Settle Port: probe a browser download's final state to confirm the byte
   *  landed before the irreversible Clear. Real `chrome.downloads.search` in the
   *  SW; a fixture row in tests. Resolves `undefined` when the row is gone or the
   *  search throws — `decideSettle` fails that closed (no Clear). */
  readonly settleProbe: (downloadId: number) => Promise<DownloadProbe | undefined>
  /** Durable sweep worklist port. Defaults to extension local storage. */
  readonly worklistStorage?: {
    readonly get: () => Promise<unknown>
    readonly set: (value: unknown) => Promise<void>
  }
  /** Injected timer port for the settle-confirm window. Defaults to the real
   *  `setTimeout` wrapper when omitted — tests supply a hand-rolled fake instead. */
  readonly clock?: SettleClock
}

export const makeClearSession = (deps: ClearSessionDeps): ClearSession => {
  const { getSettings, trace, dispatchClear, settleProbe } = deps
  const clock = deps.clock ?? realSettleClock

  // Clear-on-complete ledger (worklist un-bookmark/un-like). In-memory v1: a SW
  // recycle simply skips the Clear — it can never wrong-clear — and durable
  // `storage.local` persistence + reconcile-on-boot (spec §4.3) is the hardening
  // follow-up. Keyed by tweetId; every read-modify-write goes through one
  // serialized chain (the outbox pattern) so interleaved completion events and the
  // clear round-trip can't double-fire on a tweet.
  const clearLedger = new Map<string, LedgerEntry>()
  const clearQueue = makeSerialQueue(deps.queueError('clear'))
  const settleCancels = new Set<() => void>()
  const clearOriginTab = new Map<string, number>()
  let generation = 0
  const CLEAR_ORIGIN_TAB_CAP = 512

  const rememberOrigin = (tweetId: string, tabId: number): void => {
    clearOriginTab.delete(tweetId)
    clearOriginTab.set(tweetId, tabId)
    for (const oldest of clearOriginTab.keys()) {
      if (clearOriginTab.size <= CLEAR_ORIGIN_TAB_CAP) break
      clearOriginTab.delete(oldest)
    }
  }

  // Durable sweep worklist — the one-by-one clear's persistent flag (the
  // `storage.local` follow-up to the in-memory ledger). It survives SW recycle,
  // popup close, and scrolling, so the sweep resumes and never re-touches a post
  // it already cleared. The background is the SINGLE writer; every read-modify-
  // write goes through one serialized chain (the outbox pattern). FUTURE: back this
  // with Convex sync as the state store — core/clear/worklist is storage-agnostic,
  // so the swap lives at this I/O boundary, not in the logic.
  const sweepWorklistItem = storage.defineItem<unknown>('local:clearWorklist', { fallback: null })
  const worklistStorage = deps.worklistStorage ?? {
    get: () => sweepWorklistItem.getValue(),
    set: (value: unknown) => sweepWorklistItem.setValue(value),
  }
  const worklistQueue = makeSerialQueue(deps.queueError('worklist'))

  /** Advance a swept tweet's durable state, PER SCOPE — the worklist tracks each
   *  list independently, so a Likes sweep can't be masked by a prior Bookmarks
   *  clear. No-op when the (tweet, scope) isn't part of a sweep (markState ignores
   *  untracked keys), so ordinary downloads never create worklist entries.
   *  Serialized; only writes when some scope's state actually changes. */
  const setSweepState = (tweetId: string, scopes: Iterable<Scope>, state: SweepState): void => {
    worklistQueue.push(async () => {
      const wl = decodeWorklist(await worklistStorage.get())
      const now = Date.now()
      let next = wl
      for (const scope of scopes) next = markSweepState(next, tweetId, scope, state, now)
      if (next !== wl) await worklistStorage.set(next)
    })
  }

  /** Claim inside the serial queue. Network/DOM dispatch happens after this returns,
   * so one slow Scroll Drain cannot block later settle/failure events. */
  const prepareClearAttempt = (tweetId: string, settings: Settings): ClearAttempt | undefined => {
    const entry = clearLedger.get(tweetId)
    if (entry === undefined || !isTrulyComplete(entry)) return
    // The "Clear after download" option gates EVERY clear, re-checked here (not
    // just at seed time) so a mid-flight toggle-off blocks it.
    if (!settings.clearOnSave) return
    const enabled = enabledScopesFor(entry, settings)
    const { entry: e, claimed } = claimEnabledScopes(entry, enabled)
    clearLedger.set(tweetId, e)
    if (claimed.length === 0) {
      if (isPrunable(e, enabled)) clearLedger.delete(tweetId)
      return
    }
    trace('clear-claim', { tweetId, detail: `sending ${claimed.join('+')} to X tabs` })
    const preferTabId = clearOriginTab.get(tweetId)
    return {
      tweetId,
      claimed,
      allLists: settings.clearAllListsOnSave,
      ...(preferTabId === undefined ? {} : { preferTabId }),
      enabled,
      generation,
    }
  }

  const resolveClearAttempt = (
    attempt: ClearAttempt,
    rawResults: ReadonlyArray<ClearResult>,
  ): void => {
    if (attempt.generation !== generation) return
    const resultByScope = new Map(rawResults.map((result) => [result.scope, result]))
    const results = attempt.claimed.map((scope) => resultByScope.get(scope) ?? { scope, ok: false })
    let after = clearLedger.get(attempt.tweetId)
    if (after === undefined) return
    for (const { scope, ok } of results) {
      after = reduceLedger(after, { type: 'ResolveClear', scope, ok })
    }
    // Record the durable 'cleared' flag ONLY on the scopes that REALLY flipped —
    // never an off-list no-op (`noop`), which the content script reports ok:true
    // purely so the in-memory ledger can settle/prune. Marking per-flipped-scope
    // (not a blanket flag) keeps each list's skip-cache honest: an un-like that
    // verifiably failed never marks the post cleared just because the un-bookmark
    // no-op'd. (Sweep entries are seeded with only the page scope, so in practice
    // `flipped` already holds just that scope.)
    const flipped = results.filter((r) => r.ok && !r.noop).map((r) => r.scope)
    if (flipped.length > 0) setSweepState(attempt.tweetId, flipped, 'cleared')
    clearLedger.set(attempt.tweetId, after)
    trace('clear-resolve', {
      tweetId: attempt.tweetId,
      // `ok` alone hid a no-op (a scope that didn't fire — off-page/not-a-member —
      // reports ok:true so the ledger settles) behind the same token as a REAL flip,
      // so a log reading `like:ok` could mean "un-liked" OR "skipped". Split them:
      // ok = verified flip, noop = deliberately not fired, fail = clicked but no flip.
      detail: results
        .map((r) => `${r.scope}:${r.ok ? (r.noop ? 'noop' : 'ok') : 'fail'}`)
        .join(' '),
    })
    if (isPrunable(after, attempt.enabled)) clearLedger.delete(attempt.tweetId)
  }

  const runClearAttempt = async (tweetId: string): Promise<void> => {
    const settings = await getSettings()
    const attempt = await clearQueue.run(async () => prepareClearAttempt(tweetId, settings))
    if (attempt === undefined) return
    let results: ReadonlyArray<ClearResult>
    try {
      results = await dispatchClear(
        attempt.tweetId,
        attempt.claimed,
        attempt.allLists,
        attempt.preferTabId,
      )
    } catch (error) {
      trace('clear-dispatch-failed', {
        tweetId,
        detail: error instanceof Error ? error.message : String(error),
      })
      results = attempt.claimed.map((scope) => ({ scope, ok: false }))
    }
    await clearQueue.run(async () => resolveClearAttempt(attempt, results))
  }

  /** A tweet with any permanently-failed media can never be Truly Complete, so it
   *  would otherwise sit in the in-memory map forever — drop it (a re-download
   *  reseeds a fresh entry). The feature targets exactly these post-handoff
   *  failures, so this is the common case, not an edge. */
  const pruneIfTerminalFailed = (tweetId: string, e: LedgerEntry): void => {
    if (e.failed.size > 0 && e.inProgress.size === 0) {
      clearLedger.delete(tweetId)
      setSweepState(tweetId, e.scopes, 'failed')
    }
  }

  /** A media item permanently failed (or failed to start): record Fail. */
  const recordFailure = (tweetId: string | undefined, requestId: string): void => {
    if (tweetId === undefined) return
    clearQueue.push(async () => {
      const e = clearLedger.get(tweetId)
      if (e === undefined) return
      const next = reduceLedger(e, { type: 'Fail', mediaId: requestId })
      clearLedger.set(tweetId, next)
      pruneIfTerminalFailed(tweetId, next)
    })
  }

  /** A browser download hit onChanged 'complete'. Record Complete now (the item
   *  stays in inProgress), then after a window re-probe through the Settle Port that
   *  the file is terminal-complete and on disk before Settle. A non-landed item
   *  routes through LateInterrupt (done→failed) so the Clear never fires on a
   *  download that didn't actually land — the irreversible action waits for a
   *  verified Settle. */
  const recordComplete = (
    tweetId: string | undefined,
    requestId: string,
    downloadId: number,
  ): void => {
    if (tweetId === undefined) return
    const scheduledGeneration = generation
    clearQueue.push(async () => {
      if (scheduledGeneration !== generation) return
      const e = clearLedger.get(tweetId)
      if (e !== undefined) {
        clearLedger.set(tweetId, reduceLedger(e, { type: 'Complete', mediaId: requestId }))
      }
    })
    let cancel = NOOP_CANCEL
    cancel = clock.schedule(() => {
      settleCancels.delete(cancel)
      void (async () => {
        const verdict = decideSettle(await settleProbe(downloadId))
        const shouldClear = await clearQueue.run(async () => {
          if (scheduledGeneration !== generation) return false
          const e = clearLedger.get(tweetId)
          if (e === undefined) return false
          const next = reduceLedger(
            e,
            verdict === 'settle'
              ? { type: 'Settle', mediaId: requestId }
              : { type: 'LateInterrupt', mediaId: requestId },
          )
          clearLedger.set(tweetId, next)
          trace('clear-settle', {
            tweetId,
            itemId: requestId,
            detail: `landed=${verdict === 'settle'} truly=${isTrulyComplete(next)} done=${next.done.size}/${next.expected.size} inFlight=${next.inProgress.size}`,
          })
          if (isTrulyComplete(next)) {
            setSweepState(tweetId, next.scopes, 'downloaded')
            return true
          }
          pruneIfTerminalFailed(tweetId, next)
          return false
        })
        if (shouldClear) await runClearAttempt(tweetId)
      })().catch(deps.queueError('clear-settle'))
    }, SETTLE_CONFIRM_MS)
    settleCancels.add(cancel)
  }

  const seedLedger = async (verdict: ClearSeedVerdict): Promise<void> => {
    if (verdict.decision === 'skip') {
      const detail =
        verdict.reason === 'aria2'
          ? 'aria2 hand-offs are not byte-verifiable; excluded'
          : verdict.reason === 'clear-off'
            ? 'Clear after download is OFF — download only'
            : 'both Un-bookmark and Un-like are OFF'
      trace('clear-skip', { detail })
      return
    }
    if (verdict.unclearableCount > 0)
      trace('clear-skip', {
        detail: `${verdict.unclearableCount} tweet(s) without a numeric status id — not DOM-clearable (v1)`,
      })
    await clearQueue.run(async () => {
      for (const [tweetId, ids] of verdict.byTweet) {
        if (verdict.originTabId !== undefined) rememberOrigin(tweetId, verdict.originTabId)
        // Merge into a live entry rather than overwrite: a second download of
        // the same tweet (e.g. one-at-a-time Quick Grab, or re-clicking
        // Download-all while some media is still in flight) must UNION its ids,
        // never replace `expected` with a subset and clear a partial tweet. A
        // sweep also UPGRADES the origin so its explicit consent wins over a
        // prior hook entry for the same tweet.
        const existing = clearLedger.get(tweetId)
        const base =
          existing !== undefined && !isFullyCleared(existing)
            ? reduceLedger(existing, { type: 'Extend', ids })
            : createEntry({
                tweetId,
                scopes: verdict.scopes,
                origin: verdict.origin,
                strategy: 'browser',
                expected: ids,
              })
        // Extend preserves the prior entry's scopes; for a sweep that must NOT
        // inherit a hook entry's wider scopes (seedScopes narrows to the swept
        // scope only), or a Likes sweep could later un-bookmark on navigation.
        const stored: LedgerEntry =
          verdict.origin === 'sweep'
            ? {
                ...base,
                origin: 'sweep',
                scopes: seedScopes(existing, 'sweep', verdict.scopes),
              }
            : base
        clearLedger.set(tweetId, stored)
        trace('clear-seeded', {
          tweetId,
          detail: `origin=${stored.origin} scopes=${[...stored.scopes].join('+')} expected=${ids.length}`,
        })
      }
    })
  }

  const enqueueSweep = async <I>(
    scope: Scope,
    posts: ReadonlyArray<{ readonly tweetId: string; readonly items: ReadonlyArray<I> }>,
  ): Promise<{
    queuedPosts: { readonly items: ReadonlyArray<I> }[]
    skipped: number
  }> => {
    const queuedPosts: { readonly items: ReadonlyArray<I> }[] = []
    let skipped = 0
    await new Promise<void>((resolve) => {
      worklistQueue.push(async () => {
        let wl = decodeWorklist(await worklistStorage.get())
        const now = Date.now()
        for (const p of posts) {
          // Scope-qualified: a post already cleared in the OTHER list (e.g.
          // un-bookmarked) must still be swept here (e.g. un-liked).
          if (isSweepCleared(wl, p.tweetId, scope)) {
            skipped += 1
            continue
          }
          wl = enqueueSweepWorklist(wl, p.tweetId, scope, now)
          queuedPosts.push({ items: p.items })
        }
        await worklistStorage.set(capWorklist(wl, SWEEP_WORKLIST_MAX))
        resolve()
      })
    })
    return { queuedPosts, skipped }
  }

  const reset = async (): Promise<void> => {
    generation += 1
    for (const cancel of settleCancels) cancel()
    settleCancels.clear()
    await clearQueue.run(async () => {
      clearLedger.clear()
      clearOriginTab.clear()
    })
  }

  return {
    seedLedger,
    recordComplete,
    recordFailure,
    setSweepState,
    enqueueSweep,
    reset,
  }
}
