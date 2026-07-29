import type { Scope } from '../core/clear/ledger'
import type { ClearTweetResponse, LocateClearTweetResponse, Settings } from '../core/schema'

export interface ClearWakePort {
  /** Ensures one named alarm fires no later than `at`; it must not postpone an earlier wake. */
  readonly schedule: (at: number) => Promise<void>
}

export interface ClearDownloadRow {
  readonly state: 'in_progress' | 'complete' | 'interrupted'
  readonly exists?: boolean
}

export interface ClearDownloadSearch {
  readonly search: (downloadId: number) => Promise<ClearDownloadRow | undefined>
}

export interface ClearTabs {
  readonly locateClearTweet: (
    tweetId: string,
    scopes: Scope[],
    preferTabId?: number,
    allLists?: boolean,
  ) => Promise<
    ReadonlyArray<{
      readonly tabId: number
      readonly response: LocateClearTweetResponse
    }>
  >
  readonly clearTweetInTab: (
    tabId: number,
    tweetId: string,
    scopes: Scope[],
    allLists: boolean,
  ) => Promise<ClearTweetResponse | undefined>
}

export interface ClearSettingsAuthority {
  readonly withClearPolicyTurn: <T>(
    callback: (settings: Readonly<Settings>) => Promise<T>,
  ) => Promise<T>
}
