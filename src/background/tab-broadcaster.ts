import { allPlatformHostMatch } from '../core/adapters/catalog'
import type { TabBroadcast } from '../core/schema'
import {
  decodeClearTweetResponse,
  decodeLocateClearTweetResponse,
  type ClearScope,
  type ClearTweetResponse,
  type LocateClearTweetResponse,
} from '../core/schema'
import type { TabMessagingPort } from '../core/download/media-url-refresh'

/** The narrow tab-messaging surface every tab fan-out routes through. Owns no
 *  module state — `queryPlatformTabs` is the single tabs.query the messaging paths
 *  share, keyed off the catalog's `allPlatformHostMatch()`. Which fan-outs actually
 *  run X-specific DOM logic is decided by the receiving handler's platform gate,
 *  not by which tabs get queried here. */
export interface TabBroadcaster {
  /** The numeric ids of every open tab on a registered platform. */
  readonly queryPlatformTabs: () => Promise<number[]>
  /** The RefreshMediaUrl port the media-url refresh + retry-url resolution use. */
  readonly makeTabMessagingPort: () => TabMessagingPort
  /** Fire-and-forget a message to every open registered-platform tab; a dead tab is a silent no-op. */
  readonly broadcastToPlatformTabs: (message: TabBroadcast) => Promise<void>
  /** Announce a transfer's TERMINAL outcome to the overlays (sidecar `.json` skipped). */
  readonly reportTransferOutcome: (
    requestId: string,
    outcome: 'complete' | 'failed',
    at: number,
  ) => void
  /** Read-only presence and control check. Every valid mounted answer is returned;
   * the coordinator chooses exactly one actionable target before any click. */
  readonly locateClearTweet: (
    tweetId: string,
    scopes: ClearScope[],
    preferTabId?: number,
    allLists?: boolean,
  ) => Promise<
    ReadonlyArray<{ readonly tabId: number; readonly response: LocateClearTweetResponse }>
  >
  /** Send one destructive request to the tab already selected by Locate. Never
   * retries another tab: a lost reply is intentionally returned as undefined. */
  readonly clearTweetInTab: (
    tabId: number,
    tweetId: string,
    scopes: ClearScope[],
    allLists: boolean,
  ) => Promise<ClearTweetResponse | undefined>
}

/** The `browser.tabs` seam every platform-tab fan-out routes through. Defaults to the live
 *  binding; a test injects a fake to drive the clear-targeting + fan-out logic (the
 *  fake-browser package implements neither tabs.query's url-pattern match nor
 *  tabs.sendMessage, so the seam — not a global stub — is how this is testable). */
export interface TabsPort {
  /** The numeric ids of every open tab on a registered platform (not X-only —
   *  `defaultTabsPort` below queries `allPlatformHostMatch()`). */
  queryPlatformTabs(): Promise<number[]>
  /** Send a message to one tab; resolves to its response (or undefined). */
  sendTabMessage(tabId: number, message: unknown): Promise<unknown>
}

const defaultTabsPort = (): TabsPort => ({
  // Widened to every cataloged platform host (not X hosts alone): a
  // download that fails on an Instagram/Threads tab must still reach that tab's
  // TransferOutcome listener, or the badge set "saved" at hand-off never gets
  // corrected. The X-only *behavior* for clear-family messages lives in the
  // handlers.ts platform gate, not in which tabs get asked here.
  queryPlatformTabs: async () => {
    const tabs = await browser.tabs.query({ url: [...allPlatformHostMatch()] })
    return tabs.flatMap((t) => (t.id !== undefined ? [t.id] : []))
  },
  sendTabMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
})

export const makeTabBroadcaster = (tabs: TabsPort = defaultTabsPort()): TabBroadcaster => {
  const queryPlatformTabs = (): Promise<number[]> => tabs.queryPlatformTabs()

  const makeTabMessagingPort = (): TabMessagingPort => ({
    queryTabs: async () => (await queryPlatformTabs()).map((id) => ({ id })),
    sendTabMessage: (tabId, message) =>
      tabs.sendTabMessage(tabId, message) as Promise<{ readonly url?: string } | undefined>,
  })

  /** Broadcast a fire-and-forget message to every open registered-platform tab. A dead tab (no
   *  injected content script / stale context) is a silent no-op — the same
   *  treatment `refreshMediaUrlFromTabs` gives a missing receiver: not a failure. */
  const broadcastToPlatformTabs = async (message: TabBroadcast): Promise<void> => {
    const ids = await queryPlatformTabs()
    await Promise.all(ids.map((id) => tabs.sendTabMessage(id, message).catch(() => {})))
  }

  /** The single seam every terminal transfer site routes through: announce a
   *  transfer's TERMINAL outcome to the overlays, so a badge marked saved at
   *  hand-off is corrected by the real result (bytes landed / 403 / timeout).
   *  Sidecars never reach this media-only projection seam. */
  const reportTransferOutcome = (
    requestId: string,
    outcome: 'complete' | 'failed',
    at: number,
  ): void => {
    // `.catch` so a tabs.query failure during SW teardown is a silent no-op (the
    // same degraded outcome as no tab receiving it), never an unhandled rejection.
    void broadcastToPlatformTabs({ _tag: 'TransferOutcome', requestId, outcome, at }).catch(
      () => {},
    )
  }

  const orderedTabs = async (preferTabId?: number): Promise<number[]> => {
    const ids = await queryPlatformTabs()
    return preferTabId !== undefined && ids.includes(preferTabId)
      ? [preferTabId, ...ids.filter((id) => id !== preferTabId)]
      : ids
  }

  /** Locate is deliberately read-only. It checks every open tab so the durable
   * coordinator can retain no-target work and choose one actionable target. */
  const locateClearTweet = async (
    tweetId: string,
    scopes: ClearScope[],
    preferTabId?: number,
    allLists = false,
  ): Promise<
    ReadonlyArray<{ readonly tabId: number; readonly response: LocateClearTweetResponse }>
  > => {
    const found: Array<{ readonly tabId: number; readonly response: LocateClearTweetResponse }> = []
    // oxlint-disable no-await-in-loop -- retain ordered candidates; only Locate runs here
    for (const id of await orderedTabs(preferTabId)) {
      try {
        const response = decodeLocateClearTweetResponse(
          await tabs.sendTabMessage(id, {
            _tag: 'LocateClearTweetRequest',
            tweetId,
            scopes,
            allLists,
          }),
          scopes,
        )
        if (response?.mounted) found.push({ tabId: id, response })
      } catch {
        /* dead or unclaimed tab; no destructive request has happened */
      }
    }
    // oxlint-enable no-await-in-loop
    return found
  }

  const clearTweetInTab = async (
    tabId: number,
    tweetId: string,
    scopes: ClearScope[],
    allLists: boolean,
  ): Promise<ClearTweetResponse | undefined> => {
    try {
      return decodeClearTweetResponse(
        await tabs.sendTabMessage(tabId, {
          _tag: 'ClearTweetRequest',
          tweetId,
          scopes,
          allLists,
        }),
        scopes,
      )
    } catch {
      return undefined
    }
  }

  return {
    queryPlatformTabs,
    makeTabMessagingPort,
    broadcastToPlatformTabs,
    reportTransferOutcome,
    locateClearTweet,
    clearTweetInTab,
  }
}
