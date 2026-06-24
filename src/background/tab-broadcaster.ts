import { X_HOST_MATCH } from '../core/adapters/x'
import type { Message } from '../core/schema'
import type { ClearTweetResponse } from '../core/schema'
import type { TabMessagingPort } from '../core/download/media-url-refresh'
import type { Scope } from '../core/clear/ledger'

/** The narrow tab-messaging surface every X-tab fan-out routes through. Owns no
 *  module state — `queryXTabs` is the single tabs.query the messaging paths share,
 *  keyed off the one X_HOST_MATCH source of truth. */
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

const queryXTabs = async (): Promise<number[]> => {
  const tabs = await browser.tabs.query({ url: [...X_HOST_MATCH] })
  return tabs.flatMap((t) => (t.id !== undefined ? [t.id] : []))
}

export const makeTabBroadcaster = (): TabBroadcaster => {
  const makeTabMessagingPort = (): TabMessagingPort => ({
    queryTabs: async () => (await queryXTabs()).map((id) => ({ id })),
    sendTabMessage: (tabId, message) =>
      browser.tabs.sendMessage(tabId, message) as Promise<{ readonly url?: string } | undefined>,
  })

  /** Broadcast a fire-and-forget message to every open X tab. A dead tab (no
   *  injected content script / stale context) is a silent no-op — the same
   *  treatment `refreshMediaUrlFromTabs` gives a missing receiver: not a failure. */
  const broadcastToXTabs = async (message: Message): Promise<void> => {
    const ids = await queryXTabs()
    await Promise.all(ids.map((id) => browser.tabs.sendMessage(id, message).catch(() => {})))
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
        const res = (await browser.tabs.sendMessage(id, {
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
