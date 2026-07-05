import { allAdapterHostMatch } from '../core/adapters/registry'
import type { Message } from '../core/schema'
import type { ClearTweetResponse } from '../core/schema'
import type { TabMessagingPort } from '../core/download/media-url-refresh'
import type { Scope } from '../core/clear/ledger'

/** The narrow tab-messaging surface every tab fan-out routes through. Owns no
 *  module state — `queryXTabs` is the single tabs.query the messaging paths share,
 *  keyed off the registry's `allAdapterHostMatch()` (every registered platform, not
 *  just X — see the widening note on `defaultTabsPort` below). The name is legacy
 *  (X was the only platform when it was written); which fan-outs actually run
 *  X-specific DOM logic is now decided by the receiving handler's platform gate,
 *  not by which tabs get queried here. */
export interface TabBroadcaster {
  /** The numeric ids of every open X tab. */
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
  /** Ask open X tabs to clear the tweet; stops at the first mounted tab. `preferTabId`
   *  (the tab the download came from) is tried FIRST, so a background list tab can't
   *  win the clear and un-bookmark a post the user only meant to drop from its feed.
   *  `allLists` rides into the request so the content script clears every list the
   *  post is in (not just the page's), when the "Clear from every list" setting is on. */
  readonly sendClearToTabs: (
    tweetId: string,
    scopes: Scope[],
    preferTabId?: number,
    allLists?: boolean,
  ) => Promise<{
    mounted: boolean
    results: ReadonlyArray<{ scope: Scope; ok: boolean; noop?: boolean | undefined }>
  }>
}

/** The `browser.tabs` seam every X-tab fan-out routes through. Defaults to the live
 *  binding; a test injects a fake to drive the clear-targeting + fan-out logic (the
 *  fake-browser package implements neither tabs.query's url-pattern match nor
 *  tabs.sendMessage, so the seam — not a global stub — is how this is testable). */
export interface TabsPort {
  /** The numeric ids of every open X tab. */
  queryXTabs(): Promise<number[]>
  /** Send a message to one tab; resolves to its response (or undefined). */
  sendTabMessage(tabId: number, message: unknown): Promise<unknown>
}

const defaultTabsPort = (): TabsPort => ({
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
})

export const makeTabBroadcaster = (tabs: TabsPort = defaultTabsPort()): TabBroadcaster => {
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

  /** Ask open X tabs to clear the tweet. `mounted` is true only when a tab actually
   *  has the article and answered per-scope (verified flips); a tab without it now
   *  returns an EMPTY results array, which we skip — so "not mounted anywhere" comes
   *  back `mounted:false` (defer), distinct from a mounted-but-flip-failed result. */
  const sendClearToTabs = async (
    tweetId: string,
    scopes: Scope[],
    preferTabId?: number,
    allLists?: boolean,
  ): Promise<{
    mounted: boolean
    results: ReadonlyArray<{ scope: Scope; ok: boolean; noop?: boolean | undefined }>
  }> => {
    const ids = await queryXTabs()
    // Try the originating tab FIRST (where the user downloaded): if the post is still
    // mounted there it answers and short-circuits, so a background Bookmarks/Likes tab
    // can't win and un-bookmark a post meant only for its own feed's clear. Falls back
    // to the rest (broadcast) when the origin tab scrolled the post away or is gone.
    const ordered =
      preferTabId !== undefined && ids.includes(preferTabId)
        ? [preferTabId, ...ids.filter((id) => id !== preferTabId)]
        : ids
    // oxlint-disable no-await-in-loop -- stop at the first tab that has the mounted article
    for (const id of ordered) {
      try {
        const res = (await tabs.sendTabMessage(id, {
          _tag: 'ClearTweetRequest',
          tweetId,
          scopes,
          allLists,
        })) as ClearTweetResponse | undefined
        if (res?.results && res.results.length > 0) return { mounted: true, results: res.results }
      } catch {
        /* tab without the content script; try the next */
      }
    }
    // oxlint-enable no-await-in-loop
    return { mounted: false, results: [] }
  }

  return {
    queryXTabs,
    makeTabMessagingPort,
    broadcastToXTabs,
    reportTransferOutcome,
    sendClearToTabs,
  }
}
