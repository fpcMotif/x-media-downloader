import { storage } from 'wxt/utils/storage'
import type { DownloadTraceEntry, Settings } from '../core/schema'
import {
  createEntry,
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
  enqueue as enqueueSweep,
  isCleared as isSweepCleared,
  markState as markSweepState,
  type SweepState,
} from '../core/clear/worklist'
import { decideSettle, type DownloadProbe } from '../core/clear/settle'
import { makeSerialQueue } from '../core/serial-queue'

// The irreversible Clear is gated on a SETTLE confirmed through the Settle Port
// (chrome.downloads.search in the SW) — never the bare onChanged 'complete' delta
// (spec §4.2). Settle is deferred this long so a late post-complete 'interrupted'
// can Fail the item first and block the Clear; the probe then double-checks the
// byte truly landed (the pure `decideSettle` verdict) before draining inProgress.
// This keeps the late-interrupt-after-complete blind spot closed.
const SETTLE_CONFIRM_MS = 1500

const SWEEP_WORKLIST_MAX = 5000

/** The auto-hook's enabled clear scopes, derived from the per-scope kill
 *  switches — the single mapping shared by ledger seeding and re-checks. The
 *  page the download happens on decides which of these is actually clicked
 *  (handleClearTweet's onScope): un-bookmark/un-like on a list page, "Not
 *  interested" on the For You feed; the off-page scopes no-op. */
export const hookScopes = (s: Settings): Scope[] => [
  ...(s.autoUnbookmarkOnSave ? (['bookmark'] as Scope[]) : []),
  ...(s.autoUnlikeOnSave ? (['like'] as Scope[]) : []),
  ...(s.autoNotInterestedOnSave ? (['notInterested'] as Scope[]) : []),
]

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

export interface ClearCoordinator {
  /** Seed the clear ledger for a download batch (one entry per tweet). */
  readonly seedClearLedger: (
    byTweet: ReadonlyMap<string, string[]>,
    clearScopes: Scope[],
    clearOrigin: 'sweep' | 'hook',
  ) => void
  /** Record Complete now, then after a window verify the byte landed before Settle. */
  readonly recordClearComplete: (
    tweetId: string | undefined,
    requestId: string,
    downloadId: number,
  ) => void
  /** A media item permanently failed (or failed to start): record Fail. */
  readonly recordClearFailure: (tweetId: string | undefined, requestId: string) => void
  /** Advance a swept tweet's durable state per scope (no-op when not part of a sweep). */
  readonly setSweepState: (tweetId: string, scopes: Iterable<Scope>, state: SweepState) => void
  /** Filter a sweep's posts against the durable worklist + enqueue the rest.
   *  Generic over the item shape so the caller's full MediaItem flows through. */
  readonly enqueueSweepWorklist: <I>(
    scope: Scope,
    posts: ReadonlyArray<{ readonly tweetId: string; readonly items: ReadonlyArray<I> }>,
  ) => Promise<{
    queuedPosts: { readonly items: ReadonlyArray<I> }[]
    skipped: number
  }>
  /** The manual monitor reset bounds the in-memory clear ledger too. */
  readonly resetLedger: () => void
}

export interface ClearCoordinatorDeps {
  /** Build the queue's error observer (traces through the background's chain). */
  readonly queueError: (label: string) => (err: unknown) => void
  /** Read the current settings blob. */
  readonly getSettings: () => Promise<Settings>
  /** Trace through the background's accumulator. */
  readonly trace: (stage: string, opts?: Omit<DownloadTraceEntry, 'source' | 'stage' | 't'>) => void
  /** Ask open X tabs to clear the tweet (the tab broadcaster's seam). `allLists`
   *  (the "Clear from every list" setting) tells the content script to fire every
   *  scope the article is a member of, not just the current page's list. */
  readonly sendClearToTabs: (
    tweetId: string,
    scopes: Scope[],
    allLists: boolean,
  ) => Promise<{
    mounted: boolean
    results: ReadonlyArray<{ scope: Scope; ok: boolean; noop?: boolean | undefined }>
  }>
  /** The Settle Port: probe a browser download's final state to confirm the byte
   *  landed before the irreversible Clear. Real `chrome.downloads.search` in the
   *  SW; a fixture row in tests. Resolves `undefined` when the row is gone or the
   *  search throws — `decideSettle` fails that closed (no Clear). */
  readonly settleProbe: (downloadId: number) => Promise<DownloadProbe | undefined>
}

