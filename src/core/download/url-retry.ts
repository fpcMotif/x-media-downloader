import type { MediaItem } from '../schema'

/** Locate a fresh MediaItem for retry — prefer exact id, else tweetId+index+type. */
export function findFreshMediaItem(
  target: Pick<MediaItem, 'id' | 'tweetId' | 'index' | 'type'>,
  candidates: ReadonlyArray<MediaItem>,
): MediaItem | undefined {
  const byId = candidates.find((c) => c.id === target.id)
  if (byId !== undefined) return byId
  const matches = candidates.filter(
    (c) => c.tweetId === target.tweetId && c.index === target.index && c.type === target.type,
  )
  return matches.length === 1 ? matches[0] : undefined
}

/** Pick the URL to use on retry; falls back to the stored url when refresh misses. */
export function mergeRetryUrl(storedUrl: string, fresh: MediaItem | undefined): string {
  return fresh?.url ?? storedUrl
}

/** Tab messaging port for unit tests. */
export interface TabMessagingPort {
  readonly queryTabs: () => Promise<ReadonlyArray<{ readonly id: number }>>
  readonly sendTabMessage: (
    tabId: number,
    message: {
      readonly _tag: 'RefreshMediaUrlRequest'
      readonly itemId: string
      readonly tweetId: string
      readonly index?: number
      readonly type?: MediaItem['type']
    },
  ) => Promise<{ readonly url?: string } | undefined>
}

/** Ask an open X tab's content script for a fresher CDN url before retry. */
export async function refreshMediaUrlFromTabs(
  item: MediaItem,
  port: TabMessagingPort,
): Promise<string | null> {
  const tabs = await port.queryTabs()
  const message = {
    _tag: 'RefreshMediaUrlRequest' as const,
    itemId: item.id,
    tweetId: item.tweetId,
    index: item.index,
    type: item.type,
  }
  for (const tab of tabs) {
    try {
      const res = await port.sendTabMessage(tab.id, message)
      if (typeof res?.url === 'string' && res.url.length > 0) return res.url
    } catch {
      /* tab has no injected content script */
    }
  }
  return null
}