export const makeClearCoordinator = (deps: ClearCoordinatorDeps): ClearCoordinator => {
  const { getSettings, trace, sendClearToTabs, settleProbe } = deps

  // Clear-on-complete ledger (worklist un-bookmark/un-like). In-memory v1: a SW
  // recycle simply skips the Clear — it can never wrong-clear — and durable
  // `storage.local` persistence + reconcile-on-boot (spec §4.3) is the hardening
  // follow-up. Keyed by tweetId; every read-modify-write goes through one
  // serialized chain (the outbox pattern) so interleaved completion events and the
  // clear round-trip can't double-fire on a tweet.
  const clearLedger = new Map<string, LedgerEntry>()
  const clearQueue = makeSerialQueue(deps.queueError('clear'))

  // Durable sweep worklist — the one-by-one clear's persistent flag (the
  // `storage.local` follow-up to the in-memory ledger). It survives SW recycle,
  // popup close, and scrolling, so the sweep resumes and never re-touches a post
  // it already cleared. The background is the SINGLE writer; every read-modify-
  // write goes through one serialized chain (the outbox pattern). FUTURE: back this
  // with Convex sync as the state store — core/clear/worklist is storage-agnostic,
  // so the swap lives at this I/O boundary, not in the logic.
  const sweepWorklistItem = storage.defineItem<unknown>('local:clearWorklist', { fallback: null })
  const worklistQueue = makeSerialQueue(deps.queueError('worklist'))

  /** Advance a swept tweet's durable state, PER SCOPE — the worklist tracks each
   *  list independently, so a Likes sweep can't be masked by a prior Bookmarks
   *  clear. No-op when the (tweet, scope) isn't part of a sweep (markState ignores
   *  untracked keys), so ordinary downloads never create worklist entries.
   *  Serialized; only writes when some scope's state actually changes. */
  const setSweepState = (tweetId: string, scopes: Iterable<Scope>, state: SweepState): void => {
    worklistQueue.push(async () => {
      const wl = decodeWorklist(await sweepWorklistItem.getValue())
      const now = Date.now()
      let next = wl
      for (const scope of scopes) next = markSweepState(next, tweetId, scope, state, now)
      if (next !== wl) await sweepWorklistItem.setValue(next)
    })
  }

  /** Which scopes may clear NOW: a sweep entry uses its OWN list scope only; the
   *  auto-hook re-derives from its (mid-flight-toggleable) per-scope kill switches. */
  const enabledScopesFor = (entry: LedgerEntry, settings: Settings): Set<Scope> =>
    entry.origin === 'sweep' ? new Set<Scope>(entry.scopes) : new Set(hookScopes(settings))

  /** Truly Complete → claim the still-enabled scopes (CAS), DOM-clear them in-page,
   *  resolve each latch from the verified flip, prune once every scope is cleared.
   *  Not mounted anywhere → release the claims (defer, stays re-claimable). */
  const maybeClearTweet = async (tweetId: string): Promise<void> => {
    const settings = await getSettings()
    const entry = clearLedger.get(tweetId)
    if (entry === undefined || !isTrulyComplete(entry)) return
    // The "Clear after download" option gates EVERY clear, re-checked here (not
    // just at seed time) so a mid-flight toggle-off blocks it.
    if (!settings.clearOnSave) return
    const enabledNow = enabledScopesFor(entry, settings)
    // Prune when every scope is cleared OR no longer enabled — a scope the user
    // toggled off must not keep an entry pinned in the map forever (isFullyCleared
    // alone would require even disabled scopes to reach 'cleared', which never
    // happens because we skip claiming them).
    const prunable = (e: LedgerEntry): boolean =>
      [...e.scopes].every((s) => e.clear[s] === 'cleared' || !enabledNow.has(s))
    const { entry: e, claimed } = claimEnabledScopes(entry, enabledNow)
    clearLedger.set(tweetId, e)
    if (claimed.length === 0) {
      if (prunable(e)) clearLedger.delete(tweetId)
      return
    }
    trace('clear-claim', { tweetId, detail: `sending ${claimed.join('+')} to X tabs` })
    const { mounted, results } = await sendClearToTabs(
      tweetId,
      claimed,
      settings.clearAllListsOnSave,
    )
    let after = clearLedger.get(tweetId)
    if (after === undefined) return
    if (!mounted) {
      // Deferred: the tweet isn't mounted in any tab, so v1's DOM-click hook can't
      // clear it — and there is no re-trigger yet (reconcile/Drain are deferred,
      // spec §4.3/§12). Drop the entry rather than leak it in memory forever for a
      // Clear that can never fire; a re-download reseeds it. Nothing was clicked, so
      // this is purely housekeeping (no irreversible action happened).
      clearLedger.delete(tweetId)
      trace('clear-deferred', {
        tweetId,
        detail: 'not mounted; handed to in-page scroll-drain (watch for `clear` traces)',
      })
      return
    }
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
    if (flipped.length > 0) setSweepState(tweetId, flipped, 'cleared')
    clearLedger.set(tweetId, after)
    trace('clear-resolve', {
      tweetId,
      // `ok` alone hid a no-op (a scope that didn't fire — off-page/not-a-member —
      // reports ok:true so the ledger settles) behind the same token as a REAL flip,
      // so a log reading `like:ok` could mean "un-liked" OR "skipped". Split them:
      // ok = verified flip, noop = deliberately not fired, fail = clicked but no flip.
      detail: results.map((r) => `${r.scope}:${r.ok ? (r.noop ? 'noop' : 'ok') : 'fail'}`).join(' '),
    })
    if (prunable(after)) clearLedger.delete(tweetId)
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
  const recordClearFailure = (tweetId: string | undefined, requestId: string): void => {
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
  const recordClearComplete = (
    tweetId: string | undefined,
    requestId: string,
    downloadId: number,
  ): void => {
    if (tweetId === undefined) return
    clearQueue.push(async () => {
      const e = clearLedger.get(tweetId)
      if (e !== undefined) {
        clearLedger.set(tweetId, reduceLedger(e, { type: 'Complete', mediaId: requestId }))
      }
    })
    setTimeout(() => {
      clearQueue.push(async () => {
        const e = clearLedger.get(tweetId)
        if (e === undefined) return
        // Re-probe through the Settle Port and let the pure `decideSettle` verdict
        // (core/clear/settle) gate the irreversible action: a recorded 'complete'
        // that didn't verifiably land routes through LateInterrupt instead.
        const verdict = decideSettle(await settleProbe(downloadId))
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
          // Bytes verified on disk — record 'downloaded' before the clear attempt,
          // so the durable flag distinguishes "saved but not yet un-liked" from
          // "never downloaded" even if the clear later defers (post not mounted).
          setSweepState(tweetId, next.scopes, 'downloaded')
          await maybeClearTweet(tweetId)
          return
        }
        pruneIfTerminalFailed(tweetId, next)
      })
    }, SETTLE_CONFIRM_MS)
  }

  const seedClearLedger = (
    byTweet: ReadonlyMap<string, string[]>,
    clearScopes: Scope[],
    clearOrigin: 'sweep' | 'hook',
  ): void => {
    clearQueue.push(async () => {
      for (const [tweetId, ids] of byTweet) {
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
                scopes: clearScopes,
                origin: clearOrigin,
                strategy: 'browser',
                expected: ids,
              })
        // Extend preserves the prior entry's scopes; for a sweep that must NOT
        // inherit a hook entry's wider scopes (seedScopes narrows to the swept
        // scope only), or a Likes sweep could later un-bookmark on navigation.
        const stored: LedgerEntry =
          clearOrigin === 'sweep'
            ? { ...base, origin: 'sweep', scopes: seedScopes(existing, 'sweep', clearScopes) }
            : base
        clearLedger.set(tweetId, stored)
        trace('clear-seeded', {
          tweetId,
          detail: `origin=${stored.origin} scopes=${[...stored.scopes].join('+')} expected=${ids.length}`,
        })
      }
    })
  }

  const enqueueSweepWorklist = async <I>(
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
        let wl = decodeWorklist(await sweepWorklistItem.getValue())
        const now = Date.now()
        for (const p of posts) {
          // Scope-qualified: a post already cleared in the OTHER list (e.g.
          // un-bookmarked) must still be swept here (e.g. un-liked).
          if (isSweepCleared(wl, p.tweetId, scope)) {
            skipped += 1
            continue
          }
          wl = enqueueSweep(wl, p.tweetId, scope, now)
          queuedPosts.push({ items: p.items })
        }
        await sweepWorklistItem.setValue(capWorklist(wl, SWEEP_WORKLIST_MAX))
        resolve()
      })
    })
    return { queuedPosts, skipped }
  }

  const resetLedger = (): void => {
    clearLedger.clear()
  }

  return {
    seedClearLedger,
    recordClearComplete,
    recordClearFailure,
    setSweepState,
    enqueueSweepWorklist,
    resetLedger,
  }
}
